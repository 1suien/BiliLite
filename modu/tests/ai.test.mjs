/**
 * ai.ts 的 node 测试：本地 mock OpenAI 兼容 SSE 服务，验证流式解析 / 错误映射 / 上下文裁剪。
 *
 * 为什么不直接 import '../src/lib/ai.ts'：
 *   Node 24 的类型擦除是 strip-only 模式，不支持构造函数参数属性，
 *   而契约要求 `constructor(message: string, readonly kind: ...)`，
 *   直接 import 会报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（parameter property）。
 *   另外 ai.ts 里 `@/db` 只是 type-only import（会被擦掉）。所以先用项目里已有的
 *   esbuild 打成 /tmp/ai.bundle.mjs 再动态 import；类型仍由 vue-tsc 校验。
 *
 * 运行：cd /root/readawre/app && node tests/ai.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundlePath = path.join(os.tmpdir(), 'ai.bundle.mjs')
const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild')

const build = spawnSync(
  esbuild,
  ['src/lib/ai.ts', '--bundle', '--format=esm', '--platform=node', '--log-level=warning', '--outfile=' + bundlePath],
  { cwd: root, encoding: 'utf8' },
)
if (build.status !== 0) {
  console.error('esbuild 打包 ai.ts 失败：')
  console.error(build.stderr || build.error || ('exit ' + build.status))
  process.exit(1)
}

const { AiError, chatEndpoint, estimateTokens, trimMessages, streamChat } = await import(
  pathToFileURL(bundlePath).href
)

// ---------- 断言小工具 ----------

let passed = 0
let failed = 0

function pass(name) {
  passed++
  console.log('PASS ' + name)
}

async function test(name, fn) {
  try {
    await fn()
    pass(name)
  } catch (e) {
    failed++
    console.error('FAIL ' + name)
    console.error(String((e && e.stack) || e).replace(/^/gm, '  '))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 断言 reject 的是 AiError 且 kind / message 符合预期 */
async function rejectsAi(fn, kind, message) {
  let caught
  try {
    await fn()
  } catch (e) {
    caught = e
  }
  assert.ok(caught, '应当抛错，实际成功返回')
  assert.ok(caught instanceof AiError, '应当抛 AiError，实际：' + caught)
  assert.equal(caught.kind, kind, 'kind 不对：' + caught.kind + ' / ' + caught.message)
  if (message) assert.equal(caught.message, message)
  return caught
}

// ---------- mock OpenAI 兼容服务 ----------

const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
}

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n'
const delta = (text) => sse({ choices: [{ delta: { content: text } }] })

// 最后一次流式请求的现场，用来核对请求体
const seen = { body: null, auth: null, contentType: null }

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('error', () => {})
  res.on('error', () => {})

  req.on('end', async () => {
    const url = (req.url || '').split('?')[0]
    let payload = null
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* 不是 JSON 就当没有 */
    }

    if (!url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const route = url.slice(0, url.length - '/chat/completions'.length) || '/'

    if (route === '/v1') {
      seen.body = payload
      seen.auth = req.headers.authorization
      seen.contentType = req.headers['content-type']
      res.writeHead(200, sseHeaders)
      // 混合几种写法：注释、event: 行、reasoning_content、CRLF 分隔、一个事件多行 data:
      const parts = [
        ': keep-alive\n\n',
        'event: message\n' + sse({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
        sse({ choices: [{ delta: { reasoning_content: '（思考中，应忽略）' } }] }),
        delta('你好').replace('\n\n', '\r\n\r\n'),
        delta('，我是'),
        sse({ choices: [{ delta: { content: '墨读' } }] }) + sse({ choices: [{ delta: { content: ' AI' } }] }),
        delta('助手。'),
        'data: [DONE]\n\n',
      ]
      for (const part of parts) {
        if (res.destroyed || res.writableEnded) return
        res.write(part)
        await sleep(5)
      }
      res.end()
      return
    }

    if (route === '/slow') {
      res.writeHead(200, sseHeaders)
      res.write(delta('开头'))
      await sleep(800)
      if (!res.destroyed && !res.writableEnded) {
        res.write(delta('结尾'))
        res.end()
      }
      return
    }

    if (route === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: '这是非流式回复。' }, finish_reason: 'stop' }],
        }),
      )
      return
    }

    if (route === '/text') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ choices: [{ text: '旧式文本回复' }] }))
      return
    }

    if (route === '/err') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }

    if (route === '/forbidden') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'forbidden' } }))
      return
    }

    if (route === '/nf') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    if (route === '/many') {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limited' } }))
      return
    }

    if (route === '/boom') {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('服务器炸了')
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no route ' + route } }))
  })
})

