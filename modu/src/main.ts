import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/app.css'

const app = createApp(App)
app.use(router)
app.mount('#app')

// 开发期：URL 带 ?seed=1 时自动灌入示例书（含一个 PDF），方便在浏览器里验收三种阅读器
if (import.meta.env.DEV && location.search.includes('seed=1')) {
  import('./dev/seed').then((m) => m.seedDemoBooks())
}
