import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { store } from './store.js'
import { registerIpc } from './ipc.js'
import { BASE_HEADERS } from './bili/http.js'
import { registerLocalScheme, installLocalProtocol } from './local-media.js'

// 本地视频的 lmedia:// 自定义协议必须在 app ready 之前登记特权
registerLocalScheme()

// 主进程以 CJS 打包（package.json 未声明 type=module），__dirname 可直接使用。
let mainWindow = null
// 冒烟测试进行中：期间不允许关窗（手快点到 X 会让测试半路消失、报告残缺）
let smokeRunning = false

// 绿色/便携模式：把用户数据目录指到指定位置（也方便在受限环境里跑自检）。
// 必须在任何 app.getPath('userData') 调用之前设置，因此放在模块顶层。
if (process.env.STUDY_USER_DATA) {
  try {
    app.setPath('userData', process.env.STUDY_USER_DATA)
  } catch (err) {
    console.warn('[bililite] 设置 userData 失败：', err && err.message)
  }
} else {
  // 应用已改名（学习 B 站 → BiliLite），Electron 默认会跟着 productName 换到新的 userData 目录；
  // 这里固定回原来的 study-bili，保证登录态、学习记录、番茄钟设置都不丢。
  try {
    app.setName('BiliLite')
    app.setPath('userData', join(app.getPath('appData'), 'study-bili'))
  } catch (err) {
    console.warn('[bililite] 固定 userData 失败：', err && err.message)
  }
}

const IMAGE_HOSTS = ['hdslb.com', 'biliimg.com']

/**
 * 媒体线路的域名规则。
 * 以前这里是一张写死的白名单（bilivideo.com / bilivideo.cn / akamaized.net / hdslb.com），
 * 但 B 站 CDN 会临时开出各种主机：upos-sz-*.bilivideo.com、xy116x196x140x59xy.mcdn.bilivideo.cn:8082、
 * b-baaa1gvj119u13vbgs9iegnauj0c.edge.mountaintoys.cn:4483……白名单漏掉一个，那条线就必然
 * 「拉流失败：Failed to fetch」（没 Referer → CDN 403；没有可读的 CORS 头 → 渲染层只能看到 TypeError）。
 * 所以改成按规则判断，并且把 Range 请求头当成更强的信号。
 */
const MEDIA_HOST_RULES = [
  /(^|\.)bilivideo\.(com|cn|net)$/i,
  /(^|\.)akamaized\.net$/i,
  /(^|\.)hdslb\.com$/i,
  /(^|\.)biliimg\.com$/i,
  /(^|\.)mcdn\./i,
  /^\d+x\d+x\d+x\d+xy\./i,
  /(^|\.)edge\./i
]

// 响应侧判定用的 content-type（音视频分片、fMP4 的 init 段、HLS 清单）
const MEDIA_TYPE_RE = /^(video|audio)\//i
const MEDIA_APP_TYPE_RE = /^application\/(octet-stream|vnd\.apple\.mpegurl|x-mpegurl)/i

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith('.' + h))
}

function isMediaHost(host) {
  return !!host && MEDIA_HOST_RULES.some((re) => re.test(host))
}

/** 请求/响应头大小写不敏感取一个值 */
function headerValue(headers, name) {
  if (!headers) return ''
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? String(headers[key]) : ''
}

/**
 * 是不是媒体拉流请求。
 * 分段拉流一定带 Range，这是最可靠的信号；没有 Range 时（例如 fMP4 的首个请求）
 * 退回按域名规则判断。注意这里的兜底只用来「补 Referer / 补 CORS 头」，
 * 对普通 API 请求注入这两个头也没有副作用。
 */
