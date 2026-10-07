// fMP4(DASH) → 通用 MP4 remux 的自检脚本（不联网、不依赖真实 B 站文件、不需要 Electron）。
//   node tools/check-remux.mjs          正常跑，末尾自动删掉 tmp-remux-test
//   node tools/check-remux.mjs --keep   保留 tmp-remux-test 方便对着字节看
//
// 测试夹具是这里手工拼出来的合成 fMP4：ftyp + moov(空 stbl + mvex/trex) + 若干 (styp/free/moof/mdat)，
// 覆盖 trun 显式采样表、tfhd 默认值 + default-base-is-moof、trun 不带 data_offset、
// 非零 tfdt、co64（渐进式输入 + >32 位偏移）、version 1 有符号合成偏移。
//
// 约定说明：
//   * trun 的字段顺序按 ISO/IEC 14496-12 §8.8.8.1：
//       version/flags → sample_count → [data_offset] → [first_sample_flags] → 逐采样字段
//     sample_count 在最前面，不是可选字段。这里写错一个字段，解析侧就会整体错位。
//   * tfhd 的字段顺序是 track_ID → [base_data_offset] → [sample_description_index]
//       → [default_sample_duration] → [default_sample_size] → [default_sample_flags]。
//   * trun 的 data_offset 相对 base：default-base-is-moof 时 base = moof 起点，
//     否则 base = tfhd 的 base_data_offset（没有就还是 moof 起点）。
//   * stss 里的采样序号是 1-based（规范如此）。
//   * 「某轨占用的 mdat 字节数」= 该轨采样在 mdat 里连续占用的总长度（本模块单 chunk 顺序排列）。

import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { remuxDashToMp4, inspectMp4 } from '../src/main/mp4/remux.js'

// ---------------------------------------------------------------- 断言框架

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    console.log(`FAIL ${label} :: ${detail === undefined ? '（无诊断）' : JSON.stringify(detail)}`)
  }
}
function eq(label, actual, expected) {
  check(label, actual === expected, { actual, expected })
}
/** 断言会抛错（并且错误信息里含 need） */
function throws(label, fn, need) {
  try {
    fn()
    check(label, false, '本该抛错却成功了')
  } catch (e) {
    const msg = String((e && e.message) || e)
    check(label, !need || msg.includes(need), { message: msg, need })
  }
}
/** 断言 promise 会 reject（并且错误信息里含 need） */
async function rejects(label, fn, need) {
  try {
    const v = await fn()
    check(label, false, { resolved: String(v && v.message ? v.message : v) })
  } catch (e) {
    const msg = String((e && e.message) || e)
    check(label, !need || msg.includes(need), { message: msg, need })
  }
}

const outDir = path.resolve('tmp-remux-test')
fs.mkdirSync(outDir, { recursive: true })
const T = (name) => path.join(outDir, name)

// 无论正常结束还是中途抛错，都在退出时清掉临时目录（--keep 可跳过）
const KEEP = process.argv.includes('--keep')
process.on('exit', () => {
  if (KEEP) {
    console.log(`（--keep）保留测试目录：${outDir}`)
    return
  }
  try {
    fs.rmSync(outDir, { recursive: true, force: true })
    console.log(`已清理测试目录：${outDir}`)
  } catch (e) {
    console.log(`清理测试目录失败：${e && e.message ? e.message : e}`)
  }
})

// ---------------------------------------------------------------- box 拼装 helper

const u32 = (v) => {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32BE(v >>> 0, 0)
  return b
}
const u64 = (v) => {
  const b = Buffer.allocUnsafe(8)
  b.writeBigUInt64BE(BigInt(v), 0)
  return b
}
const cat = (list) => Buffer.concat(list.filter((x) => x && x.length))
/** 普通 box: size + type + children */
const box = (type, ...kids) => {
  const body = cat(kids)
  return cat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}
/** full box: size + type + version/flags + body */
const fbox = (type, ver, flags, ...kids) => {
  const body = cat(kids)
  const h = Buffer.alloc(4)
  h.writeUInt32BE(((ver & 0xff) << 24) | (flags & 0xffffff), 0)
  return cat([u32(body.length + 12), Buffer.from(type, 'latin1'), h, body])
}
const desc = (tag, payload) => cat([Buffer.from([tag]), Buffer.from([payload.length & 0x7f]), payload])

/** 假 avc1 sample entry（带一个能用的 avcC） */
function avc1Entry() {
  const avcC = box(
    'avcC',
    Buffer.from([1, 0x64, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1e, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80])
  )
  return box(
    'avc1',
    Buffer.alloc(6),
    Buffer.from([0, 1]), // data_reference_index
    Buffer.alloc(16),
    Buffer.from([0x05, 0x00]), // width 1280
    Buffer.from([0x02, 0xd0]), // height 720
    u32(0x00480000), // horizresolution
    u32(0x00480000), // vertresolution
    u32(0),
    Buffer.from([0, 1]), // frame_count
    Buffer.alloc(32),
    Buffer.from([0x00, 0x18]), // depth
    Buffer.from([0xff, 0xff]), // pre_defined
    avcC
  )
}

