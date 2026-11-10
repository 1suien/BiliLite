import type { AiSettings } from '@/db'

/** 一条对话消息（OpenAI 兼容格式） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamOptions {
  signal?: AbortSignal
  /** 每次收到一段增量文本时调用 */
  onDelta?: (text: string) => void
  /** 可选：直连不开的调试入口，默认 fetch */
  fetchImpl?: typeof fetch
}

/** AI 调用失败；kind 决定提示文案和能否重试 */
export class AiError extends Error {
  constructor(message: string, readonly kind: 'config' | 'network' | 'http' | 'abort' | 'parse') {
    super(message)
    this.name = 'AiError'
  }
}

/** 中文（含全角标点）——1 字 ≈ 1 token；其余按 4 字符 ≈ 1 token */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 粗略估算 token 数（中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token），用于截断上下文 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 把 baseUrl 归一化：去掉尾部 /，若填的是 .../v1 就补 /chat/completions；
 * 也兼容用户直接填完整 endpoint（以 /chat/completions 结尾原样返回）。
 */
export function chatEndpoint(baseUrl: string): string {
  const url = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (/\/chat\/completions$/i.test(url)) return url
  return url + '/chat/completions'
}

/** 把正文裁到 maxTokens 以内（按字符边界切，不留半个字） */
function clipToTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const cost = CJK_RE.test(ch) ? 1 : 0.25
    if (used + cost > maxTokens + 1e-9) break
    used += cost
    out += ch
  }
  // 小数累加上取整偶尔会多 1，兜底再退到预算内
  while (out && estimateTokens(out) > maxTokens) out = out.slice(0, -1)
  return out
}

/**
 * 按预算裁剪消息历史：保留 system（若有，只留第一条）、最新若干条整消息，
 * 总 token <= budget；最后一条 user 一定保留（放不下就截断正文）。返回按原顺序排列。
 */
export function trimMessages(messages: ChatMessage[], budget: number): ChatMessage[] {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return []
  const limit = Math.max(0, Math.floor(budget || 0))

  // 只认第一条 system；多余的 system 丢掉，免得几份设定互相挤占预算
  let sysIndex = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i].role === 'system') {
      sysIndex = i
      break
    }
  }
  const sys = sysIndex >= 0 ? list[sysIndex] : undefined

  const rest: ChatMessage[] = []
  for (let i = 0; i < list.length; i++) {
    if (i === sysIndex || list[i].role === 'system') continue
    rest.push(list[i])
  }

  let used = sys ? estimateTokens(sys.content) : 0
  let lastUser = -1
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].role === 'user') {
      lastUser = i
      break
    }
  }

  // 从最新往旧走，能整条放下就留
  const keep = new Set<number>()
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content)
    if (used + cost > limit) break
    keep.add(i)
    used += cost
  }

  // 至少留最后一条 user：预算不够就截断它的正文
  if (lastUser >= 0 && !keep.has(lastUser)) {
    const room = Math.max(0, limit - used)
    keep.add(lastUser)
    rest[lastUser] = { role: rest[lastUser].role, content: clipToTokens(rest[lastUser].content, room) }
    used += estimateTokens(rest[lastUser].content)
  }

  const out: ChatMessage[] = sys ? [sys] : []
  for (let i = 0; i < rest.length; i++) {
    if (keep.has(i)) out.push(rest[i])
  }
  return out
}

/** 判断异常是不是 abort（不同运行时 name / code 都有差异） */
function isAbort(e: any): boolean {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')
}

function tryJson(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 从一次响应（流式 chunk 或非流式整段 JSON）里取增量文本。
 * reasoning_content 一律忽略，只取正文。
 */
function chunkText(obj: any): string {
  if (!obj || typeof obj !== 'object') return ''
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null
  if (!choice) return ''
  const delta = choice.delta
  if (delta) {
    if (typeof delta.content === 'string') return delta.content
    if (typeof delta.text === 'string') return delta.text
  }
  const message = choice.message
  if (message && typeof message.content === 'string') return message.content
  if (typeof choice.text === 'string') return choice.text
  return ''
}

/** 按空行切出完整事件，剩下半截留在 rest 里等下一个 chunk */
function takeEvents(buf: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buf
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest)
    if (!m) break
    events.push(rest.slice(0, m.index))
    rest = rest.slice(m.index + m[0].length)
  }
  return { events, rest }
}

