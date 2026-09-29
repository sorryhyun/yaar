package io.github.sorryhyun.yaar;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

/**
 * The server lives in Termux, which is the agents' userland and not just a runner. This APK is
 * only the display. When a tap finds no server, this class asks Termux to start one.
 *
 * <p>{@code RUN_COMMAND} needs two one-time grants, and the waiting screen names both:
 * <ul>
 *   <li>{@code allow-external-apps = true} in {@code ~/.termux/termux.properties};</li>
 *   <li>the {@code com.termux.permission.RUN_COMMAND} runtime permission.</li>
 * </ul>
 *
 * <p>Not every Termux takes it. The Google Play build (measured: {@code googleplay.2026.06.21})
 * ships without {@code RunCommandService}, and so without the permission, which Android then
 * refuses without asking. With that Termux you run {@code yaar} yourself; the app only waits.
 */
final class Termux {
    static final String PACKAGE = "com.termux";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService";

    /** The launcher install.sh puts in {@code $PREFIX/bin}; it runs {@code make termux} in ~/yaar. */
    private static final String YAAR_LAUNCHER = "/data/data/com.termux/files/usr/bin/yaar";

    private Termux() {}

    static boolean installed(Context context) {
        try {
            context.getPackageManager().getPackageInfo(PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** Whether this Termux can be asked to run anything at all (see the class comment). */
    static boolean takesRunCommand(Context context) {
        try {
            context.getPackageManager()
                    .getServiceInfo(new ComponentName(PACKAGE, RUN_COMMAND_SERVICE), 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** Termux's own launcher activity, or null. */
    static Intent launchIntent(Context context) {
        return context.getPackageManager().getLaunchIntentForPackage(PACKAGE);
    }

    static boolean hasPermission(Context context) {
        return context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Run {@code yaar} in a new Termux terminal session without bringing Termux to the front.
     * It is a session rather than a background task so the server's log is one tap away.
     * Termux answers a refused {@code allow-external-apps} with its own notification, not
     * with an exception here. So a start that throws nothing is not proof the server is
     * coming, and the caller keeps polling either way.
     */
    static void startServer(Context context) {
        Intent intent = new Intent("com.termux.RUN_COMMAND")
                .setClassName(PACKAGE, RUN_COMMAND_SERVICE)
                .putExtra("com.termux.RUN_COMMAND_PATH", YAAR_LAUNCHER)
                .putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
                // 1: switch to the new session, but do not open Termux's activity.
                .putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "1");
        context.startService(intent);
    }
}
