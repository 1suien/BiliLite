// fMP4(DASH) → 通用（渐进式）MP4 的零依赖 remux。
//
// 输入：B 站 DASH 的 .m4s —— 一个 init segment（ftyp + moov，moov 里的 stbl 采样表是空的）
//       后面跟着若干媒体分片（styp/free + moof + mdat）。
// 输出：ftyp + moov + mdat 的渐进式 MP4，普通播放器 / <video> 能直接播。
//       stsd（含 avcC / esds 等编解码配置）从 init 段原样搬过来，采样表全部按实际采样重算。
//
// 实现约定（踩过的坑都记在这里）：
//   * 所有 box 偏移一律用「相对整个文件」的绝对下标：stco/co64 和 moof 的 base_data_offset
//     都要求文件绝对偏移，嵌套解析时不能把子 box 的 payload 下标当成绝对下标。
//   * trun 的字段顺序是 version/flags → [data_offset] → [first_sample_flags] → sample_count → 逐采样字段。
//     sample_count 在可选字段之后，绝不能写死在 payload 偏移 4（带 data_offset 时那里是 data_offset）。
//   * tfhd 的 base_data_offset / default_sample_* 由 flags 决定是否出现，必须按位依次读。
//   * trun 的 data_offset 是相对「base」的：base = default-base-is-moof ? moof 起点
//     : (base_data_offset ?? moof 起点)；没写 data_offset 时接着上一个 run 的数据末尾（第一个 run
//     就落在紧随 moof 之后的 mdat 数据区起点）—— real world 的分片都是这个布局。
//   * 输出每轨只有一个 chunk（stsc 只有一条 { first_chunk:1, samples_per_chunk:N, desc:1 }），
//     采样在 mdat 里按轨连续排列，因此 stco/co64 只有一个绝对偏移。
//   * ctts 只有在存在非零合成偏移时才写；出现负值就用 version 1（有符号 int32）。

import fsp from 'node:fs/promises'

// ============================================================ box 读取

/**
 * 列出 [start, end) 区间里的所有 box。
 * 传入的 buf 始终是整个文件，start/end 是绝对下标，返回的 offset/payloadStart 也是绝对下标，
 * 这样递归解析时可以直接用 b.payloadStart 继续，拿到的偏移天然是文件绝对偏移。
 */
function listBoxes(buf, start = 0, end = buf.length) {
  const boxes = []
  let p = start
  const limit = Math.min(end, buf.length)
  while (p + 8 <= limit) {
    const size = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let headerSize = 8
    let boxSize = size
    if (size === 1) {
      if (p + 16 > limit) break
      boxSize = Number(buf.readBigUInt64BE(p + 8))
      headerSize = 16
    } else if (size === 0) {
      // size==0 表示「一直到文件/父容器末尾」
      boxSize = limit - p
    }
    if (boxSize < headerSize || p + boxSize > limit) {
      // 长度不合法：停在这里（调用方通常还会配合各自的容错逻辑）
      break
    }
    boxes.push({
      type,
      size: boxSize,
      headerSize,
      offset: p,
      payloadStart: p + headerSize,
      payloadLength: boxSize - headerSize,
      payload: buf.subarray(p + headerSize, p + boxSize),
      raw: buf.subarray(p, p + boxSize)
    })
    p += boxSize
  }
  return boxes
}

/** 某个 box 的直接子 box */
const children = (buf, parent) => listBoxes(buf, parent.payloadStart, parent.payloadStart + parent.payloadLength)

/** 某个 box 的第一个指定类型的子 box */
const child = (buf, parent, type) => children(buf, parent).find((b) => b.type === type) || null

/** 原样复制一个 box（保留 16 字节大 box 头等细节） */
const cloneBox = (b) => Buffer.from(b.raw)

/** 沿 trak → mdia → minf → stbl 这类固定路径找 box */
function childPath(buf, parent, path) {
  let cur = parent
  for (const type of path) {
    if (!cur) return null
    cur = child(buf, cur, type)
  }
  return cur
}

// ============================================================ box 写出

const u32 = (v) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(Number(v) >>> 0, 0)
  return b
}
const i32 = (v) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(Number(v) | 0, 0)
  return b
}
const u64 = (v) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(v), 0)
  return b
}
const cat = (list) => Buffer.concat(list.filter((x) => x && x.length))

/** 普通 box：size + type + body */
function box(type, ...kids) {
  const body = cat(kids)
  return cat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}

/** full box：size + type + version/flags + body */
function fbox(type, version, flags, ...kids) {
  const body = cat(kids)
  return cat([
    u32(body.length + 12),
    Buffer.from(type, 'latin1'),
    u32(((version & 0xff) << 24) | (flags & 0xffffff)),
    body
  ])
}

// ============================================================ 时长字段改写

/** mvhd：movie timescale 下的总时长 */
function patchMvhdDuration(payload, duration) {
  const p = Buffer.from(payload)
  const d = Math.max(0, Math.round(duration))
  if (p[0] === 1) {
    if (p.length >= 32) p.writeBigUInt64BE(BigInt(d), 24)
  } else if (p.length >= 20) {
    p.writeUInt32BE(Math.min(0xffffffff, d), 16)
  }
  return p
}

/** tkhd：duration 同样是 movie timescale；trackId 非空时顺便改 track_ID（避免两轨撞号） */
function patchTkhd(payload, duration, trackId) {
  const p = Buffer.from(payload)
  const d = Math.max(0, Math.round(duration))
  if (p[0] === 1) {
    if (p.length >= 32) p.writeBigUInt64BE(BigInt(d), 24)
    if (trackId && p.length >= 24) p.writeUInt32BE(trackId >>> 0, 20)
  } else {
    if (p.length >= 24) p.writeUInt32BE(Math.min(0xffffffff, d), 20)
    if (trackId && p.length >= 16) p.writeUInt32BE(trackId >>> 0, 12)
  }
  return p
}

