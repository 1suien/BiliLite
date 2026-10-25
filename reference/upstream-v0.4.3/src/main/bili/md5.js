/**
 * 纯 JS 的 MD5（只用于 B 站 wbi 与 APP 接口签名）。
 *
 * 桌面端原本用 `node:crypto` 的 `createHash('md5')`，但安卓端跑在 WebView 里：
 * 没有 `node:crypto`，而 WebCrypto 又不提供 MD5（有意移除的弱算法）。
 * 所以这里自己实现一份，桌面端与安卓端共用，签名逻辑彻底只有一套。
 *
 * 正确性由 `tools/check-md5.mjs` 与 `node:crypto` 对拍（含中文、emoji、长字符串、边界长度）。
 */

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
]

/** K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = new Uint32Array(64)
for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

function toBytes(input) {
  if (input instanceof Uint8Array) return input
  return new TextEncoder().encode(String(input))
}

function wordsOf(bytes) {
  const len = bytes.length
  // 补 0x80 + 0 直到长度 ≡ 56 (mod 64)，再补 8 字节小端比特长度
  const total = (((len + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[len] = 0x80
  const view = new DataView(buf.buffer)
  const bits = len * 8
  view.setUint32(total - 8, bits >>> 0, true)
  view.setUint32(total - 4, Math.floor(bits / 4294967296), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const m = new Uint32Array(16)

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(off + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i += 1) {
      let f
      let g
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      f = (f + a + K[i] + m[g]) | 0
      a = d
      d = c
      c = b
      b = (b + ((f << SHIFT[i]) | (f >>> (32 - SHIFT[i])))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  return [a0, b0, c0, d0]
}

/** 返回 32 位小写十六进制 MD5。 */
export function md5hex(input) {
  const out = wordsOf(toBytes(input))
  let s = ''
  for (let w = 0; w < 4; w += 1) {
    const v = out[w]
    for (let i = 0; i < 4; i += 1) s += ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
  }
  return s
}

export default md5hex
