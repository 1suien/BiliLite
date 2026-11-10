// 把 pdf.js 的 cmaps / standard_fonts 拷到 public/pdfjs，让非嵌入字体的 PDF 也能正常显示。
// 由 npm run build / postinstall 调用；dev 模式下 public 目录由 vite 直接服务。
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist')
const dst = join(root, 'public', 'pdfjs')

if (!existsSync(src)) {
  console.warn('[copy-pdfjs] 找不到 pdfjs-dist，跳过')
  process.exit(0)
}

mkdirSync(dst, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts']) {
  const from = join(src, dir)
  if (!existsSync(from)) {
    console.warn('[copy-pdfjs] 缺少 ' + dir)
    continue
  }
  cpSync(from, join(dst, dir), { recursive: true })
}
console.log('[copy-pdfjs] 已复制 cmaps / standard_fonts → public/pdfjs')