/** mdhd：duration 是 media timescale */
function patchMdhdDuration(payload, duration) {
  const p = Buffer.from(payload)
  const d = Math.max(0, Math.round(duration))
  if (p[0] === 1) {
    if (p.length >= 32) p.writeBigUInt64BE(BigInt(d), 24)
  } else if (p.length >= 20) {
    p.writeUInt32BE(Math.min(0xffffffff, d), 16)
  }
  return p
}

// ============================================================ 各 full box 字段

const readVersion = (b) => b.payload[0]
const readFlags = (b) => (b.payload.length >= 4 ? b.payload.readUInt32BE(0) & 0xffffff : 0)

/** 找 trak 的 track_ID（tkhd） */
function readTrackId(buf, trak) {
  const tkhd = child(buf, trak, 'tkhd')
  if (!tkhd || tkhd.payloadLength < 16) return 0
  return tkhd.payload[0] === 1 ? tkhd.payload.readUInt32BE(20) : tkhd.payload.readUInt32BE(12)
}

/** mdhd 的 timescale */
function readMdhdTimescale(mdhd) {
  if (!mdhd || mdhd.payloadLength < 20) return 0
  return mdhd.payload[0] === 1 ? mdhd.payload.readUInt32BE(20) : mdhd.payload.readUInt32BE(12)
}

/** mvhd 的 timescale */
function readMvhdTimescale(mvhd) {
  if (!mvhd || mvhd.payloadLength < 20) return 1000
  const ts = mvhd.payload[0] === 1 ? mvhd.payload.readUInt32BE(20) : mvhd.payload.readUInt32BE(12)
  return ts || 1000
}

const HANDLER_KIND = { vide: 'video', soun: 'audio' }

function readHandlerKind(buf, mdia) {
  const hdlr = child(buf, mdia, 'hdlr')
  if (!hdlr || hdlr.payloadLength < 12) return 'other'
  const handler = hdlr.payload.toString('latin1', 8, 12)
  return HANDLER_KIND[handler] || 'other'
}

/** mvex/trex 的默认采样值，按 track_ID 索引 */
function readTrexDefaults(buf, moov) {
  const map = new Map()
  const mvex = child(buf, moov, 'mvex')
  if (!mvex) return map
  for (const trex of children(buf, mvex).filter((b) => b.type === 'trex')) {
    if (trex.payloadLength < 24) continue
    map.set(trex.payload.readUInt32BE(4), {
      defaultSampleDescriptionIndex: trex.payload.readUInt32BE(8),
      defaultSampleDuration: trex.payload.readUInt32BE(12),
      defaultSampleSize: trex.payload.readUInt32BE(16),
      defaultSampleFlags: trex.payload.readUInt32BE(20)
    })
  }
  return map
}

// ============================================================ sample entry / codec

const VIDEO_ENTRY_TYPES = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'av01', 'vp08', 'vp09'])
const AUDIO_ENTRY_TYPES = new Set(['mp4a', 'ac-3', 'ec-3', 'opus', 'Opus', 'alac', 'fLaC'])

/** sample entry 里固定前缀的长度（之后才是 avcC/esds 这类子 box） */
function sampleEntryPrefix(type) {
  if (VIDEO_ENTRY_TYPES.has(type)) return 78 // VisualSampleEntry
  if (AUDIO_ENTRY_TYPES.has(type)) return 28 // AudioSampleEntry v0
  return 8
}

/** sample entry 里的编解码配置 box（avcC / hvcC / av1C / esds…） */
function sampleEntryChildren(buf, entry) {
  const start = entry.payloadStart + sampleEntryPrefix(entry.type)
  if (start >= entry.payloadStart + entry.payloadLength) return []
  return listBoxes(buf, start, entry.payloadStart + entry.payloadLength)
}

/** stsd 的第一个 sample entry */
function firstSampleEntry(buf, stsd) {
  const list = listBoxes(buf, stsd.payloadStart + 8, stsd.payloadStart + stsd.payloadLength)
  return list.length ? list[0] : null
}

/** 线性遍历 esds 里的 MPEG-4 descriptor（长度用 7 位可变长编码） */
function walkDescriptors(buf, start, end, visit, depth = 0) {
  if (depth > 6) return
  let p = start
  while (p + 2 <= end) {
    const tag = buf[p]
    let q = p + 1
    let len = 0
    let n = 0
    while (q < end) {
      const byte = buf[q++]
      len = (len << 7) | (byte & 0x7f)
      if (++n === 4 || !(byte & 0x80)) break
    }
    const ps = q
    const pe = q + len
    if (pe > end) break
    visit(tag, ps, pe)
    if (tag === 0x03) walkDescriptors(buf, ps + 3, pe, visit, depth + 1) // ES_ID(2) + flags(1)
    else if (tag === 0x04) walkDescriptors(buf, ps + 13, pe, visit, depth + 1) // oti/streamType/bufferSize/bitrates
    p = pe
  }
}

const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase()

