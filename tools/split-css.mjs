// 把打包后的 CSS 按 data-v-xxxx 作用域拆回各组件，便于重建 SFC 的 <style scoped>
import fs from 'node:fs';
import path from 'node:path';

const refDir = process.argv[2] || 'reference/decompiled';
const jsDir = path.join(refDir, 'js');
const cssDir = path.join(refDir, 'css');
const outDir = process.argv[3] || 'app/src/styles/recovered';

// 1) JS 里收集 scopeId -> 组件名（精确解析 withInstall(X, [["__scopeId",...]])）
const scopeToComp = {};
const scopeToChunk = {};
for (const f of fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  const varToName = {};
  for (const m of src.matchAll(/(?:const|let|var|,)\s*([A-Za-z_$][\w$]*)\s*=\s*\{\s*__name:\s*"([^"]+)"/g)) varToName[m[1]] = m[2];
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\[([\s\S]{0,200}?)\]\)/g)) {
    const sc = [...m[3].matchAll(/\[\s*"__scopeId",\s*"data-v-([0-9a-f]+)"\s*\]/g)].map((x) => x[1]);
    for (const id of sc) {
      scopeToComp[id] = varToName[m[2]] || m[2];
      scopeToChunk[id] = f;
    }
  }
}
// 2) 粗粒度 CSS 规则切分（能处理嵌套 @media / @keyframes）
function splitRules(css) {
  const rules = [];
  let buf = '', depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const end = i + 1;
        let sel = css.slice(start, css.indexOf('{', start)).trim();
        rules.push({ sel, body: css.slice(start, end).trim(), inner: css.slice(css.indexOf('{', start) + 1, i) });
        start = end;
      }
    }
  }
  return rules;
}

// 3) 单个 CSS 文件 -> 按 scope 分组
function groupByScope(css) {
  // 先切出顶层块（可能含 @media 嵌套）
  const chunks = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { chunks.push(css.slice(start, i + 1)); start = i + 1; }
    }
  }
  chunks.push(css.slice(start));
  const groups = new Map(); // scope|null -> text
  const push = (k, text) => groups.set(k, (groups.get(k) || '') + text + '\n');
  for (let chunk of chunks) {
    if (!chunk.trim()) continue;
    const scopes = [...new Set([...chunk.matchAll(/\[data-v-([0-9a-f]+)\]/g)].map((m) => m[1]))];
    if (chunk.trim().startsWith('@media') || chunk.trim().startsWith('@supports')) {
      // 嵌套选择器，按出现顺序归组
      const inner = chunk.slice(chunk.indexOf('{') + 1, chunk.lastIndexOf('}'));
      const innerChunks = [];
      let d = 0, s = 0;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '{') d++;
        else if (inner[i] === '}') { d--; if (d === 0) { innerChunks.push(inner.slice(s, i + 1)); s = i + 1; } }
      }
      const head = chunk.slice(0, chunk.indexOf('{')).trim();
      for (const ic of innerChunks) {
        const sc = [...new Set([...ic.matchAll(/\[data-v-([0-9a-f]+)\]/g)].map((m) => m[1]))];
        push(sc.length === 1 ? sc[0] : sc.length > 1 ? sc.join('+') : null, `${head} {${ic}}`);
      }
      continue;
    }
    if (chunk.trim().startsWith('@keyframes') || chunk.trim().startsWith('@font-face') || chunk.trim().startsWith('@-webkit-keyframes')) {
      // keyframes 名字带 scope 后缀
      const m = chunk.match(/-([0-9a-f]{8})\s*\{/) || chunk.match(/-([0-9a-f]+)\s*\{/);
      const sc = m && scopeToComp[m[1]] ? m[1] : null;
      push(sc, chunk.trim());
      continue;
    }
    if (scopes.length === 1) push(scopes[0], chunk.trim());
    else if (scopes.length > 1) push(scopes.join('+'), chunk.trim());
    else push(null, chunk.trim());
  }
  return groups;
}

// 4) 去掉作用域属性与 keyframes 后缀
function unscope(text) {
  return text
    .replace(/\[data-v-[0-9a-f]+\]/g, '')
    .replace(/-[0-9a-f]{6,10}(?=\s*\{)/g, '') // keyframes 后缀（近似）
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

fs.mkdirSync(outDir, { recursive: true });
const report = [];
for (const f of fs.readdirSync(cssDir).filter((f) => f.endsWith('.css'))) {
  const css = fs.readFileSync(path.join(cssDir, f), 'utf8');
  const groups = groupByScope(css);
  for (const [scope, text] of groups) {
    const comp = scope ? scopeToComp[scope] || `unknown-${scope}` : 'global';
    const name = (scope && scope.includes('+')) ? `mixed-${scope.replace(/\+/g, '-')}` : comp;
    const outFile = path.join(outDir, `${name}${f.startsWith('index-') ? '.global' : ''}.css`);
    const cleaned = unscope(text);
    if (!cleaned) continue;
    if (fs.existsSync(outFile)) fs.appendFileSync(outFile, `\n/* --- from ${f} --- */\n` + cleaned + '\n');
    else fs.writeFileSync(outFile, `/* 来源: ${f}${scope ? `  scope: data-v-${scope}` : '  （无作用域，全局）'} */\n` + cleaned + '\n');
    report.push(`${f}  scope=${scope || '(global)'} -> ${path.basename(outFile)}  (${cleaned.length} chars)`);
  }
}
console.log(report.join('\n'));
fs.writeFileSync(path.join(outDir, '_scope-map.json'), JSON.stringify(scopeToComp, null, 2));
