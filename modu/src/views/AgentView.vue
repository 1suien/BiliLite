<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import HomeHeader from '@/components/HomeHeader.vue'
import {
  DEFAULT_AI,
  listBooks,
  loadAiSettings,
  saveAiSettings,
  type AiSettings,
  type Book,
} from '@/db'
import { AiError, streamChat, trimMessages, type ChatMessage } from '@/lib/ai'

type Msg = { role: 'user' | 'assistant'; content: string; error?: boolean }

const books = ref<Book[]>([])
const ai = ref<AiSettings>({ ...DEFAULT_AI })
const messages = ref<Msg[]>([])
const input = ref('')
const streaming = ref(false)
const chatEl = ref<HTMLElement>()
const inputEl = ref<HTMLTextAreaElement>()
const moreOpen = ref(false)
const cfgOpen = ref(false)
const cfg = ref<AiSettings>({ ...DEFAULT_AI })
const cfgErr = ref('')
const toast = ref('')

const configured = computed(() => !!ai.value.apiKey.trim())

const PRESETS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
]

const SUGGESTIONS = [
  { t: '帮我挑下一本', d: '按书架和进度推荐', p: '看看我书架上的书和阅读进度，帮我挑下一本最值得读的，说说理由。' },
  { t: '最近的阅读状态', d: '读得怎么样', p: '根据我的书架和阅读进度，总结一下我最近的阅读状态，给一点建议。' },
  { t: '解释一个概念', d: '读到不懂的地方', p: '我在读书时遇到一个概念想弄明白，请告诉我你可以从哪些角度帮我解释。' },
  { t: '排一个阅读计划', d: '每天 20 分钟', p: '按每天 20 分钟，帮我安排一个两周的阅读计划，书从我的书架里选。' },
]

let ctrl: AbortController | null = null
let toastTimer = 0

function showToast(msg: string) {
  toast.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 3600)
}

async function load() {
  const [list, settings] = await Promise.all([listBooks(), loadAiSettings()])
  books.value = list
  ai.value = settings
}

function shelfContext(): string {
  if (!books.value.length) return '书架目前是空的。'
  const rows = books.value
    .slice(0, 30)
    .map((b) => {
      const pct = Math.round(b.percent * 100)
      const state = pct >= 99 ? '已读完' : pct > 0 ? `读到 ${pct}%` : '未读'
      return `- 《${b.title}》${b.author ? `，${b.author}` : ''}（${(b.format || '').toUpperCase()}，${state}）`
    })
    .join('\n')
  return `书架上的书（共 ${books.value.length} 本）：\n${rows}`
}

function systemPrompt(): string {
  return [
    '你是「墨读」里的阅读助理。墨读是一个离线电子书阅读器，书架上有用户的 TXT / EPUB / PDF / FB2 / CBZ 书。',
    '回答用简体中文，简洁、具体、像朋友聊天；不要编造书里没给过的情节。',
    '如果用户问推荐或计划，优先从书架里挑，参考阅读进度；书架为空时给通用建议并邀请他导入书。',
    '',
    shelfContext(),
  ].join('\n')
}

function scrollToEnd() {
  nextTick(() => {
    const el = chatEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function send(text?: string) {
  const content = (text ?? input.value).trim()
  if (streaming.value) return
  if (!configured.value) {
    openCfg()
    return
  }
  if (!content) return
  input.value = ''
  messages.value.push({ role: 'user', content })
  messages.value.push({ role: 'assistant', content: '' })
  streaming.value = true
  scrollToEnd()
  const history: ChatMessage[] = trimMessages(
    [
      { role: 'system', content: systemPrompt() },
      ...messages.value
        .slice(0, -1)
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content })),
    ],
    3200,
  )
  ctrl = new AbortController()
  try {
    await streamChat(ai.value, history, {
      signal: ctrl.signal,
      onDelta: (delta) => {
        const last = messages.value[messages.value.length - 1]
        if (last) last.content += delta
        scrollToEnd()
      },
    })
  } catch (e: any) {
    const last = messages.value[messages.value.length - 1]
    if (e instanceof AiError && e.kind === 'abort') {
      if (last && !last.content) messages.value.pop()
    } else {
      const msg = e instanceof AiError ? e.message : e?.message || '请求失败'
      if (last) {
        last.content = last.content ? last.content + `\n\n（出错了：${msg}）` : `出错了：${msg}`
        last.error = true
      }
    }
  } finally {
    streaming.value = false
    ctrl = null
    scrollToEnd()
  }
}

function stop() {
  ctrl?.abort()
}

function newChat() {
  if (streaming.value) stop()
  messages.value = []
  input.value = ''
  nextTick(() => inputEl.value?.focus())
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function autosize() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(132, el.scrollHeight) + 'px'
}

