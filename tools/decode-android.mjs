#!/usr/bin/env node
/**
 * decode-android.mjs —— 纯 Node 实现的安卓二进制资源解码器（无需 java / aapt / jadx）
 *
 * 用途：APK 里的 AndroidManifest.xml 与 res/values 是 AXML / ARSC 二进制格式，
 * 本脚本把它们解码成可读内容，供 android/ 目录与文档使用。
 *
 * 输出：
 *   android/AndroidManifest.xml          解码后的清单（XML 文本）
 *   android/AndroidManifest.bin.xml      原始二进制清单（原样拷贝，保留二进制原始数据）
 *   android/res/values/strings.xml       默认配置下的字符串资源
 *   android/res/values/colors.xml        默认配置下的颜色资源
 *   android/res/values/styles.xml        默认配置下的 style 资源（仅名字与继承关系）
 *   android/res/values/dimens.xml        默认配置下的尺寸资源
 *   android/res/xml/*.xml                原样拷贝 res/xml 下的明文 XML
 *   android/res/mipmap-xxx/ic_launcher 图标资源
 *
 * 用法：node tools/decode-android.mjs [apkDir]   （默认 .work/unzipped）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.resolve(ROOT, process.argv[2] || '.work/unzipped')
const OUT = path.resolve(ROOT, 'android')

// ---------------------------------------------------------------- 二进制读取

class Buf {
  constructor(buf, pos = 0) {
    this.b = buf
    this.p = pos
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  u8() { return this.b[this.p++] }
  u16() { const v = this.view.getUint16(this.p, true); this.p += 2; return v }
  u32() { const v = this.view.getUint32(this.p, true); this.p += 4; return v }
  i32() { const v = this.view.getInt32(this.p, true); this.p += 4; return v }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v }
  skip(n) { this.p += n }
}

const CHUNK = {
  NULL: 0x0000,
  STRING_POOL: 0x0001,
  TABLE: 0x0002,
  XML: 0x0003,
  XML_START_NAMESPACE: 0x0100,
  XML_END_NAMESPACE: 0x0101,
  XML_START_ELEMENT: 0x0102,
  XML_END_ELEMENT: 0x0103,
  XML_CDATA: 0x0104,
  XML_RESOURCE_MAP: 0x0180,
  TABLE_PACKAGE: 0x0200,
  TABLE_TYPE: 0x0201,
  TABLE_TYPE_SPEC: 0x0202,
  TABLE_LIBRARY: 0x0203,
}

// -------------------------------------------------------------- 字符串池解码

const STRING_FLAG_UTF8 = 0x100

function decodeStringPool(buf) {
  const start = buf.p
  const type = buf.u16()
  const headerSize = buf.u16()
  const size = buf.u32()
  if (type !== CHUNK.STRING_POOL) throw new Error(`期望字符串池 chunk，得到 0x${type.toString(16)}`)
  const stringCount = buf.u32()
  const styleCount = buf.u32()
  const flags = buf.u32()
  const stringsStart = buf.u32()
  const stylesStart = buf.u32()

  const isUtf8 = (flags & STRING_FLAG_UTF8) !== 0
  const offsets = []
  for (let i = 0; i < stringCount; i++) offsets.push(buf.u32())

  const strings = []
  const base = start + stringsStart
  for (const off of offsets) {
    const p = new Buf(buf.b, base + off)
    if (isUtf8) {
      // utf16 长度（可能两字节），然后 utf8 字节数（可能两字节）
      let n = p.u8()
      if (n & 0x80) n = ((n & 0x7f) << 8) | p.u8()
      let m = p.u8()
      if (m & 0x80) m = ((m & 0x7f) << 8) | p.u8()
      strings.push(p.bytes(m).toString('utf8'))
    } else {
      let n = p.u16()
      if (n & 0x8000) n = ((n & 0x7fff) << 16) | p.u16()
      const chars = Buffer.from(p.bytes(n * 2))
      strings.push(chars.toString('utf16le'))
    }
  }
  buf.p = start + size
  return { strings, styles: styleCount, flags }
}

// --------------------------------------------------------------- ARSC 解析

const RES_STRING_POOL_TYPE = 0x0001

function parseResTable(buffer) {
  const buf = new Buf(buffer)
  const type = buf.u16()
  if (type !== CHUNK.TABLE) throw new Error('不是 resources.arsc')
  const headerSize = buf.u16()
  const size = buf.u32()
  const packageCount = buf.u32()

  const globalStrings = []
  const packages = []

  // 表头之后：全局字符串池 + 若干 package
  let p = headerSize
  while (p < size) {
    const chunkBuf = new Buf(buffer, p)
    const ctype = chunkBuf.u16()
    chunkBuf.u16()
    const csize = chunkBuf.u32()
    if (csize <= 0) break
    if (ctype === RES_STRING_POOL_TYPE) {
      const pool = decodeStringPool(new Buf(buffer, p))
      globalStrings.push(...pool.strings)
    } else if (ctype === CHUNK.TABLE_PACKAGE) {
      packages.push(parsePackage(buffer, p, globalStrings))
    }
    p += csize
  }
  return { globalStrings, packages }
}

function parseConfig(buffer, pos, size) {
  const cfg = { size, raw: buffer.subarray(pos, pos + size) }
  const b = new Buf(buffer, pos + 4)
  // 只关心 locale / density / sdk 等几个常用维度，够本任务使用
  const lang = buffer.subarray(pos + 8, pos + 10).toString('latin1').replace(/\0/g, '')
  const country = buffer.subarray(pos + 10, pos + 12).toString('latin1').replace(/\0/g, '')
  const orientation = buffer[pos + 12]
  const density = buffer.readUInt16LE(pos + 14)
  if (lang || country) cfg.locale = `${lang}${country ? '-' + country.toUpperCase() : ''}`
  if (density && density !== 0) cfg.density = density
  if (orientation === 1) cfg.orientation = 'port'
  if (orientation === 2) cfg.orientation = 'land'
  return cfg
}

function parsePackage(buffer, start, globalStrings) {
  const buf = new Buf(buffer, start)
  buf.u16() // type
  const headerSize = buf.u16()
  const size = buf.u32()
  const id = buf.u32()
  const nameBytes = buf.bytes(256)
  const name = Buffer.from(nameBytes).toString('utf16le').replace(/\0/g, '')
  const typeStringsOff = buf.u32()
  const lastPublicType = buf.u32()
  const keyStringsOff = buf.u32()
  buf.u32() // lastPublicKey
  // headerSize 可能是 288（含 typeIdOffset）
  const typePoolPos = start + typeStringsOff
  const keyPoolPos = start + keyStringsOff
  const typeStrings = typeStringsOff ? decodeStringPool(new Buf(buffer, typePoolPos)).strings : []
  const keyStrings = keyStringsOff ? decodeStringPool(new Buf(buffer, keyPoolPos)).strings : []

  const entries = new Map() // resId -> [{ config, value }]
  let p = start + headerSize
  const end = start + size
  while (p < end) {
    const cb = new Buf(buffer, p)
    const ctype = cb.u16()
    cb.u16()
    const csize = cb.u32()
    if (csize <= 0) break
    if (ctype === CHUNK.TABLE_TYPE) {
      const typeId = buffer[p + 8]
      const flags = buffer[p + 9]
      const entryCount = buffer.readUInt32LE(p + 12)
      const entriesStart = buffer.readUInt32LE(p + 16)
      const cfgSize = buffer.readUInt32LE(p + 20)
      const config = parseConfig(buffer, p + 20, cfgSize)
      const offsetsPos = p + 20 + cfgSize
      const isSparse = (flags & 0x01) !== 0 // FLAG_SPARSE
      const typeName = typeStrings[typeId - 1] || `type${typeId}`
      const entriesBase = p + entriesStart
      const list = []
      if (isSparse) {
        // sparse 表：每项 4 字节（idx u16, offset/4 u16）
        for (let i = 0; i < entryCount; i++) {
          const idx = buffer.readUInt16LE(offsetsPos + i * 4)
          const off = buffer.readUInt16LE(offsetsPos + i * 4 + 2) * 4
          list.push([idx, entriesBase + off])
        }
      } else {
        for (let i = 0; i < entryCount; i++) {
          const off = buffer.readUInt32LE(offsetsPos + i * 4)
          if (off === 0xffffffff) continue
          list.push([i, entriesBase + off])
        }
      }
      for (const [idx, epos] of list) {
        const eb = new Buf(buffer, epos)
        const esize = eb.u16()
        const eflags = eb.u16()
        const keyIdx = eb.u32()
        const key = keyStrings[keyIdx] || `key${keyIdx}`
        const resId = ((id & 0xff) << 24) | ((typeId & 0xff) << 16) | (idx & 0xffff)
        if (eflags & 0x0001) {
          // complex（bag/style/attr）：记录一条带条目的标记，供 style 输出使用
          entries.set(resId, { typeName, key, config, complex: true, value: null })
          continue
        }
        const vsize = eb.u16()
        eb.u8()
        const dataType = eb.u8()
        let data = eb.u32()
        entries.set(resId, { typeName, key, config, dataType, data, complex: false })
      }
    }
    p += csize
  }
  return { id, name, typeStrings, keyStrings, entries }
}

// ------------------------------------------------------------ 值 → 文本

function resValueToString(entry, table) {
  if (!entry) return ''
  if (entry.complex) return '<complex>'
  const { dataType, data } = entry
  switch (dataType) {
    case 0x00: return ''
    case 0x01: { // 资源引用
      const ref = resolveRef(table, data)
      return ref ? `@${ref.typeName}/${ref.key}` : `@0x${(data >>> 0).toString(16)}`
    }
    case 0x02: return `?0x${(data >>> 0).toString(16)}` // theme attr
    case 0x03: return table.globalStrings[data] ?? ''
    case 0x04: return String(data / 100) // float
    case 0x10: return String(data | 0)
    case 0x11: return `0x${(data >>> 0).toString(16)}`
    case 0x12: return String(data !== 0)
    case 0x1c: case 0x1d: case 0x1e: case 0x1f: return `#${(data >>> 0).toString(16).padStart(8, '0')}`
    default: return `0x${(data >>> 0).toString(16)}`
  }
}

function resolveRef(table, resId) {
  for (const pkg of table.packages) {
    const e = pkg.entries.get(resId >>> 0)
    if (e && !e.complex) return { typeName: e.typeName, key: e.key, entry: e }
    if (e && e.complex) return { typeName: e.typeName, key: e.key, entry: e }
  }
  return null
}

// --------------------------------------------------------------- AXML 解析

function decodeAxml(buffer, table) {
  const buf = new Buf(buffer)
  const type = buf.u16()
  if (type !== CHUNK.XML) throw new Error('不是 AXML（二进制 XML）')
  const headerSize = buf.u16()
  const size = buf.u32()

  const pool = decodeStringPool(new Buf(buffer, headerSize))
  const strings = pool.strings
  const resourceIds = [] // attribute 名字对应的资源 id（RES_XML_RESOURCE_MAP）
  if (process.env.DEBUG_AXML) console.log('DEBUG pool', strings.length, strings.slice(0, 12).join('|'))

  const root = { name: '#document', attrs: [], children: [] }
  const stack = [root]

  // 字符串池之后是其他 chunk；字符串池的 chunk 大小写在它的 +4 处
  let p = headerSize + buffer.readUInt32LE(headerSize + 4)
  while (p + 8 <= size) {
    const ctype = buffer.readUInt16LE(p)
    const chs = buffer.readUInt16LE(p + 2)
    const cs = buffer.readUInt32LE(p + 4)
    if (process.env.DEBUG_AXML) console.log('DEBUG chunk', p, '0x' + ctype.toString(16), chs, cs)
    if (cs <= 0) break
    if (ctype === CHUNK.XML_RESOURCE_MAP) {
      const n = (cs - chs) / 4
      for (let i = 0; i < n; i++) resourceIds.push(buffer.readUInt32LE(p + chs + i * 4))
    } else if (ctype === CHUNK.XML_START_ELEMENT) {
      // ResXMLTree_node 的 chunk header 是 16 字节（8 字节头 + lineNumber + comment），
      // 之后紧跟 ResXMLTree_attrExt：ns(u32) name(u32) attributeStart(u16) attributeSize(u16) ...
      const ANDROID_NS = 'http://schemas.android.com/apk/res/android'
      const ext = p + chs
      const nsIdx = buffer.readUInt32LE(ext)
      const nameIdx = buffer.readUInt32LE(ext + 4)
      const attrStart = buffer.readUInt16LE(ext + 8)
      const attrSize = buffer.readUInt16LE(ext + 10)
      const attrCount = buffer.readUInt16LE(ext + 12)
      const name = strings[nameIdx] || `tag${nameIdx}`
      const attrs = []
      for (let i = 0; i < attrCount; i++) {
        const ab = ext + attrStart + i * attrSize
        const ansIdx = buffer.readUInt32LE(ab)
        const anameIdx = buffer.readUInt32LE(ab + 4)
        const rawValueIdx = buffer.readUInt32LE(ab + 8)
        const dataType = buffer.readUInt8(ab + 15)
        const data = buffer.readUInt32LE(ab + 16)
        const ansStr = ansIdx === 0xffffffff ? '' : strings[ansIdx] || ''
        const isAndroid = ansStr === ANDROID_NS
        const aname = strings[anameIdx] || `attr${anameIdx}`
        let value
        if (dataType === 0x03) value = strings[data] ?? ''
        else if (dataType === 0x01) {
          const ref = resolveRef(table, data)
          value = ref ? `@${ref.typeName}/${ref.key}` : `@0x${(data >>> 0).toString(16)}`
        } else value = resValueToString({ dataType, data, complex: false }, table)
        if (value === '' && rawValueIdx !== 0xffffffff) value = strings[rawValueIdx] ?? ''
        attrs.push({ name: aname, ns: isAndroid ? 'android' : '', value })
      }
      const node = { name, attrs, children: [] }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    } else if (ctype === CHUNK.XML_END_ELEMENT) {
      if (stack.length > 1) stack.pop()
    }
    p += cs
  }
  return serializeXml(root.children, 0)
}

/** 把 AXML 树序列化成 XML（空元素写自闭合，带 Android 命名空间声明） */
function serializeXml(nodes, depth) {
  const indent = '    '.repeat(depth)
  return nodes
    .map(n => {
      const attrText = n.attrs
        .map(a => {
          const prefix = a.ns ? a.ns + ':' : ''
          const value = a.ns === 'android' ? prettyAndroidValue(a.name, a.value) : a.value
          return `${prefix}${a.name}="${escapeXml(value)}"`
        })
        .join(' ')
      const head = `${indent}<${n.name}${attrText ? ' ' + attrText : ''}`
      if (!n.children.length) return head + ' />'
      const inner = serializeXml(n.children, depth + 1)
      return `${head}>\n${inner}\n${indent}</${n.name}>`
    })
    .join('\n')
}

