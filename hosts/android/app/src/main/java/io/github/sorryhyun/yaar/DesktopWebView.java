package io.github.sorryhyun.yaar;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * The desktop's WebView, which can go on telling its page it is visible after the activity's
 * window is gone. A page that turns {@code hidden} has its timers throttled, and WebView
 * freezes it after a minute; see "Out of sight" in {@link MainActivity}.
 */
final class DesktopWebView extends WebView {
    /** Set only while {@link KeepAliveService} runs. */
    boolean stayVisible;

    DesktopWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(stayVisible ? View.VISIBLE : visibility);
    }
}
