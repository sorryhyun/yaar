package io.github.sorryhyun.yaar;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * {@code window.yaarHost} for the desktop, the Android half of {@code @yaar/shared}'s host
 * contract.
 *
 * The page half is {@code assets/yaar-host.js}, generated from the desktop window's adapter
 * ({@code scripts/codegen/android-host-script.ts}). It posts {@code {id, op, args}} as JSON
 * on the channel androidx.webkit's {@code addWebMessageListener} gives it, and this class
 * answers {@code {id, result}} or {@code {id, error}}.
 *
 * <p><b>Top frame of the desktop origin only.</b> There are three layers, and any one of them
 * is enough:
 * <ul>
 *   <li>the channel and the script are injected only into frames whose origin matches the
 *       desktop's (so never into the app iframes, which are on 127.0.0.1);</li>
 *   <li>{@link #onPostMessage} drops anything that is not from the main frame of that
 *       origin;</li>
 *   <li>the script defines nothing outside the top frame.</li>
 * </ul>
 * Never {@code addJavascriptInterface}: that object would be visible to every frame.
 */
final class HostBridge implements WebViewCompat.WebMessageListener {
    /** The binding's name, {@code YAAR_HOST_BINDING} in {@code host-contract.ts}. */
    static final String BINDING = "__yaarHostInvoke";

    /** Must match {@code ANDROID_ORIGIN_PLACEHOLDER} in {@code host-bridge.ts}, quotes included. */
    private static final String ORIGIN_PLACEHOLDER = "\"__YAAR_HOST_ORIGIN__\"";

    /** Where the host's saves land, under the shared Downloads collection. */
    private static final String DOWNLOAD_SUBDIR = Environment.DIRECTORY_DOWNLOADS + "/YAAR";

    private final Context context;
    private final String origin;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private HostBridge(Context context, String origin) {
        this.context = context.getApplicationContext();
        this.origin = origin;
    }

    /**
     * Give {@code web} a {@code window.yaarHost} on {@code origin} (e.g. {@code http://localhost:8000}).
     * Returns false when the installed WebView is too old for either half, in which case the
     * page has no host and keeps its browser paths, exactly as in Chrome.
     */
    static boolean install(Context context, WebView web, String origin) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            return false;
        }
        String script;
        try {
            script = readAsset(context, "yaar-host.js")
                    .replace(ORIGIN_PLACEHOLDER, JSONObject.quote(origin));
        } catch (IOException e) {
            return false;
        }
        Set<String> rules = Set.of(origin);
        WebViewCompat.addWebMessageListener(web, BINDING, rules, new HostBridge(context, origin));
        WebViewCompat.addDocumentStartJavaScript(web, script, rules);
        return true;
    }

    @Override
    public void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin,
            boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame || !origin.equals(sourceOrigin.toString())) return;
        String data = message.getData();
        if (data == null) return;
        final long id;
        final String op;
        final JSONObject args;
        try {
            JSONObject msg = new JSONObject(data);
            id = msg.getLong("id");
            op = msg.getString("op");
            args = msg.optJSONObject("args") != null ? msg.getJSONObject("args") : new JSONObject();
        } catch (JSONException e) {
            return;
        }
        // A download can be 128 MB of base64: decode and write off the UI thread. The rest
        // are one system call each and must run on it (the clipboard is the focused app's).
        if (op.equals("download")) {
            io.execute(() -> answer(reply, id, op, args));
        } else {
            answer(reply, id, op, args);
        }
    }

    private void answer(JavaScriptReplyProxy reply, long id, String op, JSONObject args) {
        JSONObject out = new JSONObject();
        try {
            out.put("id", id);
            try {
                out.put("result", dispatch(op, args));
            } catch (Exception e) {
                out.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
            }
        } catch (JSONException e) {
            return;
        }
        String json = out.toString();
        main.post(() -> reply.postMessage(json));
    }

    private JSONObject dispatch(String op, JSONObject args) throws Exception {
        switch (op) {
            case "download":
                return new JSONObject().put("savedTo", download(
                        args.getString("name"), args.optString("mime", ""), args.getString("base64")));
            case "clipboard.readText":
                return new JSONObject().put("text", readClipboard());
            case "clipboard.writeText":
                clipboard().setPrimaryClip(ClipData.newPlainText("YAAR", args.getString("text")));
                return new JSONObject();
            case "openExternal":
                openExternal(context, args.getString("url"));
                return new JSONObject();
            default:
                throw new IllegalArgumentException("unknown host op: " + op);
        }
    }

    /**
     * Save into Downloads/YAAR through MediaStore, which needs no permission and renames
     * rather than overwrites. Resolves with the name MediaStore actually gave the file.
     */
    private String download(String name, String mime, String base64) throws IOException {
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, safeFileName(name));
        if (!mime.isEmpty()) values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.RELATIVE_PATH, DOWNLOAD_SUBDIR);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("the Downloads folder refused the file");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("could not open " + uri);
            out.write(bytes);
        } catch (IOException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(uri, done, null, null);
        return DOWNLOAD_SUBDIR + "/" + displayName(resolver, uri, name);
    }

    private static String displayName(ContentResolver resolver, Uri uri, String fallback) {
        try (Cursor c = resolver.query(uri, new String[] {MediaStore.Downloads.DISPLAY_NAME},
                null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        }
        return fallback;
    }

    /** The same rule as {@code safeFileName} in {@code host-bridge.ts}. */
    static String safeFileName(String name) {
        String base = name.replace('\\', '/');
        base = base.substring(base.lastIndexOf('/') + 1);
        base = base.replaceAll("[:\\x00-\\x1f]", "_").replaceAll("^[.\\s]+", "").trim();
        return base.isEmpty() ? "download" : base;
    }

    private String readClipboard() {
        ClipData clip = clipboard().getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "";
        CharSequence text = clip.getItemAt(0).coerceToText(context);
        return text == null ? "" : text.toString();
    }

    private ClipboardManager clipboard() {
        return (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
    }

    /** http(s) and mailto: only, in whatever app owns them. */
    static void openExternal(Context context, String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme) && !"mailto".equals(scheme)) {
            throw new IllegalArgumentException("only http(s) and mailto: URLs open externally");
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            throw new IllegalStateException("no app opens " + url);
        }
    }

    private static String readAsset(Context context, String name) throws IOException {
        // Not readAllBytes(): that is API 33.
        try (InputStream in = context.getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
