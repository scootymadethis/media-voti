package it.federicoscutariu.spaggiari2;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.lang.ref.WeakReference;
import java.util.Locale;

/**
 * WebView dedicata al login sul sito ufficiale di ClasseViva (SPID, CIE o credenziali).
 *
 * - Link http(s): restano nella WebView (pagine di ClasseViva e dei gestori SPID/CIE).
 * - CIE con app CieID: le pagine del Ministero aprono un indirizzo con "/OpenApp"; come da
 *   documentazione IPZS lo passiamo all'app CieID e, al ritorno, ricarichiamo l'URL che CieID
 *   restituisce nell'extra "URL".
 * - intent:// e altri schemi (app dei gestori SPID): aperti con l'app esterna.
 * - Dopo ogni pagina di ClasseViva che non fa parte del flusso di login, il cookie PHPSESSID
 *   viene passato alla pagina Aulera, che lo fa verificare al backend.
 */
public class SpaggiariLoginActivity extends AppCompatActivity {

    static final String EXTRA_URL = "url";
    private static final int CIEID_REQUEST = 0xC1E;
    private static final String CIEID_PACKAGE = "it.ipzs.cieid";
    private static final String CIEID_ACTIVITY = "it.ipzs.cieid.BaseActivity";
    private static final String[] AUTH_PATH_HINTS = {"login", "auth-p7", "sso", "spid", "cie", "idp", "saml", "logout"};

    private static WeakReference<SpaggiariLoginActivity> current = new WeakReference<>(null);

    private static final long VERIFY_TIMEOUT_MS = 9000;

    private WebView webView;
    private ProgressBar progress;
    private TextView urlLabel;
    private View overlay;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean verifying = false;
    private String lastPostLoginUrl = null;
    private int retriesForUrl = 0;
    private final Runnable verifyTimeout = () -> resumeAfterFailedCheck();

    static void finishCurrent() {
        SpaggiariLoginActivity activity = current.get();
        if (activity != null) activity.runOnUiThread(activity::finish);
    }

    /** La pagina Aulera ha scartato la sessione (non ancora valida): torna a mostrare ClasseViva. */
    static void resumeCurrent() {
        SpaggiariLoginActivity activity = current.get();
        if (activity != null) activity.runOnUiThread(activity::resumeAfterFailedCheck);
    }

    private void resumeAfterFailedCheck() {
        handler.removeCallbacks(verifyTimeout);
        verifying = false;
        overlay.setVisibility(View.GONE);
        // ClasseViva può completare la sessione un attimo dopo: riprova sulla stessa pagina.
        if (lastPostLoginUrl != null && retriesForUrl < 3) {
            retriesForUrl++;
            String url = lastPostLoginUrl;
            handler.postDelayed(() -> detectSession(url), 1200);
        }
    }