server.on('clientError', (err, socket) => socket.destroy())
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const base = 'http://127.0.0.1:' + port
const settings = (suffix, over = {}) => ({
  baseUrl: base + suffix,
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  ...over,
})
const messages = [
  { role: 'system', content: '你是墨读 AI 助手' },
  { role: 'user', content: '你好' },
]

// ---------- 用例 ----------

await test('chatEndpoint 归一化三种 baseUrl 写法', () => {
  assert.equal(chatEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(chatEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(chatEndpoint('https://api.openai.com/v1//'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(
    chatEndpoint('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  )
  assert.equal(
    chatEndpoint('  https://api.openai.com/v1/chat/completions/  '),
    'https://api.openai.com/v1/chat/completions',
  )
  assert.equal(chatEndpoint('https://proxy.example.com'), 'https://proxy.example.com/chat/completions')
  assert.equal(chatEndpoint(''), '')
})

await test('estimateTokens 正数且量级合理', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好世界'), 4) // 中文 1 字 1 token
  assert.equal(estimateTokens('中'.repeat(100)), 100)
  assert.equal(estimateTokens('a'.repeat(400)), 100) // 英文 4 字符 1 token
  assert.ok(estimateTokens('hello') > 0)
  assert.ok(estimateTokens('hello world') <= 5 && estimateTokens('hello world') >= 2)
  assert.ok(estimateTokens('你好，世界！') >= 5) // 全角标点也算 1 token
})

await test('trimMessages 预算足够时全保留且 system 在最前', () => {
  const sys = { role: 'system', content: '你是墨读的读书助手。' }
  const convo = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: '第三问' },
  ]
  const out = trimMessages([sys, ...convo], 1000)
  assert.equal(out.length, 6)
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, sys.content)
  assert.deepEqual(out.slice(1), convo)
})

await test('trimMessages 预算小：保留 system 与最新消息，总数不超预算', () => {
  const sys = { role: 'system', content: '你是墨读的读书助手。' } // 10 token
  const convo = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: '第三问' },
  ]
  const before = JSON.parse(JSON.stringify(convo))
  const budget = 16
  const out = trimMessages([sys, ...convo], budget)
  assert.equal(out[0].role, 'system', 'system 必须保留且在最前')
  assert.equal(out[out.length - 1].role, 'user', '最后一条必须是 user')
  assert.equal(out[out.length - 1].content, '第三问')
  const total = out.reduce((n, m) => n + estimateTokens(m.content), 0)
  assert.ok(total <= budget, '总 token ' + total + ' 应 <= ' + budget)
  assert.deepEqual(convo, before, '不应改动传入数组')
})

await test('trimMessages 预算不够时截断最后一条 user 正文', () => {
  const sys = { role: 'system', content: '你是墨读的读书助手。' } // 10 token
  const convo = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第三问' },
  ]
  const budget = 12
  const out = trimMessages([sys, ...convo], budget)
  assert.equal(out.length, 2)
  assert.equal(out[1].role, 'user')
  assert.equal(out[1].content, '第三') // 只剩 2 token
  const total = out.reduce((n, m) => n + estimateTokens(m.content), 0)
  assert.ok(total <= budget)
})

await test('trimMessages 只保留第一条 system', () => {
  const out = trimMessages(
    [
      { role: 'system', content: '设定一' },
      { role: 'system', content: '设定二' },
      { role: 'user', content: '问题' },
    ],
    100,
  )
  assert.equal(out.filter((m) => m.role === 'system').length, 1)
  assert.equal(out[0].content, '设定一')
})

await test('trimMessages 没有 system 时也能工作', () => {
  const out = trimMessages([{ role: 'user', content: '只有一句' }], 10)
  assert.equal(out.length, 1)
  assert.equal(out[0].content, '只有一句')
})