/** 假 mp4a sample entry（带一个能用的 esds） */
function mp4aEntry() {
  const asc = Buffer.from([0x12, 0x10]) // AAC-LC 44.1k 立体声
  const dsi = desc(0x05, asc)
  const dcd = desc(0x04, cat([Buffer.from([0x40, 0x15]), u32(0), u32(0), dsi]))
  const sl = desc(0x06, Buffer.from([0x02]))
  const es = desc(0x03, cat([Buffer.from([0x00, 0x01, 0x00]), sl, dcd]))
  const esds = fbox('esds', 0, 0, es)
  return box(
    'mp4a',
    Buffer.alloc(6),
    Buffer.from([0, 1]),
    Buffer.alloc(8), // version/revision/vendor
    Buffer.from([0, 2]), // channelcount
    Buffer.from([0, 16]), // samplesize
    Buffer.from([0, 0]),
    Buffer.from([0, 0]),
    u32(44100 << 16), // samplerate
    esds
  )
}

/** 空的采样表（stts/stsc/stsz/stco 都合法但为空，stss 不写） */
function emptyStbl(entry) {
  const stsd = fbox('stsd', 0, 0, u32(1), entry)
  const stts = fbox('stts', 0, 0, u32(0))
  const stsc = fbox('stsc', 0, 0, u32(0))
  const stsz = fbox('stsz', 0, 0, u32(0), u32(0))
  const stco = fbox('stco', 0, 0, u32(0))
  return box('stbl', stsd, stts, stsc, stsz, stco)
}

/** 带真实采样表的 stbl（渐进式输入用）；asCo64 决定写 co64 还是 stco */
function filledStbl(entry, samples, chunkOffset, asCo64) {
  const stsd = fbox('stsd', 0, 0, u32(1), entry)
  const stts = fbox('stts', 0, 0, u32(1), u32(samples.length), u32(samples[0].duration))
  const stsc = fbox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1))
  const stsz = fbox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.size)))
  const off = asCo64 ? fbox('co64', 0, 0, u32(1), u64(chunkOffset)) : fbox('stco', 0, 0, u32(1), u32(chunkOffset))
  return box('stbl', stsd, stts, stsc, stsz, off)
}

function hdlrBox(kind) {
  return fbox('hdlr', 0, 0, u32(0), Buffer.from(kind, 'latin1'), Buffer.alloc(12), Buffer.from([0]))
}

/**
 * 造一个 trak。tkhd 用 version 0（duration 在 payload offset 20），mdhd 用 version 0（duration 在 payload offset 16）。
 * stsd 直接写进输出，remux 会原样拷贝它。stbl 不给就写一个空的采样表（init 段用）。
 */
function trackBox({ trackId, kind, timescale, entry, width, height, stbl = null, duration = 0 }) {
  const tkhd = fbox(
    'tkhd', 0, 7,
    u32(0), u32(0), u32(trackId), u32(0), u32(0),
    Buffer.alloc(8), // reserved
    Buffer.from([0, 0]), Buffer.from([0, 0]), Buffer.from([0, 0]), Buffer.from([0, 0]), // layer/altgroup/volume/reserved
    u32(0x00010000), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), // matrix
    u32((width || 0) << 16), u32((height || 0) << 16)
  )
  const mdhd = fbox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), Buffer.from([0x55, 0xc4]), Buffer.from([0, 0]))
  const hdlr = hdlrBox(kind === 'video' ? 'vide' : 'soun')
  const dinf = box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1)))
  const media = kind === 'video'
    ? fbox('vmhd', 0, 1, u32(0), u32(0), u32(0), u32(0))
    : fbox('smhd', 0, 0, u32(0), u32(0))
  const minf = box('minf', media, dinf, stbl || emptyStbl(entry))
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf))
}

function mvhdBox(duration) {
  return fbox(
    'mvhd', 0, 0,
    u32(0), u32(0), u32(1000), u32(duration), // creation / modification / timescale / duration
    u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
    Buffer.alloc(24), u32(2)
  )
}

const FTYP = box('ftyp', Buffer.from('dash', 'latin1'), u32(0x200), Buffer.from('dashiso6mp41', 'latin1'))

/** init segment：ftyp + moov(mvhd + trak + mvex(trex)) */
function makeInit({ trackId, kind, timescale, entry, width, height, defDuration, defSize, defFlags }) {
  const trex = fbox('trex', 0, 0, u32(trackId), u32(1), u32(defDuration), u32(defSize), u32(defFlags))
  const moov = box('moov', mvhdBox(0), trackBox({ trackId, kind, timescale, entry, width, height }), box('mvex', trex))
  return cat([FTYP, moov])
}