/** 生成 codec 串（avc1.64001E / mp4a.40.2 / hvc1.… / av01.…） */
function codecString(buf, entry) {
  if (!entry) return ''
  const type = entry.type
  const kinds = sampleEntryChildren(buf, entry)
  if (type === 'avc1' || type === 'avc2' || type === 'avc3' || type === 'avc4') {
    const avcC = kinds.find((b) => b.type === 'avcC')
    if (avcC && avcC.payloadLength >= 4) {
      return `${type}.${hex2(avcC.payload[1])}${hex2(avcC.payload[2])}${hex2(avcC.payload[3])}`
    }
    return type
  }
  if (type === 'hvc1' || type === 'hev1') {
    const hvcC = kinds.find((b) => b.type === 'hvcC')
    if (hvcC && hvcC.payloadLength >= 13) {
      const p = hvcC.payload
      const profileSpace = (p[1] >> 6) & 0x03
      const tier = (p[1] >> 5) & 0x01
      const profileIdc = p[1] & 0x1f
      const compat = p.readUInt32BE(2).toString(16).toUpperCase().padStart(8, '0')
      const level = p[12]
      return `${type}.${profileSpace ? 'A' + profileSpace : ''}${profileIdc}.${compat}.${tier ? 'H' : 'L'}${level}`
    }
    return type
  }
  if (type === 'av01') {
    const av1C = kinds.find((b) => b.type === 'av1C')
    if (av1C && av1C.payloadLength >= 4) {
      const p = av1C.payload
      return `av01.${(p[1] >> 5) & 0x07}.${String(p[1] & 0x1f).padStart(2, '0')}${(p[2] >> 7) & 0x01 ? 'H' : 'M'}.${String(p[2] & 0x1f).padStart(2, '0')}`
    }
    return type
  }
  if (type === 'mp4a') {
    const esds = kinds.find((b) => b.type === 'esds')
    if (!esds || esds.payloadLength < 4) return 'mp4a'
    let oti = 0
    let asc = null
    walkDescriptors(
      buf,
      esds.payloadStart + 4,
      esds.payloadStart + esds.payloadLength,
      (tag, ps, pe) => {
        if (tag === 0x04 && !oti) oti = buf[ps]
        if (tag === 0x05 && !asc) asc = buf.subarray(ps, pe)
      }
    )
    if (!oti) return 'mp4a'
    let out = `mp4a.${hex2(oti).toLowerCase()}`
    if (asc && asc.length >= 1) {
      let aot = (asc[0] >> 3) & 0x1f
      if (aot === 31 && asc.length >= 2) aot = 32 + (((asc[0] & 0x07) << 3) | ((asc[1] >> 5) & 0x07))
      out += `.${aot}`
    }
    return out
  }
  return type
}

// ============================================================ 采样表（stbl）

/** stsz：每个采样的大小。sample_size!=0 表示全部相同 */
function readStsz(buf, stsz) {
  const p = stsz.payload
  const fixed = p.readUInt32BE(4)
  const count = p.readUInt32BE(8)
  const sizes = []
  if (fixed) {
    for (let i = 0; i < count; i++) sizes.push(fixed)
    return sizes
  }
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 4
    sizes.push(at + 4 <= p.length ? p.readUInt32BE(at) : 0)
  }
  return sizes
}

/** stts：采样时长（差分的 run-length）→ 逐采样时长数组 */
function readStts(buf, stts) {
  const p = stts.payload
  const n = p.readUInt32BE(4)
  const out = []
  let at = 8
  for (let i = 0; i < n && at + 8 <= p.length; i++, at += 8) {
    const count = p.readUInt32BE(at)
    const delta = p.readUInt32BE(at + 4)
    for (let k = 0; k < count; k++) out.push(delta)
  }
  return out
}

/** ctts：合成偏移。version 1 是有符号 int32，v0 无符号 */
function readCtts(buf, ctts) {
  const version = ctts.payload[0]
  const p = ctts.payload
  const n = p.readUInt32BE(4)
  const out = []
  let at = 8
  for (let i = 0; i < n && at + 8 <= p.length; i++, at += 8) {
    const count = p.readUInt32BE(at)
    const off = version === 1 ? p.readInt32BE(at + 4) : p.readUInt32BE(at + 4)
    for (let k = 0; k < count; k++) out.push(off)
  }
  return out
}

/** stsc：{first_chunk, samples_per_chunk, desc_index}，语义是「从 first_chunk 起每 chunk 多少个采样」 */
function readStsc(buf, stsc) {
  const p = stsc.payload
  const n = p.readUInt32BE(4)
  const out = []
  let at = 8
  for (let i = 0; i < n && at + 12 <= p.length; i++, at += 12) {
    out.push({
      firstChunk: p.readUInt32BE(at),
      samplesPerChunk: p.readUInt32BE(at + 4),
      descIndex: p.readUInt32BE(at + 8)
    })
  }
  return out
}

/** stco / co64：chunk 的文件绝对偏移 */
function readChunkOffsets(buf, stbl) {
  const stco = child(buf, stbl, 'stco')
  const co64 = stco ? null : child(buf, stbl, 'co64')
  if (stco) {
    const p = stco.payload
    const n = p.readUInt32BE(4)
    const out = []
    for (let i = 0; i < n; i++) {
      const at = 8 + i * 4
      out.push(at + 4 <= p.length ? p.readUInt32BE(at) : 0)
    }
    return out
  }
  if (co64) {
    const p = co64.payload
    const n = p.readUInt32BE(4)
    const out = []
    for (let i = 0; i < n; i++) {
      const at = 8 + i * 8
      out.push(at + 8 <= p.length ? Number(p.readBigUInt64BE(at)) : 0)
    }
    return out
  }
  return []
}

/** stss：同步采样序号（1-based）。没有 stss 表示每个采样都是随机访问点 */
function readStss(buf, stbl) {
  const stss = child(buf, stbl, 'stss')
  if (!stss) return null
  const p = stss.payload
  const n = p.readUInt32BE(4)
  const set = new Set()
  for (let i = 0; i < n; i++) {
    const at = 8 + i * 4
    if (at + 4 <= p.length) set.add(p.readUInt32BE(at))
  }
  return set
}

/**
 * 解析 stbl 里的采样表，还原成逐采样记录。
 * 返回 { samples, chunkOffsets, stss }；samples[i] = { offset, size, duration, cts, sync }。
 */
