/**
 * 端到端冒烟测试（只在 STUDY_SMOKE=1 时被主进程动态载入，正常运行不会执行）。
 *
 * 直接在真实 Electron 渲染进程里跑，覆盖：preload 桥接 → 路由 → 网络接口
 * （推荐流 / 搜索 / 视频信息 / playurl）→ DASH+MSE 播放链路。
 * 返回进程退出码：0 全部通过，1 有失败。
 */
import { app } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s == null) return String(s)
  return s.length > 400 ? s.slice(0, 400) + ` …(+${s.length - 400})` : s
}

export async function runSmoke(win) {
  const wc = win.webContents
  const fails = []

  // Electron 在 Windows 上是 GUI 子系统程序，stdout 有时接不到父控制台，
  // 因此结果同时落盘一份，pwsh 侧直接读文件即可。
  const outFile = process.env.STUDY_SMOKE_OUT || join(process.cwd(), 'smoke-report.txt')
  try {
    writeFileSync(outFile, '', 'utf8')
  } catch {
    /* 写不了就只走 stdout */
  }

  const log = (s) => {
    try {
      process.stdout.write(s + '\n')
    } catch {
      /* 忽略 */
    }
    try {
      appendFileSync(outFile, s + '\n', 'utf8')
    } catch {
      /* 忽略 */
    }
  }
  const pass = (label, detail, ms) => log(`PASS  ${label}${ms != null ? ` [${ms}ms]` : ''}${detail ? ' :: ' + show(detail) : ''}`)
  const fail = (label, detail) => {
    fails.push(label)
    log(`FAIL  ${label} :: ${show(detail)}`)
  }

  // 渲染层 console 与加载失败都记下来，便于定位白屏
  wc.on('console-message', (...a) => {
    let level = a[1]
    let message = a[2]
    let line = a[3]
    let source = a[4]
    if (a[0] && typeof a[0] === 'object' && 'message' in a[0]) {
      level = a[0].level
      message = a[0].message
      line = a[0].lineNumber
      source = a[0].sourceId
    }
    const isErr = level === 'error' || level === 3 || (typeof level === 'number' && level >= 2)
    log(`${isErr ? 'RCONSOLE-ERR' : 'RCONSOLE'}      ${message}${source ? `  @${String(source).slice(-60)}:${line}` : ''}`)
  })
  wc.on('did-fail-load', (_e, code, desc, url) => fail('did-fail-load', `${code} ${desc} ${url}`))
  wc.on('render-process-gone', (_e, d) => fail('render-process-gone', d && d.reason))

  const js = (code) => wc.executeJavaScript(code, true)
  const step = async (label, code, check) => {
    const t0 = Date.now()
    let value
    try {
      value = await js(code)
    } catch (err) {
      fail(label, err.message)
      return null
    }
    const ms = Date.now() - t0
    if (check && !check(value)) {
      fail(label, value)
      return value
    }
    pass(label, value, ms)
    return value
  }

  log('=== study-bili 冒烟测试开始 ===')

  // 尽早挂上渲染层错误钩子，后面任何异常都能在报告里看到 file:line
  await js(`(() => {
    if (window.__smokeHook) return true
    window.__smokeHook = true
    window.__smokeErr = ''
    window.addEventListener('error', (e) => {
      window.__smokeErr += '[error] ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || '') + ' | '
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      window.__smokeErr += '[reject] ' + ((r && (r.stack || r.message)) || String(r)) + ' | '
    })
    return true
  })()`)

  await step('bridge 已注入', 'typeof window.bili', (v) => v === 'object')
  await step('bridge 通道齐全', "Object.keys(window.bili).join(',')", (v) => /auth/.test(v) && /video/.test(v))
  await step('app:ping', 'window.bili.ping()', (v) => v === 'pong' || Boolean(v))
  await step('侧栏导航 5 项', "document.querySelectorAll('.nav-item').length", (v) => v === 5)
  await step('品牌文案', "document.querySelector('.brand b') && document.querySelector('.brand b').textContent", (v) => typeof v === 'string' && v.length > 0)
  await step('主题令牌已应用', "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()", (v) => typeof v === 'string' && v.length > 0)

  // ---- 网络接口 ----
  const feed = await step(
    'home.feed 推荐流',
    'window.bili.home.feed(1)',
    (v) => v && Array.isArray(v.items) && v.items.length > 0
  )
  if (feed && feed.items && feed.items.length) {
    pass('推荐流来源', `${feed.source} · 首条 ${feed.items[0].title} / cid=${feed.items[0].cid}`)
  }

  const search = await step(
    'search.videos 搜索',
    "window.bili.search.videos('线性代数', 1)",
    (v) => v && Array.isArray(v.items) && v.items.length > 0
  )

  let probe = feed && feed.items && feed.items[0]
  if (!probe && search && search.items && search.items.length) probe = search.items[0]
  if (!probe) probe = { bvid: 'BV1GJ411x7h7' }
  const bvid = probe.bvid

  const view = await step(
    'video.view 视频信息',
    `window.bili.video.view(${JSON.stringify(bvid)})`,
    (v) => v && v.bvid && v.title
  )
  if (!view || !view.bvid) {
    fail('无法取得可用 bvid，播放链路跳过', bvid)
    log(`=== 结束：失败 ${fails.length} 项 ===`)
    return fails.length ? 1 : 0
  }
  pass('视频标题', `${view.title} · 分P ${view.pages ? view.pages.length : 0}`)

  const first = view.pages && view.pages[0]
  const cid = first ? first.cid : view.cid

  const playurl = await step(
    'video.playurl',
    `window.bili.video.playurl(${JSON.stringify(bvid)}, ${cid}, 80)`,
    (v) => v && (v.mode === 'dash' || v.mode === 'durl')
  )
  if (playurl) {
    const vcodes = playurl.dash && playurl.dash.video ? playurl.dash.video.length : 0
    const acodes = playurl.dash && playurl.dash.audio ? playurl.dash.audio.length : 0
    pass('playurl 详情', `mode=${playurl.mode} 画质=${playurl.quality} 可选=${(playurl.acceptQuality || []).join('/')} dash视频轨=${vcodes} 音频轨=${acodes}`)
  }

  // ---- 播放链路：真实进入视频页，观察 MSE 缓冲 ----
  await js(`location.hash = '#/video/' + ${JSON.stringify(bvid)} + '?cid=' + ${cid}`)
  await sleep(1200)
  await step('视频页已渲染', "!!document.querySelector('.player-stage')", (v) => v === true)

  let played = null
  for (let i = 0; i < 12; i++) {
    await sleep(1500)
    played = await js(`(() => {
      const v = document.querySelector('video')
      if (!v) return { err: 'no-video-element' }
      let end = 0
      try { end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 } catch (e) { end = -1 }
      const msg = document.querySelector('.player-msg')
      const panels = Array.from(document.querySelectorAll('.watch .panel')).map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 160))
      return {
        readyState: v.readyState,
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : String(v.duration),
        currentTime: Number(v.currentTime.toFixed(2)),
        bufferedEnd: Number(end.toFixed(2)),
        paused: v.paused,
        src: String(v.currentSrc || v.src || '').slice(0, 40),
        msg: msg ? msg.textContent.trim() : '',
        panels
      }
    })()`)
    log(`      · 起流轮询 ${i + 1}/12 :: ${show(played)}`)
    if (played && !played.err && played.bufferedEnd > 1 && played.readyState >= 2) break
  }
  if (!played || played.err) fail('播放器 <video> 存在', played)
  else if (played.readyState < 2 || played.bufferedEnd <= 1) fail('DASH 播放起流', played)
  else pass('DASH 播放起流', played)

  // ---- 真正播放：点播放键后 currentTime 是否前进 ----
  if (played && !played.err) {
    let advanced = false
    let t0 = null
    let last = null
    let gone = false
    try {
      await js(`(() => { const b = document.querySelector('.player-ctl button'); if (b) b.click(); return !!b })()`)
      for (let i = 0; i < 8; i++) {
        await sleep(700)
        const s = await js(`(() => {
          const v = document.querySelector('video')
          if (!v) return { err: 'no-video-element' }
          return {
            t: Number(v.currentTime.toFixed(2)),
            paused: v.paused,
            rs: v.readyState,
            buf: (() => { try { return v.buffered.length ? Number(v.buffered.end(v.buffered.length - 1).toFixed(1)) : 0 } catch (e) { return -1 } })()
          }
        })()`)
        last = s
        if (s.err) {
          gone = true
          break
        }
        if (t0 === null) t0 = s.t
        if (s.t > 0.3 || (i > 3 && s.t > t0)) advanced = true
        if (advanced) {
          pass('DASH 播放推进（currentTime 前进）', s)
          break
        }
      }
      if (gone) fail('DASH 播放推进（currentTime 前进）', { note: '<video> 元素在播放过程中消失', last })
      else if (!advanced) fail('DASH 播放推进（currentTime 前进）', { note: '点了播放键后 currentTime 未前进', last })
    } catch (err) {
      fail('DASH 播放推进（currentTime 前进）', `探针异常：${err.message}`)
    }
  }

  // ---- 进度落库：播放器每 5s 落一次盘，所以这里轮询等待 ----
  let progressRows = 0
  let progressDiag = null
  for (let i = 0; i < 12; i++) {
    const probe = await js(`(async () => {
      const v = document.querySelector('video')
      if (v && v.paused) { const b = document.querySelector('.player-ctl button'); if (b) b.click() }
      const openReq = indexedDB.open('study-bili')
      const db = await new Promise((res) => { openReq.onsuccess = () => res(openReq.result) })
      if (!db.objectStoreNames.contains('progress')) return { rows: -1 }
      const rows = await new Promise((res) => {
        const tx = db.transaction('progress', 'readonly').objectStore('progress').getAll()
        tx.onsuccess = () => res(tx.result)
      })
      return { rows: rows.length, t: v ? Number(v.currentTime.toFixed(2)) : null, paused: v ? v.paused : null }
    })()`)
    progressDiag = probe
    progressRows = probe && probe.rows
    if (progressRows > 0) break
    await sleep(900)
  }
  if (progressRows > 0) pass('学习进度已写入 IndexedDB', progressRows)
  else fail('学习进度已写入 IndexedDB', progressDiag)

  // ---- 路由与页面可用性 ----
  const routes = [
    ['搜索', '.page-head'],
    ['收藏', '.page-head'],
    ['学习', '.stat-grid'],
    ['设置', '.panel'],
    ['首页', '.grid, .page-head']
  ]
  // 顶栏搜索框（真实用户操作：输入 + 回车）
  await js(`(() => {
    const input = document.querySelector('.top-search input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'vue')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(1100)
  await step('顶栏搜索跳转', `location.hash.includes('/search')`, (v) => v === true)
  await step('顶栏搜索结果', `!!document.querySelector('.page-head')`, (v) => v === true)

  // 侧栏导航（真实用户点击，而不是直接改 location.hash —— hash 模式在 file:// 下被外部改写会叠成 #/#/x）
  const navLabels = await js(`Array.from(document.querySelectorAll('.nav-item')).map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`)
  for (const [label, sel] of routes) {
    const before = await js(`location.hash`)
    const clicked = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.nav-item')).find((e) => e.textContent.includes(${JSON.stringify(label)}))
      if (!el) return false
      el.click()
      return true
    })()`)
    await sleep(1100)
    const ok = await step(`侧栏「${label}」`, `!!document.querySelector(${JSON.stringify(sel)})`, (v) => v === true)
    if (!ok) {
      const info = await js(`({
        clicked: ${clicked},
        before: ${JSON.stringify(before)},
        hash: location.hash,
        hasStat: !!document.querySelector('.stat-grid'),
        text: (document.querySelector('#app') ? document.querySelector('#app').innerText : '').slice(0, 200).replace(/\\s+/g, ' '),
        err: String(window.__smokeErr || '').slice(-400)
      })`)
      log(`      · 诊断 ${label} :: ${show(info)}`)
      log(`      · nav-item 文本 :: ${show(navLabels)}`)
    }
  }

  const errs = await js(`String(window.__smokeErr || '')`).catch(() => '')
  if (errs) log(`渲染层异常汇总 :: ${show(errs)}`)
  else log('渲染层异常汇总 :: 无')
  log(`=== 冒烟测试结束：失败 ${fails.length} 项${fails.length ? ' → ' + fails.join(' | ') : ''} ===`)
  return fails.length ? 1 : 0
}

export function scheduleExit(code) {
  // 给 stdout 一点刷盘时间，避免日志被截断
  setTimeout(() => app.exit(code), 250)
}