/** 解析一个 SSE 事件：忽略注释和 event: 行，data: 可多行，支持 [DONE] */
function parseEvent(raw: string): { texts: string[]; done: boolean } {
  const datas: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trimStart()
    if (!s || s.startsWith(':')) continue
    if (!/^data:/i.test(s)) continue
    datas.push(s.slice(5).trim())
  }
  const texts: string[] = []
  if (!datas.length) return { texts, done: false }

  let done = false
  const payloads = datas.filter((d) => {
    if (d === '[DONE]') {
      done = true
      return false
    }
    return !!d
  })
  if (!payloads.length) return { texts, done }

  // 多行 data: 先按整段拼起来解析；不合规的逐行回退（不少兼容实现每行一个 JSON）
  let objs: any[] = []
  const joined = tryJson(payloads.join('\n'))
  if (joined) {
    objs = [joined]
  } else {
    for (const d of payloads) {
      const o = tryJson(d)
      if (o) objs.push(o)
    }
  }
  for (const o of objs) {
    const t = chunkText(o)
    if (t) texts.push(t)
  }
  return { texts, done }
}

/** 调 OpenAI 兼容的 /chat/completions 流式接口；返回完整回复文本。失败抛 AiError。 */
export async function streamChat(
  settings: AiSettings,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): Promise<string> {
  const baseUrl = (settings?.baseUrl || '').trim()
  const apiKey = (settings?.apiKey || '').trim()
  const model = (settings?.model || '').trim()

  if (!apiKey) throw new AiError('还没有配置 API Key', 'config')
  if (!model) throw new AiError('还没有填模型名（例如 gpt-4o-mini）', 'config')
  if (!baseUrl) throw new AiError('还没有填接口地址（例如 https://api.openai.com/v1）', 'config')

  const signal = opts.signal
  if (signal?.aborted) throw new AiError('已取消', 'abort')

  const doFetch = opts.fetchImpl || fetch
  const payload = { model, messages, stream: true, temperature: 0.7 }

  let res: Response
  try {
    res = await doFetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (e: any) {
    if (signal?.aborted || isAbort(e)) throw new AiError('已取消', 'abort')
    throw new AiError('网络不通：检查接口地址 / 网络 / 是否需要代理', 'network')
  }

  // 非 2xx：读一段 body 当挑错依据，映射成用户能看懂的话
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500).trim()
    } catch {
      /* 读不到 body 就只用状态码 */
    }
    if (signal?.aborted) throw new AiError('已取消', 'abort')
    if (res.status === 401 || res.status === 403) throw new AiError('Key 无效或无权限', 'config')
    if (res.status === 404) throw new AiError('接口地址不对', 'config')
    if (res.status === 429) throw new AiError('请求太频繁', 'http')
    throw new AiError('接口返回 ' + res.status + (detail ? '：' + detail : ''), 'http')
  }

  const body = res.body
  let acc = ''
  const push = (t: string) => {
    if (!t) return
    acc = acc + t
    opts.onDelta?.(t)
  }

  // 个别兼容实现不返回可读流，只能整段解析
  if (!body || typeof body.getReader !== 'function') {
    let text = ''
    try {
      text = await res.text()
    } catch (e: any) {
      if (signal?.aborted || isAbort(e)) throw new AiError('已取消', 'abort')
      throw new AiError('读取回复失败（流中断）', 'parse')
    }
    const whole = chunkText(tryJson(text.trim()))
    if (whole) opts.onDelta?.(whole)
    return whole
  }

  const ctype = ((res.headers && res.headers.get('content-type')) || '').toLowerCase()
  const isSse = !ctype.includes('application/json')
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let raw = '' // 原始文本，兜底判断服务端是不是根本没走流
  let buf = '' // SSE 残留的半截事件
  let done = false

  read: for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e: any) {
      if (signal?.aborted || isAbort(e)) throw new AiError('已取消', 'abort')
      throw new AiError('读取回复失败（流中断）', 'parse')
    }
    if (chunk.done) break
    if (!chunk.value) continue
    const text = decoder.decode(chunk.value, { stream: true })
    raw += text
    if (!isSse) continue // 非流式 JSON：等读完整段再解析

    buf += text
    const taken = takeEvents(buf)
    buf = taken.rest
    for (const ev of taken.events) {
      const parsed = parseEvent(ev)
      for (const t of parsed.texts) push(t)
      if (parsed.done) {
        done = true
        break read
      }
    }
  }
  raw += decoder.decode()

  if (!isSse) {
    // 服务端忽略 stream:true，直接回了一整段 JSON
    const whole = chunkText(tryJson(raw.trim()))
    if (whole) push(whole)
    return acc
  }

  // 收尾：有些实现最后一条事件后不带空行
  if (!done && buf.trim()) {
    const parsed = parseEvent(buf)
    for (const t of parsed.texts) push(t)
    done = parsed.done || done
  }

  // 兜底：content-type 写着事件流，实际回的是整段 JSON
  if (!acc) {
    const whole = chunkText(tryJson(raw.trim()))
    if (whole) push(whole)
  }

  if (done) {
    try {
      await reader.cancel()
    } catch {
      /* 已经结束，取消失败无所谓 */
    }
  }
  return acc
}