function parseSampleTable(buf, stbl) {
  const stsz = child(buf, stbl, 'stsz')
  const sizes = stsz ? readStsz(buf, stsz) : []
  const stts = child(buf, stbl, 'stts')
  const durations = stts ? readStts(buf, stts) : []
  const cttsBox = child(buf, stbl, 'ctts')
  const ctts = cttsBox ? readCtts(buf, cttsBox) : []
  const stscBox = child(buf, stbl, 'stsc')
  const stsc = stscBox ? readStsc(buf, stscBox) : []
  const chunkOffsets = readChunkOffsets(buf, stbl)
  const stss = readStss(buf, stbl)

  const samples = []
  let si = 0
  for (let ci = 0; ci < chunkOffsets.length && si < sizes.length; ci++) {
    // stsc 的条目适用于「first_chunk <= 当前 chunk」的最后一个条目
    let per = 0
    for (const e of stsc) {
      if (e.firstChunk <= ci + 1) per = e.samplesPerChunk
      else break
    }
    if (!per) break
    let off = chunkOffsets[ci]
    for (let k = 0; k < per && si < sizes.length; k++, si++) {
      samples.push({
        offset: off,
        size: sizes[si],
        duration: durations[si] ?? 0,
        cts: ctts[si] ?? 0,
        sync: stss ? stss.has(si + 1) : true
      })
      off += sizes[si]
    }
  }
  // 采样表不完整（stsc 覆盖不到）时补出无偏移的样本，避免整轨丢失
  for (; si < sizes.length; si++) {
    samples.push({
      offset: -1,
      size: sizes[si],
      duration: durations[si] ?? 0,
      cts: ctts[si] ?? 0,
      sync: stss ? stss.has(si + 1) : true
    })
  }
  return { samples, chunkOffsets, hasStss: !!stss }
}

// ============================================================ 分片（moof/traf/trun）

/**
 * sample_flags 的 bit16 是 sample_is_non_sync_sample：
 * 置 1 → 非同步帧；置 0 → 同步帧（I 帧/关键帧）。
 */
const isSyncSample = (flags) => ((flags >>> 16) & 1) === 0

/**
 * 把 moov 里的 trak 模板解析出来（此时 samples 来自 stbl，通常是空的）。
 */
function parseTracks(buf, moov) {
  const trex = readTrexDefaults(buf, moov)
  const tracks = []
  for (const trak of children(buf, moov).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia')
    const minf = mdia ? child(buf, mdia, 'minf') : null
    const stbl = minf ? child(buf, minf, 'stbl') : null
    const stsd = stbl ? child(buf, stbl, 'stsd') : null
    const mdhd = mdia ? child(buf, mdia, 'mdhd') : null
    const entry = stsd ? firstSampleEntry(buf, stsd) : null
    const table = stbl ? parseSampleTable(buf, stbl) : { samples: [], chunkOffsets: [], hasStss: false }
    const trackId = readTrackId(buf, trak)
    tracks.push({
      trackId,
      kind: mdia ? readHandlerKind(buf, mdia) : 'other',
      entryType: entry ? entry.type : '',
      codec: codecString(buf, entry),
      timescale: readMdhdTimescale(mdhd) || 0,
      width: 0,
      height: 0,
      src: buf,
      trakBox: trak,
      mdiaBox: mdia,
      minfBox: minf,
      stblBox: stbl,
      stsdBox: stsd,
      trex: trex.get(trackId) || null,
      samples: table.samples,
      stblChunkOffsets: table.chunkOffsets,
      hasStss: table.hasStss,
      runOffsets: [],
      fragments: []
    })
    if (entry && VIDEO_ENTRY_TYPES.has(entry.type)) {
      const t = tracks[tracks.length - 1]
      t.width = entry.payload.readUInt16BE(24)
      t.height = entry.payload.readUInt16BE(26)
    }
  }
  return tracks
}

/**
 * 解析所有 moof 分片，把采样追加到对应 track 上。
 * 位置规则：pos = base + data_offset（有 data_offset）；
 *          没有 data_offset 时接着上一个 run 的数据末尾，
 *          一个 moof 的第一个 run 落在紧随其后的 mdat 数据区起点。
 */
function attachFragments(buf, boxes, tracks) {
  const byId = new Map(tracks.map((t) => [t.trackId, t]))
  const mdats = boxes.filter((b) => b.type === 'mdat')
  const moofs = boxes.filter((b) => b.type === 'moof')
  const errors = []
  let total = 0

  for (const moof of moofs) {
    const nextMdat = mdats.find((m) => m.offset > moof.offset)
    let cursor = nextMdat ? nextMdat.payloadStart : null
    for (const traf of children(buf, moof).filter((b) => b.type === 'traf')) {
      try {
        total += readTraf(buf, traf, moof, byId, nextMdat, () => cursor, (v) => { cursor = v }, errors)
      } catch (e) {
        errors.push(`moof@${moof.offset}：${e && e.message ? e.message : e}`)
      }
    }
  }
  return { moofCount: moofs.length, sampleCount: total, errors }
}

