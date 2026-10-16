// 对拍 src/main/bili/md5.js 与 node:crypto：任何一条不一致就非零退出。
import { createHash } from 'node:crypto'
import { md5hex } from '../src/main/bili/md5.js'

function ref(s) {
  return createHash('md5').update(s).digest('hex')
}

const cases = [
  '',
  'a',
  'abc',
  'message digest',
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  '1234567890'.repeat(8),
  '中文签名测试',
  'BiliLite 学习专注型 B 站客户端',
  '🍅📚✅ emoji 也要能算',
  'wts=1700000000&w_rid=',
  'a'.repeat(55),
  'a'.repeat(56),
  'a'.repeat(57),
  'a'.repeat(63),
  'a'.repeat(64),
  'a'.repeat(65),
  'a'.repeat(119),
  'a'.repeat(120),
  'a'.repeat(1000)
]

// 追加 3000 条伪随机字符串（含中文与符号），确保不是碰巧对上
let seed = 20261012
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789&=%_-.中文测试🍅'
for (let i = 0; i < 3000; i += 1) {
  const n = Math.floor(rnd() * 90)
  let s = ''
  for (let j = 0; j < n; j += 1) s += alphabet[Math.floor(rnd() * alphabet.length)]
  cases.push(s)
}

let bad = 0
for (const s of cases) {
  const got = md5hex(s)
  const want = ref(s)
  if (got !== want) {
    bad += 1
    if (bad <= 5) console.log(`MISMATCH len=${s.length} got=${got} want=${want} src=${JSON.stringify(s.slice(0, 40))}`)
  }
}
console.log(`checked ${cases.length} cases, mismatches = ${bad}`)
process.exit(bad === 0 ? 0 : 1)
