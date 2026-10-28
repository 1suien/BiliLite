package com.bililite.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
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

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

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

  /** 系统文件选择器（多选）→ 复制到私有目录 → 返回条目 */
  @PluginMethod
  public void pickAndImport(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    intent.putExtra(Intent.EXTRA_MIME_TYPES, MIME_TYPES);
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, !Boolean.FALSE.equals(call.getBoolean("multiple", Boolean.TRUE)));
    startActivityForResult(call, intent, "pickResult");
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
      importUris(call, collectUris(intent));
    } catch (Throwable e) {
      call.reject("接收分享失败：" + e.getMessage());
    }
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
    JSArray entries = new JSArray();
    JSArray failed = new JSArray();
    for (Uri uri : uris) {
      try {
        File file = copyToMedia(uri);
        if (file != null) {
          entries.put(describe(file, mimeOf(uri, file.getName())));
        }
      } catch (Throwable e) {
        failed.put(String.valueOf(uri));
      }
    }
    JSObject out = new JSObject();
    out.put("entries", entries);
    out.put("failed", failed);
    out.put("count", entries.length());
    call.resolve(out);
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
