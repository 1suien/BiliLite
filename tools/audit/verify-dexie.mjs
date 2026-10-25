import { readFileSync } from 'node:fs'
function parse(file) {
  const txt = readFileSync(file, 'utf8'), out = {}
  const re = /version\((\d+)\)\.stores\(\{/g; let m
  while ((m = re.exec(txt))) {
    let i = re.lastIndex, depth = 1; const s = i
    while (depth > 0 && i < txt.length) { const c = txt[i]; if (c === '{') depth++; else if (c === '}') depth--; i++ }
    const clean = txt.slice(s, i - 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const e = {}
    for (const line of clean.split('\n')) { const mm = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'\s*,?\s*$/); if (mm) e[mm[1]] = mm[2] }
    out[m[1]] = e
  }
  return out
}
const U = parse('/root/学习软件/reference/upstream-v0.4.3/src/renderer/src/db/index.js')
const A = parse('/root/学习软件/app/src/db/index.ts')
for (const v of Object.keys(U)) {
  const a = A[v] || {}, u = U[v]
  const miss = Object.keys(u).filter(k => !(k in a)), extra = Object.keys(a).filter(k => !(k in u))
  const val = Object.keys(u).filter(k => k in a && u[k] !== a[k])
  console.log(`v${v}: 上游 ${Object.keys(u).length} 表 / 还原 ${Object.keys(a).length} 表`,
    'missing', JSON.stringify(miss), 'extra', JSON.stringify(extra), '值差异', JSON.stringify(val))
}
console.log('还原多出的版本:', Object.keys(A).filter(v => !(v in U)))