/**
 * 渐进式（非分片）输入：ftyp + moov(带真实采样表) + mdat。
 * 返回 { file, dataOffset, chunkOffsetUsed }；co64Value 非空时用指定的 co64 值（可以故意写到 4GiB 以上，
 * 这时文件里并没有那段数据——只用来验证解析侧不会把 64 位偏移截断）。
 */
function makeProgressive({ trackId, kind, timescale, entry, width, height, samples, asCo64 = false, co64Value = null }) {
  const payloadLen = samples.reduce((a, s) => a + s.size, 0)
  const duration = samples.reduce((a, s) => a + s.duration, 0)
  const build = (chunkOffset) => box(
    'moov',
    mvhdBox(Math.round((duration / timescale) * 1000)),
    trackBox({
      trackId, kind, timescale, entry, width, height, duration,
      stbl: filledStbl(entry, samples, chunkOffset, asCo64)
    })
  )
  // moov 长度与偏移数值无关（co64 固定 8 字节），先占位算一次就够
  const probe = build(0)
  const dataOffset = FTYP.length + probe.length + 8
  const useOffset = co64Value === null ? dataOffset : co64Value
  const moov = build(useOffset)
  if (moov.length !== probe.length) throw new Error('夹具自身有问题：moov 长度随 chunk_offset 变化')
  const mdat = cat([u32(payloadLen + 8), Buffer.from('mdat', 'latin1'), ...samples.map((s) => s.data)])
  return { file: cat([FTYP, moov, mdat]), dataOffset, chunkOffsetUsed: useOffset }
}

const F_SAMPLE_DURATION = 0x000100
const F_SAMPLE_SIZE = 0x000200
const F_SAMPLE_FLAGS = 0x000400
const F_SAMPLE_CTS = 0x000800
const F_FIRST_SAMPLE_FLAGS = 0x000004
const F_DATA_OFFSET = 0x000001
const TF_BASE_DATA_OFFSET = 0x000001
const TF_DEFAULT_BASE_IS_MOOF = 0x020000
const TF_DEFAULT_DURATION = 0x000008
const TF_DEFAULT_SIZE = 0x000010
const SYNC = 0x02000000 // sample_depends_on=2 / non_sync=0
const NON_SYNC = 0x01010000 // non_sync=1

/**
 * 造一个媒体分片：styp + 可选 free + moof(+ 可选 senc) + 可选 gap + mdat。
 * trun 里的 data_offset 按真实文件位置算好（这正是被测代码要还原的东西）。
 */