function openCfg() {
  cfg.value = { ...ai.value }
  cfgErr.value = ''
  cfgOpen.value = true
  moreOpen.value = false
}

function usePreset(p: (typeof PRESETS)[number]) {
  cfg.value = { ...cfg.value, baseUrl: p.baseUrl, model: p.model }
}

async function saveCfg() {
  const next: AiSettings = {
    baseUrl: cfg.value.baseUrl.trim(),
    model: cfg.value.model.trim(),
    apiKey: cfg.value.apiKey.trim(),
  }
  if (!next.apiKey) {
    cfgErr.value = '先填一个 API Key（只存在本机）'
    return
  }
  if (!next.baseUrl || !next.model) {
    cfgErr.value = '接口地址和模型名都要填'
    return
  }
  await saveAiSettings(next)
  ai.value = { ...next }
  cfgOpen.value = false
  showToast('模型已保存')
}

watch(input, () => nextTick(autosize))

onMounted(load)
</script>

<template>
  <div class="agent">
    <HomeHeader
      tab="agent"
      @newchat="newChat"
      @settings="openCfg"
      @more="moreOpen = true"
      @search="() => {}"
      @import="() => {}"
      @filter="() => {}"
      @stats="() => {}"
    />

    <main ref="chatEl" class="chat">
      <!-- 欢迎页 -->
      <section v-if="!messages.length" class="welcome">
        <h1>智能助理</h1>
        <p class="lead">读过的书、接下来读什么，都可以问它。它能看到你的书架和阅读进度。</p>

        <div class="suggests">
          <button v-for="s in SUGGESTIONS" :key="s.t" class="sug" @click="send(s.p)">
            <strong>{{ s.t }}</strong>
            <span>{{ s.d }}</span>
          </button>
        </div>

        <button v-if="!configured" class="cfg-cta" @click="openCfg">
          <span>配置模型</span>
          <em>自带 API Key，OpenAI / DeepSeek / 通义千问</em>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        <p v-else class="fine">当前模型：{{ ai.model }}</p>

        <p class="fine privacy">Key 只存本机 IndexedDB，请求直接发往你填的接口地址。</p>
      </section>

      <!-- 对话 -->
      <div v-else class="thread">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="bubble" :class="{ err: m.error }">
            <template v-if="m.role === 'assistant' && !m.content && streaming && i === messages.length - 1">
              <span class="typing"><i /><i /><i /></span>
            </template>
            <template v-else>{{ m.content }}</template>
          </div>
        </div>
      </div>
    </main>

    <footer class="composer">
      <div class="box">
        <textarea
          ref="inputEl"
          v-model="input"
          rows="1"
          placeholder="问点什么，比如「今天读哪本」"
          @keydown="onKeydown"
          @input="autosize"
        />
        <button v-if="streaming" class="send stop" aria-label="停止" @click="stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>
        <button v-else class="send" :disabled="!input.trim()" aria-label="发送" @click="send()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
        </button>
      </div>
      <p class="hint">Enter 发送 · Shift + Enter 换行 · AI 可能出错，重要信息请核对</p>
    </footer>

    <!-- 更多 -->
    <Transition name="fade">
      <div v-if="moreOpen" class="scrim" @click="moreOpen = false" />
    </Transition>
    <Transition name="sheet" appear>
      <div v-if="moreOpen" class="sheet" @click.stop>
        <button class="menu-row" @click="newChat(); moreOpen = false">新对话</button>
        <button class="menu-row" @click="openCfg">设置模型</button>
        <button class="menu-row cancel" @click="moreOpen = false">取消</button>
      </div>
    </Transition>

    <!-- 模型配置 -->
    <Transition name="fade">
      <div v-if="cfgOpen" class="scrim" @click="cfgOpen = false" />
    </Transition>
    <Transition name="sheet" appear>
      <div v-if="cfgOpen" class="sheet cfg-sheet" @click.stop>
        <h3 class="sheet-title">模型设置</h3>
        <p class="sheet-note">用你自己的 Key 调 OpenAI 兼容接口；Key 只保存在本机，不上传。</p>

        <div class="presets">
          <button v-for="p in PRESETS" :key="p.name" class="preset" :class="{ on: cfg.model === p.model && cfg.baseUrl === p.baseUrl }" @click="usePreset(p)">
            {{ p.name }}
          </button>
        </div>

        <label class="field">
          <span>接口地址</span>
          <input v-model="cfg.baseUrl" type="url" inputmode="url" placeholder="https://api.openai.com/v1" spellcheck="false" />
        </label>
        <label class="field">
          <span>模型</span>
          <input v-model="cfg.model" placeholder="gpt-4o-mini" spellcheck="false" />
        </label>
        <label class="field">
          <span>API Key</span>
          <input v-model="cfg.apiKey" type="password" autocomplete="off" placeholder="sk-…" spellcheck="false" />
        </label>
        <p v-if="cfgErr" class="cfg-err">{{ cfgErr }}</p>

        <button class="save-btn" @click="saveCfg">保存</button>
        <button class="menu-row cancel" @click="cfgOpen = false">取消</button>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.agent {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--shelf-bg);
}
.chat {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* 欢迎页 */
.welcome {
  max-width: 700px;
  margin: 0 auto;
  padding: clamp(28px, 7vh, 72px) 22px 24px;
}
.welcome h1 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: clamp(26px, 4vw, 34px);
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--ink);
}
.welcome .lead {
  margin: 10px 0 0;
  max-width: 520px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--ink-2);
}
.suggests {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 26px;
}
@media (max-width: 520px) {
  .suggests {
    grid-template-columns: 1fr;
  }
}
.sug {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 14px 15px;
  border-radius: 13px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  text-align: left;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.sug:hover {
  border-color: color-mix(in srgb, var(--ink) 22%, transparent);
  transform: translateY(-1px);
}
.sug strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.sug span {
  font-size: 12px;
  color: var(--muted);
}
.cfg-cta {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-top: 22px;
  padding: 14px 16px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  text-align: left;
  color: var(--ink);
}
.cfg-cta span {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
}
.cfg-cta em {
  flex: 1;
  font-style: normal;
  font-size: 12px;
  color: var(--ink-2);
}
.cfg-cta svg {
  color: var(--accent);
}
.fine {
  margin: 14px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
}
.privacy {
  margin-top: 8px;
}

/* 对话 */
.thread {
  max-width: 720px;
  margin: 0 auto;
  padding: 18px 20px 26px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.msg {
  display: flex;
}
.msg.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 86%;
  font-size: 14.5px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.user .bubble {
  padding: 10px 14px;
  border-radius: 15px 15px 4px 15px;
  background: var(--accent);
  color: #fbf9f3;
}
.msg.assistant .bubble {
  font-family: var(--font-serif);
  font-size: 15px;
  color: var(--ink);
  padding: 2px 2px 2px 0;
}
.bubble.err {
  color: var(--danger);
  font-family: var(--font-ui);
  font-size: 13px;
}
.typing {
  display: inline-flex;
  gap: 4px;
  padding: 8px 0;
}
.typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted);
  animation: blink 1.1s infinite ease-in-out;
}
.typing i:nth-child(2) {
  animation-delay: 0.16s;
}
.typing i:nth-child(3) {
  animation-delay: 0.32s;
}
@keyframes blink {
  0%,
  80%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

/* 输入 */
.composer {
  flex: 0 0 auto;
  padding: 8px 16px calc(10px + var(--safe-bottom));
  background: linear-gradient(to top, var(--shelf-bg) 72%, transparent);
}
.box {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 720px;
  margin: 0 auto;
  padding: 6px 6px 6px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  box-shadow: 0 10px 26px -20px rgba(30, 24, 16, 0.5);
}
.box textarea {
  flex: 1;
  min-width: 0;
  max-height: 132px;
  padding: 8px 0;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 14.5px;
  line-height: 1.6;
}
.box textarea::placeholder {
  color: var(--muted);
}
.send {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  background: var(--accent);
  color: #fbf9f3;
  transition: opacity 0.15s ease;
}
.send:disabled {
  opacity: 0.32;
}
.send.stop {
  background: color-mix(in srgb, var(--ink) 14%, transparent);
  color: var(--ink);
}
.hint {
  max-width: 720px;
  margin: 7px auto 0;
  text-align: center;
  font-size: 10.5px;
  color: var(--muted);
}

/* sheet */
.sheet-title {
  margin: 4px 2px 6px;
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}
.sheet-note {
  margin: 0 2px 14px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
}
.cfg-sheet {
  max-height: 88vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.presets {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.preset {
  flex: 1;
  height: 36px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--ink-2);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  border: 1px solid transparent;
}
.preset.on {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.field {
  display: block;
  margin-bottom: 11px;
}
.field span {
  display: block;
  margin-bottom: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
.field input {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  color: var(--ink);
  font-size: 13.5px;
  font-family: var(--font-ui);
  outline: none;
}
.field input:focus {
  border-color: var(--accent);
}
.cfg-err {
  margin: 2px 2px 8px;
  font-size: 12px;
  color: var(--danger);
}
.save-btn {
  width: 100%;
  height: 46px;
  margin-top: 4px;
  border-radius: 12px;
  background: var(--accent);
  color: #fbf9f3;
  font-size: 15px;
}
.menu-row {
  display: block;
  width: 100%;
  height: 48px;
  padding: 0 4px;
  text-align: left;
  font-size: 15px;
  color: var(--ink);
  border-top: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
}
.menu-row:active {
  color: var(--accent);
}
.menu-row.cancel {
  margin-top: 6px;
  color: var(--muted);
  text-align: center;
}
</style>
