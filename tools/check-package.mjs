/**
 * 打包产物自检：确认 electron-builder 产出的 asar 里真的带着应用跑起来需要的东西。
 *
 * 为什么要单独查 asar 头：`build.files` 只写了 `["out/**\/*", "package.json"]`，
 * 一旦哪个入口没被 build 出来（或 out/ 被清过），装完就会白屏，而开发时一切正常。
 *
 * 用法：
 *   & "$nodeDir\node.exe" tools/check-package.mjs
 *   & "$nodeDir\node.exe" tools/check-package.mjs --dir release\win-unpacked
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/** 读 asar 头部索引（Pickle 格式：8 字节 size pickle + header pickle + JSON） */
function readAsarIndex(file) {
  const buf = readFileSync(file)
  const headerSize = buf.readUInt32LE(4)
  const headerBuf = buf.subarray(8, 8 + headerSize)
  const jsonLen = headerBuf.readUInt32LE(4)
  const json = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'))
  const paths = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, p)
      else paths.push({ path: p, size: child.size || 0 })
    }
  }
  walk(json, '')
  return { json, paths, bytes: buf.length }
}

const unpacked = resolve(root, arg('--dir', join('release', 'win-unpacked')))
const asar = join(unpacked, 'resources', 'app.asar')
const fails = []
const line = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  :: ' + detail : ''}`)
  if (!ok) fails.push(label)
}

if (!existsSync(asar)) {
  console.error(`FAIL  asar 不存在：${asar}（先跑 pnpm package）`)
  process.exit(1)
}

const { paths, bytes } = readAsarIndex(asar)
const has = (p) => paths.some((f) => f.path === p)
const find = (p) => paths.find((f) => f.path === p)

line(true, 'asar 可读', `${(bytes / 1024 / 1024).toFixed(1)} MB / ${paths.length} 个文件`)
line(has('out/main/index.js'), '主进程入口在包内', find('out/main/index.js')?.size + ' B')
line(has('out/preload/index.js'), 'preload 在包内', find('out/preload/index.js')?.size + ' B')
line(has('out/renderer/index.html'), '渲染层入口在包内')

// 摘掉读书模块后，包里不该再有 pdf.js 的 CMap / 标准字体（这几条是防回归的反向断言）
const cmaps = paths.filter((f) => f.path.startsWith('out/main/pdfjs/cmaps/')).length
const fonts = paths.filter((f) => f.path.startsWith('out/main/pdfjs/standard_fonts/')).length
line(cmaps === 0 && fonts === 0, '包里不再带 pdf.js 资源（读书模块已移除）', `${cmaps} cMaps / ${fonts} fonts`)

// 主进程不许有未打包的运行时依赖：业务代码只 require('electron') 与 Node 内置模块
const mainSrc = readFileSync(join(root, 'out', 'main', 'index.js'), 'utf8')
const bare = new Set()
for (const m of mainSrc.matchAll(/require\("([^".][^"]*)"\)/g)) bare.add(m[1])
const outside = [...bare].filter((m) => m !== 'electron' && !m.startsWith('node:'))
line(outside.length === 0, '主进程只依赖 electron 与内置模块',
  `require: ${[...bare].join(', ') || '(无)'}${outside.length ? ' / 越界: ' + outside.join(', ') : ''}`)

// 只是提示：渲染层已经被 Vite 打进 out/renderer/assets，运行时不需要 node_modules
const nm = paths.filter((f) => f.path.startsWith('node_modules/')).length
console.log(`INFO  asar 里 node_modules 文件数：${nm}（期望 0：渲染层已打包，主进程零运行时依赖）`)

console.log(fails.length ? `\n=== 打包自检失败 ${fails.length} 项 ===` : '\n=== 打包自检全部通过 ===')
process.exit(fails.length ? 1 : 0)