function makeFragment(opts) {
  const {
    trackId, seq, samples, tfdt = 0,
    baseDataOffset = null, // 非 null → tfhd 带 base_data_offset，trun 的 data_offset 相对它
    defaultBaseIsMoof = false, // true → tfhd 带 0x020000，trun 的 data_offset 相对 moof 起点
    defaults = null, // { duration, size } → tfhd 带默认值，trun 不再逐采样给 size/duration
    trunFlags = F_DATA_OFFSET | F_SAMPLE_DURATION | F_SAMPLE_SIZE | F_SAMPLE_FLAGS,
    version = 0,
    freeBytes = 0,
    gapBytes = 0,
    withStyp = true,
    senc = false
  } = opts

  const tfhdFlags =
    (baseDataOffset !== null ? TF_BASE_DATA_OFFSET : 0) |
    (defaultBaseIsMoof ? TF_DEFAULT_BASE_IS_MOOF : 0) |
    (defaults ? TF_DEFAULT_DURATION | TF_DEFAULT_SIZE : 0)
  const tfhdParts = [u32(trackId)]
  if (baseDataOffset !== null) tfhdParts.push(u64(baseDataOffset))
  if (defaults) tfhdParts.push(u32(defaults.duration), u32(defaults.size))

  const buf32 = (v) => {
    // trun 的 data_offset 是 int32
    const b = Buffer.allocUnsafe(4)
    b.writeInt32BE(v | 0, 0)
    return b
  }

  const buildMoof = (dataOffset) => {
    // ISO/IEC 14496-12 §8.8.8.1：sample_count 在最前，之后才是可选的 data_offset / first_sample_flags
    const parts = [u32(samples.length)]
    if (trunFlags & F_DATA_OFFSET) parts.push(buf32(dataOffset))
    if (trunFlags & F_FIRST_SAMPLE_FLAGS) parts.push(u32(samples[0].flags))
    for (const s of samples) {
      if (trunFlags & F_SAMPLE_DURATION) parts.push(u32(s.duration))
      if (trunFlags & F_SAMPLE_SIZE) parts.push(u32(s.size))
      if (trunFlags & F_SAMPLE_FLAGS) parts.push(u32(s.flags))
      if (trunFlags & F_SAMPLE_CTS) parts.push(u32(s.cts | 0))
    }
    const trun = fbox('trun', version, trunFlags, cat(parts))
    const tfdtBox = fbox('tfdt', 1, 0, u64(tfdt))
    const trafKids = [fbox('tfhd', 0, tfhdFlags, cat(tfhdParts)), tfdtBox, trun]
    if (senc) trafKids.push(fbox('senc', 0, 0, u32(samples.length)))
    return box('moof', fbox('mfhd', 0, 0, u32(seq)), box('traf', ...trafKids))
  }

  const styp = withStyp ? box('styp', Buffer.from('msdh', 'latin1'), u32(0), Buffer.from('msdhmsix', 'latin1')) : Buffer.alloc(0)
  const free = freeBytes ? box('free', Buffer.alloc(freeBytes)) : Buffer.alloc(0)
  const payloadLen = samples.reduce((a, s) => a + s.size, 0)
  const mdatHeader = payloadLen + 8 > 0xffffffff ? 16 : 8

  // 先造一次拿 moof 长度（delta 与 dataOffset 数值无关）
  const probe = buildMoof(0)
  const prefixLen = styp.length + free.length
  const moofStart = prefixLen
  const mdatStart = moofStart + probe.length + gapBytes
  const dataStart = mdatStart + mdatHeader
  // 目标语义：base + data_offset === 采样数据第一字节
  const base = defaultBaseIsMoof ? moofStart : baseDataOffset !== null ? baseDataOffset : moofStart
  const delta = dataStart - base
  const moof = buildMoof(delta)
  if (moof.length !== probe.length) throw new Error('夹具自身有问题：moof 长度随 data_offset 变化')
  const mdat = cat([u32(payloadLen + mdatHeader), Buffer.from('mdat', 'latin1'), ...samples.map((s) => s.data)])

  // 自检：算出来的 data_offset 必须真的指向 mdat 数据区
  const sampleStart = base + delta
  if (sampleStart !== dataStart) throw new Error(`夹具自身有问题：数据起点算错 ${sampleStart} !== ${dataStart}`)

  return cat([styp, free, moof, Buffer.alloc(gapBytes), mdat])
}

/** 合成一个完整输入文件：init + 各分片 */
function makeInput(init, fragments, trailer) {
  return cat([init, ...fragments, trailer || Buffer.alloc(0)])
}

// ---------------------------------------------------------------- 夹具参数

const VIDEO_TS = 90000
const AUDIO_TS = 48000
const VID_ENTRY = avc1Entry()
const AUD_ENTRY = mp4aEntry()

// 分片 1：每采样显式 duration/size/flags/cts，第 1/4/7/10 个（1-based）是同步帧
function videoSamplesA() {
  const list = []
  for (let i = 0; i < 10; i++) {
    const sync = i === 0 || i === 3 || i === 6 || i === 9
    list.push({
      duration: 3000,
      size: 100 + i * 7,
      flags: sync ? SYNC : NON_SYNC,
      cts: 0,
      data: Buffer.alloc(100 + i * 7, 0xa0 + i)
    })
  }
  return list
}

// 分片 2：6 个采样，时长/大小走 tfhd 默认值，只有 flags 逐采样给（第 1 个是同步帧 → 总体第 11 个）
function videoSamplesB() {
  const list = []
  for (let i = 0; i < 6; i++) {
    list.push({ duration: 3000, size: 150, flags: i === 0 ? SYNC : NON_SYNC, cts: 0, data: Buffer.alloc(150, 0xb0 + i) })
  }
  return list
}

// 分片 3：version 1 有符号合成偏移（含负值），第 1 个是同步帧（总体第 17 个）
function videoSamplesC() {
  return [
    { duration: 3000, size: 200, flags: SYNC, cts: 0, data: Buffer.alloc(200, 0xd0) },
    { duration: 3000, size: 200, flags: NON_SYNC, cts: -6000, data: Buffer.alloc(200, 0xd1) },
    { duration: 3000, size: 200, flags: NON_SYNC, cts: 3000, data: Buffer.alloc(200, 0xd2) },
    { duration: 3000, size: 200, flags: NON_SYNC, cts: -9000, data: Buffer.alloc(200, 0xd3) }
  ]
}

function audioSamples() {
  const list = []
  for (let i = 0; i < 12; i++) {
    list.push({ duration: 1024, size: 100 + i * 5, flags: SYNC, cts: 0, data: Buffer.alloc(100 + i * 5, 0xc0 + i) })
  }
  return list
}