/** 解析一个 traf（tfhd / tfdt / trun…），返回新增采样数 */
function readTraf(buf, traf, moof, byId, nextMdat, getCursor, setCursor, errors) {
  const tfhd = child(buf, traf, 'tfhd')
  if (!tfhd || tfhd.payloadLength < 8) throw new Error('traf 里缺少 tfhd')
  const tp = tfhd.payload
  const flags = readFlags(tfhd)
  const trackId = tp.readUInt32BE(4)
  let q = 8
  let baseDataOffset = null
  let sampleDescIndex = null
  let defDuration = null
  let defSize = null
  let defFlags = null
  if (flags & 0x000001) {
    baseDataOffset = Number(tp.readBigUInt64BE(q))
    q += 8
  }
  if (flags & 0x000002) {
    sampleDescIndex = tp.readUInt32BE(q)
    q += 4
  }
  if (flags & 0x000008) {
    defDuration = tp.readUInt32BE(q)
    q += 4
  }
  if (flags & 0x000010) {
    defSize = tp.readUInt32BE(q)
    q += 4
  }
  if (flags & 0x000020) {
    defFlags = tp.readUInt32BE(q)
    q += 4
  }

  const track = byId.get(trackId)
  const trex = track ? track.trex : null
  // base：default-base-is-moof 时是 moof 起点；否则用 base_data_offset，再缺省还是 moof 起点
  const base = flags & 0x020000 ? moof.offset : baseDataOffset !== null ? baseDataOffset : moof.offset

  const tfdt = child(buf, traf, 'tfdt')
  const baseMediaDecodeTime = tfdt
    ? Number(tfdt.payload[0] === 1 ? tfdt.payload.readBigUInt64BE(4) : tfdt.payload.readUInt32BE(4))
    : 0

  const truns = children(buf, traf).filter((b) => b.type === 'trun')
  if (!truns.length) throw new Error('traf 里缺少 trun')

  let added = 0
  let runStart = null
  for (const trun of truns) {
    const p = trun.payload
    if (p.length < 8) throw new Error('trun 长度不足')
    const version = p[0]
    const tflags = p.readUInt32BE(0) & 0xffffff
    // ISO/IEC 14496-12：sample_count 紧跟在 version/flags 之后，
    // 之后才是可选的 data_offset / first_sample_flags，最后才是逐采样字段。
    // 顺序写反会让 count/data_offset/flags 全部错位（最容易踩的坑）。
    let r = 4
    if (r + 4 > p.length) throw new Error('trun 缺少 sample_count')
    const sampleCount = p.readUInt32BE(r)
    r += 4
    let dataOffset = null
    let firstSampleFlags = null
    if (tflags & 0x000001) {
      if (r + 4 > p.length) throw new Error('trun 缺少 data_offset')
      dataOffset = p.readInt32BE(r)
      r += 4
    }
    if (tflags & 0x000004) {
      if (r + 4 > p.length) throw new Error('trun 缺少 first_sample_flags')
      firstSampleFlags = p.readUInt32BE(r)
      r += 4
    }

    let pos
    if (dataOffset !== null) pos = base + dataOffset
    else if (getCursor() !== null) pos = getCursor()
    else throw new Error('trun 没有 data_offset，且后面找不到 mdat 数据区')
    runStart = pos
    if (!track) {
      // 未知 track_ID：按字段长度跳过（避免把别的轨的字节当成自己的）
      let skip = r
      for (let i = 0; i < sampleCount; i++) {
        if (tflags & 0x000100) skip += 4
        if (tflags & 0x000200) skip += 4
        if (tflags & 0x000400) skip += 4
        if (tflags & 0x000800) skip += 4
      }
      if (skip > p.length) throw new Error(`trun 字段长度越界（track_ID=${trackId} 不在 moov 里）`)
      setCursor(pos)
      continue
    }

    const fragment = { trackId, tfdt: baseMediaDecodeTime, dataStart: pos, sampleCount, runOffset: pos }
    let runBytes = 0
    for (let i = 0; i < sampleCount; i++) {
      let duration = defDuration
      let size = defSize
      let sflags = defFlags
      if (tflags & 0x000100) {
        if (r + 4 > p.length) throw new Error(`trun 逐采样 duration 越界（sample ${i}/${sampleCount}）`)
        duration = p.readUInt32BE(r)
        r += 4
      }
      if (tflags & 0x000200) {
        if (r + 4 > p.length) throw new Error(`trun 逐采样 size 越界（sample ${i}/${sampleCount}）`)
        size = p.readUInt32BE(r)
        r += 4
      }
      if (tflags & 0x000400) {
        if (r + 4 > p.length) throw new Error(`trun 逐采样 flags 越界（sample ${i}/${sampleCount}）`)
        sflags = p.readUInt32BE(r)
        r += 4
      }
      let cts = 0
      if (tflags & 0x000800) {
        if (r + 4 > p.length) throw new Error(`trun 逐采样 cts 越界（sample ${i}/${sampleCount}）`)
        cts = version === 1 ? p.readInt32BE(r) : p.readUInt32BE(r)
        r += 4
      }
      if (duration === null || duration === undefined) duration = trex ? trex.defaultSampleDuration : 0
      if (size === null || size === undefined) size = trex ? trex.defaultSampleSize : 0
      if (sflags === null || sflags === undefined) sflags = trex ? trex.defaultSampleFlags : 0
      if (i === 0 && firstSampleFlags !== null) sflags = firstSampleFlags
      if (!size) throw new Error(`采样 ${i} 取不到 size（trun 未给，tfhd/trex 也没有默认值）`)
      track.samples.push({
        offset: pos + runBytes,
        size,
        duration: duration >>> 0,
        cts: cts | 0,
        sync: isSyncSample(sflags)
      })
      runBytes += size
      added++
    }
    setCursor(pos + runBytes)
    track.runOffsets.push(pos)
    track.fragments.push(fragment)
    // 采样必须真的落在紧随其后的 mdat 数据区里，否则说明 base/data_offset 组合算错了
    if (nextMdat) {
      const ms = nextMdat.payloadStart
      const me = nextMdat.payloadStart + nextMdat.payloadLength
      if (runStart < ms || runStart + runBytes > me) {
        errors.push(
          `moof@${moof.offset}（track_ID=${trackId}）采样越出后续 mdat：[${runStart}, ${runStart + runBytes}) 不在 [${ms}, ${me})`
        )
      }
    }
  }
  return added
}

// ============================================================ 文件级解析