await test('streamChat 累加完整文本并按增量调用 onDelta', async () => {
  const deltas = []
  const text = await streamChat(settings('/v1'), messages, { onDelta: (d) => deltas.push(d) })
  assert.equal(text, '你好，我是墨读 AI助手。')
  assert.ok(deltas.length >= 2, 'onDelta 至少 2 次，实际 ' + deltas.length)
  assert.equal(deltas.join(''), text)
  assert.ok(!deltas.join('').includes('思考中'), 'reasoning_content 不应混进正文')
})

await test('streamChat 请求体 / 鉴权头符合 OpenAI 兼容约定', () => {
  assert.equal(seen.auth, 'Bearer sk-test')
  assert.match(String(seen.contentType), /application\/json/)
  assert.equal(seen.body.model, 'gpt-4o-mini')
  assert.equal(seen.body.stream, true)
  assert.equal(seen.body.temperature, 0.7)
  assert.deepEqual(seen.body.messages, messages)
})

await test('streamChat 兼容直接填完整 endpoint', async () => {
  const text = await streamChat(settings('/v1/chat/completions'), messages)
  assert.equal(text, '你好，我是墨读 AI助手。')
})

await test('streamChat 非流式 JSON 回退（message.content）', async () => {
  const deltas = []
  const text = await streamChat(settings('/json'), messages, { onDelta: (d) => deltas.push(d) })
  assert.equal(text, '这是非流式回复。')
  assert.deepEqual(deltas, ['这是非流式回复。'])
})

await test('streamChat 兼容 choices[0].text', async () => {
  const text = await streamChat(settings('/text'), messages)
  assert.equal(text, '旧式文本回复')
})

await test('401 映射为 config 错误', async () => {
  await rejectsAi(() => streamChat(settings('/err'), messages), 'config', 'Key 无效或无权限')
})

await test('403 映射为 config 错误', async () => {
  await rejectsAi(() => streamChat(settings('/forbidden'), messages), 'config', 'Key 无效或无权限')
})

await test('404 映射为接口地址错误', async () => {
  await rejectsAi(() => streamChat(settings('/nf'), messages), 'config', '接口地址不对')
})

await test('429 映射为请求太频繁', async () => {
  await rejectsAi(() => streamChat(settings('/many'), messages), 'http', '请求太频繁')
})

await test('其它状态码带状态 + body 片段', async () => {
  const err = await rejectsAi(() => streamChat(settings('/boom'), messages), 'http')
  assert.ok(err.message.includes('500'), '应含状态码：' + err.message)
  assert.ok(err.message.includes('服务器炸了'), '应含 body 片段：' + err.message)
})

await test('abort 映射为 abort 错误（流中途取消）', async () => {
  const ac = new AbortController()
  let n = 0
  await rejectsAi(
    () =>
      streamChat(settings('/slow'), messages, {
        signal: ac.signal,
        onDelta: () => {
          n++
          if (n === 1) ac.abort()
        },
      }),
    'abort',
    '已取消',
  )
  assert.equal(n, 1, 'abort 前应只收到第一段')
})

await test('连不上的端口映射为 network 错误', async () => {
  const dead = http.createServer(() => {})
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise((r) => dead.close(r))
  const err = await rejectsAi(
    () => streamChat({ baseUrl: 'http://127.0.0.1:' + deadPort + '/v1', apiKey: 'k', model: 'm' }, messages),
    'network',
  )
  assert.ok(err.message.includes('网络不通'), err.message)
})

await test('配置校验：apiKey / model / baseUrl 为空都抛 config', async () => {
  await rejectsAi(() => streamChat({ baseUrl: base + '/v1', apiKey: '', model: 'm' }, messages), 'config', '还没有配置 API Key')
  await rejectsAi(() => streamChat({ baseUrl: base + '/v1', apiKey: '   ', model: 'm' }, messages), 'config', '还没有配置 API Key')
  let err = await rejectsAi(() => streamChat({ baseUrl: base + '/v1', apiKey: 'k', model: '' }, messages), 'config')
  assert.ok(err.message.includes('模型'), err.message)
  err = await rejectsAi(() => streamChat({ baseUrl: '', apiKey: 'k', model: 'm' }, messages), 'config')
  assert.ok(err.message.includes('接口地址'), err.message)
})

// ---------- 收尾 ----------

server.closeAllConnections?.()
await new Promise((r) => server.close(r))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed) {
  console.error('有失败用例')
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}
