/**
 * 自定义原生能力（安卓侧 Kotlin 插件，见 android/README.md）
 * 这三个插件在 APK 里是私有实现，渲染层只负责调用。
 */
import { registerPlugin } from '@capacitor/core'

export interface PipPlugin {
  /** 把当前视频状态（是否在播 + 画面位置）同步给系统画中画 */
  setPlaying(opts: { playing: boolean; left?: number; top?: number; width?: number; height?: number }): Promise<void>
  setGeometry(opts: { left: number; top: number; width: number; height: number }): Promise<void>
}

export interface ImmersivePlugin {
  /** 全屏时隐藏状态栏/导航栏（沉浸式） */
  setImmersive(opts: { on: boolean }): Promise<void>
}

export const Pip = registerPlugin<PipPlugin>('Pip')
export const Immersive = registerPlugin<ImmersivePlugin>('Immersive')
