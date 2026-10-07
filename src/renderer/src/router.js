import { createRouter, createWebHashHistory } from 'vue-router'

const HomeView = () => import('./views/HomeView.vue')
const SearchView = () => import('./views/SearchView.vue')
const VideoView = () => import('./views/VideoView.vue')
const FavView = () => import('./views/FavView.vue')
const FavFolderView = () => import('./views/FavFolderView.vue')
const LearnView = () => import('./views/LearnView.vue')
const CacheView = () => import('./views/CacheView.vue')
const UpManageView = () => import('./views/UpManageView.vue')
const UpView = () => import('./views/UpView.vue')
const SettingsView = () => import('./views/SettingsView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { title: '首页' } },
    { path: '/search', name: 'search', component: SearchView, meta: { title: '搜索' } },
    { path: '/video/:bvid', name: 'video', component: VideoView, meta: { title: '播放' } },
    { path: '/fav', name: 'fav', component: FavView, meta: { title: '收藏' } },
    { path: '/fav/:mediaId', name: 'fav-folder', component: FavFolderView, meta: { title: '收藏夹' } },
    { path: '/learn', name: 'learn', component: LearnView, meta: { title: '学习' } },
    { path: '/cache', name: 'cache', component: CacheView, meta: { title: '缓存' } },
    { path: '/ups', name: 'ups', component: UpManageView, meta: { title: 'UP 管理' } },
    { path: '/up/:mid', name: 'up', component: UpView, meta: { title: 'UP 主' } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { title: '设置' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

router.afterEach((to) => {
  document.title = to.meta && to.meta.title ? `${to.meta.title} · BiliLite` : 'BiliLite'
})

export default router
