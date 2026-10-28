package com.bililite.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 提醒通道插件（本机定制 0.4.14）—— 只做 Android 26+ 的「通知通道」三件事：
 *
 * 1. ensureChannel()：建一个带**系统默认提示音**的高重要性通道。
 *    为什么不用 @capacitor/local-notifications 的 createChannel？因为它只能按
 *    `res/raw/<名字>` 指定自定义音效，而自定义 WAV 在部分国产 ROM 上会被静音；
 *    直接把通道声音设成 Settings.System.DEFAULT_NOTIFICATION_URI，跟着平板自己的
 *    通知声音走，最不容易哑。
 *
 * 2. testNotification()：立刻发一条测试通知，让用户在真机上验证「响不响 / 弹不弹」，
 *    不用等到提醒时间，也方便排查是不是把 App 通知或通道声音关掉了。
 *
 * 3. openChannelSettings()：直接跳到本 App 这条通道的系统设置页（Android 8+），
 *    用户可以自己调重要性 / 声音 / 振动。
 *
 * 注意：Android 8+ 通道一旦创建，声音等属性就**不可再改**，所以通道 id 带版本号
 * （bililite-reminders-v2）。以后要再换声音，把 id 升到 v3 即可。
 */
@CapacitorPlugin(name = "ReminderChannel")
public class ReminderChannelPlugin extends Plugin {

  /** 与 JS 侧 src/bridge/notify.ts 的 CHANNEL_ID 保持一致 */
  public static final String CHANNEL_ID = "bililite-reminders-v2";

  @PluginMethod
  public void ensureChannel(PluginCall call) {
    boolean ok = false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        NotificationManager nm =
            (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
          NotificationChannel ch =
              new NotificationChannel(CHANNEL_ID, "到点提醒", NotificationManager.IMPORTANCE_HIGH);
          ch.setDescription("专注 / 打卡 / 课表的到点提醒");
          AudioAttributes attrs =
              new AudioAttributes.Builder()
                  .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                  .build();
          // 系统默认通知音：不会因为自定义音效不被 ROM 支持而静音
          ch.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, attrs);
          ch.enableVibration(true);
          ch.enableLights(true);
          ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
          ch.setShowBadge(true);
          nm.createNotificationChannel(ch);
          ok = true;
        }
      } catch (Throwable ignored) {
        // 建通道失败就交给 JS 侧降级（local-notifications 的旧通道）
      }
    }
    JSObject ret = new JSObject();
    ret.put("ok", ok);
    ret.put("channelId", CHANNEL_ID);
    call.resolve(ret);
  }

  @PluginMethod
  public void testNotification(PluginCall call) {
    String title = call.getString("title", "测试提醒");
    String body = call.getString("body", "能看到这条通知、并且响了一声，就说明设置没问题。");
    boolean ok = false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        NotificationManager nm =
            (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
          Notification.Builder b =
              new Notification.Builder(getContext(), CHANNEL_ID)
                  .setContentTitle(title)
                  .setContentText(body)
                  .setSmallIcon(android.R.drawable.ic_popup_reminder)
                  .setAutoCancel(true)
                  .setWhen(System.currentTimeMillis());
          nm.notify(47100, b.build());
          ok = true;
        }
      } catch (Throwable ignored) {
        // 失败由 JS 侧兜底
      }
    }
    JSObject ret = new JSObject();
    ret.put("ok", ok);
    call.resolve(ret);
  }

  @PluginMethod
  public void openChannelSettings(PluginCall call) {
    boolean ok = false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        Intent intent =
            new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_ID)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        ok = true;
      } catch (Throwable ignored) {
        // 有些 ROM 没实现这个页面，JS 侧会给提示
      }
    }
    JSObject ret = new JSObject();
    ret.put("ok", ok);
    call.resolve(ret);
  }
}
