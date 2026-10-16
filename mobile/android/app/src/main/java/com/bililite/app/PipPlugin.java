package com.bililite.app;

import android.app.PictureInPictureParams;
import android.graphics.Rect;
import android.os.Build;
import android.util.Rational;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 最小的画中画（Picture-in-Picture）插件 —— Capacitor 没有官方 PiP 插件，自己写一个。
 *
 * 分工：
 *   JS 侧（src/mobile/platform.js）只负责汇报「现在有没有在播」以及视频区域在哪；
 *   真正的进入时机由 MainActivity.onUserLeaveHint() 决定 —— 用户按 Home / 切到别的
 *   App 的那一瞬间缩成小窗继续播，这才是 Android 的习惯用法（而不是让页面里放个按钮）。
 *
 * 只用到 API 26+ 的 PictureInPictureParams；低版本 supported() 直接返回 false，
 * JS 侧不会去调 enter()。
 */
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {

  /** MainActivity 在 onUserLeaveHint() 里要用到当前实例，这里留一个静态引用。 */
  private static PipPlugin instance;

  /** 视频是否正在播放（由 JS 的全局 play/pause 监听汇报）。 */
  private volatile boolean playing = false;

  /** 视频在 WebView 里的位置（CSS px），用来给 PiP 小窗做裁剪提示。 */
  private Rect sourceRect = null;

  private Rational aspect = new Rational(16, 9);

  public PipPlugin() {
    instance = this;
  }

  static PipPlugin get() {
    return instance;
  }

  @PluginMethod
  public void setPlaying(PluginCall call) {
    playing = Boolean.TRUE.equals(call.getBoolean("playing", Boolean.FALSE));
    readGeometry(call);
    JSObject ret = new JSObject();
    ret.put("playing", playing);
    ret.put("supported", supported());
    ret.put("pip", false);
    call.resolve(ret);
  }

  /** 窗口尺寸变化 / 滚动后重新汇报视频区域（只更新几何，不改播放状态）。 */
  @PluginMethod
  public void setGeometry(PluginCall call) {
    readGeometry(call);
    call.resolve();
  }

  /** 手动进入小窗（JS 侧目前不用，留着方便以后加按钮）。 */
  @PluginMethod
  public void enter(PluginCall call) {
    if (!supported()) {
      call.reject("当前系统不支持画中画（需要 Android 8.0 以上）");
      return;
    }
    if (!enterPip()) {
      call.reject("进入画中画失败");
      return;
    }
    call.resolve();
  }

  @PluginMethod
  public void isSupported(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("supported", supported());
    call.resolve(ret);
  }

  boolean isPlaying() {
    return playing;
  }

  boolean supported() {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
  }

  /** 进入小窗；任何异常都吞掉（比如 Activity 正在销毁），返回是否成功。 */
  boolean enterPip() {
    if (!supported() || getActivity() == null) return false;
    try {
      PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
      if (sourceRect != null) builder.setSourceRectHint(sourceRect);
      if (aspect != null) builder.setAspectRatio(aspect);
      return getActivity().enterPictureInPictureMode(builder.build());
    } catch (Exception err) {
      return false;
    }
  }

  /**
   * 读出 JS 换算前的 CSS 像素几何，转成物理像素（sourceRectHint 要的是窗口坐标）。
   * 参数不全就保持上一次的值，不至于把好数据覆盖成空。
   */
  private void readGeometry(PluginCall call) {
    Double left = call.getDouble("left");
    Double top = call.getDouble("top");
    Double width = call.getDouble("width");
    Double height = call.getDouble("height");
    if (left == null || top == null || width == null || height == null) return;
    if (width <= 0 || height <= 0) return;
    float density = getContext().getResources().getDisplayMetrics().density;
    int l = Math.round(left.floatValue() * density);
    int t = Math.round(top.floatValue() * density);
    int r = Math.round((left.floatValue() + width.floatValue()) * density);
    int b = Math.round((top.floatValue() + height.floatValue()) * density);
    sourceRect = new Rect(l, t, r, b);
    aspect = new Rational(Math.max(1, Math.round(width.floatValue())), Math.max(1, Math.round(height.floatValue())));
  }
}
