<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { AiSettings } from '@/db'
import { AiError, streamChat, trimMessages, type ChatMessage } from '@/lib/ai'

interface Ctx {
  title: string
  excerpt: string
  sentence: string
}

const props = defineProps<{
  bookTitle: string
  chapterTitle: string
  quote: string
  ai: AiSettings
  getContext: () => Ctx | undefined
}>()
const emit = defineEmits<{
  (e: 'save-ai', s: AiSettings): void
  (e: 'close'): void
}>()

interface Msg {
  role: 'user' | 'assistant'
  text: string
}

const PRESETS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
]

const messages = ref<Msg[]>([])
const input = ref('')
const streaming = ref(false)
const errorMsg = ref('')
const showConfig = ref(false)
const draft = ref<AiSettings>({ ...props.ai })
const listEl = ref<HTMLDivElement>()
const inputEl = ref<HTMLTextAreaElement>()
let ctrl: AbortController | null = null

const configured = computed(() => !!props.ai.apiKey.trim() && !!props.ai.model.trim() && !!props.ai.baseUrl.trim())
const quick = computed(() => {
  const q = props.quote.trim()
  return q
    ? ['这句话是什么意思？', '帮我理解这段的言外之意', '概括这一段的主旨', '这里有什么值得注意的写法？']
    : ['概括这一章', '这段在讲什么？', '帮我解释一个词', '作者想表达什么？']
})

function toggleConfig() {
  draft.value = { ...props.ai }
  showConfig.value = !showConfig.value
}
function saveConfig() {
  emit('save-ai', { ...draft.value, baseUrl: draft.value.baseUrl.trim(), apiKey: draft.value.apiKey.trim(), model: draft.value.model.trim() })
  showConfig.value = false
  errorMsg.value = ''
}
function usePreset(p: (typeof PRESETS)[number]) {
  draft.value = { ...draft.value, baseUrl: p.baseUrl, model: p.model }
}

