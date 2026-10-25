/**
 * 桌面端与安卓端共用的设置默认值。
 *
 * 之前这份常量写死在 `src/main/store.js` 里，安卓端要用就只能复制一份 —— 一旦两边
 * 漂移，就会出现「同一个设置项在平板上默认值不一样」这种极难查的问题。
 * 桌面端与安卓端都从这里 import，只此一份。
 */

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  defaultQuality: 80,
  autoNext: true,
  seekStep: 5,
  backupPath: '',
  playerVolume: 0.8,
  autoCheckin: true,
  playbackRate: 1,
  danmakuOn: true,
  danmakuOpacity: 0.9,
  danmakuArea: 1,
  autoHideCtl: true,
  /** 侧栏顺序（路由路径数组；空数组 = 用代码里的默认顺序） */
  navOrder: [],
  /** 字幕：自动开启在线字幕 */
  subAuto: false,
  /** 字幕：字号 px / 是否画背景遮罩 / 距舞台底部百分比 */
  subFontSize: 22,
  subBg: true,
  subBottom: 8,
  /** 专注弹层里的快捷任务（可自定义；空数组 = 用代码里的默认四个） */
  focusTasks: ['阅读', '刷题', '看课', '整理笔记']
}

export default DEFAULT_SETTINGS
