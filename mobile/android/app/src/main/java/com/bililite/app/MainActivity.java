package com.bililite.app;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 安卓端 Activity。
 *
 * 相比 Capacitor 默认实现加了三件事：
 * 1. 注册自己写的两个插件：{@link PipPlugin}（画中画）、{@link ImmersivePlugin}（沉浸式全屏）；
 * 2. 覆写 onUserLeaveHint()：用户按 Home / 切走时，如果视频正在播就缩成小窗继续播。
 *    这是 Android 的惯例做法，不需要页面里再放个「小窗」按钮。
 * 3. 把 WebView 的 User-Agent 换成桌面 Chrome 的。
 *
 * ★ 第 3 点是必须的：B 站的分片 CDN（`upos-*.bilivideo.com`）会 403 掉移动端 / WebView
 * 的 UA（实测同一分片 + 同一 Referer：桌面 Chrome UA → 206，Chrome 安卓 UA → 403）。
 * 渲染层的播放器是用 fetch 自己拉 DASH 分片喂 MSE 的，这些请求由 WebView 发出，
 * 头就是这里设置的 UA；而接口调用走 CapacitorHttp（{@code src/main/bili/http.js} 的
 * BASE_HEADERS 本来就带桌面 UA），所以只改 WebView 这一处就够。
 */
public class MainActivity extends BridgeActivity {

  /** 与 `src/main/bili/http.js` 里的 UA 保持一致，curl 实测这个串能拿到 206。 */
  private static final String DESKTOP_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // registerPlugin 必须在 super.onCreate() 之前调用，否则插件不会挂到 Bridge 上
    registerPlugin(PipPlugin.class);
    registerPlugin(ImmersivePlugin.class);
    super.onCreate(savedInstanceState);
    applyDesktopUserAgent();
  }

  @Override
  public void onResume() {
    super.onResume();
    // 兜底：万一 onCreate 时 WebView 还没建好（换 Activity 重建、进程恢复等）
    applyDesktopUserAgent();
  }

  /** 让 WebView 发出的所有请求（含渲染层直接 fetch 的 DASH 分片）都带桌面 Chrome UA。 */
  private void applyDesktopUserAgent() {
    try {
      WebView webView = getBridge().getWebView();
      if (webView == null) return;
      WebSettings settings = webView.getSettings();
      if (settings == null) return;
      settings.setUserAgentString(DESKTOP_UA);
    } catch (Throwable ignored) {
      // 拿不到就算了：接口层（CapacitorHttp）自己带 UA，不至于整页不可用
    }
  }

  @Override
  public void onUserLeaveHint() {
    super.onUserLeaveHint();
    PipPlugin pip = PipPlugin.get();
    if (pip == null) return;
    if (!pip.isPlaying()) return;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    pip.enterPip();
  }
}
