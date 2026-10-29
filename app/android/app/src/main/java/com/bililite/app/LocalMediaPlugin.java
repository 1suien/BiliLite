package com.bililite.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;

/**
 * 本地媒体导入插件（本机定制 0.4.15）。
 *
 * 为什么要它：安卓 WebView 里用 `<input type=file>` 选到的文件只能变成内存里的 blob URL
 * （`src/bridge/android.ts` 的 FILE_STORE），刷新就丢、大文件还吃内存。这个插件改成：
 *
 *  1. 用系统 SAF（ACTION_OPEN_DOCUMENT）选视频/音频，把文件**复制**到 App 私有目录
 *     `files/local-media/`，返回可直接交给 `<video>` 的 `https://localhost/_capacitor_file_/...`
 *     地址（Capacitor 的本地服务器支持 Range，能边下边播，不用整个读进内存）；
 *  2. 接收别的 App「分享 / 用其他应用打开」过来的 `content://`（比如 WPS 网盘里的视频），
 *     同样落盘到私有目录，之后即使重启 App 也能继续播；
 *  3. 提供 probe（重启后按路径还原条目）和 discard（删除记录时清理文件）。
 *
 * 文件全部放在应用私有目录，卸载 App 时随之删除。
 */
@CapacitorPlugin(name = "LocalMedia")
public class LocalMediaPlugin extends Plugin {

  /** 私有目录下的子目录名 */
  private static final String MEDIA_DIR = "local-media";

  /** SAF 选择器里允许的类型 */
  private static final String[] MIME_TYPES = new String[] { "video/*", "audio/*" };

  /** 分享过来的文件常是 application/octet-stream / 没有 mime，只能按扩展名判断是不是音视频（0.4.18 起） */
  private static final Set<String> MEDIA_EXTS = new HashSet<>(
    Arrays.asList("mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m3u8", "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus")
  );

  /** 系统文件选择器（多选）→ 复制到私有目录 → 返回条目 */
  @PluginMethod
  public void pickAndImport(PluginCall call) {
    boolean multiple = !Boolean.FALSE.equals(call.getBoolean("multiple", Boolean.TRUE));
    // 0.4.16：先用 ACTION_OPEN_DOCUMENT；有的平板 ROM 把文档选择器裁掉了，就退到 ACTION_GET_CONTENT；
    // 两个都没有才报错（让 JS 回退到 WebView 的 <input type=file>）。
    Intent intent = buildPickIntent(Intent.ACTION_OPEN_DOCUMENT, multiple);
    if (!canHandle(intent)) intent = buildPickIntent(Intent.ACTION_GET_CONTENT, multiple);
    if (!canHandle(intent)) {
      call.reject("这台设备上没有可用的系统文件选择器（DocumentsUI / 文件管理被裁掉了），已改用应用内选择器");
      return;
    }
    try {
      startActivityForResult(call, intent, "pickResult");
    } catch (Throwable e) {
      // 少数 ROM 会在这里抛 ActivityNotFoundException / SecurityException，交给 JS 回退
      call.reject("打开系统文件选择器失败：" + e.getMessage());
    }
  }

  private Intent buildPickIntent(String action, boolean multiple) {
    Intent intent = new Intent(action);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    intent.putExtra(Intent.EXTRA_MIME_TYPES, MIME_TYPES);
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
    return intent;
  }

  private boolean canHandle(Intent intent) {
    try {
      return intent.resolveActivity(getContext().getPackageManager()) != null;
    } catch (Throwable e) {
      return false;
    }
  }

  /** 诊断：系统选择器到底能不能用（设置页 / 本地页的「检测」按钮用） */
  @PluginMethod
  public void diagnose(PluginCall call) {
    JSObject res = new JSObject();
    res.put("openDocument", canHandle(buildPickIntent(Intent.ACTION_OPEN_DOCUMENT, true)));
    res.put("getContent", canHandle(buildPickIntent(Intent.ACTION_GET_CONTENT, true)));
    res.put("sdk", Build.VERSION.SDK_INT);
    res.put("mediaDir", new File(getContext().getFilesDir(), MEDIA_DIR).getAbsolutePath());
    call.resolve(res);
  }

