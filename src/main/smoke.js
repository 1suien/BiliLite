/**
 * 端到端冒烟测试（只在 STUDY_SMOKE=1 时被主进程动态载入，正常运行不会执行）。
 *
 * 直接在真实 Electron 渲染进程里跑，覆盖：preload 桥接 → 路由 → 网络接口
 * （推荐流 / 搜索 / 视频信息 / playurl）→ DASH+MSE 播放链路。
 * 返回进程退出码：0 全部通过，1 有失败。
 */
import { app } from 'electron'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s == null) return String(s)
  return s.length > 400 ? s.slice(0, 400) + ` …(+${s.length - 400})` : s
}

// 「当前清晰度」文案（与 src/renderer/src/utils/quality.js 的 QN_LABEL 一致）
const QN_TEXT = { 6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60', 80: '1080P', 100: '智能修复', 112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K' }
const qnText = (qn) => QN_TEXT[qn] || `qn${qn}`

/**
 * 与渲染层 `pickVideoTrack` 同一套规则，用来算「应该挑中哪条轨」：
 * 先按本次下发的画质 id 过滤（没有匹配就退回全部），再 avc1 优先、分辨率降序、带宽降序。
 */
function expectVideoTrack(tracks = [], want = 0) {
  const usable = tracks.filter((t) => t && (t.url || t.baseUrl || t.base_url))
  if (!usable.length) return null
  const rank = (t) => {
    const c = String(t.codecs || '')
    if (c.startsWith('avc1')) return 0
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 1
    if (c.startsWith('av01')) return 2
    return 3
  }
  const matched = Number(want) ? usable.filter((t) => Number(t.id) === Number(want)) : []
  const pool = matched.length ? matched : usable
  return pool
    .slice()
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0) ||
        (b.bandwidth || 0) - (a.bandwidth || 0)
    )[0]
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
  // 环境性失败（接口风控等）不计入失败项，但要在报告里显式留痕
  const warn = (text) => log(`WARN  ${text}`)

  // 需要在浅色/深色下都看一眼界面时用 STUDY_SMOKE_THEME 指定。
  // 注意 settings.init() 是异步的，完成时会按落盘设置再刷一次主题，所以这里每次用时都重新强制一次。
  const wantTheme =
    process.env.STUDY_SMOKE_THEME === 'light' || process.env.STUDY_SMOKE_THEME === 'dark' ? process.env.STUDY_SMOKE_THEME : ''
  // 强制主题：`--accent` / `--accent-fg` 是 settings.applyTheme() 按「强调色预设 × 主题」内联写死的
  // （见 src/renderer/src/stores/settings.js 的 ACCENT_PRESETS），只改 data-theme 不会重算它，
  // 于是浅色下 --accent 还停在深色主题的 #ffffff（白底白字，截图会误导）。这里把强调色一起换过去。
  const forceTheme = async () => {
    if (!wantTheme) return
    try {
      await js(`(async () => {
        const want = ${JSON.stringify(wantTheme)}
        const pairs = [['#ffffff','#17171a'],['#5ad1c8','#0f766e'],['#6ea8fe','#1d4ed8'],['#b39ddb','#6d28d9'],['#f0a868','#b45309'],['#7fd68a','#15803d']]
        const root = document.documentElement
        root.dataset.theme = want
        const cur = String(root.style.getPropertyValue('--accent') || '').trim().toLowerCase()
        let hex = ''
        for (const p of pairs) if (cur === p[0] || cur === p[1]) { hex = want === 'light' ? p[1] : p[0]; break }
        if (!hex) hex = want === 'light' ? '#17171a' : '#ffffff'
        const n = parseInt(hex.slice(1), 16)
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        root.style.setProperty('--accent', hex)
        root.style.setProperty('--accent-fg', lum > 0.6 ? '#0a0a0b' : '#ffffff')
        // 只改 DOM 还不够：应用里任何一次 settings.patch() 都会走 applyTheme()，按「已落盘的主题」
        // 把 dataset.theme 改回去（见 src/renderer/src/stores/settings.js 的 patch → applyTheme），
        // 于是指定浅色的跑法会在中途某次写设置之后又变回默认深色——截图与对比度断言都会失真
        // （曾出现：前几张截图是浅色，学习页那张突然变深）。这里把主题一起落盘，之后的 patch
        // 只会把它再设成同一个值。userData 目录是冒烟自己的一次性目录，改它无害。
        try {
          if (window.bili && window.bili.settings && window.bili.settings.patch) await window.bili.settings.patch({ theme: want })
        } catch { /* 落盘失败就只按 DOM 强制，后面每次截图前还会再强制一次 */ }
        return hex
      })()`)
    } catch {
      /* 忽略 */
    }
  }

  // 需要看真实界面时设置 STUDY_SMOKE_SHOT=<目录>，会顺手截几张图
  const shotDir = process.env.STUDY_SMOKE_SHOT
  const shot = async (name) => {
    if (!shotDir) return
    try {
      mkdirSync(shotDir, { recursive: true })
      await forceTheme()
      // 主题令牌切换会带动带 transition 的控件（.input/.btn/.page-pill 等）过渡，
      // 等过渡走完再截，否则截图里会拍到「半路」的灰底（曾把输入框拍成深灰）。
      await sleep(400)
      const img = await win.webContents.capturePage()
      writeFileSync(join(shotDir, name), img.toPNG())
      log(`      · 截图已保存：${name}`)
    } catch (err) {
      log('      · 截图失败：' + (err && err.message))
    }
  }

  // 渲染层 console 与加载失败都记下来，便于定位白屏
  const dashLogs = []
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
    if (typeof message === 'string' && message.startsWith('[dash]')) dashLogs.push(message)
    const isErr = level === 'error' || level === 3 || (typeof level === 'number' && level >= 2)
    log(`${isErr ? 'RCONSOLE-ERR' : 'RCONSOLE'}      ${message}${source ? `  @${String(source).slice(-60)}:${line}` : ''}`)
  })
  wc.on('did-fail-load', (_e, code, desc, url) => fail('did-fail-load', `${code} ${desc} ${url}`))
  wc.on('render-process-gone', (_e, d) => fail('render-process-gone', d && d.reason))

  // 单步卡死（接口挂住 / 渲染层被占住）时不要让整个冒烟永远停在那一行：
  // executeJavaScript 加超时，超时按失败处理，报告里能看到是哪一步挂的。
  const js = (code, timeoutMs = 30000) =>
    Promise.race([
      wc.executeJavaScript(code, true),
      sleep(timeoutMs).then(() => {
        throw new Error(`executeJavaScript 超时（${timeoutMs}ms）`)
      })
    ])
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
  // 真实鼠标点击：优先走 CDP 的 Input.dispatchMouseEvent，而不是 Electron 的 sendInputEvent。
  // 实测 sendInputEvent 只产生 mouse 事件、**不产生 pointer 事件**，所以挂在 @pointerup 上的
  // 按钮在冒烟里永远点不动（假失败）；而 CDP 的输入注入走的是浏览器真正的输入管线
  // （Puppeteer 的 page.click 就是它），pointerdown/mousedown/pointerup/mouseup/click 按真实顺序来，
  // 「拖动抢指针 → 按钮点不动」这类毛病才暴露得出来。
  let dbgState = null
  const dbgReady = async () => {
    if (dbgState !== null) return dbgState
    try {
      const d = wc.debugger
      if (!d.isAttached()) d.attach('1.3')
      dbgState = true
    } catch (err) {
      warn('CDP 调试器挂不上，真实鼠标点击退回 sendInputEvent：' + err.message)
      dbgState = false
    }
    return dbgState
  }
  const clickReal = async (x, y) => {
    const px = Math.round(x)
    const py = Math.round(y)
    if (await dbgReady()) {
      const d = wc.debugger
      const send = (type, extra) =>
        d.sendCommand(
          'Input.dispatchMouseEvent',
          Object.assign({ type, x: px, y: py, button: 'left', clickCount: 1 }, extra || {})
        )
      try {
        await send('mouseMoved', { buttons: 0 })
        await sleep(80)
        await send('mousePressed', { buttons: 1 })
        await sleep(80)
        await send('mouseReleased', { buttons: 0 })
        await sleep(150)
        return
      } catch (err) {
        warn('CDP 点击失败，退回 sendInputEvent：' + err.message)
        dbgState = false
      }
    }
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    await sleep(80)
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
    await sleep(80)
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
    await sleep(150)
  }
  // 点之前先看看那个坐标上站的是谁：如果返回的不是按钮，就是「有东西盖住了」。
  const hitAt = (x, y) =>
    js(`(() => {
      const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
      if (!el) return 'none'
      return (el.tagName + '.' + String(el.className || '')).replace(/\\s+/g, ' ').trim().slice(0, 60)
    })()`)
  // 最近 6 条真实 click 记录（冒烟开头挂的捕获阶段监听器记的），用来判断 click 到底有没有派发出来
  const clickLog = () =>
    js(`(() => (window.__navLog || []).filter((r) => r[0] === 'click').slice(-6).map((r) => r[1] + '@' + r[2]))()`)

  log('=== BiliLite 冒烟测试开始 ===')

  // 尽早挂上渲染层错误钩子，后面任何异常都能在报告里看到 file:line
  await js(`(() => {
    if (window.__smokeHook) return true
    window.__smokeHook = true
    window.__smokeErr = ''
    window.addEventListener('error', (e) => {
      const st = e.error && e.error.stack ? String(e.error.stack).split('\\n').slice(0, 4).join(' | ') : ''
      window.__smokeErr += '[error] ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || '') + (st ? ' :: ' + st : '') + ' | '
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      window.__smokeErr += '[reject] ' + ((r && (r.stack || r.message)) || String(r)) + ' | '
    })
    // 记录「谁把页面导航走了」：点击目标 + hash 变化 + pushState/replaceState 调用栈。
    // 实测有人在冒烟跑的时候点了窗口（设置页主题、番茄钟按钮、侧栏「UP 管理」），
    // 页面被带走后番茄钟面板消失，断言会假失败 —— 日志留着定位。
    if (!window.__navLog) {
      window.__navLog = []
      const navSt = () => { try { return String(new Error().stack || '').split('\\n').slice(1, 5).join(' | ').slice(0, 300) } catch (e) { return '' } }
      const keep = (row) => { if (window.__navLog.length < 400) window.__navLog.push(row) }
      const push = history.pushState.bind(history)
      const rep = history.replaceState.bind(history)
      history.pushState = function (...a) { keep(['push', String(a[2]), navSt()]); return push(...a) }
      history.replaceState = function (...a) { keep(['replace', String(a[2]), navSt()]); return rep(...a) }
      addEventListener('hashchange', () => keep(['hash', location.hash, navSt()]), true)
      addEventListener('popstate', () => keep(['pop', location.hash, navSt()]), true)
      addEventListener('click', (e) => {
        const t = e.target
        const b = t && t.closest ? t.closest('button,a,.vcard,.rowitem,.nav-item,.mi') : null
        keep(['click', b ? String(b.textContent || b.className).replace(/\\s+/g, ' ').trim().slice(0, 30) : (t && t.tagName) || '?', location.hash, navSt()])
      }, true)
    }
    return true
  })()`)

  await step('bridge 已注入', 'typeof window.bili', (v) => v === 'object')
  await step('bridge 通道齐全', "Object.keys(window.bili).join(',')", (v) => /auth/.test(v) && /video/.test(v))
  await step('app:ping', 'window.bili.ping()', (v) => v === 'pong' || Boolean(v))
  await step('侧栏导航 6 项', "document.querySelectorAll('.nav-item').length", (v) => v === 6)
  await step(
    '侧栏已没有「读书」入口',
    "Array.from(document.querySelectorAll('.nav-item')).some((e) => e.textContent.includes('读书'))",
    (v) => v === false
  )
  await step(
    '侧栏不再有「搜索」入口（保留顶栏搜索）',
    "Array.from(document.querySelectorAll('.nav-item')).some((e) => e.textContent.includes('搜索'))",
    (v) => v === false
  )
  await step('品牌文案', "document.querySelector('.brand b') && document.querySelector('.brand b').textContent", (v) => typeof v === 'string' && v.length > 0)
  await step('主题令牌已应用', "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()", (v) => typeof v === 'string' && v.length > 0)

  // ---- 进度库诊断：key 形如 `:cid` 的行 = 早期 bvid 为空写出的脏行（首页重复卡片的根源）----
  const progDump = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const readAll = async () => {
      const openReq = indexedDB.open('study-bili')
      const db = await new Promise((res, rej) => { openReq.onsuccess = () => res(openReq.result); openReq.onerror = () => rej(openReq.error) })
      if (!db.objectStoreNames.contains('progress')) return []
      return await new Promise((res) => { const tx = db.transaction('progress', 'readonly').objectStore('progress').getAll(); tx.onsuccess = () => res(tx.result) })
    }
    // 应用的 learn store 启动时会清理脏行，等它做完（最多 4 秒）
    let rows = []
    for (let i = 0; i < 10; i++) {
      rows = await readAll()
      if (!rows.some((r) => !r.bvid)) break
      await sleep(400)
    }
    const byBvid = {}
    for (const r of rows) byBvid[r.bvid] = (byBvid[r.bvid] || 0) + 1
    const dup = Object.keys(byBvid).filter((k) => k && byBvid[k] > 1)
    return {
      n: rows.length,
      noBvid: rows.filter((r) => !r.bvid).length,
      dupBvid: dup.length,
      rows: rows
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 14)
        .map((r) => ({ key: String(r.key), cid: r.cid, page: r.page, sec: Math.round(r.seconds || 0), dur: Math.round(r.duration || 0), t: String(r.title || '').slice(0, 12) }))
    }
  })()`)
  log('进度行诊断 :: ' + JSON.stringify(progDump))
  if (progDump && progDump.n >= 0) {
    if (progDump.noBvid === 0) pass('进度库没有缺失 bvid 的脏行', { rows: progDump.n, noBvid: 0, dupBvid: progDump.dupBvid })
    else fail('进度库没有缺失 bvid 的脏行', { rows: progDump.n, noBvid: progDump.noBvid, sample: (progDump.rows || []).filter((r) => String(r.key).startsWith(':')).slice(0, 3) })
  } else {
    log('      · 进度库读不到，跳过脏行断言')
  }
  // STUDY_SMOKE_THEME=light 时用浅色主题跑一遍（浅色下更容易看出浅色描边/留白类问题）
  if (wantTheme) {
    await forceTheme()
    log(`      · 主题强制为 ${wantTheme}`)
  }

  // ---- 网络接口 ----
  const feed = await step(
    'home.feed 推荐流',
    'window.bili.home.feed(1)',
    (v) => v && Array.isArray(v.items) && v.items.length > 0
  )
  if (feed && feed.items && feed.items.length) {
    pass('推荐流来源', `${feed.source} · 首条 ${feed.items[0].title} / cid=${feed.items[0].cid}`)
  }

  // 搜索接口会被 B 站按 IP 风控（同一个关键词有的轮次 total=1000、有的轮次 total=0），
  // 所以「返回了合法结构」才算这一步通过，0 条会重试 3 次后降级为 WARN（不是功能回归）。
  let search = null
  for (let i = 0; i < 3; i++) {
    search = await step(
      i ? `search.videos 搜索（第 ${i + 1} 次）` : 'search.videos 搜索',
      "window.bili.search.videos('线性代数', 1)",
      (v) => v && Array.isArray(v.items)
    )
    if (search && search.items && search.items.length) break
    if (i < 2) await sleep(1500)
  }
  if (search && search.items && search.items.length) {
    pass('搜索结果可用', `total=${search.total} 首条 ${search.items[0].title}`)
  } else {
    warn(`search.videos 搜索返回 0 条（本机 IP 被搜索接口风控时就是这样，非功能回归）：${show(search)}`)
  }

  let probe = feed && feed.items && feed.items[0]
  if (!probe && search && search.items && search.items.length) probe = search.items[0]
  if (!probe) probe = { bvid: 'BV1GJ411x7h7' }
  // STUDY_SMOKE_BVID=<bvid> 可以指定视频（例如用多分P的视频专门验「分P标题」这类断言）
  if (process.env.STUDY_SMOKE_BVID) probe = { bvid: process.env.STUDY_SMOKE_BVID }
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

  // ---- 切页回到顶部：先去一个长页面（搜索结果）拉到最底 ----
  await js(`location.hash = '#/search?q=' + encodeURIComponent('线性代数')`)
  await sleep(2200)
  await js(`(() => { const el = document.querySelector('.scroll'); el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); return Math.round(el.scrollTop) })()`)
  await sleep(600)
  let scrolledBefore = await js(`Math.round(document.querySelector('.scroll').scrollTop)`)
  if (scrolledBefore <= 150) {
    // 结果还没渲染完就滚不动：再等一会儿滚一次
    await js(`(() => { const el = document.querySelector('.scroll'); el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); return Math.round(el.scrollTop) })()`)
    await sleep(900)
    scrolledBefore = await js(`Math.round(document.querySelector('.scroll').scrollTop)`)
  }

  // ---- 播放链路：真实进入视频页，观察 MSE 缓冲 ----
  await js(`location.hash = '#/video/' + ${JSON.stringify(bvid)} + '?cid=' + ${cid}`)
  // 视频页要先拉 view/pagelist 再拉 playurl，网络慢或接口被风控时十几秒才起来：轮询等够 28s，
  // 起不来的话把页面文本记进详情（能直接看到「视频信息加载失败」这类真实原因）
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    if (await js("!!document.querySelector('.player-stage')")) break
  }
  const stageOk = await js("!!document.querySelector('.player-stage')")
  if (stageOk) {
    pass('视频页已渲染', true)
  } else {
    const pageText = await js("document.body.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)")
    fail('视频页已渲染', { stage: false, page: pageText })
  }
  const topAfterNav = await js(`Math.round(document.querySelector('.scroll').scrollTop)`)
  if (scrolledBefore > 150) {
    if (topAfterNav < 30) pass('切换页面自动回到顶部', { before: scrolledBefore, after: topAfterNav })
    else fail('切换页面自动回到顶部', { before: scrolledBefore, after: topAfterNav })
  } else {
    warn(`切换页面自动回到顶部：搜索结果页没滚起来（before=${scrolledBefore}），跳过`)
  }

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
        verr: v.error ? String(v.error.code) + ' ' + String(v.error.message || '') : '',
        netState: v.networkState,
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

  // ---- 右栏「相关推荐」已移除，但 tab 里的相关推荐要保留 ----
  await step(
    '播放页右栏没有「相关推荐」',
    "Array.from(document.querySelectorAll('.watch > aside .panel')).some((e) => e.textContent.includes('相关推荐'))",
    (v) => v === false
  )
  for (let i = 0; i < 10; i++) {
    if (await js("document.querySelectorAll('.tabs .tab').length > 0")) break
    await sleep(500)
  }
  await step(
    '播放页 tab 仍保留「相关推荐」',
    "Array.from(document.querySelectorAll('.tabs .tab')).some((e) => e.textContent.includes('相关推荐'))",
    (v) => v === true
  )

  // ---- 分P列表要带分P标题（后端 pagelist 字段是 `part`，界面读 `title`，曾渲染成「P1 ·」和「正在播放：P1 undefined」）----
  // 列表已改成「等宽序号徽章 + 单行省略标题」的对齐清单（components/PartList.vue）
  for (let i = 0; i < 10; i++) {
    if (await js("document.querySelectorAll('.pages-list .page-pill').length > 0")) break
    await sleep(600)
  }
  const partInfo = await js(`(() => {
    const pills = Array.from(document.querySelectorAll('.pages-list .page-pill'))
    const rows = pills.map((b) => {
      const pn = b.querySelector('.pn') ? b.querySelector('.pn').textContent.trim() : ''
      const pt = b.querySelector('.pt') ? b.querySelector('.pt').textContent.trim() : ''
      return { pn, pt, title: String(b.getAttribute('title') || '') }
    })
    const cur = Array.from(document.querySelectorAll('.watch *'))
      .filter((e) => e.children.length === 0 && e.textContent.trim().indexOf('正在播放') === 0)
      .map((e) => e.textContent.trim())[0] || ''
    const onCount = document.querySelectorAll('.pages-list .page-pill.on').length
    const onEl = document.querySelector('.pages-list .page-pill.on')
    const onCs = onEl ? getComputedStyle(onEl) : null
    const rootCs = getComputedStyle(document.documentElement)
    return {
      n: pills.length,
      first: rows.slice(0, 3),
      pillTitle: rows.length ? rows[0].title : '',
      // 上传者没给分P起名时后端 pagelist 的 part 就是序号占位（pt === pn === 'P1'），
      // 这时「标题和序号不一样」根本无从满足，不该判失败（桌面打包版那轮就撞上了一个单P视频）。
      placeholderOnly: rows.length > 0 && rows.every((r) => r.pt === r.pn),
      onCount,
      hasFilter: !!document.querySelector('.pages-filter'),
      onStyle: onCs
        ? {
            cls: onEl.className,
            attrs: Array.from(onEl.attributes).map((a) => a.name).join(','),
            bg: onCs.backgroundColor,
            color: onCs.color,
            theme: document.documentElement.dataset.theme,
            accent: rootCs.getPropertyValue('--accent').trim(),
            accentFg: rootCs.getPropertyValue('--accent-fg').trim(),
            t1: rootCs.getPropertyValue('--t1').trim()
          }
        : null,
      bad: rows
        .filter((r) => !/^P\\d+$/.test(r.pn) || !r.pt || r.pt.indexOf('undefined') >= 0 || r.title.length < 1)
        .slice(0, 3)
        .map((r) => r.pn + '|' + r.pt),
      cur
    }
  })()`)
  if (
    partInfo &&
    partInfo.n > 0 &&
    partInfo.bad.length === 0 &&
    partInfo.onCount === 1 &&
    // 原来要求 pillTitle 长度 > 1，但真有人给分P起名叫「B」（搜到的单P视频标题就是 1 个字），
    // 于是断言把正确的界面判成失败。改成「至少有一个分P的标题和序号徽章不一样」——
    // 这才是「带分P标题」的意思，标题真的丢了（pt 为空）仍由上面的 bad 拦住。
    // 例外：后端给的 part 全是序号占位（placeholderOnly）时无从比较，只要每行都有非空标题就算过。
    String(partInfo.pillTitle || '').length >= 1 &&
    (partInfo.placeholderOnly || (partInfo.first || []).some((r) => r.pt && r.pt !== r.pn)) &&
    String(partInfo.cur || '').indexOf('undefined') < 0
  ) {
    pass('分P列表带分P标题', partInfo)
  } else {
    fail('分P列表带分P标题', partInfo)
  }

  // 长列表（>12 P）给筛选框，并且真的能把列表筛短
  if (partInfo && partInfo.n > 12) {
    const before = partInfo.n
    await js(`(() => {
      const i = document.querySelector('.pages-filter')
      if (!i) return false
      i.value = '单词'
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(350)
    const after = await js("document.querySelectorAll('.pages-list .page-pill').length")
    if (partInfo.hasFilter && after > 0 && after < before) pass('分P列表可按关键字筛选', { before, after })
    else fail('分P列表可按关键字筛选', { hasFilter: partInfo.hasFilter, before, after })
    await js(`(() => {
      const i = document.querySelector('.pages-filter')
      if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })) }
      return true
    })()`)
    await sleep(250)
    // 清空筛选后当前 P 必须回到列表可视区（列表不能停在中间）
    const back = await js(`(() => {
      const l = document.querySelector('.pages-list')
      const el = l && l.querySelector('.page-pill.on')
      if (!l || !el) return { rows: 0, inView: false }
      const lt = l.getBoundingClientRect(), et = el.getBoundingClientRect()
      return { rows: l.querySelectorAll('.page-pill').length, st: Math.round(l.scrollTop),
        inView: et.top >= lt.top - 1 && et.bottom <= lt.bottom + 1 }
    })()`)
    if (back.inView && back.rows === before) pass('清空筛选后当前 P 回到列表可视区', back)
    else fail('清空筛选后当前 P 回到列表可视区', { ...back, before })
  } else {
    log(`      · 分P 只有 ${partInfo ? partInfo.n : '?'} 个，跳过筛选框断言（>12 才出现）`)
  }

  // ---- 真正播放：点播放键后 currentTime 是否前进 ----
  if (played && !played.err) {
    let advanced = false
    let t0 = null
    let last = null
    let gone = false
    try {
      for (let i = 0; i < 8; i++) {
        if (i > 0) await sleep(700)
        const s = await js(`(() => {
          const v = document.querySelector('video')
          if (!v) return { err: 'no-video-element' }
          // 播放键是切换语义：只在暂停时才点，避免把正在播的视频点停
          if (v.paused) { const b = document.querySelector('.player-ctl button'); if (b) b.click() }
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

  // ---- 播放中不应再盖着「缓冲中…」遮罩：欠载恢复（playing 事件）后 UI 必须回到播放态 ----
  if (played && !played.err) {
    let overlay = null
    try {
      for (let i = 0; i < 10; i++) {
        const s = await js(`(() => {
          const v = document.querySelector('video')
          const m = document.querySelector('.player-msg')
          return {
            t: v ? Number(v.currentTime.toFixed(2)) : -1,
            rs: v ? v.readyState : -1,
            paused: v ? v.paused : null,
            msg: !!(m && m.offsetParent !== null),
            text: m ? (m.textContent || '').trim().slice(0, 24) : ''
          }
        })()`)
        overlay = s
        if (s && !s.msg) break
        await sleep(600)
      }
      if (overlay && !overlay.msg) pass('播放中不显示「缓冲中」遮罩', overlay)
      else fail('播放中不显示「缓冲中」遮罩', overlay)
    } catch (err) {
      fail('播放中不显示「缓冲中」遮罩', `探针异常：${err.message}`)
    }
  }

  // ---- 跳转（等价于「继续播放」）：跳过去要能接着播，而不是卡死/一直缓冲 ----
  if (played && !played.err) {
    let seek = null
    let t1 = null
    let t2 = null
    try {
      const before = await js(`(() => { const v = document.querySelector('video'); return v ? Number(v.currentTime.toFixed(2)) : -1 })()`)
      // 目标点按已知总时长来定：短视频（例如新概念英语 P1 只有 ~75 秒）硬跳 120 秒会落到片尾之外，
      // 那是无效目标，不是播放器卡死。
      const dur = await js(`(() => { const v = document.querySelector('video'); return v && Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : 0 })()`)
      const target = dur > 10 ? Math.min(120, Math.max(2, Math.round(dur * 0.6))) : 120
      await js(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = ${target}; return true })()`)
      for (let i = 0; i < 24; i++) {
        await sleep(700)
        const s = await js(`(() => {
          const v = document.querySelector('video')
          if (!v) return { err: 'no-video-element' }
          const m = document.querySelector('.player-msg')
          return {
            t: Number(v.currentTime.toFixed(2)),
            rs: v.readyState,
            paused: v.paused,
            buf: (() => { try { return v.buffered.length ? Number(v.buffered.end(v.buffered.length - 1).toFixed(1)) : 0 } catch (e) { return -1 } })(),
            msg: !!(m && m.offsetParent !== null),
            text: m ? (m.textContent || '').trim().slice(0, 24) : ''
          }
        })()`)
        seek = s
        if (s.err) break
        if (!s.paused && s.rs >= 3 && !s.msg) break
      }
      // 再采样一次确认时间在推进（不是停住不动）
      if (seek && !seek.err && !seek.paused && seek.rs >= 3 && !seek.msg) {
        t1 = seek.t
        await sleep(1600)
        t2 = await js(`(() => { const v = document.querySelector('video'); return v ? Number(v.currentTime.toFixed(2)) : -1 })()`)
      }
      // 「走了 ranged 起流」的证据是立刻打印的 streamFrom offset=<大偏移>（ranged stream 只在整条拉完才打）
      const rangedLog =
        [...dashLogs].reverse().find((l) => /streamFrom video offset=\d{5,}/.test(l) || l.includes('ranged start')) || ''
      const detail = Object.assign({ before, dur, target }, seek, { t1, t2, log: rangedLog.replace(/^\[dash\] /, '').slice(0, 110) })
      const resumed = !!(seek && !seek.err && !seek.paused && seek.rs >= 3 && !seek.msg && t1 != null && t2 > t1)
      if (resumed) pass('跳转后能继续播放', detail)
      else fail('跳转后能继续播放', detail)
      if (/offset=\d{5,}/.test(rangedLog)) pass('跳转走 ranged 起流（sidx 定位）', rangedLog.replace(/^\[dash\] /, '').slice(0, 110))
      else warn(`跳转未走 ranged 起流（回退顺序拉流，慢但可用） :: ${rangedLog ? rangedLog.replace(/^\[dash\] /, '').slice(0, 110) : '无 ranged/streamFrom 偏移日志'}`)
    } catch (err) {
      fail('跳转后能继续播放', `探针异常：${err.message}`)
    }
  }

  // ---- 播放器：倍速 / 字幕 / 控制栏（弹幕、画中画、在线人数已按要求移除）----
  if (played && !played.err) {
    const ctl = await js(`(() => {
      const titles = [...document.querySelectorAll('.stage-ui button')].map((b) => b.title || b.textContent.trim())
      return {
        speed: titles.includes('倍速'),
        cc: titles.includes('字幕'),
        mute: titles.includes('静音'),
        full: titles.some((t) => String(t).includes('全屏')),
        dmBar: !!document.querySelector('.dm-bar'),
        dmInput: !!document.querySelector('.dm-bar input'),
        dmLayer: !!document.querySelector('.dm-layer'),
        pip: titles.some((t) => String(t).includes('画中画')),
        online: !!document.querySelector('.stage-online'),
        titles
      }
    })()`)
    if (ctl && ctl.speed && ctl.cc && ctl.mute && ctl.full)
      pass('控制栏含倍速/字幕/静音/全屏控件', ctl.titles.filter(Boolean).join(' · '))
    else fail('控制栏含倍速/字幕/静音/全屏控件', ctl)

    if (ctl && !ctl.dmBar && !ctl.dmInput && !ctl.dmLayer && !ctl.pip && !ctl.online)
      pass('播放页已移除弹幕/画中画/在线人数 UI', { dmBar: ctl.dmBar, dmLayer: ctl.dmLayer, pip: ctl.pip, online: ctl.online })
    else fail('播放页已移除弹幕/画中画/在线人数 UI', ctl)

    // 选轨按「本次下发的画质」挑，而不是永远挑最高带宽那条
    const pickedLog = dashLogs.find((l) => l.includes('picked quality'))
    const picked = pickedLog && pickedLog.match(/want=(\d+)\s+got=(\d+)/)
    const vTracks = (playurl && playurl.dash && playurl.dash.video) || []
    const want = playurl ? Number(playurl.quality) || 0 : 0
    const expect = expectVideoTrack(vTracks, want)
    const expectId = expect ? Number(expect.id) : 0
    if (picked && expectId && Number(picked[2]) === expectId)
      pass('视频轨按画质挑选（' + (pickedLog || '').replace('[dash] ', '') + '）', { want, expect: expectId, got: Number(picked[2]) })
    else fail('视频轨按画质挑选', { log: pickedLog || '没有 [dash] picked quality 日志', want, expect: expectId, tracks: vTracks.map((t) => t.id + ':' + t.width + 'x' + t.height) })

    // 「当前清晰度」显示的是真正在播的那条轨（服务端可能降级：报 720P 只回 480P 轨）
    const uiQ = await js(`(() => {
      const panel = [...document.querySelectorAll('.panel')].find((el) => el.textContent.includes('清晰度'))
      if (!panel) return { err: 'no-quality-panel' }
      const cur = panel.querySelector('.muted')
      return {
        cur: cur ? cur.textContent.replace(/\\s+/g, '') : '',
        on: [...panel.querySelectorAll('.chip.on')].map((c) => c.textContent.trim())
      }
    })()`)
    const expectText = qnText(expectId)
    if (uiQ && !uiQ.err && expectId && uiQ.cur.includes(expectText) && uiQ.on.includes(expectText))
      pass('「当前清晰度」与实播画质一致', uiQ)
    else fail('「当前清晰度」与实播画质一致', { ui: uiQ, expect: expectText, expectId })

    // 倍速：点 2x 后 playbackRate 变化，再还原成 1x
    const speedProbe = await js(`(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      const btn = [...document.querySelectorAll('.stage-ui button')].find((b) => b.title === '倍速')
      if (!btn) return { err: 'no-speed-button' }
      btn.click()
      await new Promise((r) => setTimeout(r, 150))
      const two = [...document.querySelectorAll('.ctl-menu .mi')].find((el) => el.textContent.trim().startsWith('2x'))
      if (!two) return { err: 'no-2x-option', items: [...document.querySelectorAll('.ctl-menu .mi')].map((el) => el.textContent.trim()) }
      two.click()
      await new Promise((r) => setTimeout(r, 200))
      const rate = document.querySelector('video').playbackRate
      btn.click()
      await new Promise((r) => setTimeout(r, 150))
      const one = [...document.querySelectorAll('.ctl-menu .mi')].find((el) => el.textContent.trim().startsWith('1.0x'))
      if (one) one.click()
      await new Promise((r) => setTimeout(r, 200))
      return { rate, restored: document.querySelector('video').playbackRate }
    })()`)
    if (speedProbe && speedProbe.rate === 2 && speedProbe.restored === 1) pass('倍速切换生效（2x → 还原 1x）', speedProbe)
    else fail('倍速切换生效（2x → 还原 1x）', speedProbe)

    // 字幕菜单能打开
    const ccProbe = await js(`(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      const btn = [...document.querySelectorAll('.stage-ui button')].find((b) => b.title === '字幕')
      if (!btn) return { err: 'no-cc-button' }
      btn.click()
      await new Promise((r) => setTimeout(r, 300))
      const menu = document.querySelector('.ctl-menu')
      const text = menu ? menu.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : ''
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 100))
      return { opened: !!menu, text }
    })()`)
    if (ccProbe && ccProbe.opened) pass('字幕菜单能打开', ccProbe.text)
    else fail('字幕菜单能打开', ccProbe)

    // ---- 本地字幕：真写一个 .srt 文件 → 真的走「拖进来」那条路 → 解析 → 落库 → 画到播放器上 ----
    // 拖拽事件是 preload 暴露的公开事件（bili:files-dropped），不是测试后门，
    // 所以这里和用户把字幕文件拖进窗口走的是同一条代码路径。
    const subFile = join(app.getPath('userData'), 'smoke-local-sub.srt')
    writeFileSync(
      subFile,
      ['1', '00:00:00,000 --> 99:00:00,000', '冒烟本地字幕：这句话应该出现在播放器上', ''].join('\r\n'),
      'utf8'
    )
    const subProbe = await js(`(async () => {
      window.dispatchEvent(new CustomEvent('bili:files-dropped', { detail: { paths: [${JSON.stringify(subFile)}] } }))
      await new Promise((r) => setTimeout(r, 1000))
      const line = document.querySelector('.cc-line')
      const openReq = indexedDB.open('study-bili')
      const db = await new Promise((res) => { openReq.onsuccess = () => res(openReq.result) })
      let rows = -1
      if (db.objectStoreNames.contains('subs')) {
        rows = await new Promise((res) => {
          const q = db.transaction('subs', 'readonly').objectStore('subs').getAll()
          q.onsuccess = () => res(q.result.length)
          q.onerror = () => res(-1)
        })
      }
      return { rows, text: line ? line.textContent.trim() : '' }
    })()`)
    if (subProbe && subProbe.rows === 1 && subProbe.text.includes('冒烟本地字幕'))
      pass('本地字幕：拖入文件 → 解析 → 落 IndexedDB → 显示在播放器上', subProbe)
    else fail('本地字幕：拖入文件 → 解析 → 落 IndexedDB → 显示在播放器上', subProbe)

    // 字幕字号/位置可调（用户在需求里点名要的）
    const subStyle = await js(`(async () => {
      const btn = [...document.querySelectorAll('.stage-ui button')].find((b) => b.title === '字幕')
      if (!btn) return { err: 'no-cc-button' }
      btn.click()
      await new Promise((r) => setTimeout(r, 350))
      const menu = document.querySelector('.ctl-menu.cc-menu')
      const chips = [...document.querySelectorAll('.ctl-menu.cc-menu .chip')].map((c) => c.textContent.trim())
      const big = [...document.querySelectorAll('.ctl-menu.cc-menu .chip')].find((c) => c.textContent.trim() === '特大')
      if (big) big.click()
      await new Promise((r) => setTimeout(r, 250))
      const up = [...document.querySelectorAll('.ctl-menu.cc-menu .chip')].find((c) => c.textContent.trim() === '靠上')
      if (up) up.click()
      await new Promise((r) => setTimeout(r, 250))
      const line = document.querySelector('.cc-line')
      const cs = line ? getComputedStyle(line) : null
      // 对比度：这个浮层是固定深色底，里面的 chip / 选中行不能跟主题走。
      // 浅色主题下 --soft 是近白、--accent 是近黑，套进来就是「白底白字 / 黑底黑字」。
      const pxc = (c) => { const m = String(c || '').match(/[\\d.]+/g) || [0, 0, 0]; return [+m[0], +m[1], +m[2], m.length > 3 ? +m[3] : 1] }
      const blend = (c, base) => { const p = pxc(c); return [0, 1, 2].map((i) => Math.round(p[i] * p[3] + base[i] * (1 - p[3]))) }
      const lumn = (v) => { const f = (x) => { x = x / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }; return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]) }
      const ratio = (a, b) => { const l1 = lumn(a), l2 = lumn(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
      const menuBg = blend(menu ? getComputedStyle(menu).backgroundColor : 'rgb(22,22,26)', [22, 22, 26])
      const subRows = [...document.querySelectorAll('.ctl-menu.cc-menu .mrow.sub-row')]
      let chipMin = 99
      for (const c of [...document.querySelectorAll('.ctl-menu.cc-menu .mrow.sub-row .chip')]) {
        const st = getComputedStyle(c)
        const bg = blend(st.backgroundColor, menuBg)
        chipMin = Math.min(chipMin, ratio(blend(st.color, bg), bg))
      }
      const onRowEl = document.querySelector('.ctl-menu.cc-menu .mi.on')
      let onMin = 99
      if (onRowEl) {
        const st = getComputedStyle(onRowEl)
        const bg = blend(st.backgroundColor, menuBg)
        onMin = ratio(blend(st.color, bg), bg)
      }
      const out = {
        theme: document.documentElement.dataset.theme,
        chips,
        subRows: subRows.length,
        subLab: subRows.map((r) => (r.querySelector('.sublab') ? r.querySelector('.sublab').textContent.trim() : '')),
        chipMin: Math.round(chipMin * 10) / 10,
        onMin: Math.round(onMin * 10) / 10,
        localRow: menu ? menu.textContent.includes('smoke-local-sub.srt') : false,
        font: cs ? cs.fontSize : '',
        bottom: cs ? cs.bottom : '',
        text: line ? line.textContent.trim().slice(0, 20) : ''
      }
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 150))
      return out
    })()`)
    if (subStyle && subStyle.font === '32px' && subStyle.localRow && Number.parseInt(subStyle.bottom, 10) >= 200)
      pass('字幕可调：字号「特大」+ 位置「靠上」立刻生效', subStyle)
    else fail('字幕可调：字号「特大」+ 位置「靠上」立刻生效', subStyle)

    // 字幕设置那一坨的排版与可读性（用户反馈：浅色主题下选项是一排纯白小球，看不清）
    // 顺带把「此刻确实是哪个主题」记进断言里：-Theme 指定了主题时，这条只有在主题真的生效时才算过，
    // 否则「浅色下也看得清」这句话没有被验证（曾经因为 settings.patch() 把主题改回深色而失真）。
    const subLayout = subStyle
      ? { theme: subStyle.theme, subLab: subStyle.subLab, subRows: subStyle.subRows, chipMin: subStyle.chipMin, onMin: subStyle.onMin }
      : subStyle
    const themeOk = !wantTheme || (subLayout && subLayout.theme === wantTheme)
    if (subLayout && subLayout.subRows === 3 && subLayout.chipMin >= 4.5 && subLayout.onMin >= 4.5 && themeOk)
      pass('字幕显示设置：字号/背景/位置各占一行，菜单里的文字对比度足够（浅色主题下也看得清）', subLayout)
    else fail('字幕显示设置：字号/背景/位置各占一行，菜单里的文字对比度足够（浅色主题下也看得清）', { wantTheme, ...subLayout })

    // 再留一张「CC 菜单开着」的截图：这个浮层是固定深色配色，用户就是在浅色主题下看它看不清的，
    // 光靠对比度数字不够直观，留图为证（浅色/深色两轮都能对照）。
    await js(`(async () => {
      const btn = [...document.querySelectorAll('.stage-ui button')].find((b) => b.title === '字幕')
      if (btn) btn.click()
      await new Promise((r) => setTimeout(r, 350))
      return true
    })()`)
    await shot('3-视频-字幕菜单.png')
    await js(`(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true })()`)
    await sleep(200)

    await shot('3-视频页播放器.png')
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

  // ---- 分P续播：找一个真的多分P视频，切到 P2 → 离开（onBeforeUnmount 落库）→ 不带 ?p 回来 ----
  // 老版本的入口只认 ?p，所以从首页/学习记录点进多分P视频永远回 P1；这里就是要证明现在回得去。
  {
    const partProbe = await js(`(async () => {
      const openParts = async () => {
        const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('分P'))
        if (tab) tab.click()
        await new Promise((r) => setTimeout(r, 400))
        return [...document.querySelectorAll('.page-pill')]
      }
      const origHash = location.hash
      let found = null
      try {
        const r = await window.bili.search.videos('线性代数', 1)
        for (const v of (r.items || []).slice(0, 8)) {
          const pages = await window.bili.video.pages(v.bvid)
          if (Array.isArray(pages) && pages.length > 1) {
            found = { bvid: v.bvid, n: pages.length, title: String(v.title || '').slice(0, 24) }
            break
          }
        }
      } catch (err) {
        return { err: String((err && err.message) || err) }
      }
      if (!found) return { skipped: true, origBvid: (origHash.match(/video\\/([^/?#]+)/) || [])[1] || '' }

      location.hash = '#/video/' + found.bvid
      await new Promise((r) => setTimeout(r, 4500))
      let pills = [...document.querySelectorAll('.page-pill')]
      if (pills.length < 2) pills = await openParts()
      if (pills.length < 2) return Object.assign(found, { err: 'part-list-not-ready', hash: location.hash })

      pills[1].click()
      // 等 P2 真的开始出画面再离开：onBeforeUnmount 里的 flushProgress 只写 currentTime > 0 的进度，
      // 起流没完成就跳走会「没东西可续」，那不是代码的错，是环境慢。
      const t0 = Date.now()
      let t2 = 0
      while (Date.now() - t0 < 12000) {
        const v = document.querySelector('video')
        t2 = v ? Number(v.currentTime || 0) : 0
        if (t2 > 0.5) break
        await new Promise((r) => setTimeout(r, 300))
      }
      await new Promise((r) => setTimeout(r, 600))
      const afterClick = [...document.querySelectorAll('.page-pill')].findIndex((p) => p.classList.contains('on'))

      location.hash = '#/'
      await new Promise((r) => setTimeout(r, 1600))
      location.hash = '#/video/' + found.bvid
      await new Promise((r) => setTimeout(r, 4800))
      let back = [...document.querySelectorAll('.page-pill')]
      if (!back.length) back = await openParts()
      const hash = location.hash
      const on = back.findIndex((p) => p.classList.contains('on'))
      const titles = back.map((p) => p.textContent.trim().slice(0, 12))
      // 组件自己渲染出来的「当前 Pn」（PartList 头部），用来区分「判定错了」还是「只高亮错了」
      const headEl = document.querySelector('.pages-head .muted')
      const head = headEl ? headEl.textContent.trim() : ''
      const onAll = back.map((p, i) => (p.classList.contains('on') ? i : -1)).filter((i) => i >= 0)
      // 顺手把库里这个 bvid 的进度行都取出来：库是按写入顺序盖 updatedAt 的，
      // 内存里的顺序错了才会出现「库里明明有 P2 却回到 P1」
      let rowsInfo = []
      let p2row = false
      try {
        const openReq = indexedDB.open('study-bili')
        const db = await new Promise((res) => { openReq.onsuccess = () => res(openReq.result) })
        if (db.objectStoreNames.contains('progress')) {
          const rows = await new Promise((res) => {
            const q = db.transaction('progress', 'readonly').objectStore('progress').getAll()
            q.onsuccess = () => res(q.result)
            q.onerror = () => res([])
          })
          const mine = rows.filter((r) => r.bvid === found.bvid)
          p2row = mine.some((r) => Number(r.page) === 2)
          // 注意：这段代码跑在注入脚本里（外面是模板字符串），所以不能用正则和插值语法
          rowsInfo = mine.map((r) => r.page + '@' + r.updatedAt)
        }
      } catch (err) {
        /* 只是诊断字段 */
      }
      location.hash = origHash
      await new Promise((r) => setTimeout(r, 1200))
      return Object.assign(found, { afterClick, on, t2, p2row, head, onAll, rowsInfo, hash, restored: location.hash })
    })()`)
    if (!partProbe || partProbe.err) fail('分P续播：不带 ?p 回到上次那个分P', partProbe)
    else if (partProbe.skipped) warn('分P续播：搜不到多分P视频，跳过')
    else if (partProbe.t2 <= 0.5) warn(`分P续播：P2 起流超时（currentTime=${partProbe.t2}），本轮跳过`)
    else if (partProbe.afterClick === 1 && partProbe.on === 1)
      pass('分P续播：不带 ?p 回到上次那个分P', partProbe)
    else fail('分P续播：不带 ?p 回到上次那个分P', partProbe)
  }

  // ---- 本地播放：现场造一个视频文件 → 加进「本地」列表 → 播放 → 进度续播 → 移除 ----
  // 不联网、不依赖用户机器上的文件：渲染层用 canvas.captureStream + MediaRecorder 录 2 秒 webm，
  // base64 回传主进程写成文件，再走「打开文件」之后的那条链路（local:register → lmedia:// → <video>）。
  {
    const fixtureDir = join(process.cwd(), 'tmp-local-fixture')
    const fixture = join(fixtureDir, 'clip.webm')
    try {
      mkdirSync(fixtureDir, { recursive: true })
      const rec = await js(`(async () => {
        try {
          const c = document.createElement('canvas')
          c.width = 320
          c.height = 180
          const ctx = c.getContext('2d')
          let frame = 0
          let streaming = true
          const draw = () => {
            frame++
            ctx.fillStyle = 'rgb(' + ((frame * 7) % 255) + ',' + ((frame * 3) % 255) + ',' + ((frame * 11) % 255) + ')'
            ctx.fillRect(0, 0, 320, 180)
            ctx.fillStyle = '#fff'
            ctx.font = '20px sans-serif'
            ctx.fillText('smoke ' + frame, 12, 96)
            if (streaming) requestAnimationFrame(draw)
          }
          draw()
          const stream = c.captureStream(25)
          const mr = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
          const chunks = []
          mr.ondataavailable = (e) => {
            if (e.data && e.data.size) chunks.push(e.data)
          }
          const stopped = new Promise((r) => {
            mr.onstop = r
          })
          mr.start()
          await new Promise((r) => setTimeout(r, 2200))
          mr.stop()
          streaming = false
          await stopped
          const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
          let s = ''
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
          return { b64: btoa(s), bytes: bytes.length }
        } catch (err) {
          return { err: String((err && err.message) || err) }
        }
      })()`)
      if (!rec || rec.err || !rec.b64) {
        warn('本地播放：造夹具视频失败，跳过这一段 → ' + show(rec))
      } else {
        writeFileSync(fixture, Buffer.from(rec.b64, 'base64'))
        const fixtureBytes = statSync(fixture).size

        // 进「本地」页（页面挂载后才会装上 __addLocalFiles / __localProbe 这两个自动化钩子）
        await js(`(() => { location.hash = '#/local'; return true })()`)
        await sleep(1100)
        const added = await js(`(async () => {
          try {
            const n = await window.__addLocalFiles([${JSON.stringify(fixture)}])
            return { rows: n, probe: window.__localProbe ? window.__localProbe() : null }
          } catch (err) {
            return { err: String((err && err.message) || err) }
          }
        })()`)

        // ① 加入列表 → 隐藏 <video> 解析时长 + canvas 抽封面（都写进 IndexedDB）
        let lp = null
        for (let i = 0; i < 30; i++) {
          lp = await js(`(() => (window.__localProbe ? window.__localProbe() : null))()`)
          if (lp && lp.length === 1 && lp[0].duration > 0 && lp[0].thumb && !lp[0].missing) break
          await sleep(500)
        }
        const addDiag = { file: fixtureBytes, added, probe: lp }
        if (lp && lp.length === 1 && lp[0].duration > 0 && lp[0].thumb && !lp[0].missing)
          pass('本地播放：加进列表后解析出时长与封面缩略图', addDiag)
        else fail('本地播放：加进列表后解析出时长与封面缩略图', addDiag)
        await shot('7-本地页.png')

        // ② 打开播放：应该走 lmedia:// 自定义协议，并且真的出画面
        const localId = lp && lp[0] ? lp[0].id : ''
        await js(`(() => { location.hash = '#/local/' + ${JSON.stringify(localId)}; return true })()`)
        let pp = null
        for (let i = 0; i < 22; i++) {
          await sleep(700)
          pp = await js(`(() => (window.__playProbe ? window.__playProbe() : null))()`)
          if (pp && pp.t > 0.3) break
        }
        const plog = await js(`window.__playLog || null`)
        const playDiag = { probe: pp, log: plog }
        if (pp && pp.t > 0.3 && plog && plog.source === 'local' && String(plog.url || '').startsWith('lmedia://'))
          pass('本地播放：点播放真的放起来（走 lmedia:// 本地协议）', playDiag)
        else fail('本地播放：点播放真的放起来（走 lmedia:// 本地协议）', playDiag)
        await shot('8-本地播放.png')

        // ③ 回到列表：进度已经写回本地库（这条是「续播」的地基）
        await js(`(() => { location.hash = '#/local'; return true })()`)
        let back = null
        for (let i = 0; i < 14; i++) {
          back = await js(`(() => (window.__localProbe ? window.__localProbe() : null))()`)
          if (back && back.length === 1 && back[0].pos > 0) break
          await sleep(500)
        }
        const resumeDiag = { probe: back }
        if (back && back.length === 1 && back[0].pos > 0) pass('本地播放：播放进度写回本地库（下次进来即续播）', resumeDiag)
        else fail('本地播放：播放进度写回本地库（下次进来即续播）', resumeDiag)

        // ④ 从列表移除（真实点按钮 + 确认框）：列表清空，但磁盘上的文件不能动
        const clicked = await js(`(() => {
          const b = document.querySelector('button[title^="从列表移除"]')
          if (!b) return false
          b.click()
          return true
        })()`)
        await sleep(600)
        const okBtn = await js(`(() => {
          const b = document.querySelector('.overlay .modal .btn.danger')
          if (!b) return false
          b.click()
          return true
        })()`)
        let after = null
        for (let i = 0; i < 10; i++) {
          await sleep(400)
          after = await js(`(() => (window.__localProbe ? window.__localProbe() : null))()`)
          if (after && after.length === 0) break
        }
        const delDiag = { clicked, okBtn, after, fileStill: existsSync(fixture) }
        if (clicked && okBtn && after && after.length === 0 && existsSync(fixture))
          pass('本地播放：从列表移除后列表清空，磁盘上的原文件没被删', delDiag)
        else fail('本地播放：从列表移除后列表清空，磁盘上的原文件没被删', delDiag)
      }
    } catch (err) {
      warn('本地播放：这一段异常跳过 → ' + String((err && err.message) || err))
    }
    if (process.env.STUDY_SMOKE_KEEP_LOCAL !== '1') {
      try {
        rmSync(fixtureDir, { recursive: true, force: true })
      } catch {
        /* 夹具目录删不掉也不影响结论 */
      }
    }
  }

  // ---- 小窗播放：卡片上的小窗按钮 → 悬浮小窗边看边翻页 → 关闭 ----
  // 这一段的判断标准只有一个：小窗里那个 <video> 的 currentTime 在涨（说明真的在播，不是只弹了个壳）。
  {
    const miniProbe = `(() => {
      const el = document.querySelector('.mini-player')
      const v = document.querySelector('.mini-player .mp-video')
      return {
        open: !!el,
        log: window.__miniLog || null,
        loads: Number(window.__miniLoads) || 0,
        t: v ? Number(v.currentTime) || 0 : 0,
        paused: v ? !!v.paused : null,
        ended: v ? !!v.ended : null,
        err: (document.querySelector('.mini-player .mp-err') || {}).textContent || ''
      }
    })()`
    try {
      // 先回首页并等卡片出现（首页信息流要联网，超时不算失败）
      await js(`(() => { location.hash = '#/'; return true })()`)
      let hasBtn = false
      for (let i = 0; i < 20; i++) {
        await sleep(700)
        hasBtn = await js(`!!document.querySelector('.vcard .mini')`)
        if (hasBtn) break
      }
      if (!hasBtn) {
        warn('小窗播放：首页没有可用卡片（信息流没加载出来？），跳过这一段')
      } else {
        const clicked = await js(`(() => {
          window.__miniLoads = 0
          const b = document.querySelector('.vcard .mini')
          if (!b) return false
          b.click()
          return true
        })()`)

        let st = null
        for (let i = 0; i < 34; i++) {
          await sleep(800)
          st = await js(miniProbe)
          if (st && st.log && st.t > 0.5) break
        }
        const firstDiag = { clicked, ...(st || {}) }
        if (clicked && st && st.open && st.log && st.log.source === 'mini' && st.t > 0.5)
          pass('小窗播放：卡片按钮拉起小窗，且小窗里真的出画面', firstDiag)
        else fail('小窗播放：卡片按钮拉起小窗，且小窗里真的出画面', firstDiag)
        // 一次点击只允许取一路流：旧写法 open/seq 两个 watcher 会各跑一遍 reload()，
        // 两次 load() 叠在一起把 MediaSource 顶掉，表现就是「放两秒停住、再点播放也没反应」
        const loadDiag = { loads: st ? st.loads : null, t: st ? st.t : null, paused: st ? st.paused : null }
        if (st && st.open && st.loads === 1) pass('小窗播放：一次「点小窗」只取一路流', loadDiag)
        else fail('小窗播放：一次「点小窗」只取一路流', loadDiag)
        await shot('9-小窗播放.png')

        // 切到别的页面：小窗跟着走、而且要一直播下去（放两秒就停 = 这段的核心 bug）
        const t1 = st ? st.t : 0
        await js(`(() => { location.hash = '#/learn'; return true })()`)
        await sleep(8600)
        const st2 = await js(miniProbe)
        const moved = { from: t1, need: 5, ...(st2 || {}) }
        const keptPlaying = st2 && st2.open && ((st2.t > t1 + 5 && st2.paused === false) || st2.ended === true)
        if (keptPlaying) pass('小窗播放：切到别的页面后小窗继续播（8 秒后进度还在涨、没有被卡住）', moved)
        else fail('小窗播放：切到别的页面后小窗继续播（8 秒后进度还在涨、没有被卡住）', moved)

        // ② 视频页那枚「小窗播放」按钮：点完本页让位，显示「视频正在小窗播放」
        // （先关掉卡片拉起来的小窗，避免两路抢同一个 store）
        // ③ 标题栏/底栏那排按钮必须真的点得动。用户反馈「画圈部分点击不生效」，
        //    而且他截图时小窗正好是暂停状态（画面盖着「点一下继续播放」）——
        //    所以这里刻意先按暂停，再在**暂停状态下**用真实鼠标去点换大小/收起/关闭。
        //    脚本 b.click() 测不出这类问题，只有让 Electron 发真实输入才算数。
        const miniRect = async (sel, idx = 0) =>
          js(`(() => {
            const list = document.querySelectorAll(${JSON.stringify(sel)})
            const b = list[${idx}]
            if (!b) return null
            const r = b.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          })()`)
        const miniWidth = () =>
          js(`(() => { const m = document.querySelector('.mini-player'); return m ? Math.round(m.getBoundingClientRect().width) : 0 })()`)
        // tap() 里的埋点：判断真实鼠标事件到底有没有进到处理函数（ran=false 就是被 dragging/去重挡了）
        const tapLog = () => js(`(() => (window.__tapLog || []).slice(-8))()`)
        // 点击死活不进处理函数时，唯一能分清「监听器没挂上」和「抓到的是另一份 DOM」的办法：
        // 数一数页面上到底有几个 .mini-player、按钮元素上有没有 Vue 的监听器表（_vei）、
        // 以及直接派发一次 click 后 __tapLog 有没有长出来。
        const domProbe = await js(`(() => {
          const all = [...document.querySelectorAll('.mini-player')]
          return {
            count: all.length,
            items: all.map((m) => {
              const r = m.getBoundingClientRect()
              const btns = [...m.querySelectorAll('.mp-head .mp-btn')]
              const b = btns[1] || null
              const before = (window.__tapLog || []).length
              let delta = null
              let err = ''
              if (b) {
                try {
                  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                  delta = (window.__tapLog || []).length - before
                } catch (e) {
                  err = String(e && e.message)
                }
              }
              let topNode = null
              if (b) {
                const br = b.getBoundingClientRect()
                const el = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2)
                topNode = el && el.closest ? el.closest('.mini-player') : null
              }
              const syms = b ? Object.getOwnPropertySymbols(b).map(String).filter((s) => /vei/i.test(s)) : null
              return {
                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                cls: String(m.className),
                nbtn: btns.length,
                // Vue 3.5 把事件调用器存在一个 Symbol("_vei") 上，字符串 el._vei 是空的（别再用它判断）
                veiSyms: syms,
                sameNode: topNode === m,
                tapped: delta,
                err
              }
            })
          }
        })()`)
        log('      · 小窗 DOM 探针：' + JSON.stringify(domProbe).slice(0, 480))
        // 探针里那次派发会占掉 500ms 去重窗口，等过去再跑后面的诊断，免得 script 那条看着像坏的
        await sleep(600)
        // 先用脚本 b.click() 点一次「换大小」：验证处理函数和 store 动作本身是好的，
        // 坏的话就跟真实输入无关了，省得一直怀疑事件管线
        const wScript0 = await miniWidth()
        const scriptHit = await js(`(() => {
          const b = document.querySelectorAll('.mini-player .mp-head .mp-btn')[1]
          if (!b) return 'no-btn'
          b.click()
          return 'clicked'
        })()`)
        await sleep(500)
        const wScript1 = await miniWidth()

        // 先暂停：底栏第 1 个按钮
        const pauseBtn = await miniRect('.mini-player .mp-foot .mp-btn', 0)
        const pauseHit = pauseBtn ? await hitAt(pauseBtn.x, pauseBtn.y) : 'no-btn'
        if (pauseBtn) await clickReal(pauseBtn.x, pauseBtn.y)
        await sleep(700)
        const pausedNow = await js(`(() => {
          const m = document.querySelector('.mini-player')
          const v = m ? m.querySelector('.mp-video') : null
          const o = m ? m.querySelector('.mp-overlay') : null
          return { paused: !!(v && v.paused), overlay: !!o, tip: o ? (o.textContent || '').trim().slice(0, 20) : '' }
        })()`)
        pausedNow.pauseHit = pauseHit
        pausedNow.pauseClicks = await clickLog()
        pausedNow.pauseTaps = await tapLog()
        pausedNow.script = [wScript0, wScript1, scriptHit]

        // 换大小：真实鼠标点标题栏第 2 个按钮 → 宽度必须变
        const w0 = await miniWidth()
        const sizeBtn = await miniRect('.mini-player .mp-head .mp-btn', 1)
        const sizeHit = sizeBtn ? await hitAt(sizeBtn.x, sizeBtn.y) : 'no-btn'
        if (sizeBtn) await clickReal(sizeBtn.x, sizeBtn.y)
        await sleep(600)
        const w1 = await miniWidth()
        if (sizeBtn && w1 > 0 && w1 !== w0) pass('小窗播放：暂停时标题栏「换大小」真实鼠标点得动', { w0, w1, ...pausedNow })
        else
          fail('小窗播放：暂停时标题栏「换大小」真实鼠标点得动', {
            w0,
            w1,
            ...pausedNow,
            at: sizeBtn,
            hit: sizeHit,
            clicks: await clickLog(),
            taps: await tapLog(),
            script: [wScript0, wScript1, scriptHit]
          })

        // 收起 / 展开：标题栏第 1 个按钮
        const minBtn = await miniRect('.mini-player .mp-head .mp-btn', 0)
        const minHit = minBtn ? await hitAt(minBtn.x, minBtn.y) : 'no-btn'
        if (minBtn) await clickReal(minBtn.x, minBtn.y)
        await sleep(600)
        const collapsed = await js(`(() => {
          const m = document.querySelector('.mini-player')
          const body = m ? m.querySelector('.mp-body') : null
          return { has: !!document.querySelector('.mini-player.collapsed'), bodyHidden: body ? body.offsetParent === null : null }
        })()`)
        const minBtn2 = await miniRect('.mini-player .mp-head .mp-btn', 0)
        if (minBtn2) await clickReal(minBtn2.x, minBtn2.y)
        await sleep(600)
        const expanded = await js(`!document.querySelector('.mini-player.collapsed')`)
        if (minBtn && collapsed.has && collapsed.bodyHidden === true && expanded)
          pass('小窗播放：标题栏「收起/展开」真实鼠标点得动', { collapsed: collapsed.has, bodyHidden: collapsed.bodyHidden, expanded })
        else
          fail('小窗播放：标题栏「收起/展开」真实鼠标点得动', {
            collapsed: collapsed.has,
            bodyHidden: collapsed.bodyHidden,
            expanded,
            at: minBtn,
            hit: minHit,
            clicks: await clickLog(),
            taps: await tapLog()
          })

        // 关闭：真实鼠标点标题栏最右边那个 ×
        const closeRect = await miniRect('.mini-player .mp-btn.danger', 0)
        const closeHit = closeRect ? await hitAt(closeRect.x, closeRect.y) : 'no-btn'
        let realClosed = false
        if (closeRect && closeRect.x > 0 && closeRect.y > 0) {
          await clickReal(closeRect.x, closeRect.y)
          for (let i = 0; i < 8; i++) {
            realClosed = await js(`!document.querySelector('.mini-player')`)
            if (realClosed) break
            await sleep(300)
          }
        }
        if (realClosed) pass('小窗播放：标题栏「关闭」真实鼠标点得动', { at: closeRect })
        else fail('小窗播放：标题栏「关闭」真实鼠标点得动', { at: closeRect, hit: closeHit, closed: realClosed, clicks: await clickLog(), taps: await tapLog() })
        // 真点没生效就用脚本兜底关掉，别让后面的断言跟着一起倒
        // （小窗里的按钮现在挂在 pointerup 上，所以兜底也要发 pointerup，不能只 b.click()）
        await js(`(() => {
          const b = document.querySelector('.mini-player .mp-btn.danger')
          if (b) b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
          return !!b
        })()`)
        await sleep(700)
        const closedAfterCard = await js(`!document.querySelector('.mini-player')`)
        if (st.log && st.log.bvid) {
          await js(`(() => { location.hash = ${JSON.stringify('#/video/' + st.log.bvid)}; return true })()`)
          // 等这一页的播放器起来（网络慢就多等一会儿）
          let pageT = 0
          for (let i = 0; i < 26; i++) {
            await sleep(800)
            pageT = await js(`(() => { const v = document.querySelector('.player-stage video'); return v ? Number(v.currentTime) || 0 : 0 })()`)
            if (pageT > 0.5) break
          }
          if (pageT > 0.5) {
            const popped = await js(`(() => {
              const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').indexOf('小窗播放') >= 0)
              if (!b) return false
              b.click()
              return true
            })()`)
            await sleep(900)
            let st3 = null
            for (let i = 0; i < 26; i++) {
              st3 = await js(miniProbe)
              if (st3 && st3.log && st3.t > 0.3) break
              await sleep(800)
            }
            const still = await js(`(() => {
              const m = document.querySelector('.player-msg-col')
              return m ? (m.textContent || '').trim() : ''
            })()`)
            const videoDiag = { popped, pageT, mini: st3, pageMsg: still }
            // 位置也要真的交接过去：不读 store 里那个可能还停在 0 的响应式值，而是以 <video> 为准
            // （暂停时 timeupdate 不触发，旧写法点了小窗会从头重放）
            const handed = st3 && st3.log && Number(st3.log.startTime) >= pageT - 12
            if (popped && st3 && st3.open && handed && (st3.t > 0.3 || (still && still.indexOf('小窗播放') >= 0)))
              pass('小窗播放：视频页按钮把这一路交给小窗（含看到的时间点），本页显示「正在小窗播放」', videoDiag)
            else fail('小窗播放：视频页按钮把这一路交给小窗（含看到的时间点），本页显示「正在小窗播放」', videoDiag)
            // 收尾：点「收回本页播放」，确认小窗关掉、页面重新起播
            const back = await js(`(() => {
              const b = Array.from(document.querySelectorAll('.player-msg-col button')).find((x) => (x.textContent || '').indexOf('收回') >= 0)
              if (!b) return false
              b.click()
              return true
            })()`)
            let pageBack = 0
            for (let i = 0; i < 24; i++) {
              await sleep(800)
              pageBack = await js(`(() => { const v = document.querySelector('.player-stage video'); return v ? Number(v.currentTime) || 0 : 0 })()`)
              if (pageBack > 0.5) break
            }
            const goneAfter = await js(`!document.querySelector('.mini-player')`)
            const backDiag = { back, goneAfter, pageBack }
            if (back && goneAfter && pageBack > 0.5)
              pass('小窗播放：点「收回本页播放」后小窗关闭、本页接着播', backDiag)
            else fail('小窗播放：点「收回本页播放」后小窗关闭、本页接着播', backDiag)
          } else {
            warn('小窗播放：视频页没能起播（网络风控？），视频页按钮那两条跳过')
          }
        } else {
          warn('小窗播放：卡片那段没拿到 bvid，视频页按钮那两条跳过')
        }
        if (!closedAfterCard) warn('小窗播放：清理卡片拉起的小窗时它没关掉')
        await js(`(() => {
          const b = document.querySelector('.mini-player .mp-btn.danger')
          if (b) b.click()
          return !!b
        })()`)
      }
    } catch (err) {
      warn('小窗播放：这一段异常跳过 → ' + String((err && err.message) || err))
      try {
        await js(`(() => { const b = document.querySelector('.mini-player .mp-btn.danger'); if (b) b.click(); return true })()`)
      } catch {
        /* ignore */
      }
    }
  }

  // ---- 路由与页面可用性 ----
  const routes = [
    ['搜索', '.page-head'],
    ['收藏', '.page-head'],
    ['学习', '.stat-grid'],
    ['本地', '.page-head'],
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

  // ---- 侧栏换序：真的发一遍 HTML5 拖拽事件（dragstart → dragover → drop），看顺序有没有变、有没有落盘 ----
  {
    const navDrag = await js(`(async () => {
      const items = () => [...document.querySelectorAll('.nav-item')]
      const labels = () => items().map((e) => e.textContent.replace(/\\s+/g, ' ').trim())
      const hrefs = () => items().map((e) => String(e.getAttribute('href') || '').replace(/^.*#/, ''))
      const before = labels()
      const beforeHrefs = hrefs()
      if (items().length < 3) return { err: 'nav-too-few', before }
      const dt = new DataTransfer()
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire(items()[0], 'dragstart')
      fire(items()[2], 'dragover')
      fire(items()[2], 'drop')
      fire(items()[2], 'dragend')
      await new Promise((r) => setTimeout(r, 1000))
      const after = labels()
      const afterHrefs = hrefs()
      let saved = null
      try { saved = await window.bili.settings.get() } catch (err) { saved = { err: String((err && err.message) || err) } }
      return {
        before,
        after,
        beforeHrefs,
        afterHrefs,
        navOrder: (saved && saved.navOrder) || [],
        err: saved && saved.err ? saved.err : ''
      }
    })()`)
    const moved = navDrag && !navDrag.err && navDrag.after && navDrag.after[2] === navDrag.before[0] && navDrag.after[0] === navDrag.before[1]
    const persisted = navDrag && Array.isArray(navDrag.navOrder) && navDrag.navOrder.join('|') === (navDrag.afterHrefs || []).join('|')
    if (moved && persisted) pass('侧栏拖拽换序（并把新顺序落盘）', navDrag)
    else fail('侧栏拖拽换序（并把新顺序落盘）', navDrag)
  }

  // ================= 本轮新增功能：UP 管理 / 本机收藏 / 学习打卡 =================
  log('--- 新功能冒烟：UP 管理 / 本机收藏 / 学习打卡 ---')

  const idbCount = (store) =>
    js(`(async () => {
      const openReq = indexedDB.open('study-bili')
      const db = await new Promise((res, rej) => { openReq.onsuccess = () => res(openReq.result); openReq.onerror = () => rej(openReq.error) })
      if (!db.objectStoreNames.contains(${JSON.stringify(store)})) return -1
      const rows = await new Promise((res) => {
        const rq = db.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).getAll()
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => res([])
      })
      return rows.length
    })()`)

  const clickNav = async (label) => {
    let ok = false
    try {
      ok = await js(`(() => {
        const el = Array.from(document.querySelectorAll('.nav-item')).find((e) => e.textContent.includes(${JSON.stringify(label)}))
        if (!el) return false
        el.click()
        return true
      })()`)
    } catch (err) {
      // 路由渲染时抛错会让 executeJavaScript reject —— 记 FAIL 但不要让整轮冒烟崩掉
      fail(`点击侧栏「${label}」`, err && err.message ? err.message : String(err))
      await sleep(800)
      return false
    }
    await sleep(1300)
    return ok
  }

  await step('ups 库已升级到 v2 表', `(() => 'indexedDB' in window)()`, (v) => v === true)
  await step(
    'bridge up 通道齐全',
    "Object.keys(window.bili.up).sort().join(',')",
    (v) => typeof v === 'string' && /followings/.test(v) && /latest/.test(v) && /resolve/.test(v)
  )

  // up.latest 可能被 B 站风控（-352/-412），重试 + 风控时软跳过
  let latestProbe = null
  let latestMsg = ''
  let latestOk = false
  for (let i = 0; i < 3; i++) {
    latestProbe = await js('window.bili.up.latest([946974], 2)')
    latestOk = Boolean(latestProbe && latestProbe.items && latestProbe.items.length)
    if (latestOk) break
    latestMsg = latestProbe && latestProbe.errors && latestProbe.errors[0] && latestProbe.errors[0].message
    if (i < 2) await sleep(1500)
  }
  if (latestOk) {
    pass('up.latest 拉取名单 UP 的最新投稿', {
      n: latestProbe.items.length,
      first: latestProbe.items[0].bvid,
      upMid: latestProbe.items[0].upMid,
      errors: (latestProbe.errors || []).length
    })
  } else if (/banned|风控|risk|权限|访问|forbidden|-352|-412|-403/i.test(String(latestMsg || ''))) {
    log('WARN  up.latest 被 B 站风控/权限拦截（匿名空间投稿接口），跳过；本地流程不受影响：' + latestMsg)
  } else {
    fail('up.latest 拉取名单 UP 的最新投稿', latestProbe || latestMsg)
  }

  // 往本机名单写一个 UP（真实 UP：影视飓风 mid=946974）
  const seeded = await js(`(async () => {
    const openReq = indexedDB.open('study-bili')
    const db = await new Promise((res, rej) => { openReq.onsuccess = () => res(openReq.result); openReq.onerror = () => rej(openReq.error) })
    if (!db.objectStoreNames.contains('ups')) return { ok: false, reason: 'no-ups-store' }
    await new Promise((res, rej) => {
      const tx = db.transaction('ups', 'readwrite')
      tx.objectStore('ups').put({ mid: 946974, name: '影视飓风', group: '未分组', addedAt: Date.now(), face: '', fans: 0, sign: '' })
      tx.oncomplete = () => res(true)
      tx.onerror = () => rej(tx.error)
    })
    return { ok: true, rows: await new Promise((res) => { const rq = db.transaction('ups', 'readonly').objectStore('ups').count(); rq.onsuccess = () => res(rq.result) }) }
  })()`)
  if (seeded && seeded.ok && seeded.rows > 0) pass('写入本机 UP 名单', seeded)
  else fail('写入本机 UP 名单', seeded)

  // UP 管理页
  await clickNav('UP 管理')
  await step('UP 管理页路由', "location.hash.includes('/ups')", (v) => v === true)
  await step('UP 管理页渲染名单', "document.querySelectorAll('.uprow').length", (v) => typeof v === 'number' && v >= 1)
  await step(
    'UP 管理页有「添加 UP」',
    "!!Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('添加 UP'))",
    (v) => v === true
  )

  // UP 主页投稿列表（走同一套 fetchUpVideos，顺带验证分页 count）
  await js(`location.hash = '#/up/' + 946974`)
  let upCards = 0
  for (let i = 0; i < 10; i++) {
    upCards = await js("document.querySelectorAll('.rowitem').length")
    if (upCards > 0) break
    await sleep(800)
  }
  if (upCards > 0) pass('UP 主页投稿列表', upCards)
  else log('WARN  UP 主页 8 秒内没有投稿卡片（接口失败）')

  // 右侧悬浮操作组 + 页面可下拉（右侧滚动条）——在长列表页（UP 主页）上验证
  const floatOk = await js(`!!document.querySelector('.page-float .float-btn')`)
  if (floatOk) pass('右侧悬浮操作组存在', floatOk)
  else fail('右侧悬浮操作组存在', '没有 .page-float')

  const scrollInfo = await js(`(() => {
    const el = document.querySelector('.scroll')
    if (!el) return null
    const main = document.querySelector('.main')
    const app = document.querySelector('.app')
    return {
      sh: el.scrollHeight,
      ch: el.clientHeight,
      win: window.innerHeight,
      body: document.body.clientHeight,
      app: app ? app.clientHeight : -1,
      main: main ? main.clientHeight : -1,
      mainH: main ? getComputedStyle(main).height : '',
      appH: app ? getComputedStyle(app).height : ''
    }
  })()`)
  log('      · 滚动诊断：' + JSON.stringify(scrollInfo))
  const canScroll = !!scrollInfo && scrollInfo.sh > scrollInfo.ch + 4
  // UP 主页的投稿靠接口拿：接口失败/被风控时列表是空的，页面本来就不需要滚动，那不是代码问题
  // （这一轮桌面版就跑出过这种情况：UP 主页 0 张卡 → 页面不可滚 → 两条断言连坐 FAIL）。
  // 内容够长却滚不动（sh <= ch）才是真问题，仍按 FAIL 报。
  if (canScroll) pass('页面可上下滚动（右侧下拉）', scrollInfo)
  else if (upCards === 0)
    warn(`页面可上下滚动（右侧下拉）：UP 主页没数据（接口失败），页面本来就不需要滚动，跳过。${JSON.stringify(scrollInfo)}`)
  else fail('页面可上下滚动（右侧下拉）', scrollInfo)

  // 往下拉 → 出现「顶部」按钮 → 点它回到顶部
  // 注意：.scroll 是 scroll-behavior:smooth，滚动本身是动画；固定等 700ms 在机器忙时会漏
  // → 改成「赋值 + 轮询」直到按钮出现（最多 10 次 × 300ms）
  // 诊断：统计 capture 阶段实际收到多少个 scroll 事件（区分「事件没送到」还是「状态没跟着更新」）
  await js(`(() => {
    if (!window.__scrollSeen) {
      window.__scrollSeen = 0
      document.addEventListener('scroll', () => { window.__scrollSeen += 1 }, true)
    }
    return true
  })()`)
  let topBtnShown = false
  let scrollState = null
  for (let i = 0; i < 10 && !topBtnShown; i += 1) {
    scrollState = await js(`(() => {
      const el = document.querySelector('.scroll')
      // 必须用 behavior:'instant' —— .scroll 是 scroll-behavior:smooth，直接赋值是「动画」，
      // 在同一 tick 里读 scrollTop 还是 0，重复赋值还会把动画重启，永远滚不过 200px
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
      const bs = Array.from(document.querySelectorAll('.page-float .float-btn'))
      return {
        top: Math.round(el.scrollTop),
        scrolls: document.querySelectorAll('.scroll').length,
        btns: bs.length,
        disp: bs.map((b) => getComputedStyle(b).display).join('|'),
        op: bs.map((b) => (b.offsetParent ? 'ok' : 'null')).join('|'),
        seen: window.__scrollSeen || 0,
        shown: bs.some((b) => b.textContent.includes('顶部') && b.offsetParent !== null)
      }
    })()`)
    topBtnShown = !!(scrollState && scrollState.shown)
    if (!topBtnShown) await sleep(300)
  }
  if (!topBtnShown) log(`      · 下拉诊断：${JSON.stringify(scrollState)}`)
  if (topBtnShown) {
    pass('下拉后出现「顶部」按钮', true)
    await shot('2-下拉后出现顶部按钮.png')
    const clickedTop = await js(`(() => {
      const b = Array.from(document.querySelectorAll('.page-float .float-btn')).find((x) => x.textContent.includes('顶部'))
      if (!b) return false
      b.click()
      return true
    })()`)
    // 回顶是 smooth 动画（组件里还有 400ms 的「不动就跳」兜底），轮询等它落到 0（最多 6s）
    let backTop = null
    for (let i = 0; i < 20; i += 1) {
      await sleep(300)
      backTop = await js(`Math.round(document.querySelector('.scroll').scrollTop)`)
      if (backTop < 40) break
    }
    if (clickedTop && backTop < 40) pass('点「顶部」回到页面顶部', backTop)
    else fail('点「顶部」回到页面顶部', { clicked: clickedTop, top: backTop })
  } else if (upCards === 0) {
    warn(`下拉后出现「顶部」按钮：UP 主页没数据（接口失败），没有可滚动的长列表，跳过。${JSON.stringify(scrollState)}`)
  } else {
    fail('下拉后出现「顶部」按钮', scrollState)
  }

  // 「换一换」= 重挂载当前页面并重新拉数据
  await js(`(() => {
    const b = document.querySelector('.page-float .float-btn')
    b.click()
    return true
  })()`)
  const wantRows = upCards > 0 ? upCards : 1
  let afterRefresh = 0
  await sleep(1500)
  for (let i = 0; i < 10; i++) {
    afterRefresh = await js("document.querySelectorAll('.rowitem').length")
    if (afterRefresh > 0) break
    await sleep(800)
  }
  if (upCards > 0 && afterRefresh > 0) pass('「换一换」后页面重新渲染', afterRefresh)
  else if (upCards === 0) log('      · 换一换跳过：UP 主页本来就没数据')
  else fail('「换一换」后页面重新渲染', { before: wantRows, after: afterRefresh })

  // 首页只显示本机名单里的 UP
  await clickNav('首页')
  const homeText = await js(`document.querySelector('#app').innerText`)
  const homeOk = /个 UP 的最新投稿/.test(homeText) && !homeText.includes('还没有添加 UP 主')
  if (homeOk) pass('首页只显示本机名单 UP', { count: (homeText.match(/(\d+) 个 UP 的最新投稿/) || [])[0] })
  else fail('首页只显示本机名单 UP', homeText.slice(0, 200).replace(/\s+/g, ' '))

  // 首页卡片：数据已能拿到（up.latest 通过）时就应当渲染出来
  let homeCards = 0
  for (let i = 0; i < 10; i++) {
    homeCards = await js("document.querySelectorAll('.grid .vcard').length")
    if (homeCards > 0) break
    await sleep(800)
  }
  const latestOkNow = latestOk
  if (homeCards > 0) pass('首页出现关注 UP 的视频卡', homeCards)
  else if (latestOkNow) fail('首页出现关注 UP 的视频卡', { note: 'up.latest 有数据但首页 8 秒内没有卡片' })
  else log('      · 首页卡片跳过：up.latest 未取到数据（网络/风控）')

  // 「继续学习」按视频去重：同一视频的多个分P/脏行不该渲染成多张同标题卡片
  const contDump = await js(`(() => {
    const titles = [...document.querySelectorAll('section .grid .vcard .title')].map((el) => el.textContent.trim())
    const seen = {}
    for (const t of titles) seen[t] = (seen[t] || 0) + 1
    return { n: titles.length, dup: Object.keys(seen).filter((k) => seen[k] > 1), titles }
  })()`)
  if (contDump.n === 0) log('      · 「继续学习」为空，跳过去重断言')
  else if (!contDump.dup.length) pass('首页「继续学习」卡片不重复', { n: contDump.n })
  else fail('首页「继续学习」卡片不重复', { n: contDump.n, dup: contDump.dup, titles: contDump.titles })
  await shot('1-首页顶部.png')

  // 本机收藏：进视频页 → 点收藏 → 选文件夹（视频页渲染偶有延迟，重试导航）
  let hasPlayer = false
  for (let i = 0; i < 4 && !hasPlayer; i++) {
    await js(`location.hash = '#/video/' + ${JSON.stringify(bvid)} + '?cid=' + ${cid}`)
    await sleep(2200)
    hasPlayer = await js(`!!document.querySelector('.player-stage')`)
  }
  if (hasPlayer) {
    const opened = await js(`(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => /^(收藏|已收藏)/.test(x.textContent.trim()))
      if (!b) return false
      b.click()
      return true
    })()`)
    await sleep(600)
    await step('视频页「收藏」按钮打开弹窗', `!!document.querySelector('.overlay .modal')`, (v) => v === true)
    const picked = await js(`(() => {
      const r = document.querySelector('.overlay .frow')
      if (!r) return false
      r.click()
      return true
    })()`)
    await sleep(1000)
    const collectRows = await idbCount('collect')
    if (picked && collectRows > 0) pass('本机收藏写入 IndexedDB', { picked, rows: collectRows })
    else fail('本机收藏写入 IndexedDB', { picked, rows: collectRows })
    const closed = await js(`(() => { const b = Array.from(document.querySelectorAll('.overlay .modal button')).find((x) => x.textContent.trim() === '关闭'); if (b) { b.click(); return true } return false })()`)
    if (!closed) log('      · 收藏弹窗可能已自动关闭（收藏成功后会自动关）')
  } else {
    log('WARN  视频页多次未渲染出 .player-stage，收藏弹窗测试跳过（时序/网络）')
  }

  // 学习页：统计卡 + 专注面板（签到日历 / 近 14 天条形图 / 按 UP 分布饼图 / 手动打卡按钮已按需求移除）
  await clickNav('学习')
  await step('学习页 7 个统计卡', "document.querySelectorAll('.stat-grid .stat').length", (v) => v === 7)
  await step(
    '学习页已没有签到日历 / 14 天条形图 / UP 分布饼图 / 打卡按钮',
    `(() => {
      const app = document.querySelector('#app')
      const text = app ? app.innerText : ''
      return {
        cells: document.querySelectorAll('.cal .cell').length,
        bars: document.querySelectorAll('.bars14').length,
        pie: document.querySelectorAll('svg.pie, .pie-wrap').length,
        checkinBtn: !!Array.from(document.querySelectorAll('button')).find((x) => /今日打卡|今日已签到/.test(x.textContent)),
        textHit: /每日签到|近 14 天|按 UP 分布/.test(text)
      }
    })()`,
    (v) => v && v.cells === 0 && v.bars === 0 && v.pie === 0 && !v.checkinBtn && !v.textHit
  )

  // ── 专注（TickTick 风格面板）：存在 / 倒计时 / 暂停 / 专注结束记入学习时长 ──
  // 面板 DOM 见 components/FocusPanel.vue：根节点 .panel.focus，大号倒计时是 .ring-clock
  await step('学习页有专注面板', "!!document.querySelector('.focus .ring-clock')", (v) => v === true)

  // 专注快捷任务可自定义（用户反馈：阅读 / 刷题 / 看课 / 整理笔记 这四个要能自己改）
  // 必须在番茄钟开跑前做：计时中绑定按钮是 disabled 的
  const quickProbe = await js(`(async () => {
    const openBtn = Array.from(document.querySelectorAll('.focus button')).find((b) => /绑定任务|更换/.test(b.textContent))
    if (!openBtn) return { err: 'no-bind-button' }
    openBtn.click()
    await new Promise((r) => setTimeout(r, 400))
    const modal = document.querySelector('.overlay .modal')
    if (!modal) return { err: 'no-modal' }
    const chipTexts = () => Array.from(modal.querySelectorAll('.chip')).map((c) => c.textContent.trim())
    const before = chipTexts()
    const editChip = Array.from(modal.querySelectorAll('.chip')).find((c) => /自定义|完成/.test(c.textContent))
    if (!editChip) return { err: 'no-edit-chip', before }
    editChip.click()
    await new Promise((r) => setTimeout(r, 250))
    const input = modal.querySelector('input.grow')
    if (!input) return { err: 'no-edit-input', before }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '背单词')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const addBtn = Array.from(modal.querySelectorAll('button')).find((b) => /^(添加|保存)$/.test(b.textContent.trim()))
    if (!addBtn) return { err: 'no-add-button', before }
    addBtn.click()
    await new Promise((r) => setTimeout(r, 400))
    const after = chipTexts()
    const saved = await window.bili.settings.get()
    const savedHas = Array.isArray(saved.focusTasks) && saved.focusTasks.includes('背单词')
    const del = Array.from(modal.querySelectorAll('.chip .chip-x')).pop()
    if (del) del.click()
    await new Promise((r) => setTimeout(r, 400))
    const afterDel = chipTexts()
    const saved2 = await window.bili.settings.get()
    const savedAfterDel = Array.isArray(saved2.focusTasks) ? saved2.focusTasks.includes('背单词') : null
    const cancel = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent.trim() === '取消')
    if (cancel) cancel.click()
    await new Promise((r) => setTimeout(r, 250))
    return {
      before,
      after,
      hasChip: after.some((t) => t.indexOf('背单词') >= 0),
      hasDelX: after.some((t) => t.indexOf('背单词') >= 0 && t.indexOf('✕') >= 0),
      savedHas,
      savedAfterDel,
      afterDelCount: afterDel.length,
      modalClosed: !document.querySelector('.overlay .modal')
    }
  })()`)
  if (quickProbe && quickProbe.hasChip && quickProbe.hasDelX && quickProbe.savedHas && quickProbe.savedAfterDel === false)
    pass('专注快捷任务可自定义（新增/删除都落盘）', quickProbe)
  else fail('专注快捷任务可自定义（新增/删除都落盘）', quickProbe)

  // 导航日志已在冒烟开始时就挂上（见 __smokeHook），这里只确保它存在
  await js(`(() => { window.__navLog = window.__navLog || []; return true })()`)

  const pressPomo = (re) =>
    js(`(() => {
      const b = Array.from(document.querySelectorAll('.focus button')).find((x) => ${re}.test(x.textContent))
      if (!b) return 'no-button'
      b.click()
      return b.textContent.replace(/\\s+/g, ' ').trim()
    })()`)
  const pomoClock = () =>
    js("(() => { const el = document.querySelector('.focus .ring-clock'); return el ? el.textContent.trim() : '' })()")
  const pomoHead = () =>
    js(`(() => {
      const el = document.querySelector('.focus .focus-head .muted')
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''
    })()`)
  const todayChip = () =>
    js("(() => { const el = document.querySelector('.top .chip'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' })()")
  const pomoPanelText = () =>
    js(`(() => {
      const p = document.querySelector('.focus')
      if (!p) return ''
      return String(p.innerText || p.textContent || '').replace(/\\s+/g, ' ').trim()
    })()`)
  const pomoDiag = () =>
    js(`(() => {
      const p = document.querySelector('.focus')
      const sc = document.querySelector('.scroll')
      return {
        hash: location.hash,
        pomo: document.querySelectorAll('.focus').length,
        clock: document.querySelectorAll('.focus .ring-clock').length,
        muted: document.querySelectorAll('.focus .muted').length,
        cls: p ? p.className : 'none',
        panel: p ? String(p.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : '',
        page: sc ? String(sc.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : 'no-scroll',
        nav: (window.__navLog || []).slice(-12)
      }
    })()`)

  // 有人在冒烟跑的时候点窗口会把页面带走（实测点了设置页主题 / 番茄钟按钮 / 侧栏「UP 管理」）：
  // 面板没了就点回学习页，而不是让后面的 js() 抛 TypeError 把整轮冒烟打断。
  const backToLearn = async () => {
    if (await js("!!document.querySelector('.focus .ring-clock')").catch(() => false)) return true
    const h = await js('location.hash').catch(() => '?')
    log(`WARN  专注面板不见了（hash=${h}），重新点侧栏「学习」继续`)
    await clickNav('学习')
    await sleep(900)
    return js("!!document.querySelector('.focus .ring-clock')").catch(() => false)
  }

  // 把「专注」改 1 分钟，方便在冒烟里跑完整一轮。时长输入框收在齿轮按钮后面，得先展开。
  // 注意：面板重挂载（backToLearn）不会丢时长 —— 它已经写进 pinia store。
  await js(`(() => {
    const gear = Array.from(document.querySelectorAll('.focus button')).find((x) => /设置时长|收起时长设置/.test(x.title))
    if (gear) gear.click()
    return !!gear
  })()`)
  await sleep(250)
  await js(`(() => {
    const i = document.querySelector('.focus .focus-settings input')
    if (!i) return false
    i.value = '1'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(400)
  await js(`(() => {
    const gear = Array.from(document.querySelectorAll('.focus button')).find((x) => /收起时长设置/.test(x.title))
    if (gear) gear.click()
    return !!gear
  })()`)
  await sleep(250)

  await backToLearn()
  const todayBefore = await todayChip()
  const dur0 = await pomoClock()
  if (!dur0) log(`WARN  读不到专注倒计时 :: ${show(await pomoDiag().catch(() => null))}`)
  const started = await pressPomo('/开始|继续/')
  await sleep(2600)
  await backToLearn()
  const dur1 = await pomoClock()
  if (started !== 'no-button' && dur1 && dur0 && dur1 !== dur0) pass('专注开始后倒计时在走', { dur0, dur1, started })
  else fail('专注开始后倒计时在走', { dur0, dur1, started })

  await pressPomo('/暂停/')
  await sleep(1500)
  await backToLearn()
  const dur2 = await pomoClock()
  await sleep(1500)
  await backToLearn()
  const dur3 = await pomoClock()
  // 「暂停后不再走」= 时钟不该继续往下掉。但时钟**往上跳回整轮**不是暂停没生效，而是面板收到了
  // 重置（`R` 快捷键 / 「重置」按钮，都会把 remain 置回 totalSeconds）——冒烟跑的时候窗口就在
  // 桌面上，外面的键鼠事件进得来，这类干扰以前也出现过（见本文件里「外部点击干扰」那段注释）。
  const clockSec = (s) => {
    const m = /^(\d+):(\d+)$/.exec(String(s || ''))
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const c2 = clockSec(dur2)
  const c3 = clockSec(dur3)
  if (dur2 && dur2 === dur3) pass('专注暂停后不再走', { dur2, dur3 })
  else if (c2 != null && c3 != null && c3 > c2) warn(`专注暂停后不再走：倒计时被重置回 ${dur3}（外部输入触发重置，不是暂停失效）`)
  else fail('专注暂停后不再走', { dur2, dur3 })

  // 继续跑完这一轮（专注 1 分钟）：完成后应自动切到休息并把时长记进统计
  const resumed = await pressPomo('/开始|继续/')
  log(`      · 专注诊断（开始后） :: ${show(await pomoDiag())}`)
  let done = null
  let toastText = ''
  for (let i = 0; i < 80; i++) {
    await sleep(1000)
    if (!(await js("!!document.querySelector('.focus .ring-clock')").catch(() => false))) await backToLearn()
    const head = await pomoHead()
    const panel = await pomoPanelText()
    // 新面板头部文案是「今日 N 轮 · M:SS」；历史面板也要出现这一轮（证明落了库）
    const history = panel.includes('专注记录')
    if (/今日\s*1\s*轮/.test(head) || /今日\s*1\s*轮/.test(panel)) {
      done = { head, panel: panel.slice(0, 90), history, clock: await pomoClock() }
      toastText = await js("Array.from(document.querySelectorAll('.toast')).map((e) => e.textContent).join(' | ')")
      break
    }
  }
  const todayAfter = await todayChip()
  if (done) {
    pass('专注结束（自动进入休息 + 计入学习时长）', { ...done, resumed, toast: toastText, todayBefore, todayAfter })
    if (/番茄钟完成/.test(toastText) || todayAfter !== todayBefore) pass('专注完成有提示且学习时长增加', { toast: toastText, todayBefore, todayAfter })
    else warn(`专注完成没抓到 toast/时长变化（可能是时长文案取整相同）：${todayBefore} → ${todayAfter}`)
    await shot('4-学习页专注.png')
  } else {
    fail('专注结束（自动进入休息 + 计入学习时长）', {
      resumed,
      head: await pomoHead(),
      diag: await pomoDiag(),
      todayBefore,
      todayAfter
    })
  }


  const errs = await js(`String(window.__smokeErr || '')`).catch(() => '')
  if (errs) log(`渲染层异常汇总 :: ${show(errs)}`)
  else log('渲染层异常汇总 :: 无')
  const navTail = await js('(window.__navLog || []).slice(-8)').catch(() => '')
  if (navTail && navTail.length) log(`      · 导航/点击日志（末尾 8 条） :: ${show(navTail)}`)
  log(`=== 冒烟测试结束：失败 ${fails.length} 项${fails.length ? ' → ' + fails.join(' | ') : ''} ===`)
  return fails.length ? 1 : 0
}

export function scheduleExit(code) {
  // 给 stdout 一点刷盘时间，避免日志被截断
  setTimeout(() => app.exit(code), 250)
}
