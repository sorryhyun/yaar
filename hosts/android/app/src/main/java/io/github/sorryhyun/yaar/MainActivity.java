package io.github.sorryhyun.yaar;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
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
import android.view.Window;
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
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.IOException;
import java.net.ConnectException;
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
    private static final int REQ_CAPTURE = 2;
    private static final int REQ_TERMUX = 3;
    private static final long PROBE_INTERVAL_MS = 1000;
    private static final int PROBE_TIMEOUT_MS = 800;
    private static final long WATCH_INTERVAL_MS = 3000;
    private static final int WATCH_TIMEOUT_MS = 2000;
    /** Misses in a row before the desktop gives way to the waiting screen, by kind. */
    private static final int WATCH_REFUSED_LIMIT = 2;
    private static final int WATCH_TIMEOUT_LIMIT = 4;

    private static final int ANSWERED = 0;
    private static final int REFUSED = 1;
    private static final int NO_ANSWER = 2;

    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private DesktopWebView web;
    private View waiting;
    private TextView waitingText;
    /** Shown only for a Termux that cannot be asked to start the server. */
    private View openTermux;

    /** {@code http://localhost:<port>/}: the only URL this activity loads as the desktop. */
    private Uri desktop;
    /** The desktop has been handed to {@link #web} (it may still be loading). */
    private boolean loaded;
    private volatile boolean probing;
    private boolean termuxStarted;
    private boolean termuxPermissionAsked;
    /** Bumped on every start and stop of the watch, so a probe from an old one is dropped. */
    private int watchGeneration;
    private int watchRefused;
    private int watchTimedOut;

    /** A person can see the desktop: between onStart and onStop. */
    private boolean attended;

    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingCapture;
    private Dialog popup;
    private WebView popupView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        hideStatusBar(getWindow());
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        waiting = buildWaitingView();
        root.addView(waiting, match());
        ViewCompat.setOnApplyWindowInsetsListener(root, this::applyInsets);
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
        web = new DesktopWebView(this);
        web.setBackgroundColor(Color.BLACK);
        configure(web.getSettings());
        // App iframes are on 127.0.0.1, a different site from the desktop's localhost.
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new DesktopClient());
        web.setWebChromeClient(new DesktopChrome());
        web.setDownloadListener(this::onDownload);
        if (!HostBridge.install(this, web, origin(), () -> attended)) {
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

        /**
         * The microphone and camera, for the two loopback origins only, asking Android first.
         * A request naming anything else (protected media, MIDI) is refused whole.
         */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            String[] resources = request.getResources();
            if (resources.length == 0 || !isLoopback(request.getOrigin())) {
                request.deny();
                return;
            }
            List<String> missing = new ArrayList<>();
            for (String r : resources) {
                String perm = androidPermissionFor(r);
                if (perm == null) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) missing.add(perm);
            }
            if (missing.isEmpty()) {
                request.grant(resources);
                return;
            }
            if (pendingCapture != null) pendingCapture.deny();
            pendingCapture = request;
            requestPermissions(missing.toArray(new String[0]), REQ_CAPTURE);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingCapture == request) pendingCapture = null;
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
        ViewCompat.setOnApplyWindowInsetsListener(frame, this::applyInsets);
        popup.setContentView(frame);
        hideStatusBar(popup.getWindow());
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
        openTermux.setVisibility(View.GONE);
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
                        keepAlive();
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
        return probe(url, PROBE_TIMEOUT_MS) == ANSWERED;
    }

    /**
     * Any HTTP answer is {@link #ANSWERED}. {@link #REFUSED} means nothing listens on the port,
     * which on loopback is a definite answer; anything else is {@link #NO_ANSWER}, which a busy
     * server can also give.
     */
    private static int probe(String url, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.getResponseCode();
            return ANSWERED;
        } catch (ConnectException e) {
            return REFUSED;
        } catch (IOException e) {
            return NO_ANSWER;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ── Watching a loaded desktop ───────────────────────────────────────────────────────

    /*
     * A reload with no server does not come back to the waiting screen: once sw.js has cached
     * the shell, it answers the reload itself and onReceivedError never fires. The desktop
     * reconnects on its own when the server returns, but nothing would start it, so a server
     * killed while YAAR was in the background left the app on a desktop waiting forever.
     *
     * So while the activity is in front and the desktop is loaded, it probes /health itself,
     * and a server that is gone hands over to awaitServer(), which starts it again in Termux.
     * A refused connection is a server that is gone; no answer in time can be a busy one (a
     * compile, a big turn), so it takes more of those.
     */

    private void startWatch() {
        int generation = ++watchGeneration;
        watchRefused = 0;
        watchTimedOut = 0;
        main.post(() -> watchTick(generation));
    }

    private void stopWatch() {
        watchGeneration++;
    }

    private void watchTick(int generation) {
        if (generation != watchGeneration) return;
        if (!loaded) {
            // awaitServer() is probing; pick up again once it has loaded the desktop.
            main.postDelayed(() -> watchTick(generation), WATCH_INTERVAL_MS);
            return;
        }
        String health = desktop.toString() + "health";
        Thread t = new Thread(() -> {
            int result = probe(health, WATCH_TIMEOUT_MS);
            main.post(() -> onWatchResult(generation, result));
        }, "yaar-watch");
        t.setDaemon(true);
        t.start();
    }

    private void onWatchResult(int generation, int result) {
        if (generation != watchGeneration) return;
        if (loaded) {
            watchRefused = result == REFUSED ? watchRefused + 1 : 0;
            watchTimedOut = result == NO_ANSWER ? watchTimedOut + 1 : 0;
            if (watchRefused >= WATCH_REFUSED_LIMIT || watchTimedOut >= WATCH_TIMEOUT_LIMIT) {
                Log.i(TAG, "server gone under the desktop ("
                        + (result == REFUSED ? "refused" : "no answer") + "), waiting for it again");
                watchRefused = 0;
                watchTimedOut = 0;
                awaitServer();
            }
        }
        main.postDelayed(() -> watchTick(generation), WATCH_INTERVAL_MS);
    }

    /** One failed probe: say why, and start the server in Termux once per wait. */
    private void onServerMissing() {
        String where = desktop.getAuthority();
        openTermux.setVisibility(View.GONE);
        if (!Termux.installed(this)) {
            waitingText.setText("YAAR's server runs in Termux, which is not installed.\n\n"
                    + "Install Termux (F-Droid or GitHub), then in Termux run:\n\n"
                    + "curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash"
                    + "\n\nWaiting for a server on " + where + "…");
            return;
        }
        // Termux from Google Play has no RUN_COMMAND, so asking for it would be refused
        // unseen and the screen would ask for a permission there is no way to give.
        if (!Termux.takesRunCommand(this)) {
            if (Termux.launchIntent(this) != null) openTermux.setVisibility(View.VISIBLE);
            waitingText.setText("No YAAR server on " + where + ".\n\n"
                    + "Open Termux and run\n\nyaar\n\n"
                    + "The desktop opens here once the server answers.");
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
        Button open = new Button(this);
        open.setText("Open Termux");
        open.setVisibility(View.GONE);
        open.setOnClickListener(v -> {
            Intent termux = Termux.launchIntent(this);
            if (termux != null) startActivity(termux);
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(24);
        box.addView(open, lp);
        openTermux = open;
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
     *
     * The insets are consumed here, so the WebView under the padding never sees them. Newer
     * WebViews do put the bars in env() (153 on a Galaxy S25: 35 px top, 48 px bottom), and
     * handed the same insets unconsumed they padded a second time on top of this.
     *
     * Through androidx.core, because the platform's WindowInsets.Type is API 30 and the app
     * runs from 29.
     */
    private WindowInsetsCompat applyInsets(View v, WindowInsetsCompat insets) {
        Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
        v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
        return WindowInsetsCompat.CONSUMED;
    }

    /**
     * The status bar is hidden, so the desktop gets the top of the screen; a swipe from the
     * edge shows it over the page for a moment. A hidden bar has no insets, so
     * {@link #applyInsets} pads the top by the display cutout alone, which in portrait on a
     * punch-hole phone is still most of the bar. The navigation bar stays: Back and Home
     * need it.
     */
    private static void hideStatusBar(Window window) {
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.statusBars());
    }

    /** The system can bring the bar back (another app, a dialog, the lock screen). */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideStatusBar(getWindow());
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

    /** API 29–32 only: from 33 on, Back arrives through the dispatcher registered above. */
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
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

    // ── Out of sight ────────────────────────────────────────────────────────────────────

    /*
     * An agent goes on working after the user has left for another app, and what it asks the
     * desktop (an app's state, a screenshot) has to be answered by the page that ran its
     * earlier commands. Measured on a Galaxy S25 (Android 16, WebView 153), a backgrounded
     * activity loses that page in two steps:
     *
     *  - Android caches the process and freezes it within 20 s. Nothing runs at all.
     *  - With the process kept alive, the page still turns `hidden` with its window, its
     *    timers drop to one a second, and after 60 s WebView freezes the page itself.
     *
     * So it takes both halves: KeepAliveService keeps the process out of the cached state,
     * and DesktopWebView.stayVisible keeps the page `visible`. With both, timers run at full
     * rate and fetch and DOM capture answer, through 7 minutes in the background and with the
     * screen off. requestAnimationFrame does not fire: there is no surface to draw to.
     *
     * The page can then no longer tell that nobody is looking, so the host says it
     * (yaarHost.attended and the `attention` event), which is what lets the server go on
     * mirroring notifications into the shade.
     */

    /**
     * Keep the desktop running out of sight, from the first load on. The page is held visible
     * only if the service is running: a visible page in a frozen process would look able to
     * answer and never do it. Android 12 and later refuse the start from the background, so
     * onStart tries again.
     */
    private void keepAlive() {
        if (!loaded || web == null) return;
        boolean running = KeepAliveService.running;
        if (!running) {
            try {
                KeepAliveService.start(this);
                running = true;
            } catch (RuntimeException e) {
                Log.w(TAG, "the keep-alive service did not start: " + e);
            }
        }
        web.stayVisible = running;
    }

    private void setAttended(boolean now) {
        attended = now;
        if (web == null || !loaded) return;
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('yaarhost:attention',"
                + "{detail:{attended:" + now + "}}))", null);
    }

    @Override
    protected void onStart() {
        super.onStart();
        keepAlive();
        setAttended(true);
    }

    @Override
    protected void onStop() {
        super.onStop();
        setAttended(false);
    }

    /**
     * Per-WebView pause only, and not for a page that is being kept running. Never the global
     * pauseTimers().
     */
    @Override
    protected void onPause() {
        super.onPause();
        stopWatch();
        if (web != null && !web.stayVisible) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        startWatch();
    }

    @Override
    protected void onDestroy() {
        probing = false;
        stopWatch();
        KeepAliveService.stop(this);
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

    /** The Android permission a WebView capture resource needs, or null for one we never grant. */
    private static String androidPermissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
            return Manifest.permission.RECORD_AUDIO;
        }
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
            return Manifest.permission.CAMERA;
        }
        return null;
    }

    /**
     * All or nothing: getUserMedia for camera and microphone fails if either is missing, so a
     * half grant would only move the failure from Android's dialog to the page.
     */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_CAPTURE || pendingCapture == null) return;
        boolean all = results.length == permissions.length && results.length > 0;
        for (int r : results) {
            if (r != PackageManager.PERMISSION_GRANTED) all = false;
        }
        if (all) {
            pendingCapture.grant(pendingCapture.getResources());
        } else {
            pendingCapture.deny();
        }
        pendingCapture = null;
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