function parseMp4(buf) {
  const boxes = listBoxes(buf)
  const moov = boxes.find((b) => b.type === 'moov') || null
  const tracks = moov ? parseTracks(buf, moov) : []
  const frag = moov ? attachFragments(buf, boxes, tracks) : { moofCount: 0, sampleCount: 0, errors: [] }
  return { boxes, moov, tracks, frag }
}

const ENCRYPT_BOXES = ['pssh', 'senc', 'saiz', 'saio', 'sinf', 'tenc', 'schm', 'schi', 'encv', 'enca']
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf', 'udta', 'meta'])

/** 递归找加密相关 box（DRM/加密流不能直接 remux） */
function findEncryptBox(buf, parent, depth = 0) {
  if (depth > 8) return null
  const kids = children(buf, parent)
  for (const b of kids) if (ENCRYPT_BOXES.includes(b.type)) return b.type
  for (const b of kids) {
    if (CONTAINER_BOXES.has(b.type)) {
      const hit = findEncryptBox(buf, b, depth + 1)
      if (hit) return hit
    } else if (b.type === 'stsd') {
      for (const entry of listBoxes(buf, b.payloadStart + 8, b.payloadStart + b.payloadLength)) {
        for (const c of sampleEntryChildren(buf, entry)) {
          if (ENCRYPT_BOXES.includes(c.type)) return c.type
        }
      }
    }
  }
  return null
}

/**
 * 从文件顶层开始扫加密 box：pssh/tenc/sinf 在 moov 里，
 * 而 senc/saiz/saio 在 moof/traf 里（和 moov 同级），所以必须从顶层往下递归。
 */
function findEncryptBoxInFile(buf, boxes) {
  for (const b of boxes) {
    if (ENCRYPT_BOXES.includes(b.type)) return b.type
    if (CONTAINER_BOXES.has(b.type)) {
      const hit = findEncryptBox(buf, b)
      if (hit) return hit
    }
  }
  return null
}

/**
 * 解析一个输入文件（视频或音频），失败时抛带中文说明的错误。
 * 只有 init 段（没有 moof）或根本不是 MP4 都会明确报错。
 */
function parseInput(buf, label) {
  const parsed = parseMp4(buf)
  if (!parsed.moov) throw new Error(`${label}：不是有效的 MP4/m4s 文件（找不到 moov box）`)
  const enc = findEncryptBoxInFile(buf, parsed.boxes)
  if (enc) throw new Error(`${label}：检测到加密 box（${enc}），DRM/加密流暂不支持 remux`)
  const withSamples = parsed.tracks.filter((t) => t.samples.length > 0)
  if (!withSamples.length) {
    const moofCount = parsed.boxes.filter((b) => b.type === 'moof').length
    if (!moofCount) throw new Error(`${label}：没有找到任何 moof 分片，只有 init 段无法出片`)
    throw new Error(`${label}：解析到 ${moofCount} 个 moof 但没有取到任何采样`)
  }
  // 采样位置算错（越出后续 mdat）时宁可报错，也不要把错位的字节 remux 进输出
  if (parsed.frag.errors.length) {
    throw new Error(`${label}：${parsed.frag.errors.join('；')}（可能是 base_data_offset / default-base-is-moof 的组合不被支持）`)
  }
  return { ...parsed, withSamples }
}

const sumSizes = (samples) => samples.reduce((a, s) => a + s.size, 0)
const sumDurations = (samples) => samples.reduce((a, s) => a + (s.duration || 0), 0)

/** 取一条轨：优先指定类型（video/audio），否则取第一条有采样的轨 */
function pickTrack(src, kind) {
  return src.withSamples.find((t) => t.kind === kind) || src.withSamples[0]
}

/** 按采样记录把输入文件里的数据拷出来（同时做越界检查） */
function collectSampleData(buf, samples, label) {
  let total = 0
  for (const s of samples) {
    if (s.offset < 0 || s.offset + s.size > buf.length) {
      throw new Error(`${label}：采样数据越出输入文件（offset=${s.offset} size=${s.size} fileSize=${buf.length}）`)
    }
    total += s.size
  }
  const out = Buffer.allocUnsafe(total)
  let p = 0
  for (const s of samples) {
    buf.copy(out, p, s.offset, s.offset + s.size)
    p += s.size
  }
  return out
}

// ============================================================ 输出装配

/** 连续相同值合并成 run-length（stts/ctts 都是这个结构） */
function runsOf(values) {
  const runs = []
  for (const v of values) {
    const last = runs[runs.length - 1]
    if (last && last.value === v) last.count++
    else runs.push({ count: 1, value: v })
  }
  return runs
}

function buildStts(durations) {
  const runs = runsOf(durations)
  const body = [u32(runs.length)]
  for (const r of runs) body.push(u32(r.count), u32(r.value))
  return fbox('stts', 0, 0, ...body)
}

/** 合成偏移：全 0 不写；有负值必须 version 1（有符号 int32） */
function buildCtts(ctts) {
  if (!ctts.some((v) => v !== 0)) return null
  const signed = ctts.some((v) => v < 0)
  const runs = runsOf(ctts)
  const body = [u32(runs.length)]
  for (const r of runs) body.push(u32(r.count), signed ? i32(r.value) : u32(r.value))
  return fbox('ctts', signed ? 1 : 0, 0, ...body)
}

/** 单 chunk：一个轨只有一个 chunk，采样连续排列 */
function buildStsc(sampleCount) {
  return fbox('stsc', 0, 0, u32(1), u32(1), u32(sampleCount), u32(1))
}

function buildStsz(sizes) {
  return fbox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map((s) => u32(s)))
}

/** 超过 32 位寻址就写 co64 */
function buildChunkOffset(offset) {
  if (offset > 0xffffffff) return fbox('co64', 0, 0, u32(1), u64(offset))
  return fbox('stco', 0, 0, u32(1), u32(offset))
}