// 采样表：init 里是空的，值都写在 trun 里
const videoInit = makeInit({
  trackId: 1, kind: 'video', timescale: VIDEO_TS, entry: VID_ENTRY, width: 1280, height: 720,
  defDuration: 3000, defSize: 150, defFlags: 0
})
const audioInit = makeInit({
  trackId: 2, kind: 'audio', timescale: AUDIO_TS, entry: AUD_ENTRY,
  defDuration: 1024, defSize: 128, defFlags: 0
})

// 视频：分片 1（每采样显式 duration/size/flags/cts，trun 的 data_offset 相对 moof 起点，前面有 styp）
//       分片 2（default-base-is-moof + tfhd 默认 duration/size，trun 不带 data_offset，中间还隔一个 free）
//       分片 3（version 1 有符号合成偏移，含负值）
//       分片 2/3 的 tfdt 是接续上一段解码时间的非零值（真实分片就是这样）
const fragV1b = makeFragment({
  trackId: 1, seq: 1, samples: videoSamplesA(), tfdt: 0, withStyp: true,
  trunFlags: F_DATA_OFFSET | F_SAMPLE_DURATION | F_SAMPLE_SIZE | F_SAMPLE_FLAGS | F_SAMPLE_CTS
})
const fragV2 = makeFragment({
  trackId: 1, seq: 2, samples: videoSamplesB(), tfdt: 30000,
  defaultBaseIsMoof: true, defaults: { duration: 3000, size: 150 },
  trunFlags: F_FIRST_SAMPLE_FLAGS | F_SAMPLE_FLAGS, withStyp: false, freeBytes: 16
})
const fragV3 = makeFragment({
  trackId: 1, seq: 3, samples: videoSamplesC(), tfdt: 48000,
  defaultBaseIsMoof: true, version: 1,
  trunFlags: F_DATA_OFFSET | F_SAMPLE_DURATION | F_SAMPLE_SIZE | F_SAMPLE_FLAGS | F_SAMPLE_CTS,
  withStyp: true, freeBytes: 8
})

const videoPath = T('video.mp4')
fs.writeFileSync(videoPath, makeInput(videoInit, [fragV1b, fragV2, fragV3], box('free', Buffer.alloc(32))))

// 音频：1 个分片，12 个采样，走 default-base-is-moof
const fragA1 = makeFragment({
  trackId: 2, seq: 1, samples: audioSamples(), tfdt: 0,
  defaultBaseIsMoof: true, trunFlags: F_DATA_OFFSET | F_SAMPLE_DURATION | F_SAMPLE_SIZE, withStyp: true
})
const audioPath = T('audio.mp4')
fs.writeFileSync(audioPath, makeInput(audioInit, [fragA1]))

// co64 输入 1：普通的渐进式 MP4，但 chunk 偏移写在 co64 盒子里（真正能被 remux）
const progressive = makeProgressive({
  trackId: 1, kind: 'video', timescale: VIDEO_TS, entry: VID_ENTRY, width: 1280, height: 720,
  samples: videoSamplesA().slice(0, 4), asCo64: true
})
const co64InPath = T('co64-in.mp4')
fs.writeFileSync(co64InPath, progressive.file)

// co64 输入 2：co64 里写一个 > 32 位的偏移（文件里当然没有那段数据，只用 inspectMp4 验证不截断）
const CO64_HUGE = 0x1_0000_1000
const progressiveHuge = makeProgressive({
  trackId: 1, kind: 'video', timescale: VIDEO_TS, entry: VID_ENTRY, width: 1280, height: 720,
  samples: videoSamplesA().slice(0, 4), asCo64: true, co64Value: CO64_HUGE
})
const co64HugePath = T('co64-huge.mp4')
fs.writeFileSync(co64HugePath, progressiveHuge.file)

// 加密流：traf 里带 senc（DRM）——应该被 remux 明确拒绝
const fragEnc = makeFragment({
  trackId: 1, seq: 1, samples: videoSamplesA().slice(0, 2), tfdt: 0,
  defaultBaseIsMoof: true, senc: true, withStyp: false
})
const encPath = T('enc.mp4')
fs.writeFileSync(encPath, makeInput(videoInit, [fragEnc]))

// ---------------------------------------------------------------- 夹具自检

const EXPECTED_VIDEO_SAMPLES = [...videoSamplesA(), ...videoSamplesB(), ...videoSamplesC()]
const EXPECTED_AUDIO_SAMPLES = audioSamples()

