import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
const ROOT = '/root/学习软件'
const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
const env = { ...process.env, HOME: process.env.HOME || '/tmp/pw-home' }
if (existsSync(libDir)) env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH, '/usr/lib/aarch64-linux-gnu'].filter(Boolean).join(':')
const fc = resolve(ROOT, 'tools/browser/fonts.conf')
if (existsSync(fc)) { env.FONTCONFIG_FILE = fc; env.FONTCONFIG_PATH = resolve(ROOT, 'tools/browser') }
const browser = await chromium.launch({ env, args: ['--no-sandbox', '--allow-file-access-from-files'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const shots = [
  ['today.html', '01-today.png'],
  ['week.html', '02-week.png'],
  ['edit.html', '03-edit.png'],
  ['paste.html', '04-paste.png'],
]
for (const [src, out] of shots) {
  await page.goto('file://' + resolve(ROOT, 'docs/mockups', src), { waitUntil: 'load' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(ROOT, 'docs/mockups', out) })
  console.log('OK', out)
}
await browser.close()