/** 全部采样都是同步帧 → 不写 stss（规范里省略 stss 表示每个采样都是随机访问点） */
function buildStss(samples) {
  if (samples.every((s) => s.sync)) return null
  const list = []
  samples.forEach((s, i) => {
    if (s.sync) list.push(i + 1)
  })
  return fbox('stss', 0, 0, u32(list.length), ...list.map((n) => u32(n)))
}

/** 输出 stbl 里要被重算掉的 box（其余原样保留，stsd 尤其必须原样） */
const REPLACED_STBL_BOXES = new Set([
  'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss',
  'sgpd', 'sbgp', 'sdtp', 'subs', 'saiz', 'saio', 'senc', 'sinf', 'frma', 'stsh', 'stps', 'stdp', 'padb'
])

/** 用实际采样重造 stbl（stsd 原样拷贝，codec 私有配置一个字节都不改） */
function buildStbl(buf, stbl, stsd, samples, chunkOffset) {
  const sizes = samples.map((s) => s.size)
  const durations = samples.map((s) => s.duration)
  const ctts = samples.map((s) => s.cts)
  const kids = [cloneBox(stsd), buildStts(durations)]
  const cttsBox = buildCtts(ctts)
  if (cttsBox) kids.push(cttsBox)
  kids.push(buildStsc(samples.length), buildStsz(sizes), buildChunkOffset(chunkOffset))
  const stss = buildStss(samples)
  if (stss) kids.push(stss)
  for (const b of children(buf, stbl)) {
    if (b.type === 'stsd' || REPLACED_STBL_BOXES.has(b.type)) continue
    kids.push(cloneBox(b))
  }
  return box('stbl', ...kids)
}

/** 重造一个 trak：采样表换掉，mdhd/tkhd 的时长改成重算值 */
function rebuildTrak(buf, track, chunkOffset, movieTimescale, newTrackId) {
  const { trakBox, mdiaBox, minfBox, stblBox, stsdBox, samples } = track
  if (!mdiaBox || !minfBox || !stblBox || !stsdBox) throw new Error('trak 结构不完整（缺 mdia/minf/stbl/stsd）')
  // 音频轨来自另一个输入文件，box 引用的是它自己的 buffer
  const src = track.src || buf
  const mediaDuration = sumDurations(samples)
  const timescale = track.timescale || 1
  const tkhdDuration = Math.round((mediaDuration / timescale) * movieTimescale)

  const newStbl = buildStbl(src, stblBox, stsdBox, samples, chunkOffset)
  const newMinf = box(
    'minf',
    ...children(src, minfBox).map((b) => (b.type === 'stbl' ? newStbl : cloneBox(b)))
  )
  const newMdia = box(
    'mdia',
    ...children(src, mdiaBox).map((b) => {
      if (b.type === 'minf') return newMinf
      if (b.type === 'mdhd') return box('mdhd', patchMdhdDuration(b.payload, mediaDuration))
      return cloneBox(b)
    })
  )
  return box(
    'trak',
    ...children(src, trakBox).map((b) => {
      if (b.type === 'mdia') return newMdia
      if (b.type === 'tkhd') return box('tkhd', patchTkhd(b.payload, tkhdDuration, newTrackId))
      return cloneBox(b)
    })
  )
}

/** 造一个标准渐进式 ftyp（isom/mp41 + 编解码品牌），比直接抄 DASH 的 dash 品牌兼容性好 */
function buildFtyp(videoEntryType) {
  const brands = ['isom', 'iso6', 'mp41']
  if (videoEntryType === 'hvc1' || videoEntryType === 'hev1') brands.push('hvc1')
  else if (videoEntryType === 'av01') brands.push('av01')
  else brands.push('avc1')
  return box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from(brands.join(''), 'latin1'))
}

/**
 * 重造 moov：mvhd 改时长，video/audio 两条 trak 用实际采样重建，mvex 丢掉
 * （输出已经是渐进式，不需要 trex 默认值了）。
 */
function buildMoov(buf, videoMoov, movieTimescale, movieDuration, specs) {
  const mvhd = child(buf, videoMoov, 'mvhd')
  if (!mvhd) throw new Error('moov 里没有 mvhd')
  const kids = [box('mvhd', patchMvhdDuration(mvhd.payload, movieDuration))]
  for (const spec of specs) {
    kids.push(rebuildTrak(buf, spec.track, spec.chunkOffset, movieTimescale, spec.newTrackId))
  }
  for (const b of children(buf, videoMoov)) {
    if (b.type === 'mvhd' || b.type === 'trak' || b.type === 'mvex') continue
    kids.push(cloneBox(b))
  }
  return box('moov', ...kids)
}

// ============================================================ 对外接口

/**
 * 检视一个 MP4（渐进式或 fMP4 分片都行），返回结构化的自检信息。
 * 关键字段：
 *   size / boxes / hasMoov / hasMdat / moovBeforeMdat / mdatBytes
 *   tracks[]: trackId, kind, type, timescale, codec, sampleCount, durations, sampleSizes,
 *             sampleOffsets, chunkOffsets, syncSamples（1-based）, fragments
 */