{
  const v = inspectMp4(fs.readFileSync(videoPath))
  eq('夹具：视频输入解析出 1 个 trak', v.tracks.length, 1)
  eq('夹具：视频输入 sampleCount = 20（10+6+4 三个分片）', v.tracks[0].sampleCount, 20)
  eq('夹具：视频输入 syncSamples = [1,4,7,10,11,17]', JSON.stringify(v.tracks[0].syncSamples), JSON.stringify([1, 4, 7, 10, 11, 17]))
  check('夹具：视频输入 chunkOffsets 都落在文件内', v.tracks[0].chunkOffsets.every((o) => o > 0 && o < v.size), v.tracks[0].chunkOffsets)
  eq(
    '夹具：视频输入三个分片的 tfdt = [0, 30000, 48000]（非零 tfdt 也要读对）',
    JSON.stringify(v.tracks[0].fragments.map((f) => f.tfdt)),
    JSON.stringify([0, 30000, 48000])
  )
  eq(
    '夹具：视频输入三个分片的采样数 = [10, 6, 4]',
    JSON.stringify(v.tracks[0].fragments.map((f) => f.sampleCount)),
    JSON.stringify([10, 6, 4])
  )
  eq('夹具：视频输入逐采样时长全为 3000', v.tracks[0].durations.every((d) => d === 3000), true)
  // 每个采样都必须落在某个 mdat 的数据区里（夹具的 data_offset/base 真的算对了）
  const mdatRanges = v.boxes.filter((b) => b.type === 'mdat').map((b) => [b.offset + 8, b.offset + b.size])
  const t = v.tracks[0]
  const allInside = t.sampleOffsets.every((o, i) => mdatRanges.some(([s, e]) => o >= s && o + t.sampleSizes[i] <= e))
  check('夹具：视频输入每个采样都落在某个 mdat 数据区内', allInside, { mdats: mdatRanges, sampleOffsets: t.sampleOffsets })
  eq(
    '夹具：视频输入采样字节合计 = 源数据字节数',
    t.sampleSizes.reduce((a, b) => a + b, 0),
    EXPECTED_VIDEO_SAMPLES.reduce((a, s) => a + s.size, 0)
  )
}

{
  const raw = fs.readFileSync(co64InPath)
  const moovText = raw.subarray(0, raw.indexOf(Buffer.from('mdat', 'latin1'))).toString('latin1')
  check('夹具：co64 输入的 moov 里用的是 co64 盒子（没有 stco）', moovText.includes('co64') && !moovText.includes('stco'), true)
  const c = inspectMp4(raw)
  eq('夹具：co64 输入解析出 4 个采样', c.tracks[0].sampleCount, 4)
  eq('夹具：co64 输入的 chunkOffsets[0] = mdat 数据起点', c.tracks[0].chunkOffsets[0], progressive.chunkOffsetUsed)
  const h = inspectMp4(fs.readFileSync(co64HugePath))
  check(
    '夹具：> 32 位的 co64 偏移不被截断（确实走了 co64 分支）',
    h.tracks[0].chunkOffsets[0] === CO64_HUGE && h.tracks[0].chunkOffsets[0] > 0xffffffff,
    { actual: h.tracks[0].chunkOffsets, expected: CO64_HUGE }
  )
  eq('夹具：> 32 位 co64 输入也解析出 4 个采样', h.tracks[0].sampleCount, 4)
}

// ---------------------------------------------------------------- 主用例：视频 20 采样 + 音频 12 采样

let r1 = null
let o1 = null
try {
  r1 = await remuxDashToMp4({ videoPath, audioPath, outPath: T('out.mp4') })
  o1 = inspectMp4(fs.readFileSync(T('out.mp4')))
  check('remux 视频+音频：不抛错', true)
} catch (e) {
  check('remux 视频+音频：不抛错', false, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e))
}

