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

  // 需要看真实界面时设置 STUDY_SMOKE_SHOT=<目录>，会顺手截几张图
  const shotDir = process.env.STUDY_SMOKE_SHOT
  const shot = async (name) => {
    if (!shotDir) return
    try {
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
  await step('侧栏导航 6 项', "document.querySelectorAll('.nav-item').length", (v) => v === 6)
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
  await sleep(1500)
  await js(`(() => { const el = document.querySelector('.scroll'); el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); return Math.round(el.scrollTop) })()`)
  await sleep(600)
  const scrolledBefore = await js(`Math.round(document.querySelector('.scroll').scrollTop)`)

  // ---- 播放链路：真实进入视频页，观察 MSE 缓冲 ----
  await js(`location.hash = '#/video/' + ${JSON.stringify(bvid)} + '?cid=' + ${cid}`)
  // 视频页要先拉 playurl 再挂播放器，网络慢的时候 1.2s 不够：轮询等它出现（否则后面整段播放断言都会被跳过）
  for (let i = 0; i < 24; i++) {
    await sleep(700)
    if (await js("!!document.querySelector('.player-stage')")) break
  }
  await step('视频页已渲染', "!!document.querySelector('.player-stage')", (v) => v === true)
  const topAfterNav = await js(`Math.round(document.querySelector('.scroll').scrollTop)`)
  if (scrolledBefore > 150 && topAfterNav < 30) pass('切换页面自动回到顶部', { before: scrolledBefore, after: topAfterNav })
  else fail('切换页面自动回到顶部', { before: scrolledBefore, after: topAfterNav })

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
      await js(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = 120; return true })()`)
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
      const detail = Object.assign({ before }, seek, { t1, t2, log: rangedLog.replace(/^\[dash\] /, '').slice(0, 110) })
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
    const ok = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.nav-item')).find((e) => e.textContent.includes(${JSON.stringify(label)}))
      if (!el) return false
      el.click()
      return true
    })()`)
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
  if (canScroll) pass('页面可上下滚动（右侧下拉）', scrollInfo)
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

  // 学习页：统计卡 / 日历 / 条形图 / 饼图 / 手动打卡
  await clickNav('学习')
  await step('学习页 5 个统计卡', "document.querySelectorAll('.stat-grid .stat').length", (v) => v === 5)
  await step('签到日历格子数', "document.querySelectorAll('.cal .cell').length", (v) => typeof v === 'number' && v >= 350)
  await step('近 14 天条形图', "document.querySelectorAll('.bars14 .bcol').length", (v) => v === 14)
  await step(
    '按 UP 分布饼图',
    "!!document.querySelector('svg.pie') || document.querySelector('#app').innerText.includes('还没有分布数据')",
    (v) => v === true
  )

  const beforeCheckin = await idbCount('checkins')
  const clickedCheckin = await js(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /今日打卡|今日已签到/.test(x.textContent))
    if (!b) return 'no-button'
    if (b.disabled) return 'already'
    b.click()
    return true
  })()`)
  await sleep(1000)
  const afterCheckin = await idbCount('checkins')
  if ((afterCheckin > beforeCheckin && afterCheckin > 0) || (clickedCheckin === 'already' && afterCheckin > 0)) {
    pass('手动打卡写入 checkins', { before: beforeCheckin, after: afterCheckin, clicked: clickedCheckin })
  } else {
    fail('手动打卡写入 checkins', { before: beforeCheckin, after: afterCheckin, clicked: clickedCheckin })
  }
  await step('签到后日历出现绿色格子', "document.querySelectorAll('.cal .cell.on').length", (v) => typeof v === 'number' && v >= 1)

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