function resolveValueChain(table, entry) {
  if (!entry) return null
  if (entry.complex) return null
  if (entry.dataType === 0x03) return table.globalStrings[entry.data] ?? null
  if (entry.dataType === 0x01) {
    const ref = resolveRef(table, entry.data)
    if (!ref) return null
    return resolveValueChain(table, ref.entry)
  }
  return resValueToString(entry, table)
}

// 少量 android 属性的枚举/标志位映射，让解码结果更易读
const ANDROID_ENUMS = {
  launchMode: { 0: 'standard', 1: 'singleTop', 2: 'singleTask', 3: 'singleInstance' },
  protectionLevel: { 0: 'normal', 1: 'dangerous', 2: 'signature', 3: 'signatureOrSystem' },
  screenOrientation: {
    0: 'landscape', 1: 'portrait', 2: 'user', 3: 'behind', 4: 'sensor', 5: 'nosensor', 6: 'sensorLandscape',
    7: 'sensorPortrait', 8: 'reverseLandscape', 9: 'reversePortrait', 10: 'fullSensor', 11: 'userLandscape',
    12: 'userPortrait', 13: 'fullUser', 14: 'locked',
  },
  configChanges: {
    0x0001: 'mcc', 0x0002: 'mnc', 0x0004: 'locale', 0x0008: 'touchscreen', 0x0010: 'keyboard',
    0x0020: 'keyboardHidden', 0x0040: 'navigation', 0x0080: 'orientation', 0x0100: 'screenLayout',
    0x0200: 'uiMode', 0x0400: 'screenSize', 0x0800: 'smallestScreenSize', 0x1000: 'density', 0x2000: 'layoutDirection',
    0x4000: 'fontScale',
  },
  windowSoftInputMode: { 0x10: 'adjustResize', 0x20: 'adjustPan', 1: 'stateUnspecified', 2: 'stateUnchanged', 3: 'stateHidden', 4: 'stateAlwaysHidden', 5: 'stateVisible', 6: 'stateAlwaysVisible' },
}