if (r1 && o1) {
  const [vid, aud] = o1.tracks
  const mdatBytes = o1.mdatBytes
  const outBuf = fs.readFileSync(T('out.mp4'))
  const vidBytes = vid.sampleSizes.reduce((a, b) => a + b, 0)
  const audBytes = aud.sampleSizes.reduce((a, b) => a + b, 0)
  const expectedVid = EXPECTED_VIDEO_SAMPLES.reduce((a, s) => a + s.size, 0)
  const expectedAud = EXPECTED_AUDIO_SAMPLES.reduce((a, s) => a + s.size, 0)

  eq('返回值 videoSamples = 20（三个分片的采样都要写进去）', r1.videoSamples, 20)
  eq('返回值 audioSamples = 12', r1.audioSamples, 12)
  eq('返回值 bytes = 落盘文件大小', r1.bytes, fs.statSync(T('out.mp4')).size)
  check('返回值 durationMs > 0', r1.durationMs > 0, { durationMs: r1.durationMs })

  eq('输出 moovBeforeMdat === true', o1.moovBeforeMdat, true)
  eq('输出 hasMoov === true', o1.hasMoov, true)
  eq('输出有 ftyp/moov/mdat 三个顶层 box', o1.boxes.map((b) => b.type).join(','), 'ftyp,moov,mdat')
  eq(
    '输出 moov 在 mdat 之前',
    o1.boxes.findIndex((b) => b.type === 'moov') < o1.boxes.findIndex((b) => b.type === 'mdat'),
    true
  )
  eq('输出 moov 里没有分片用的 mvex', outBuf.toString('latin1').includes('mvex'), false)

  eq('输出轨数 = 2', o1.tracks.length, 2)
  eq('视频轨采样数 = 20', vid.sampleCount, 20)
  eq('音频轨采样数 = 12', aud.sampleCount, 12)
  eq('视频轨 type=video', vid.type, 'video')
  eq('音频轨 type=audio', aud.type, 'audio')
  eq('视频轨 timescale 与输入一致 (90000)', vid.timescale, VIDEO_TS)
  eq('音频轨 timescale 与输入一致 (48000)', aud.timescale, AUDIO_TS)
  eq('视频轨 codec 串来自拷贝的 avcC', vid.codec, 'avc1.64001E')
  check('音频轨 codec 串来自拷贝的 esds', String(aud.codec).startsWith('mp4a.40'), { codec: aud.codec })

  // stss 是 1-based，见文件头约定
  eq('视频轨 syncSamples = [1,4,7,10,11,17]（1-based）', JSON.stringify(vid.syncSamples), JSON.stringify([1, 4, 7, 10, 11, 17]))
  eq('音频轨没写 stss（全部采样都是同步帧）', aud.syncSamples.length, 12)
  eq('视频轨 durations 全为 3000（分片 2 走 tfhd 默认值）', vid.durations.every((d) => d === 3000), true)
  eq('视频轨 durations 条数 = 采样数', vid.durations.length, 20)
  eq('音频轨 durations 全为 1024', aud.durations.every((d) => d === 1024), true)

  eq('视频轨 sampleSizes 合计 = 源数据字节数', vidBytes, expectedVid)
  eq('音频轨 sampleSizes 合计 = 源数据字节数', audBytes, expectedAud)
  eq('两轨字节合计 = mdat 数据区字节数', vidBytes + audBytes, mdatBytes)

  // 采样字节必须一模一样：把输出 mdat 数据区和「输入各分片采样按顺序拼接」对比
  {
    const mdatBox = o1.boxes.find((b) => b.type === 'mdat')
    const outData = outBuf.subarray(mdatBox.offset + 8, mdatBox.offset + mdatBox.size)
    const expectedData = Buffer.concat([
      ...EXPECTED_VIDEO_SAMPLES.map((s) => s.data),
      ...EXPECTED_AUDIO_SAMPLES.map((s) => s.data)
    ])
    eq('输出 mdat 数据区 = 输入采样按顺序拼接的字节（视频整段在前、音频整段在后）', outData.equals(expectedData), true)
  }

  // 顺序：视频整段在前，音频整段在后 → 音频 chunk 起点 = 视频 chunk 起点 + 视频总字节
  eq('音频 chunkOffsets[0] = 视频 chunkOffsets[0] + 视频字节数', aud.chunkOffsets[0], vid.chunkOffsets[0] + vidBytes)

  const mdatStart = o1.boxes.find((b) => b.type === 'mdat').offset
  for (const [name, t] of [['视频', vid], ['音频', aud]]) {
    const total = t.sampleSizes.reduce((a, b) => a + b, 0)
    const off = t.chunkOffsets[0]
    eq(`${name}轨只有一个 chunk`, t.chunkOffsets.length, 1)
    check(`${name}轨 chunkOffsets[0] 落在 [0, fileSize)`, off >= 0 && off < o1.size, { off, fileSize: o1.size })
    check(`${name}轨采样累加不越出文件`, off + total <= o1.size, { off, total, fileSize: o1.size })
    check(`${name}轨数据整体落在 mdat 数据区内`, off >= mdatStart && off + total <= o1.size, { off, total, mdatStart })
  }

  // 采样表结构
  const moovArea = outBuf.subarray(o1.boxes.find((b) => b.type === 'moov').offset, mdatStart)
  const moovText = moovArea.toString('latin1')
  eq('输出有 stsc', moovText.includes('stsc'), true)
  eq('输出有 stsz', moovText.includes('stsz'), true)
  eq('输出有 stts', moovText.includes('stts'), true)
  eq('输出写了 stss（视频有非同步帧）', moovText.includes('stss'), true)
  check('输出含 stco 或 co64', moovText.includes('stco') || moovText.includes('co64'), true)
  eq('输出写了 ctts（合成偏移不全为 0）', moovText.includes('ctts'), true)
} else {
  check('输出结构断言（因 remux 失败跳过）', false, '未拿到 remux 结果')
}

// ---------------------------------------------------------------- 负值合成偏移（version 1 有符号）

