package it.federicoscutariu.spaggiari2;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin locale per il login SPID/CIE su ClasseViva (va registrato prima di super.onCreate).
        registerPlugin(SpaggiariLoginPlugin.class);
        super.onCreate(savedInstanceState);
        NotificationWorker.ensureChannel(this);
        NotificationWorker.schedule(this);
        openFromNotification(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromNotification(intent);
    }

    /** Tocco su una notifica: apre la sezione collegata (es. /voti, /bacheca?id=…). */
    private void openFromNotification(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra(NotificationWorker.EXTRA_URL);
        if (path == null || !path.startsWith("/") || path.startsWith("//")) return;
        intent.removeExtra(NotificationWorker.EXTRA_URL);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(NotificationWorker.BASE_URL + path));
        }
    }
}
