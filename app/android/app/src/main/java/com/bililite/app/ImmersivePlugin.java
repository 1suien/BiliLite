package com.bililite.app;

import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 「沉浸式全屏」开关 —— 官方 status-bar 插件只能藏状态栏，藏不掉底部的手势条，
 * 而状态栏那块高度在 WebView 里是一整条黑带（真机全屏截图反馈「播放窗口有多余」）。
 *
 * JS 侧（src/mobile/platform.js）在进入/退出全屏时调 setImmersive({on})：
 *   on = true  → 让内容铺到系统栏底下（setDecorFitsSystemWindows(false)）
 *                并把状态栏 + 手势条一起藏掉，只留下「边缘滑动呼出」的临时显示；
 *   on = false → 系统栏显示回来，恢复系统自己排版（普通页面就不会顶到状态栏上面）。
 *
 * 全程不抛异常：拿不到 Activity / 系统不支持时就当没这回事，页面照常可用。
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

  @PluginMethod
  public void setImmersive(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on", Boolean.FALSE));
    if (getActivity() == null) {
      call.resolve();
      return;
    }
    getActivity()
        .runOnUiThread(
            () -> {
              try {
                Window window = getActivity().getWindow();
                WindowCompat.setDecorFitsSystemWindows(window, !on);
                WindowInsetsControllerCompat ctl =
                    WindowCompat.getInsetsController(window, window.getDecorView());
                if (ctl != null) {
                  if (on) {
                    ctl.hide(WindowInsetsCompat.Type.systemBars());
                    // 从边缘滑一下能临时唤出系统栏，别让用户在全屏里迷路
                    ctl.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                  } else {
                    ctl.show(WindowInsetsCompat.Type.systemBars());
                  }
                }
              } catch (Throwable ignored) {
                // 系统不支持就算了，全屏本身还能用
              }
            });
    call.resolve();
  }
}