    /**
     * Appena ClasseViva mostra una pagina successiva al login, copre la WebView e passa il
     * cookie ad Aulera: lo studente non vede la dashboard di Spaggiari, vede "accesso in corso".
     */
    private void detectSession(String url) {
        if (!isPostLoginPage(url)) return;
        if (!url.equals(lastPostLoginUrl)) retriesForUrl = 0;
        lastPostLoginUrl = url;
        if (verifying) return;
        String phpsessid = SpaggiariLoginPlugin.readPhpSessId(url);
        if (phpsessid == null) return;
        verifying = true;
        overlay.setVisibility(View.VISIBLE);
        handler.removeCallbacks(verifyTimeout);
        handler.postDelayed(verifyTimeout, VERIFY_TIMEOUT_MS);
        SpaggiariLoginPlugin.emitSessionCandidate(phpsessid, url);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#070B12"));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), dp(8), dp(8), dp(8));
        bar.setBackgroundColor(Color.parseColor("#101722"));

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("Accesso a ClasseViva");
        title.setTextColor(Color.parseColor("#F6F6F7"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        urlLabel = new TextView(this);
        urlLabel.setTextColor(Color.parseColor("#8295A8"));
        urlLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        urlLabel.setSingleLine(true);
        titles.addView(title);
        titles.addView(urlLabel);
        bar.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button close = new Button(this);
        close.setText("Chiudi");
        close.setAllCaps(false);
        close.setTextColor(Color.parseColor("#A1D8E2"));
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setOnClickListener(v -> finish());
        bar.addView(close);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        FrameLayout content = new FrameLayout(this);
        webView = new WebView(this);
        content.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout cover = new LinearLayout(this);
        cover.setOrientation(LinearLayout.VERTICAL);
        cover.setGravity(Gravity.CENTER);
        cover.setBackgroundColor(Color.parseColor("#070B12"));
        cover.setClickable(true);
        ProgressBar spinner = new ProgressBar(this);
        cover.addView(spinner);
        TextView coverText = new TextView(this);
        coverText.setText("Accesso ad Aulera in corso…");
        coverText.setTextColor(Color.parseColor("#F6F6F7"));
        coverText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        coverText.setPadding(0, dp(16), 0, 0);
        cover.addView(coverText);
        cover.setVisibility(View.GONE);
        overlay = cover;
        content.addView(cover, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        // Margini per barra di stato e barra di navigazione (edge-to-edge su Android 15).
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
        });
        webView.setWebViewClient(new LoginClient());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack();
                else finish();
            }
        });

        String url = getIntent().getStringExtra(EXTRA_URL);
        webView.loadUrl(url != null ? url : SpaggiariLoginPlugin.DEFAULT_LOGIN_URL);
    }

    private class LoginClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            Uri uri = Uri.parse(url);
            urlLabel.setText(uri.getHost() != null ? uri.getHost() : "");
            // Il cookie di sessione arriva con il redirect dal login: si può verificare subito.
            detectSession(url);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            detectSession(url); // navigazioni interne delle pagine (history.pushState)
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
            detectSession(url);
        }
    }

    private static boolean isPostLoginPage(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (!host.equals("spaggiari.eu") && !host.endsWith(".spaggiari.eu")) return false;
        if (host.startsWith("www.")) return false; // sito vetrina, non il registro
        String path = uri.getPath() == null ? "" : uri.getPath().toLowerCase(Locale.ROOT);
        for (String hint : AUTH_PATH_HINTS) {
            if (path.contains(hint)) return false;
        }
        return true;
    }

    private boolean handleUrl(Uri uri) {
        String url = uri.toString();
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);

        if (url.contains("/OpenApp")) {
            openCieId(url);
            return true;
        }
        if (scheme.equals("http") || scheme.equals("https")) {
            return false;
        }
        if (scheme.equals("intent")) {
            try {
                Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
                try {
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    String fallback = intent.getStringExtra("browser_fallback_url");
                    if (fallback != null && fallback.startsWith("https://")) webView.loadUrl(fallback);
                    else Toast.makeText(this, "App necessaria non installata", Toast.LENGTH_LONG).show();
                }
            } catch (Exception e) {
                Toast.makeText(this, "Link non supportato", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        // Altri schemi (app dei gestori SPID, mailto, tel, ...): app esterna.
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "App necessaria non installata", Toast.LENGTH_LONG).show();
        }
        return true;
    }

    private void openCieId(String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setClassName(CIEID_PACKAGE, CIEID_ACTIVITY);
        try {
            startActivityForResult(intent, CIEID_REQUEST);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Installa l'app CieID per entrare con la CIE", Toast.LENGTH_LONG).show();
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + CIEID_PACKAGE)));
            } catch (ActivityNotFoundException ignored) {
                // nessuno store disponibile
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CIEID_REQUEST) return;
        String next = data != null ? data.getStringExtra("URL") : null;
        if (next != null && next.startsWith("https://")) {
            webView.loadUrl(next);
        } else if (resultCode != Activity.RESULT_OK) {
            Toast.makeText(this, "Accesso con CIE annullato", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (current.get() == this) current = new WeakReference<>(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        SpaggiariLoginPlugin.emitClosed();
        super.onDestroy();
    }
}