function looksLikeMediaRequest(url, headers) {
  if (headerValue(headers, 'range')) return true
  try {
    return isMediaHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** 响应像不像音视频分片：按 content-type / Accept-Ranges 判断，避免再漏掉未收录的线路域名 */
function looksLikeMediaResponse(url, headers) {
  const type = headerValue(headers, 'content-type')
  if (MEDIA_TYPE_RE.test(type) || MEDIA_APP_TYPE_RE.test(type)) return true
  if (/bytes/i.test(headerValue(headers, 'accept-ranges'))) return true
  try {
    return isMediaHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * B 站 CDN 校验 Referer，且不允许跨域读取分片。
 * 渲染层用普通 fetch/XHR 拉 fMP4，因此这里统一注入 Referer 与 CORS 头。
 * 是否媒体由 looksLikeMediaRequest / looksLikeMediaResponse 判定（Range 头 + 域名规则 + 响应类型），
 * 不再依赖写死的域名白名单。
 */
function installNetworkHooks() {
  const ses = session.defaultSession

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || ''
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return callback({ requestHeaders: details.requestHeaders })
    }
    if (looksLikeMediaRequest(url, details.requestHeaders) || hostMatches(host, IMAGE_HOSTS)) {
      details.requestHeaders.Referer = 'https://www.bilibili.com/'
      details.requestHeaders.Origin = 'https://www.bilibili.com'
      details.requestHeaders['User-Agent'] = BASE_HEADERS['User-Agent']
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  ses.webRequest.onHeadersReceived((details, callback) => {
    if (looksLikeMediaResponse(details.url || '', details.responseHeaders)) {
      const headers = { ...(details.responseHeaders || {}) }
      for (const key of Object.keys(headers)) {
        if (/^access-control-/i.test(key)) delete headers[key]
      }
      headers['Access-Control-Allow-Origin'] = ['*']
      headers['Access-Control-Allow-Headers'] = ['*']
      headers['Access-Control-Allow-Methods'] = ['GET,HEAD,OPTIONS']
      headers['Access-Control-Expose-Headers'] = ['Content-Length,Content-Range,Accept-Ranges']
      return callback({ responseHeaders: headers })
    }
    callback({ responseHeaders: details.responseHeaders })
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    title: 'BiliLite',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 番茄钟要在窗口被挡住/最小化时照样走完（Chromium 默认会把后台窗口的定时器限流到 1 次/分钟，
      // 那样倒计时会「停住」，播放器也会被限流）；学习类应用需要它一直在跑。
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 端到端冒烟测试入口：只在显式设置环境变量时载入，正常运行不会走到这里
  if (process.env.STUDY_SMOKE) {
    mainWindow.on('close', (e) => {
      if (smokeRunning) e.preventDefault()
    })
    mainWindow.webContents.once('did-finish-load', async () => {
      smokeRunning = true
      try {
        const { runSmoke, scheduleExit } = await import('./smoke.js')
        const code = await runSmoke(mainWindow)
        smokeRunning = false
        scheduleExit(code)
      } catch (err) {
        smokeRunning = false
        console.error('[smoke] 运行崩溃：', err)
        // 崩了就再也读不到报告了：把渲染层的现场（异常栈 + 导航/点击日志）抢救出来
        try {
          const dump = await mainWindow.webContents.executeJavaScript(
            "(() => ({ hash: location.hash, err: String(window.__smokeErr || '').slice(-600), nav: (window.__navLog || []).slice(-10) }))()",
            true
          )
          console.error('[smoke] 崩溃现场 ::', JSON.stringify(dump))
        } catch (err2) {
          console.error('[smoke] 崩溃现场读取失败：', err2)
        }
        app.exit(1)
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // Windows 上要给进程一个 AppUserModelID，习惯打卡的「到点提醒」走系统通知时
    // 才会以 BiliLite 自己的身份出现（否则通知可能被系统丢掉或显示成 electron.app.*）
    try {
      app.setAppUserModelId('com.bililite.desktop')
    } catch (err) {
      console.warn('[app] setAppUserModelId 失败：', err && err.message)
    }
    store.load()
    installNetworkHooks()
    installLocalProtocol()
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
