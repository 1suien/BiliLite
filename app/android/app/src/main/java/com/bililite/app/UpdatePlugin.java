package com.bililite.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * 软件内更新插件（本机定制 0.4.66）。
 *
 * 只做四件事：
 * 1. current()：读 BuildConfig 的 versionCode/versionName（替掉渲染层里硬编码的版本号）；
 * 2. check(url)：原生发 GET 拉 update.json，避开 WebView 的跨域/混合内容限制；
 * 3. download(url, sha256, name)：下载 APK 到 cacheDir，边下边发 updateProgress，下完校验 sha256；
 * 4. install(path)：FileProvider + ACTION_VIEW(application/vnd.android.package-archive) 拉起系统安装器；
 *    没开「安装未知应用」时跳系统设置页并返回 needPermission。
 */
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {

  @PluginMethod
  public void current(PluginCall call) {
    JSObject res = new JSObject();
    try {
      android.content.pm.PackageInfo pi =
        getContext()
          .getPackageManager()
          .getPackageInfo(getContext().getPackageName(), 0);
      int code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? (int) pi.getLongVersionCode() : pi.versionCode;
      res.put("versionCode", code);
      res.put("versionName", pi.versionName);
    } catch (Exception e) {
      res.put("versionCode", 0);
      res.put("versionName", "");
    }
    call.resolve(res);
  }

  @PluginMethod
  public void check(PluginCall call) {
    final String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("缺少更新清单地址");
      return;
    }
    new Thread(
      () -> {
        HttpURLConnection conn = null;
        try {
          conn = (HttpURLConnection) new URL(url).openConnection();
          conn.setConnectTimeout(5000);
          conn.setReadTimeout(8000);
          conn.setRequestProperty("Accept", "application/json");
          conn.setInstanceFollowRedirects(true);
          int code = conn.getResponseCode();
          if (code != 200) {
            call.reject("更新服务返回 HTTP " + code);
            return;
          }
          InputStream in = conn.getInputStream();
          String body = readAll(in);
          in.close();
          JSONObject json = new JSONObject(body);
          JSObject res = new JSObject();
          res.put("versionCode", json.optInt("versionCode", 0));
          res.put("versionName", json.optString("versionName", ""));
          res.put("apk", json.optString("apk", ""));
          res.put("sha256", json.optString("sha256", ""));
          res.put("size", json.optLong("size", 0));
          res.put("publishedAt", json.optString("publishedAt", ""));
          org.json.JSONArray notes = json.optJSONArray("notes");
          if (notes != null) {
            com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
            for (int i = 0; i < notes.length(); i++) arr.put(notes.optString(i, ""));
            res.put("notes", arr);
          }
          call.resolve(res);
        } catch (Exception e) {
          call.reject("检查更新失败：" + e.getMessage());
        } finally {
          if (conn != null) conn.disconnect();
        }
      },
      "update-check"
    ).start();
  }

  @PluginMethod
  public void download(PluginCall call) {
    final String url = call.getString("url");
    final String sha = call.getString("sha256", "");
    final String name = call.getString("name", "BiliLite-update.apk");
    if (url == null || url.isEmpty()) {
      call.reject("缺少 APK 地址");
      return;
    }
    new Thread(
      () -> {
        HttpURLConnection conn = null;
        File tmp = new File(getContext().getCacheDir(), "update-" + System.currentTimeMillis() + ".apk");
        try {
          conn = (HttpURLConnection) new URL(url).openConnection();
          conn.setConnectTimeout(8000);
          conn.setReadTimeout(30000);
          conn.setInstanceFollowRedirects(true);
          int code = conn.getResponseCode();
          if (code != 200) {
            call.reject("下载失败：HTTP " + code);
            return;
          }
          long total = conn.getContentLengthLong();
          InputStream in = conn.getInputStream();
          FileOutputStream out = new FileOutputStream(tmp);
          byte[] buf = new byte[65536];
          long got = 0;
          long lastEmit = 0;
          int n;
          while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            got += n;
            long now = System.currentTimeMillis();
            if (now - lastEmit > 200) {
              lastEmit = now;
              JSObject p = new JSObject();
              p.put("received", got);
              p.put("total", total);
              notifyListeners("updateProgress", p);
            }
          }
          out.flush();
          out.close();
          in.close();
          if (sha != null && !sha.isEmpty()) {
            String actual = sha256(tmp);
            if (!actual.equalsIgnoreCase(sha)) {
              tmp.delete();
              call.reject("安装包校验失败（sha256 不一致）");
              return;
            }
          }
          JSObject res = new JSObject();
          res.put("path", tmp.getAbsolutePath());
          res.put("size", got);
          call.resolve(res);
        } catch (Exception e) {
          tmp.delete();
          call.reject("下载失败：" + e.getMessage());
        } finally {
          if (conn != null) conn.disconnect();
        }
      },
      "update-download"
    ).start();
  }

  @PluginMethod
  public void install(PluginCall call) {
    final String path = call.getString("path");
    if (path == null || path.isEmpty()) {
      call.reject("缺少安装包路径");
      return;
    }
    File apk = new File(path);
    if (!apk.exists()) {
      call.reject("安装包不存在，请重新下载");
      return;
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        if (!getContext().getPackageManager().canRequestPackageInstalls()) {
          Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
          intent.setData(Uri.parse("package:" + getContext().getPackageName()));
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          getContext().startActivity(intent);
          JSObject res = new JSObject();
          res.put("needPermission", true);
          call.resolve(res);
          return;
        }
      }
      Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
      Intent intent = new Intent(Intent.ACTION_VIEW);
      intent.setDataAndType(uri, "application/vnd.android.package-archive");
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      JSObject res = new JSObject();
      res.put("needPermission", false);
      call.resolve(res);
    } catch (Exception e) {
      call.reject("拉起安装器失败：" + e.getMessage());
    }
  }

  private static String readAll(InputStream in) throws IOException {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    return new String(out.toByteArray(), "UTF-8");
  }

  private static String sha256(File f) throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    InputStream in = new java.io.FileInputStream(f);
    byte[] buf = new byte[65536];
    int n;
    while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
    in.close();
    StringBuilder sb = new StringBuilder();
    for (byte b : md.digest()) sb.append(String.format("%02x", b));
    return sb.toString();
  }
}
