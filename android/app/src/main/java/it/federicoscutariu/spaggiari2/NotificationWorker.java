package it.federicoscutariu.spaggiari2;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Notifiche di Skoolio anche ad app chiusa.
 *
 * Ogni ~15 minuti (WorkManager, solo con rete) legge {@code /api/notifiche} con il cookie di
 * sessione dell'app e mostra come notifiche Android quelle nuove. Le novità le trova il server
 * (sincronizzazione periodica con ClasseViva): qui si mostrano soltanto.
 */
public class NotificationWorker extends Worker {

    static final String BASE_URL = "https://spaggiari2.federicoscutariu.it";
    static final String CHANNEL_ID = "novita";
    static final String EXTRA_URL = "skoolio_url";
    private static final String PREFS = "skoolio_notifications";
    private static final String KEY_LAST_ID = "last_notified_id";
    private static final String WORK_NAME = "skoolio-notifiche";

    public NotificationWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** Pianifica il controllo periodico (idempotente). */
    public static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(NotificationWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Novità dal registro", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Nuovi voti, comunicazioni, note e compiti");
        nm.createNotificationChannel(channel);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String cookies;
        try {
            cookies = CookieManager.getInstance().getCookie(BASE_URL);
        } catch (Exception e) {
            return Result.success(); // WebView non disponibile: riprova al prossimo giro
        }
        if (cookies == null || !cookies.contains("session_id=")) return Result.success();

        JSONArray items;
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(BASE_URL + "/api/notifiche?limit=20").openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("Cookie", cookies);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == 401) return Result.success(); // sessione scaduta: niente da mostrare
            if (code != 200) return Result.retry();
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            items = new JSONObject(body.toString()).optJSONArray("items");
        } catch (Exception e) {
            return Result.retry();
        }
        if (items == null) return Result.success();

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long lastId = prefs.getLong(KEY_LAST_ID, -1);
        long maxId = lastId;
        for (int i = 0; i < items.length(); i++) {
            maxId = Math.max(maxId, items.optJSONObject(i).optLong("id", 0));
        }
        if (lastId < 0) {
            // Prima esecuzione: non mostrare le notifiche vecchie, segna solo il punto di partenza.
            prefs.edit().putLong(KEY_LAST_ID, Math.max(0, maxId)).apply();
            return Result.success();
        }
        if (!canNotify(context)) {
            prefs.edit().putLong(KEY_LAST_ID, maxId).apply();
            return Result.success();
        }
        ensureChannel(context);
        int shown = 0;
        for (int i = items.length() - 1; i >= 0; i--) { // dal più vecchio al più nuovo
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            long id = item.optLong("id", 0);
            if (id <= lastId || item.optBoolean("read", false)) continue;
            if (shown < 6) show(context, (int) (id % Integer.MAX_VALUE), item.optString("title", "Skoolio"),
                item.optString("body", ""), item.optString("url", "/notifiche"));
            shown++;
        }
        prefs.edit().putLong(KEY_LAST_ID, maxId).apply();
        return Result.success();
    }

    private static boolean canNotify(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    private static void show(Context context, int id, String title, String body, String url) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.putExtra(EXTRA_URL, url);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_skoolio)
            .setColor(0xFFE3242C)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
        } catch (SecurityException ignored) {
            // permesso revocato nel frattempo
        }
    }
}