function prettyAndroidValue(name, value) {
  const v = String(value)
  const map = ANDROID_ENUMS[name]
  if (!map) return v
  if (/^0x[0-9a-f]+$/i.test(v)) {
    const n = parseInt(v, 16)
    if (name === 'configChanges' || name === 'windowSoftInputMode') {
      const parts = []
      for (const [bit, label] of Object.entries(map)) {
        const b = Number(bit)
        if (b && (n & b) === b) parts.push(label)
      }
      return parts.length ? parts.join('|') + ` (0x${n.toString(16)})` : v
    }
    return map[n] ?? v
  }
  if (/^\d+$/.test(v)) return map[Number(v)] ?? v
  return v
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// --------------------------------------------------------------- 主流程

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true })
}

function writeFile(rel, content) {
  const full = path.join(OUT, rel)
  ensureDir(path.dirname(full))
  fs.writeFileSync(full, content)
  console.log('  写', path.relative(ROOT, full))
}

const manifestPath = path.join(SRC, 'AndroidManifest.xml')
const arscPath = path.join(SRC, 'resources.arsc')
if (!fs.existsSync(manifestPath)) {
  console.error('找不到 AndroidManifest.xml：', manifestPath)
  process.exit(1)
}
ensureDir(OUT)

console.log('解析 resources.arsc …')
const table = fs.existsSync(arscPath) ? parseResTable(fs.readFileSync(arscPath)) : { globalStrings: [], packages: [] }
console.log('  全局字符串', table.globalStrings.length, '个；包', table.packages.map(p => p.name).join(', '))

