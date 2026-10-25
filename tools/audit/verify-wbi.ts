import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { md5Hex, getMixinKey, encWbi, clearWbiCache } from './wbi.ts'
import { setNav } from './http.ts'

const upSrc = readFileSync('/root/学习软件/reference/upstream-v0.4.3/src/main/bili/wbi.js', 'utf8')
const tabText = upSrc.slice(upSrc.indexOf('['), upSrc.indexOf(']') + 1)
const upTab: number[] = tabText.split(',').map(s => Number(s.replace(/[^0-9]/g, '')))
const upMix = (img: string, sub: string) => {
  const raw = img + sub
  return upTab.map(n => raw[n] || '').join('').slice(0, 32)
}
const refMd5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

let fail = 0
// 1) md5
const samples = ['', 'a', 'abc', '中文弹幕', 'hello 世界 🌏', '0'.repeat(55), '0'.repeat(56), '0'.repeat(57), '0'.repeat(64), '0'.repeat(119), '0'.repeat(120)]
for (let i = 0; i < 200; i++) {
  let s = ''
  const n = Math.floor(Math.random() * 200)
  for (let j = 0; j < n; j++) s += String.fromCharCode(32 + Math.floor(Math.random() * 90))
  samples.push(s)
}
for (const s of samples) if (md5Hex(s) !== refMd5(s)) { fail++; console.log('MD5 MISMATCH', JSON.stringify(s), md5Hex(s), refMd5(s)) }
console.log(`md5Hex: ${samples.length} 个输入与 node:crypto 比对，失败 ${fail}`)

// 2) mixinKey
let mfail = 0
for (let i = 0; i < 200; i++) {
  const rnd = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  const img = rnd(), sub = rnd()
  if (getMixinKey(img, sub) !== upMix(img, sub)) { mfail++; console.log('MIXIN MISMATCH', img, sub) }
}
console.log(`mixinKey 重排: 200 组随机 key，失败 ${mfail}`)

// 3) encWbi 端到端
const img = '7cd084941338484aae1ad9425b84077c'
const sub = '4932caff0ff746eab6f01bf08b70ac45'
setNav({ data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${img}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${sub}.png` } } })
clearWbiCache()
const realNow = Date.now
const FIXED = 1700000000123
const cases: Record<string, any>[] = [
  {},
  { keyword: '学习', page: 1, order: 'totalrank', page_size: 30 },
  { mid: 123456, pn: 1, ps: 30, tid: 0, keyword: '', order: 'pubdate', platform: 'web', web_location: 1550101, order_avoided: true },
  { bvid: 'BV1xx411c7mD', cid: 2333, qn: 80, fnver: 0, fnval: 4048, fourk: 1, platform: 'pc', high_quality: 1 },
  { vmid: '12345', pn: 1, ps: 50, order: 'desc', order_type: 'attention' },
  { 'weird!key': "a'b(c)d*e", z: "!()*", 中文: '值' },
]
let efail = 0
for (const c of cases) {
  ;(Date as any).now = () => FIXED
  const got = await encWbi(c)
  // 参照实现（照抄上游 signParams 语义，md5 用 node:crypto）
  const withTs = { ...c, wts: Math.round(FIXED / 1000) }
  const query = Object.keys(withTs).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`).join('&')
  const want = { ...withTs, w_rid: refMd5(query + upMix(img, sub)) }
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) { efail++; console.log('ENC MISMATCH\n got', JSON.stringify(got), '\nwant', JSON.stringify(want)) }
}
;(Date as any).now = realNow
console.log(`encWbi: ${cases.length} 组参数端到端比对，失败 ${efail}`)
console.log(fail + mfail + efail === 0 ? 'ALL EQUIVALENT' : 'MISMATCH FOUND')
