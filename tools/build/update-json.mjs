#!/usr/bin/env node
/**
 * 生成软件内更新清单 update.json（本机 0.4.66）
 *
 * 用法：node tools/build/update-json.mjs [apk文件名] [更新说明…]
 * 默认读仓库根的 BiliLite-latest.apk（软链→最新包），写出仓库根 update.json。
 * 清单会被本机 dsh web 的 /dl 路由直接访问：http://127.0.0.1:3080/dl/update.json
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync, writeFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const argApk = process.argv[2]
const notes = process.argv.slice(3)

function findApk() {
  if (argApk) return resolve(ROOT, argApk)
  const latest = resolve(ROOT, 'BiliLite-latest.apk')
  if (!existsSync(latest)) throw new Error('找不到 BiliLite-latest.apk')
  // 软链直接读实体文件
  return lstatSync(latest).isSymbolicLink() ? latest : latest
}

/** 从 aapt2 badging 太麻烦，这里用文件名解析版本（BiliLite-0.4.66-debug.apk） */
function versionFromName(name) {
  const m = /BiliLite-(\d+\.\d+\.\d+)-debug\.apk$/.exec(name)
  if (!m) throw new Error('无法从文件名解析版本：' + name)
  return m[1]
}

/** versionCode 从 APK 里读（aapt2 badging），避免和 build.gradle 对不上 */
function readBadging(apk) {
  const aapt2 = resolve(ROOT, 'tools/build/aapt2-qemu.sh')
  const qemu = process.env.QEMU || '/opt/toolchain/usr/bin/qemu-x86_64-static'
  const out = execFileSync('bash', [aapt2, 'dump', 'badging', apk], {
    encoding: 'utf-8',
    env: { ...process.env, QEMU: qemu },
  })
  const code = Number((/versionCode='(\d+)'/.exec(out) || [])[1] || 0)
  const name = (/(?:versionName)='([^']+)'/.exec(out) || [])[1] || ''
  return { versionCode: code, versionName: name }
}

const apk = findApk()
const real = resolve(apk)
const buf = readFileSync(real)
const sha256 = createHash('sha256').update(buf).digest('hex')
const name = real.split('/').pop()
const fallbackVersion = versionFromName(name)
let versionName = fallbackVersion
let versionCode = 0
try {
  const badging = readBadging(real)
  if (badging.versionCode) versionCode = badging.versionCode
  if (badging.versionName) versionName = badging.versionName
} catch (e) {
  console.warn('[update-json] aapt2 读取 versionCode 失败，按文件名推导：', e && e.message)
}
if (!versionCode) {
  const [a, b, c] = versionName.split('.').map(Number)
  versionCode = a * 1000 + b * 100 + c
}
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const publishedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+08:00`

const payload = {
  versionCode,
  versionName,
  apk: 'http://127.0.0.1:3080/dl/BiliLite-latest.apk',
  sha256,
  size: buf.length,
  publishedAt,
  notes: notes.length ? notes : ['修复与优化（详见 GitHub Release 说明）'],
}

writeFileSync(resolve(ROOT, 'update.json'), JSON.stringify(payload, null, 2) + '\n')
console.log('updated', resolve(ROOT, 'update.json'))
console.log(JSON.stringify(payload, null, 2))
