import { readFileSync } from 'node:fs'
const up = readFileSync('/root/学习软件/reference/upstream-v0.4.3/src/shared/default-settings.js', 'utf8')
const app = readFileSync('/root/学习软件/app/src/bridge/state.ts', 'utf8')
const grab = (txt) => { const o = {}; for (const m of txt.matchAll(/^\s{2}([A-Za-z_]+):\s*(.+?),?\s*$/gm)) o[m[1]] = m[2]; return o }
const U = grab(up.slice(up.indexOf('DEFAULT_SETTINGS')))
const A = grab(app.slice(app.indexOf('DEFAULT_SETTINGS'), app.indexOf('}', app.indexOf('focusTasks'))))
console.log('key 数', Object.keys(U).length, Object.keys(A).length)
console.log('missing:', Object.keys(U).filter(k => !(k in A)))
console.log('extra:', Object.keys(A).filter(k => !(k in U)))
for (const k of Object.keys(U)) if (U[k] !== A[k]) console.log('DIFF', k, U[k], A[k])
console.log('顺序一致:', Object.keys(U).join() === Object.keys(A).join())
