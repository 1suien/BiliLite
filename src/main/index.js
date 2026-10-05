import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { store } from './store.js'
import { registerIpc } from './ipc.js'
import { BASE_HEADERS } from './bili/http.js'

// 主进程以 CJS 打包（package.json 未声明 type=module），__dirname 可直接使用。
let mainWindow = null

// 绿色/便携模式：把用户数据目录指到指定位置（也方便在受限环境里跑自检）。
// 必须在任何 app.getPath('userData') 调用之前设置，因此放在模块顶层。
if (process.env.STUDY_USER_DATA) {
  try {
    app.setPath('userData', process.env.STUDY_USER_DATA)
  } catch (err) {
    console.warn('[study-bili] 设置 userData 失败：', err && err.message)
  }
}

const MEDIA_HOSTS = ['bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'hdslb.com']
const IMAGE_HOSTS = ['hdslb.com', 'biliimg.com']

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith('.' + h))
}

/**
 * B 站 CDN 校验 Referer，且不允许跨域读取分片。
 * 渲染层用普通 fetch/XHR 拉 fMP4，因此这里统一注入 Referer 与 CORS 头。
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
    if (hostMatches(host, MEDIA_HOSTS.concat(IMAGE_HOSTS))) {
      details.requestHeaders.Referer = 'https://www.bilibili.com/'
      details.requestHeaders.Origin = 'https://www.bilibili.com'
      details.requestHeaders['User-Agent'] = BASE_HEADERS['User-Agent']
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  ses.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || ''
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return callback({ responseHeaders: details.responseHeaders })
    }
    if (hostMatches(host, MEDIA_HOSTS)) {
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
    title: '学习 B 站',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 端到端冒烟测试入口：只在显式设置环境变量时载入，正常运行不会走到这里
  if (process.env.STUDY_SMOKE) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const { runSmoke, scheduleExit } = await import('./smoke.js')
        scheduleExit(await runSmoke(mainWindow))
      } catch (err) {
        console.error('[smoke] 运行崩溃：', err)
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
    store.load()
    installNetworkHooks()
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
