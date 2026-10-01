package io.github.sorryhyun.yaar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the process, and with it the desktop's renderer, out of Android's cached state while
 * the activity is in the background. A cached app is frozen within seconds, and a frozen
 * desktop answers nothing an agent asks it. See "Out of sight" in {@link MainActivity}.
 *
 * <p>{@code specialUse}, because no other foreground service type describes it, and the ones
 * that come close ({@code dataSync}) are stopped after six hours a day from Android 15 on.
 */
public final class KeepAliveService extends Service {
    private static final String CHANNEL = "desktop";
    private static final int NOTIFICATION_ID = 1;

    /** In the foreground now. Main thread only, like the activity that reads it. */
    static boolean running;

    static void start(Context context) {
        context.startForegroundService(new Intent(context, KeepAliveService.class));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, KeepAliveService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "Desktop running", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_desktop)
                .setContentTitle("YAAR")
                .setContentText("The desktop keeps answering agents in the background")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    /** Swiped away from Recents: the desktop is gone, so there is nothing left to keep. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