export function inspectMp4(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const parsed = parseMp4(buf)
  if (!parsed.moov) throw new Error('inspectMp4：输入里找不到 moov box，不是有效的 MP4')
  const moovAt = parsed.boxes.findIndex((b) => b.type === 'moov')
  const mdatAt = parsed.boxes.findIndex((b) => b.type === 'mdat')
  const mdatBytes = parsed.boxes
    .filter((b) => b.type === 'mdat')
    .reduce((a, b) => a + b.payloadLength, 0)

  const tracks = parsed.tracks.map((t) => {
    const syncSamples = []
    t.samples.forEach((s, i) => {
      if (s.sync) syncSamples.push(i + 1)
    })
    return {
      trackId: t.trackId,
      kind: t.kind,
      type: t.kind === 'other' ? t.entryType : t.kind,
      entryType: t.entryType,
      timescale: t.timescale,
      codec: t.codec,
      width: t.width,
      height: t.height,
      sampleCount: t.samples.length,
      durations: t.samples.map((s) => s.duration),
      sampleSizes: t.samples.map((s) => s.size),
      sampleOffsets: t.samples.map((s) => s.offset),
      // 渐进式文件用 stco/co64；分片文件没有 stco，用各 run 的数据起点
      chunkOffsets: t.stblChunkOffsets.length ? t.stblChunkOffsets : t.runOffsets,
      stss: !!t.hasStss,
      syncSamples,
      allSync: syncSamples.length === t.samples.length,
      fragments: t.fragments.map((f) => ({ tfdt: f.tfdt, dataStart: f.dataStart, sampleCount: f.sampleCount }))
    }
  })

  return {
    size: buf.length,
    boxes: parsed.boxes.map((b) => ({ type: b.type, offset: b.offset, size: b.size })),
    hasMoov: !!parsed.moov,
    hasMdat: mdatAt >= 0,
    moovBeforeMdat: moovAt >= 0 && mdatAt >= 0 && moovAt < mdatAt,
    mdatBytes,
    moofCount: parsed.boxes.filter((b) => b.type === 'moof').length,
    tracks
  }
}

/**
 * 把两路 DASH 分片 MP4 remux 成一个通用（渐进式）MP4 文件。audioPath 可省略。
 * 返回 { bytes, videoSamples, audioSamples, durationMs, outPath }。
 */
export async function remuxDashToMp4({ videoPath, audioPath, outPath }) {
  if (!videoPath) throw new Error('remuxDashToMp4：缺少 videoPath')
  if (!outPath) throw new Error('remuxDashToMp4：缺少 outPath')

  const videoBuf = await fsp.readFile(videoPath)
  const video = parseInput(videoBuf, '视频')
  const videoTrack = pickTrack(video, 'video')
  if (!videoTrack) throw new Error('视频：没有可用轨道')

  let audioBuf = null
  let audio = null
  let audioTrack = null
  if (audioPath) {
    audioBuf = await fsp.readFile(audioPath)
    audio = parseInput(audioBuf, '音频')
    audioTrack = pickTrack(audio, 'audio')
    if (!audioTrack) throw new Error('音频：没有可用轨道')
  }

  const vidSamples = videoTrack.samples
  const audSamples = audioTrack ? audioTrack.samples : []
  const videoData = collectSampleData(videoBuf, vidSamples, '视频')
  const audioData = audioBuf ? collectSampleData(audioBuf, audSamples, '音频') : Buffer.alloc(0)

  const movieTimescale = readMvhdTimescale(child(videoBuf, video.moov, 'mvhd'))
  const vidSeconds = sumDurations(vidSamples) / (videoTrack.timescale || 1)
  const audSeconds = audioTrack ? sumDurations(audSamples) / (audioTrack.timescale || 1) : 0
  const movieDuration = Math.round(Math.max(vidSeconds, audSeconds) * movieTimescale)

  // 音频轨的 track_ID 不能和视频轨撞号
  const videoTrackId = videoTrack.trackId || 1
  const audioTrackId = audioTrack ? audioTrack.trackId || 2 : 0
  const newAudioTrackId = audioTrack && audioTrackId === videoTrackId ? Math.max(videoTrackId, audioTrackId) + 1 : audioTrackId

  const ftyp = buildFtyp(videoTrack.entryType)
  const mdatHeaderSize = videoData.length + audioData.length + 8 > 0xffffffff ? 16 : 8

  // moov 的长度取决于 chunk 偏移（stco 4 字节 / co64 8 字节），先占位算一次再回填
  const buildWith = (videoChunkOffset, audioChunkOffset) => {
    const specs = [{ track: videoTrack, chunkOffset: videoChunkOffset, newTrackId: videoTrackId }]
    if (audioTrack) specs.push({ track: audioTrack, chunkOffset: audioChunkOffset, newTrackId: newAudioTrackId })
    return buildMoov(videoBuf, video.moov, movieTimescale, movieDuration, specs)
  }
  let moov = buildWith(0, videoData.length)
  const mdatDataStart = ftyp.length + moov.length + mdatHeaderSize
  moov = buildWith(mdatDataStart, mdatDataStart + videoData.length)
  const mdatDataStart2 = ftyp.length + moov.length + mdatHeaderSize
  if (mdatDataStart2 !== mdatDataStart) {
    // 偏移位数变化（stco↔co64）会改变 moov 长度，再算一轮收敛
    moov = buildWith(mdatDataStart2, mdatDataStart2 + videoData.length)
  }
  const videoChunkOffset = ftyp.length + moov.length + mdatHeaderSize
  const audioChunkOffset = videoChunkOffset + videoData.length

  const mdat = cat([
    mdatHeaderSize === 16
      ? cat([u32(1), Buffer.from('mdat', 'latin1'), u64(videoData.length + audioData.length + 16)])
      : cat([u32(videoData.length + audioData.length + 8), Buffer.from('mdat', 'latin1')]),
    videoData,
    audioData
  ])
  const out = cat([ftyp, moov, mdat])
  await fsp.writeFile(outPath, out)

  // 落盘后自检一次，保证写出去的 stco/co64 真的指向 mdat 里的数据
  if (videoChunkOffset + videoData.length + audioData.length > out.length) {
    throw new Error('内部错误：计算出的 chunk 偏移越出了输出文件')
  }

  return {
    bytes: out.length,
    outPath,
    videoSamples: vidSamples.length,
    audioSamples: audSamples.length,
    durationMs: Math.max(1, Math.round(Math.max(vidSeconds, audSeconds) * 1000))
  }
}

export default { remuxDashToMp4, inspectMp4 }
