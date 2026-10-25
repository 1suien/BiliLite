import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] || 'reference/decompiled/js';
const out = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  // 组件对象： const X = { __name: "Name" ... } 或 , X = { __name:
  const varToName = {};
  for (const m of src.matchAll(/(?:const|let|var|,)\s*([A-Za-z_$][\w$]*)\s*=\s*\{\s*__name:\s*"([^"]+)"/g)) varToName[m[1]] = m[2];
  // withInstall / defineComponent 包装： Y = helper(X, [["__scopeId","data-v-..."], ...])
  const scopes = [];
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\[([\s\S]{0,200}?)\]\)/g)) {
    const inner = m[3];
    const sc = [...inner.matchAll(/\[\s*"__scopeId",\s*"data-v-([0-9a-f]+)"\s*\]/g)].map((x) => x[1]);
    if (sc.length) scopes.push({ alias: m[1], target: m[2], name: varToName[m[2]] || null, scopes: sc });
  }
  // 再兜底：单独的 __scopeId 字符串
  const bare = [...src.matchAll(/"__scopeId",\s*"data-v-([0-9a-f]+)"/g)].map((x) => x[1]);
  out[f] = { varToName, scopes, bare };
}
for (const [f, v] of Object.entries(out)) {
  console.log(`\n=== ${f}`);
  console.log('  components:', Object.values(v.varToName).join(', '));
  for (const s of v.scopes) console.log(`  scopeId data-v-${s.scopes.join(',')} -> ${s.name || '(?)'}`);
  if (!v.scopes.length && v.bare.length) console.log('  bare scopes:', v.bare.join(','));
}
