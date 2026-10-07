// 解析层离线自检：不启动 Electron，直接跑字幕解析（SRT / VTT / ASS）。
//   node tools/check-parsers.mjs
// 改动 src/renderer/src/utils/subtitle.js 之后先跑它，再去跑冒烟。
// （读书模块的 zip/xml/txt/epub 解析曾在这里自检，随模块一起归档到 backup/reader-module/。）
import { decodeSubtitleBytes, isSubtitleFile, parseSubtitle } from '../src/renderer/src/utils/subtitle.js'

let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  :: ' + JSON.stringify(detail)}`)
}

// ---------------------------------------------------------------- 字幕（SRT / VTT / ASS）
// 三种格式都在真实视频上出现过：SRT 最常见、VTT 是 B 站外挂、ASS 带大量样式标记。
const srtText = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '第一句 <i>斜体</i> 字幕',
  '',
  '2',
  '00:00:03,600 --> 00:00:06,000',
  '第二句，带逗号，也有句号。',
  ''
].join('\n')
const srt = parseSubtitle(srtText, 'srt')
check('SRT 解析出 2 句', srt.items.length === 2, srt.items.length)
check('SRT 时间正确', srt.items[0].from === 1 && Math.abs(srt.items[0].to - 3.5) < 0.001, [srt.items[0].from, srt.items[0].to])
check('SRT 去掉 HTML 标签', srt.items[0].content === '第一句 斜体 字幕', srt.items[0].content)
check('SRT 保留正文里的逗号', srt.items[1].content.includes('带逗号，也有句号'), srt.items[1].content)

const vttText = [
  'WEBVTT',
  '',
  'NOTE 这行是注释',
  '',
  '00:01.000 --> 00:02.000 line:90% align:middle',
  'VTT 第一句',
  '',
  '00:00:02.500 --> 00:00:04.000',
  'VTT 第二句',
  ''
].join('\n')
const vtt = parseSubtitle(vttText, 'vtt')
check('VTT 解析出 2 句（跳过 NOTE，省略小时）', vtt.items.length === 2, vtt.items.length)
check('VTT 按时间排序', vtt.items[0].from === 1 && vtt.items[1].from === 2.5, vtt.items.map((i) => i.from))
check('VTT 丢掉时间行后面的定位参数', vtt.items[0].content === 'VTT 第一句', vtt.items[0].content)

const assText = [
  '[Script Info]',
  'Title: 测试',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(190,240)}ASS 第一句，带逗号',
  'Dialogue: 0,0:00:03.50,0:00:05.00,Default,,0,0,0,,ASS 第二句\\N换行',
  ''
].join('\n')
const ass = parseSubtitle(assText, 'ass')
check('ASS 解析出 2 句', ass.items.length === 2, ass.items.length)
check('ASS 时间正确', ass.items[0].from === 1 && Math.abs(ass.items[1].from - 3.5) < 0.001, ass.items.map((i) => i.from))
check('ASS 剥掉 {\\pos} 标记', ass.items[0].content === 'ASS 第一句，带逗号', ass.items[0].content)
check('ASS 的 \\N 变成换行', ass.items[1].content.includes('\n'), JSON.stringify(ass.items[1].content))
check('ASS 的 Text 字段里的逗号没被当分隔符', ass.items[0].content.includes('带逗号'), ass.items[0].content)

// GB18030 的中文 .srt：Node 的 Buffer 不能「编码」成 gb18030，所以直接写死字节
// （d6d0 cec4 d7d6 c4bb b2e2 cad4 = 中文字幕测试）
const gbkSrt = new Uint8Array([
  ...Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'latin1'),
  ...[...Buffer.from('d6d0cec4d7d6c4bbb2e2cad4', 'hex')],
  0x0a
])
const gbkParsed = parseSubtitle(decodeSubtitleBytes(gbkSrt), 'srt')
check('GB18030 字幕能解码出中文', gbkParsed.items[0].content === '中文字幕测试', gbkParsed.items[0].content)
check('BOM 开头的 UTF-8 字幕不把 BOM 当正文', parseSubtitle('\uFEFF' + srtText, 'srt').items[0].content === srt.items[0].content, 1)
check('认字幕扩展名', isSubtitleFile('a.SRT') && isSubtitleFile('b.ass') && !isSubtitleFile('c.mp4'), 1)

console.log(bad ? `\n=== 失败 ${bad} 项 ===` : '\n=== 解析层自检全部通过 ===')
process.exit(bad ? 1 : 0)