console.log('解析 AndroidManifest.xml（AXML）…')
const manifestXml = decodeAxml(fs.readFileSync(manifestPath), table)
writeFile('AndroidManifest.xml', manifestXml + '\n')
fs.copyFileSync(manifestPath, path.join(OUT, 'AndroidManifest.bin.xml'))

// 输出的清单里如果最后是成对标签，并不影响阅读；但把明显空标签美化一下
const finalXml = manifestXml.includes('xmlns:android')
  ? manifestXml
  : manifestXml.replace('<manifest ', '<manifest xmlns:android="http://schemas.android.com/apk/res/android" ')
writeFile('AndroidManifest.xml', '<?xml version="1.0" encoding="utf-8"?>\n' + finalXml + '\n')

// ---- 导出默认配置下的资源值
const byType = new Map()
for (const pkg of table.packages) {
  for (const [resId, entry] of pkg.entries) {
    const isDefault = !entry.config.locale && !entry.config.density && !entry.config.orientation
    if (!isDefault) continue
    if (!byType.has(entry.typeName)) byType.set(entry.typeName, [])
    byType.get(entry.typeName).push({ resId, entry })
  }
}
function resourceXml(typeName) {
  const rows = (byType.get(typeName) || []).sort((a, b) => a.entry.key.localeCompare(b.entry.key))
  if (!rows.length) return ''
  const body = rows
    .map(({ resId, entry }) => {
      const name = entry.entry || entry.key
      if (entry.complex) return `    <!-- ${name} = <${typeName} 复合资源，需从编译产物反查> -->`
      let value = resValueToString(entry, table)
      if (entry.dataType === 0x01) {
        const resolved = resolveValueChain(table, entry)
        const refText = resolveRef(table, entry.data)
        if (resolved !== null) value = `@${refText.typeName}/${refText.key}（${resolved}）`
      }
      return `    <${typeName} name="${escapeXml(entry.key)}">${escapeXml(value)}</${typeName}>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- 从 resources.arsc 解码出的默认配置资源（name 为资源名，值为解码后的内容） -->\n<resources>\n${body}\n</resources>\n`
}

for (const t of ['string', 'color', 'style', 'dimen', 'bool', 'integer']) {
  const xml = resourceXml(t)
  if (xml) writeFile(`res/values/${t}s.xml`, xml)
}

// 统计各类型资源数量，供文档引用
const stats = {}
for (const pkg of table.packages) {
  for (const entry of pkg.entries.values()) stats[entry.typeName] = (stats[entry.typeName] || 0) + 1
}
writeFile('resources-summary.json', JSON.stringify({ counts: stats, package: table.packages.map(p => ({ id: '0x' + p.id.toString(16), name: p.name, types: p.typeStrings })) }, null, 2) + '\n')

// ---- 拷贝 res/xml 与启动图标（明文，直接可用）
const sx = path.join(SRC, 'res', 'xml')
if (fs.existsSync(sx)) {
  for (const f of fs.readdirSync(sx)) {
    const src = path.join(sx, f)
    const raw = fs.readFileSync(src)
    // res/xml 下也是编译后的 AXML，需要先解码；原始二进制另存到 xml-raw/ 备查
    const rawDst = path.join(OUT, 'res', 'xml-raw', f)
    ensureDir(path.dirname(rawDst))
    fs.copyFileSync(src, rawDst)
    let text
    try {
      text = '<?xml version="1.0" encoding="utf-8"?>\n' + decodeAxml(raw, table) + '\n'
    } catch (e) {
      console.warn('  无法解码', f, e.message, '（保留原始二进制）')
      continue
    }
    const dst = path.join(OUT, 'res', 'xml', f)
    ensureDir(path.dirname(dst))
    fs.writeFileSync(dst, text)
    console.log('  解码', path.relative(ROOT, dst))
  }
}

// ---- 全量字符串资源（含各语言 config），用于文档与本地化参考
const allStrings = []
for (const pkg of table.packages) {
  for (const entry of pkg.entries.values()) {
    if (entry.typeName !== 'string') continue
    const value = resolveValueChain(table, entry)
    if (value === null || entry.complex) continue
    const cfg = entry.config
    const label = cfg.locale || 'default'
    allStrings.push({ name: entry.key, config: label, value })
  }
}
allStrings.sort((a, b) => a.name.localeCompare(b.name) || a.config.localeCompare(b.config))
if (allStrings.length) {
  const body = allStrings
    .map(r => `    <string name="${escapeXml(r.name)}" config="${escapeXml(r.config)}">${escapeXml(r.value)}</string>`)
    .join('\n')
  writeFile('res/values/strings-all.xml', `<?xml version="1.0" encoding="utf-8"?>\n<!-- 全部字符串资源（含各语言 config，共 ${allStrings.length} 条） -->\n<resources>\n${body}\n</resources>\n`)
}
for (const dir of fs.readdirSync(path.join(SRC, 'res'))) {
  if (!dir.startsWith('mipmap')) continue
  for (const f of fs.readdirSync(path.join(SRC, 'res', dir))) {
    if (!/^ic_launcher/.test(f)) continue
    const dst = path.join(OUT, 'res', dir, f)
    ensureDir(path.dirname(dst))
    fs.copyFileSync(path.join(SRC, 'res', dir, f), dst)
    console.log('  拷贝', path.relative(ROOT, dst))
  }
}

console.log('完成。资源类型统计：', stats)