async function scrollDown() {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

async function stop() {
  ctrl?.abort()
  ctrl = null
  streaming.value = false
}

async function send(text?: string) {
  if (streaming.value) return
  const q = (text ?? input.value).trim()
  if (!q) return
  if (!configured.value) {
    errorMsg.value = props.ai.apiKey ? '接口设置不完整，请检查地址和模型名' : '先在右上角填一个 API Key，就能用阅读助手'
    showConfig.value = true
    return
  }
  input.value = ''
  errorMsg.value = ''
  messages.value.push({ role: 'user', text: q })
  messages.value.push({ role: 'assistant', text: '' })
  const idx = messages.value.length - 1
  streaming.value = true
  await scrollDown()

  const ctx = props.getContext?.()
  const parts: string[] = []
  if (props.quote.trim()) parts.push(`【读者选中的原文】\n${props.quote.trim()}`)
  if (ctx?.excerpt) parts.push(`【当前上下文】\n${ctx.excerpt}`)
  parts.push(`【问题】\n${q}`)

  const system: ChatMessage = {
    role: 'system',
    content:
      `你是「墨读」里的阅读助手，帮读者读懂正在读的书。回答简洁、具体、口语化，先给结论再补充；` +
      `引用原文时用「」括起来，不要编造书里没有的内容。` +
      `当前在读《${props.bookTitle}》${props.chapterTitle ? `的「${props.chapterTitle}」` : ''}。`,
  }
  const history: ChatMessage[] = messages.value
    .slice(0, idx)
    .filter((m) => m.text)
    .map((m) => ({ role: m.role, content: m.text }))
  const sent = trimMessages([system, ...history, { role: 'user', content: parts.join('\n\n') }], 3200)

  ctrl = new AbortController()
  try {
    await streamChat(props.ai, sent, {
      signal: ctrl.signal,
      onDelta: (d) => {
        messages.value[idx].text += d
        void scrollDown()
      },
    })
  } catch (e: any) {
    const msg = e instanceof AiError ? e.message : e?.message || String(e)
    if (e instanceof AiError && e.kind === 'abort') {
      if (!messages.value[idx].text) messages.value[idx].text = '（已停止）'
    } else {
      errorMsg.value = msg
      if (!messages.value[idx].text) messages.value.splice(idx, 1)
    }
  } finally {
    ctrl = null
    streaming.value = false
    await scrollDown()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

onBeforeUnmount(() => {
  ctrl?.abort()
})
</script>

<template>
  <Transition name="fade" appear>
    <div class="scrim ai-scrim" @click="emit('close')" />
  </Transition>
  <Transition name="sheet" appear>
    <div class="sheet ai-sheet" @click.stop>
      <header>
        <div class="head-text">
          <h3>阅读助手</h3>
          <span>{{ configured ? `${ai.model} · 已连接` : '自带 Key，直接对话' }}</span>
        </div>
        <button class="mini" @click="toggleConfig">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
          </svg>
        </button>
        <button class="mini" @click="emit('close')">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <div v-if="showConfig" class="config">
        <div class="presets">
          <button v-for="p in PRESETS" :key="p.name" class="chipbtn" :class="{ on: draft.baseUrl === p.baseUrl }" @click="usePreset(p)">{{ p.name }}</button>
        </div>
        <label>
          <span>接口地址</span>
          <input v-model="draft.baseUrl" placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span>模型</span>
          <input v-model="draft.model" placeholder="gpt-4o-mini" autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span>API Key</span>
          <input v-model="draft.apiKey" type="password" placeholder="sk-…" autocomplete="off" spellcheck="false" />
        </label>
        <p class="tip">Key 只保存在这台设备的浏览器数据库里，请求直接从设备发给你填的服务商。</p>
        <button class="solid" @click="saveConfig">保存设置</button>
      </div>

      <template v-else>
        <div v-if="quote" class="quote-card">「{{ quote }}」</div>

        <div ref="listEl" class="messages">
          <div v-if="!messages.length" class="welcome">
            <p class="big">读到不懂的地方，问一句。</p>
            <p class="sub">我会带着你正在读的这一章和选中的原文一起回答。</p>
            <div class="quick">
              <button v-for="q in quick" :key="q" @click="send(q)">{{ q }}</button>
            </div>
          </div>
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <div v-if="m.text" class="bubble">{{ m.text }}</div>
            <span v-else class="typing"><i /><i /><i /></span>
          </div>
          <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
        </div>

        <div class="composer">
          <textarea
            ref="inputEl"
            v-model="input"
            rows="1"
            placeholder="问关于这本书的问题…"
            @keydown="onKeydown"
          />
          <button v-if="streaming" class="send stop" @click="stop">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
          <button v-else class="send" :disabled="!input.trim()" @click="send()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        </div>
        <p class="foot">内容由你配置的 AI 服务生成，请自行判断准确性。</p>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.ai-sheet {
  height: 84vh;
  display: flex;
  flex-direction: column;
  padding: 10px 16px calc(12px + var(--safe-bottom));
  color: var(--ink);
}
header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 2px 10px;
}
.head-text {
  flex: 1;
  min-width: 0;
}
.head-text h3 {
  margin: 0;
}
.head-text span {
  font-size: 11.5px;
  color: var(--muted);
}
.mini {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--ink-2);
}
.mini:active {
  background: var(--surface-2);
}

.config {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 4px 2px 8px;
}
.presets {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chipbtn {
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  font-size: 12.5px;
  color: var(--ink-2);
  background: var(--surface-2);
  border: 1px solid transparent;
}
.chipbtn.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.config label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
}
.config input {
  height: 42px;
  padding: 0 12px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  font-size: 14px;
  outline: none;
}
.config input:focus {
  border-color: var(--accent);
}
.tip {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
}
.solid {
  height: 44px;
  border-radius: 13px;
  background: var(--accent);
  color: #fff;
  font-size: 14.5px;
  font-weight: 600;
}

.quote-card {
  margin: 0 2px 8px;
  padding: 8px 11px;
  border-radius: 10px;
  background: var(--surface-2);
  border-left: 3px solid var(--accent);
  font-family: var(--font-serif);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
  max-height: 62px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.messages {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 2px 2px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.welcome {
  margin: auto 0;
  padding: 10px 4px;
}
.welcome .big {
  margin: 0 0 6px;
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
}
.welcome .sub {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}
.quick {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.quick button {
  text-align: left;
  padding: 11px 13px;
  border-radius: 12px;
  background: var(--surface-2);
  font-size: 13.5px;
  color: var(--ink-2);
}
.quick button:active {
  background: var(--accent-soft);
}
.msg {
  display: flex;
  flex-direction: column;
  max-width: 100%;
}
.msg.user {
  align-items: flex-end;
}
.bubble {
  padding: 10px 13px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.user .bubble {
  max-width: 84%;
  background: var(--accent);
  color: #f7f4ec;
  border-bottom-right-radius: 5px;
}
.msg.assistant .bubble {
  max-width: 100%;
  background: var(--surface-2);
  color: var(--ink);
  border-bottom-left-radius: 5px;
  font-family: var(--font-serif);
}
.typing {
  display: inline-flex;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--surface-2);
}
.typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted);
  animation: blink 1.2s infinite ease-in-out;
}
.typing i:nth-child(2) {
  animation-delay: 0.18s;
}
.typing i:nth-child(3) {
  animation-delay: 0.36s;
}
@keyframes blink {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
.err {
  margin: 0;
  padding: 9px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.6;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--line);
}
.composer textarea {
  flex: 1;
  min-height: 42px;
  max-height: 120px;
  resize: none;
  padding: 11px 13px;
  border-radius: 13px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
}
.composer textarea:focus {
  border-color: var(--accent);
}
.send {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  background: var(--accent);
  color: #fff;
}
.send:disabled {
  opacity: 0.4;
}
.send.stop {
  background: var(--ink-2);
}
.foot {
  margin: 0;
  padding-top: 4px;
  text-align: center;
  font-size: 10.5px;
  color: var(--muted);
}
</style>
