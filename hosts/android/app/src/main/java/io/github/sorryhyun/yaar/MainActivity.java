package io.github.sorryhyun.yaar;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * The YAAR desktop in the system WebView. This is the display only: the server runs in Termux
 * ({@link Termux}), and this activity waits for it, starting it if it is not running.
 *
 * <p>What the page gets, and why each is here: {@code docs/installations/android.md}.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "YaarHost";
    private static final int DEFAULT_PORT = 8000;
    private static final int REQ_FILES = 1;
    private static final int REQ_MIC = 2;
    private static final int REQ_TERMUX = 3;
    private static final long PROBE_INTERVAL_MS = 1000;
    private static final int PROBE_TIMEOUT_MS = 800;

    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView web;
    private View waiting;
    private TextView waitingText;

    /** {@code http://localhost:<port>/}: the only URL this activity loads as the desktop. */
    private Uri desktop;
    /** The desktop has been handed to {@link #web} (it may still be loading). */
    private boolean loaded;
    private volatile boolean probing;
    private boolean termuxStarted;
    private boolean termuxPermissionAsked;

    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingMic;
    private Dialog popup;
    private WebView popupView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setDecorFitsSystemWindows(false);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        waiting = buildWaitingView();
        root.addView(waiting, match());
        root.setOnApplyWindowInsetsListener(this::applyInsets);
        setContentView(root);
        registerBack();

        desktop = desktopFrom(getIntent());
        if (desktop == null) desktop = Uri.parse("http://localhost:" + DEFAULT_PORT + "/");
        createWebView();
        awaitServer();
    }

    /** termux-open-desktop.sh and notification taps land here while the activity is up. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri next = desktopFrom(intent);
        if (next != null && !next.equals(desktop)) {
            desktop = next;
            createWebView();
            awaitServer();
        } else if (!loaded && !probing) {
            awaitServer();
        }
    }

    /** A VIEW of {@code http://localhost:<port>/}, normalized; anything else is not ours. */
    private static Uri desktopFrom(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"http".equals(data.getScheme()) || !"localhost".equals(data.getHost())) {
            return null;
        }
        int port = data.getPort() == -1 ? 80 : data.getPort();
        return Uri.parse("http://localhost:" + port + "/");
    }

    /** The desktop's origin, as the page's {@code location.origin} spells it. */
    private String origin() {
        int port = desktop.getPort();
        return port == -1 || port == 80 ? "http://localhost" : "http://localhost:" + port;
    }

    // ── The WebView ─────────────────────────────────────────────────────────────────────

    private void createWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        configure(web.getSettings());
        // App iframes are on 127.0.0.1, a different site from the desktop's localhost.
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new DesktopClient());
        web.setWebChromeClient(new DesktopChrome());
        web.setDownloadListener(this::onDownload);
        if (!HostBridge.install(this, web, origin())) {
            Toast.makeText(this, "This WebView is too old for YAAR's host bridge; "
                    + "saving and clipboard fall back to the browser's.", Toast.LENGTH_LONG).show();
        }
        web.setVisibility(View.INVISIBLE);
        root.addView(web, 0, match());
        loaded = false;
    }

    private static void configure(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
    }

    private static boolean isLoopback(Uri uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        return ("http".equals(scheme) || "https".equals(scheme))
                && ("localhost".equals(host) || "127.0.0.1".equals(host));
    }

    /** Stays in a WebView: loopback, and the schemes that never leave the page. */
    private static boolean staysInside(Uri uri) {
        String scheme = uri.getScheme();
        return isLoopback(uri) || "blob".equals(scheme) || "about".equals(scheme)
                || "data".equals(scheme) || "javascript".equals(scheme);
    }

    private void openOutside(Uri uri) {
        Log.d(TAG, "opening outside: " + uri);
        try {
            HostBridge.openExternal(this, uri.toString());
        } catch (RuntimeException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private final class DesktopClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame() || staysInside(request.getUrl())) return false;
            openOutside(request.getUrl());
            return true;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (view != web) return;
            web.setVisibility(View.VISIBLE);
            waiting.setVisibility(View.GONE);
        }

        /** The server went away under a loaded desktop: back to waiting for it. */
        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == web && request.isForMainFrame()) awaitServer();
        }

        /** Recreate rather than let the process die with the renderer, which is the default. */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view == web) {
                web = null;
                root.removeView(view);
                view.destroy();
                createWebView();
                awaitServer();
            } else {
                closePopup(view);
            }
            return true;
        }
    }

    private final class DesktopChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = mimeTypes(params.getAcceptTypes());
            intent.setType(types.length == 1 ? types[0] : "*/*");
            if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, REQ_FILES);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }

        /** The microphone, for the two loopback origins only, asking Android first. */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean audio = false;
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
            }
            if (!audio || !isLoopback(request.getOrigin())) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                return;
            }
            if (pendingMic != null) pendingMic.deny();
            pendingMic = request;
            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMic == request) pendingMic = null;
        }

        /**
         * A popup starts hidden and without the host bridge. Its first navigation decides:
         * an off-machine URL goes to the default browser, which is where Google's consent
         * screen must be anyway because it refuses embedded WebViews. A loopback, blob: or
         * blank page is shown in a dialog over the desktop.
         */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                Message resultMsg) {
            closePopup(popupView);
            WebView child = new WebView(MainActivity.this);
            configure(child.getSettings());
            child.setWebViewClient(new PopupClient());
            child.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onCloseWindow(WebView window) {
                    closePopup(window);
                }
            });
            popupView = child;
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(child);
            resultMsg.sendToTarget();
            return true;
        }
    }

    private final class PopupClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            return route(view, request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (url != null && route(view, Uri.parse(url))) view.stopLoading();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            closePopup(view);
            return true;
        }

        /** True when the URL left for the default browser, taking the popup with it. */
        private boolean route(WebView view, Uri uri) {
            Log.d(TAG, "popup navigation: " + uri);
            if (staysInside(uri)) {
                showPopup(view);
                return false;
            }
            openOutside(uri);
            closePopup(view);
            return true;
        }
    }

    private void showPopup(WebView view) {
        if (view != popupView || popup != null) return;
        popup = new Dialog(this, android.R.style.Theme_Material_NoActionBar);
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.BLACK);
        frame.addView(view, match());
        frame.setOnApplyWindowInsetsListener(this::applyInsets);
        popup.setContentView(frame);
        popup.setOnCancelListener(d -> closePopup(view));
        popup.show();
    }

    private void closePopup(WebView view) {
        if (view == null || view != popupView) return;
        popupView = null;
        if (popup != null) {
            Dialog d = popup;
            popup = null;
            d.setOnCancelListener(null);
            d.dismiss();
        }
        if (view.getParent() instanceof ViewGroup parent) parent.removeView(view);
        view.destroy();
    }

    /** http(s) downloads go to DownloadManager. blob: ones cannot, and should not arrive. */
    private void onDownload(String url, String userAgent, String contentDisposition,
            String mime, long length) {
        Uri uri = Uri.parse(url);
        if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) {
            // The shell and the app SDK route their own blobs through yaarHost.download.
            Toast.makeText(this, "Couldn't save this download (" + uri.getScheme() + ":)",
                    Toast.LENGTH_LONG).show();
            return;
        }
        String name = URLUtil.guessFileName(url, contentDisposition, mime);
        DownloadManager.Request req = new DownloadManager.Request(uri)
                .setMimeType(mime)
                .addRequestHeader("User-Agent", userAgent)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "YAAR/" + name);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) req.addRequestHeader("Cookie", cookies);
        getSystemService(DownloadManager.class).enqueue(req);
        Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
    }

    // ── Waiting for the server ──────────────────────────────────────────────────────────

    /** Show the waiting screen and poll {@code /health} until the server answers. */
    private void awaitServer() {
        loaded = false;
        termuxStarted = false;
        if (web != null) web.setVisibility(View.INVISIBLE);
        waiting.setVisibility(View.VISIBLE);
        waitingText.setText("Connecting to YAAR on " + desktop.getAuthority() + "…");
        if (probing) return;
        probing = true;
        String health = desktop.toString() + "health";
        Thread t = new Thread(() -> {
            while (probing) {
                if (reachable(health)) {
                    main.post(() -> {
                        if (!probing) return;
                        probing = false;
                        loaded = true;
                        web.loadUrl(desktop.toString());
                    });
                    return;
                }
                main.post(() -> { if (probing) onServerMissing(); });
                try {
                    Thread.sleep(PROBE_INTERVAL_MS);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "yaar-probe");
        t.setDaemon(true);
        t.start();
    }

    private static boolean reachable(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(PROBE_TIMEOUT_MS);
            c.setReadTimeout(PROBE_TIMEOUT_MS);
            c.getResponseCode();
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** One failed probe: say why, and start the server in Termux once per wait. */
    private void onServerMissing() {
        String where = desktop.getAuthority();
        if (!Termux.installed(this)) {
            waitingText.setText("YAAR's server runs in Termux, which is not installed.\n\n"
                    + "Install Termux (F-Droid or GitHub), then in Termux run:\n\n"
                    + "curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash"
                    + "\n\nWaiting for a server on " + where + "…");
            return;
        }
        if (!Termux.hasPermission(this)) {
            if (!termuxPermissionAsked) {
                termuxPermissionAsked = true;
                requestPermissions(new String[] {Termux.PERMISSION}, REQ_TERMUX);
            }
            waitingText.setText("No YAAR server on " + where + ".\n\n"
                    + "Allow YAAR to run commands in Termux and it will start one, "
                    + "or run `yaar` in Termux yourself.");
            return;
        }
        if (!termuxStarted) {
            termuxStarted = true;
            try {
                Termux.startServer(this);
            } catch (RuntimeException e) {
                waitingText.setText("Termux refused to start YAAR: " + e.getMessage());
                return;
            }
        }
        waitingText.setText("Starting YAAR in Termux…\n\n"
                + "If this takes more than a minute, Termux may be refusing other apps. Add\n\n"
                + "allow-external-apps = true\n\n"
                + "to ~/.termux/termux.properties, then open YAAR again.");
    }

    private View buildWaitingView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int pad = dp(32);
        box.setPadding(pad, pad, pad, pad);
        box.addView(new ProgressBar(this));
        waitingText = new TextView(this);
        waitingText.setTextColor(Color.WHITE);
        waitingText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        waitingText.setGravity(Gravity.CENTER);
        waitingText.setTextIsSelectable(true);
        waitingText.setPadding(0, dp(24), 0, 0);
        box.addView(waitingText);
        return box;
    }

    // ── Insets, Back, lifecycle ─────────────────────────────────────────────────────────

    /**
     * The desktop is laid out between the bars, as it is in Chrome, rather than under them.
     * The page's {@code env(safe-area-inset-*)} cannot be trusted with the bars: WebView 124
     * (measured on the emulator) reports the display cutout there, and never the status or
     * navigation bar. So the gesture bar covered the phone shell's input, and a phone with
     * no cutout would get nothing at the top either. Padding natively leaves the page
     * nothing to overlap, so env() reads 0 whatever the WebView version.
     *
     * The keyboard is the same story: under edge-to-edge, adjustResize no longer shrinks
     * the window, so the page would otherwise type behind it.
     */
    private WindowInsets applyInsets(View v, WindowInsets insets) {
        Insets bars = insets.getInsets(
                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        Insets ime = insets.getInsets(WindowInsets.Type.ime());
        v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
        return insets;
    }

    /**
     * Back walks the desktop's own history, where the phone shell keeps a guard entry
     * (usePhoneBack.ts): popping it is the shell's cue to close one layer. With nothing to
     * pop, YAAR goes to the background rather than finishing, since finishing would tear
     * down the desktop.
     */
    private void registerBack() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (web != null && loaded && web.canGoBack()) {
            web.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    /** Per-WebView pause only. Never the global pauseTimers(): the page decides what to throttle. */
    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        probing = false;
        closePopup(popupView);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || fileCallback == null) return;
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            picked = uris.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_MIC || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMic.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    /** {@code accept} entries as MIME types: {@code .txt} is looked up, empty means any. */
    private static String[] mimeTypes(String[] accept) {
        List<String> out = new ArrayList<>();
        if (accept != null) {
            for (String a : accept) {
                for (String part : a.split(",")) {
                    String t = part.trim().toLowerCase();
                    if (t.isEmpty()) continue;
                    if (t.startsWith(".")) {
                        t = MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.substring(1));
                        if (t == null) return new String[] {"*/*"};
                    }
                    if (!out.contains(t)) out.add(t);
                }
            }
        }
        return out.isEmpty() ? new String[] {"*/*"} : out.toArray(new String[0]);
    }

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