  @ActivityCallback
  private void pickResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    try {
      if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
        call.resolve(new JSObject().put("canceled", true));
        return;
      }
      importUris(call, collectUris(result.getData()));
    } catch (Throwable e) {
      call.reject("导入失败：" + e.getMessage());
    }
  }

  /** 取「分享 / 用其他应用打开」传进来的文件（取一次就清空） */
  @PluginMethod
  public void sharedPending(PluginCall call) {
    Intent intent = MainActivity.takeSharedIntent();
    if (intent == null) {
      JSObject empty = new JSObject();
      empty.put("entries", new JSArray());
      empty.put("count", 0);
      call.resolve(empty);
      return;
    }
    try {
      // 0.4.18：分享入口放宽到任意 mime（WPS 网盘常以 octet-stream 分享），这里按扩展名挑出音视频
      List<Uri> all = collectUris(intent);
      List<Uri> media = new ArrayList<>();
      JSArray skipped = new JSArray();
      for (Uri uri : all) {
        if (isMediaUri(uri)) media.add(uri);
        else skipped.put(String.valueOf(queryName(getContext().getContentResolver(), uri)));
      }
      JSObject out;
      if (media.isEmpty()) {
        out = new JSObject();
        out.put("entries", new JSArray());
        out.put("failed", new JSArray());
        out.put("skipped", skipped);
        out.put("count", 0);
        call.resolve(out);
        return;
      }
      importUris(call, media, skipped);
    } catch (Throwable e) {
      call.reject("接收分享失败：" + e.getMessage());
    }
  }

  /**
   * 把外部 URL 下载进 App 私有目录（本机构建 0.4.20 起的通用能力）。
   *
   * B 站的视频 CDN 校验 Referer/UA，WebView 里 fetch 会被 CORS 与防盗链挡住，
   * 所以在原生成层用 HttpURLConnection 拉流写盘；下载进度通过 `downloadProgress`
   * 事件推给 JS（received/total/name），完成后返回和「分享接收」一样的条目结构。
   */
  @PluginMethod
  public void downloadFromUrl(PluginCall call) {
    final String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("缺少下载地址");
      return;
    }
    final String referer = call.getString("referer", "https://www.bilibili.com/");
    String rawName = call.getString("name", "");
    final String name = sanitizeName(rawName.isEmpty() ? ("video-" + System.currentTimeMillis() + ".mp4") : rawName);

    new Thread(
      () -> {
        HttpURLConnection conn = null;
        File part = new File(mediaDir(), name + ".part");
        File target = new File(mediaDir(), name);
        try {
          URL u = new URL(url);
          conn = (HttpURLConnection) u.openConnection();
          conn.setConnectTimeout(15000);
          conn.setReadTimeout(30000);
          conn.setInstanceFollowRedirects(true);
          conn.setRequestProperty(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
          );
          conn.setRequestProperty("Referer", referer);
          conn.setRequestProperty("Accept", "*/*");
          int code = conn.getResponseCode();
          if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
          long total = conn.getContentLengthLong();
          InputStream in = conn.getInputStream();
          FileOutputStream out = new FileOutputStream(part);
          byte[] buf = new byte[64 * 1024];
          long got = 0;
          long lastReport = 0;
          int n;
          while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            got += n;
            long now = System.currentTimeMillis();
            if (now - lastReport > 300) {
              lastReport = now;
              JSObject p = new JSObject();
              p.put("received", got);
              p.put("total", total);
              p.put("name", name);
              notifyListeners("downloadProgress", p);
            }
          }
          out.flush();
          out.close();
          in.close();
          if (!part.renameTo(target)) throw new IOException("保存文件失败");
          call.resolve(describe(target, mimeOf(null, name)));
        } catch (Throwable e) {
          try {
            if (part.exists()) part.delete();
          } catch (Throwable ignored) {
            // ignore
          }
          call.reject("下载失败：" + e.getMessage());
        } finally {
          if (conn != null) {
            try {
              conn.disconnect();
            } catch (Throwable ignored) {
              // ignore
            }
          }
        }
      },
      "local-media-download"
    ).start();
  }
  /** 按绝对路径还原条目（重启后 local:register 用；文件不在了就进 missing） */
  @PluginMethod
  public void probe(PluginCall call) {
    JSArray paths = call.getArray("paths");
    JSArray entries = new JSArray();
    JSArray missing = new JSArray();
    if (paths != null) {
      for (int i = 0; i < paths.length(); i++) {
        String raw = paths.optString(i);
        File file = safeFile(raw);
        if (file == null || !file.isFile()) {
          missing.put(String.valueOf(raw));
          continue;
        }
        try {
          entries.put(describe(file, mimeOf(null, file.getName())));
        } catch (Throwable ignored) {
          missing.put(String.valueOf(raw));
        }
      }
    }
    JSObject out = new JSObject();
    out.put("entries", entries);
    out.put("missing", missing);
    call.resolve(out);
  }

  /** 删除某条记录对应的私有目录文件（不在私有目录里的路径一律忽略） */
  @PluginMethod
  public void discard(PluginCall call) {
    String raw = call.getString("path");
    File file = safeFile(raw);
    boolean deleted = false;
    if (file != null && file.isFile()) {
      deleted = file.delete();
    }
    JSObject out = new JSObject();
    out.put("ok", true);
    out.put("deleted", deleted);
    call.resolve(out);
  }

  /** 私有目录占用（调试/展示用） */
  @PluginMethod
  public void storageInfo(PluginCall call) {
    File dir = mediaDir();
    File[] files = dir.listFiles();
    long bytes = 0;
    int count = 0;
    if (files != null) {
      for (File f : files) {
        if (f.isFile()) {
          bytes += f.length();
          count += 1;
        }
      }
    }
    JSObject out = new JSObject();
    out.put("dir", dir.getAbsolutePath());
    out.put("count", count);
    out.put("bytes", bytes);
    call.resolve(out);
  }

  /* ------------------------------------------------------------------ 内部实现 */

  private void importUris(PluginCall call, List<Uri> uris) {
    importUris(call, uris, new JSArray());
  }

  private void importUris(PluginCall call, List<Uri> uris, JSArray skipped) {
    JSArray entries = new JSArray();
    JSArray failed = new JSArray();
    int total = uris.size();
    int done = 0;
    for (Uri uri : uris) {
      String label = null;
      try {
        label = queryName(getContext().getContentResolver(), uri);
        File file = copyToMedia(uri);
        if (file != null) {
          entries.put(describe(file, mimeOf(uri, file.getName())));
        }
      } catch (Throwable e) {
        failed.put(String.valueOf(uri));
      }
      done++;
    }
    JSObject out = new JSObject();
    out.put("entries", entries);
    out.put("failed", failed);
    out.put("skipped", skipped);
    out.put("count", entries.length());
    call.resolve(out);
  }

  /** 按扩展名 / mime 判断是不是音视频 */
  private boolean isMediaUri(Uri uri) {
    ContentResolver cr = getContext().getContentResolver();
    String mime = null;
    try {
      mime = cr.getType(uri);
    } catch (Throwable ignored) {
      // ignore
    }
    if (mime != null && (mime.startsWith("video/") || mime.startsWith("audio/"))) return true;
    String name = queryName(cr, uri);
    return isMediaName(name);
  }

  private boolean isMediaName(String name) {
    if (name == null) return false;
    int dot = name.lastIndexOf('.');
    if (dot < 0 || dot >= name.length() - 1) return false;
    return MEDIA_EXTS.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
  }

  /** 把 content:// 复制进私有目录；同名同大小视为同一个文件（保住播放进度） */
  private File copyToMedia(Uri uri) throws Exception {
    ContentResolver cr = getContext().getContentResolver();
    String name = sanitizeName(queryName(cr, uri));
    long size = querySize(cr, uri);
    File dir = mediaDir();
    if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建目录");
    File target = new File(dir, name);
    if (target.isFile() && size > 0 && target.length() == size) return target;
    if (target.exists()) {
      String base = name;
      String ext = "";
      int dot = name.lastIndexOf('.');
      if (dot > 0) {
        base = name.substring(0, dot);
        ext = name.substring(dot);
      }
      for (int i = 2; i < 1000; i++) {
        File next = new File(dir, base + "-" + i + ext);
        if (!next.exists()) {
          target = next;
          break;
        }
      }
    }
    File tmp = new File(dir, target.getName() + ".part");
    InputStream in = cr.openInputStream(uri);
    if (in == null) throw new Exception("读不到文件");
    FileOutputStream out = new FileOutputStream(tmp);
    try {
      byte[] buf = new byte[64 * 1024];
      int read;
      while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
      out.flush();
    } finally {
      try {
        in.close();
      } catch (Throwable ignored) {}
      try {
        out.close();
      } catch (Throwable ignored) {}
    }
    if (tmp.length() <= 0) {
      tmp.delete();
      throw new Exception("文件是空的");
    }
    if (target.exists()) target.delete();
    if (!tmp.renameTo(target)) throw new Exception("保存失败");
    return target;
  }

  private JSObject describe(File file, String mime) throws Exception {
    String path = file.getAbsolutePath();
    JSObject e = new JSObject();
    e.put("id", md5(path).substring(0, 24));
    e.put("path", path);
    e.put("name", file.getName());
    e.put("dir", "本机导入");
    e.put("ext", extOf(file.getName()));
    e.put("size", file.length());
    e.put("mtime", file.lastModified());
    e.put("mime", mime == null ? "" : mime);
    e.put("url", getBridge().getLocalUrl() + "/_capacitor_file_" + path);
    e.put("native", true);
    return e;
  }

  private File mediaDir() {
    return new File(getContext().getFilesDir(), MEDIA_DIR);
  }

  /** raw 路径 → 私有目录里的 File；越界/不存在返回 null */
  private File safeFile(String raw) {
    if (raw == null) return null;
    String path = raw.startsWith("file://") ? raw.substring("file://".length()) : raw;
    if (path.isEmpty() || path.contains("\u0000")) return null;
    try {
      File root = getContext().getFilesDir().getCanonicalFile();
      File file = new File(path).getCanonicalFile();
      if (!file.getPath().startsWith(root.getPath() + File.separator)) return null;
      return file;
    } catch (Throwable ignored) {
      return null;
    }
  }

  private List<Uri> collectUris(Intent intent) {
    List<Uri> out = new ArrayList<>();
    if (intent == null) return out;
    if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
      out.add(intent.getData());
    }
    ClipData clip = intent.getClipData();
    if (clip != null) {
      for (int i = 0; i < clip.getItemCount(); i++) {
        Uri uri = clip.getItemAt(i).getUri();
        if (uri != null) out.add(uri);
      }
    }
    if (out.isEmpty()) {
      Uri single = getStreamExtra(intent);
      if (single != null) out.add(single);
    }
    if (out.isEmpty()) {
      ArrayList<Uri> list = getStreamListExtra(intent);
      if (list != null) out.addAll(list);
    }
    // 去重
    List<Uri> unique = new ArrayList<>();
    for (Uri uri : out) {
      if (uri != null && !unique.contains(uri)) unique.add(uri);
    }
    return unique;
  }

  @SuppressWarnings("deprecation")
  private Uri getStreamExtra(Intent intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
    }
    return intent.getParcelableExtra(Intent.EXTRA_STREAM);
  }

  @SuppressWarnings("deprecation")
  private ArrayList<Uri> getStreamListExtra(Intent intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
    }
    return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
  }

  private String queryName(ContentResolver cr, Uri uri) {
    String name = null;
    try (Cursor cursor = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) {
        int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0 && !cursor.isNull(idx)) name = cursor.getString(idx);
      }
    } catch (Throwable ignored) {}
    if (name == null || name.trim().isEmpty()) {
      String last = uri.getLastPathSegment();
      if (last != null) {
        int slash = last.lastIndexOf('/');
        name = slash >= 0 ? last.substring(slash + 1) : last;
      }
    }
    return name == null || name.trim().isEmpty() ? "导入的媒体" : name;
  }

  private long querySize(ContentResolver cr, Uri uri) {
    try (Cursor cursor = cr.query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) {
        int idx = cursor.getColumnIndex(OpenableColumns.SIZE);
        if (idx >= 0 && !cursor.isNull(idx)) return cursor.getLong(idx);
      }
    } catch (Throwable ignored) {}
    return 0;
  }

  private String sanitizeName(String name) {
    String clean = name == null ? "" : name.trim();
    if (clean.isEmpty()) clean = "导入的媒体";
    clean = clean.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_");
    if (clean.length() > 120) {
      String ext = extOf(clean);
      String base = clean.substring(0, Math.max(1, 116 - (ext.isEmpty() ? 0 : ext.length() + 1)));
      clean = base + (ext.isEmpty() ? "" : "." + ext);
    }
    return clean;
  }

  private String extOf(String name) {
    int dot = name == null ? -1 : name.lastIndexOf('.');
    if (dot < 0 || dot == name.length() - 1) return "";
    return name.substring(dot + 1).toLowerCase(Locale.US);
  }

  private String mimeOf(Uri uri, String name) {
    String mime = null;
    if (uri != null) {
      try {
        mime = getContext().getContentResolver().getType(uri);
      } catch (Throwable ignored) {}
    }
    if (mime == null || mime.isEmpty()) {
      mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extOf(name));
    }
    if (mime == null) {
      String ext = extOf(name);
      if (ext.equals("mkv")) mime = "video/x-matroska";
      else if (ext.equals("flv")) mime = "video/x-flv";
      else if (ext.equals("ts")) mime = "video/mp2t";
      else if (ext.equals("m4a") || ext.equals("aac")) mime = "audio/mp4";
      else if (ext.equals("flac")) mime = "audio/flac";
      else mime = "application/octet-stream";
    }
    return mime;
  }

  private String md5(String text) {
    try {
      MessageDigest digest = MessageDigest.getInstance("MD5");
      byte[] bytes = digest.digest(text.getBytes(StandardCharsets.UTF_8));
      StringBuilder sb = new StringBuilder(bytes.length * 2);
      for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
      return sb.toString();
    } catch (Throwable ignored) {
      return Integer.toHexString(text.hashCode());
    }
  }
}
