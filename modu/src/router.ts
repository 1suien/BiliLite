import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  // Capacitor 在 file:// 下加载，hash 路由最稳
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'shelf', component: () => import('./views/ShelfView.vue') },
    { path: '/read/:id', name: 'read', component: () => import('./views/ReaderView.vue') },
    { path: '/agent', name: 'agent', component: () => import('./views/AgentView.vue') },
    { path: '/stats', name: 'stats', component: () => import('./views/StatsView.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