if (o1) {
  const rawOut = fs.readFileSync(T('out.mp4'))
  const moovAt = rawOut.indexOf(Buffer.from('moov', 'latin1')) - 4
  const cttsAt = rawOut.indexOf(Buffer.from('ctts', 'latin1'), moovAt)
  if (cttsAt < 0) {
    check('ctts 是 version 1 且合成偏移可读出', false, '没找到 ctts')
  } else {
    const payload = cttsAt + 4 // 指向 version/flags
    const version = rawOut[payload]
    const entryCount = rawOut.readUInt32BE(payload + 4)
    const runs = []
    let totalCount = 0
    for (let i = 0, at = payload + 8; i < entryCount; i++, at += 8) {
      const count = rawOut.readUInt32BE(at)
      const off = version === 1 ? rawOut.readInt32BE(at + 4) : rawOut.readUInt32BE(at + 4)
      totalCount += count
      runs.push({ count, off })
    }
    eq('ctts version = 1（有符号合成偏移）', version, 1)
    eq('ctts 条目覆盖全部 20 个采样', totalCount, 20)
    eq(
      'ctts 合成偏移序列原样保留 [0,-6000,3000,-9000]',
      JSON.stringify(runs.map((r) => r.off)),
      JSON.stringify([0, -6000, 3000, -9000])
    )
    check('ctts 里存在负的合成偏移（B 帧）', runs.some((r) => r.off < 0), { runs })
  }
} else {
  check('ctts 是 version 1 且合成偏移可读出（因 remux 失败跳过）', false, '未拿到 remux 结果')
}

// ---------------------------------------------------------------- co64 输入 → 输出可解析

try {
  const r4 = await remuxDashToMp4({ videoPath: co64InPath, outPath: T('out-co64.mp4') })
  const o4 = inspectMp4(fs.readFileSync(T('out-co64.mp4')))
  const t4 = o4.tracks[0]
  const bytes4 = t4.sampleSizes.reduce((a, b) => a + b, 0)
  eq('co64 输入 remux 成功：videoSamples = 4', r4.videoSamples, 4)
  eq('co64 输入 remux：moovBeforeMdat', o4.moovBeforeMdat, true)
  eq('co64 输入 remux：单轨 4 采样', t4.sampleCount, 4)
  eq('co64 输入 remux：codec 仍是 avc1.64001E', t4.codec, 'avc1.64001E')
  check('co64 输入 remux：chunkOffsets[0] 在文件内', t4.chunkOffsets[0] > 0 && t4.chunkOffsets[0] < o4.size, t4.chunkOffsets)
  check('co64 输入 remux：数据不越界', t4.chunkOffsets[0] + bytes4 <= o4.size, { off: t4.chunkOffsets[0], bytes4, size: o4.size })
} catch (e) {
  check('co64 输入 remux 成功', false, String(e && e.message ? e.message : e))
}

// ---------------------------------------------------------------- 无音频（audioPath 省略）

try {
  const r5 = await remuxDashToMp4({ videoPath, outPath: T('out-noaudio.mp4') })
  const o5 = inspectMp4(fs.readFileSync(T('out-noaudio.mp4')))
  eq('省略 audioPath：videoSamples = 20', r5.videoSamples, 20)
  eq('省略 audioPath：audioSamples = 0', r5.audioSamples, 0)
  eq('省略 audioPath：输出只有 1 个 trak', o5.tracks.length, 1)
  eq('省略 audioPath：输出 mdat 只有视频采样字节', o5.mdatBytes, EXPECTED_VIDEO_SAMPLES.reduce((a, s) => a + s.size, 0))
} catch (e) {
  check('省略 audioPath 的 remux', false, String(e && e.message ? e.message : e))
}

// ---------------------------------------------------------------- 加密流应该报中文错

await rejects(
  'senc 加密流被拒绝且错误信息含中文说明',
  () => remuxDashToMp4({ videoPath: encPath, outPath: T('out-enc.mp4') }),
  '加密'
)

// ---------------------------------------------------------------- 坏输入的错误信息

{
  const badPath = T('bad.mp4')
  fs.writeFileSync(badPath, Buffer.from('not an mp4 at all, just some bytes here'))
  await rejects(
    '非 fMP4 输入报错且信息含「moov」',
    () => remuxDashToMp4({ videoPath: badPath, outPath: T('out-bad.mp4') }),
    'moov'
  )
  throws('inspectMp4 对垃圾输入同样报错且信息含「moov」', () => inspectMp4(Buffer.from('not an mp4 at all')), 'moov')
}

{
  // 只有 init、没有分片 → 应该报「没有找到任何 moof」
  const initOnly = T('init-only.mp4')
  fs.writeFileSync(initOnly, videoInit)
  await rejects(
    '只有 init 没有分片 → 报错提到 moof',
    () => remuxDashToMp4({ videoPath: initOnly, outPath: T('out-initonly.mp4') }),
    'moof'
  )
}

// ---------------------------------------------------------------- 汇总

console.log('')
console.log(`${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exitCode = 1
