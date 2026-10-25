import { readFileSync } from 'node:fs'
const up = readFileSync('/root/学习软件/reference/upstream-v0.4.3/src/mobile/bridge.js', 'utf8')
const app = readFileSync('/root/学习软件/app/src/bridge/android.ts', 'utf8')
const re = /^  '([a-z]+:[a-zA-Z]+)':/gm
const U = [...up.matchAll(re)].map(m => m[1])
const A = [...app.matchAll(re)].map(m => m[1])
const un = new Set(U), an = new Set(A)
console.log('上游通道', U.length, '还原通道', A.length)
console.log('missing:', U.filter(x => !an.has(x)))
console.log('extra:', A.filter(x => !un.has(x)))
console.log('顺序一致:', U.join(',') === A.join(','))
