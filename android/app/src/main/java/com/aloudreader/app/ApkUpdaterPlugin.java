package com.aloudreader.app;

import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用内更新：把新版 APK 下到缓存目录，再交给系统安装器。
 *
 * 安卓不允许普通应用静默安装，所以最后一步总是系统弹出的「安装」界面，用户点一下。
 * 签名密钥固定（见 ANDROID.md），所以是覆盖安装，书和笔记都在。
 *
 * 下载放在原生侧而不是 WebView 里 fetch：GitHub 的附件地址会 302 到另一个域名，
 * WebView 的 fetch 拿不到 blob 以外能交给安装器的文件；而这里直接落盘，
 * 再经 FileProvider（AndroidManifest 里已声明，cache-path 覆盖 cacheDir）授权给安装器读。
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private File downloaded;

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("建不了缓存目录");
                File out = new File(dir, "update.apk");

                // GitHub 的附件先 302 到 objects.githubusercontent.com，手动跟随，最多 5 跳。
                URL target = new URL(url);
                for (int hops = 0; ; hops++) {
                    conn = (HttpURLConnection) target.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20_000);
                    conn.setReadTimeout(60_000);
                    conn.setRequestProperty("User-Agent", "AloudReader-updater");
                    int code = conn.getResponseCode();
                    if (code >= 300 && code < 400 && hops < 5) {
                        String next = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (next == null) throw new IOException("跳转地址为空");
                        target = new URL(target, next);
                        continue;
                    }
                    if (code != 200) throw new IOException("HTTP " + code);
                    break;
                }

                long total = conn.getContentLengthLong();
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    long got = 0;
                    int last = -1;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        got += n;
                        if (total > 0) {
                            int pct = (int) (got * 100 / total);
                            if (pct != last) {
                                last = pct;
                                JSObject p = new JSObject();
                                p.put("percent", pct);
                                notifyListeners("progress", p);
                            }
                        }
                    }
                }
                if (total > 0 && out.length() != total) throw new IOException("下载不完整");

                downloaded = out;
                JSObject ret = new JSObject();
                ret.put("bytes", out.length());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("下载失败：" + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (downloaded == null || !downloaded.exists()) {
            call.reject("还没有下载好的安装包");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", downloaded);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            // 安卓 8+ 第一次会先问「允许逐读安装应用吗」，系统自己处理，这里不用管。
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开安装界面：" + e.getMessage());
        }
    }
}
