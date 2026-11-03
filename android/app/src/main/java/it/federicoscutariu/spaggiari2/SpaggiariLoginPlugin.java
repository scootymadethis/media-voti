package it.federicoscutariu.spaggiari2;

import android.content.Intent;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

/**
 * Login ClasseViva con SPID/CIE per Aulera.
 *
 * Apre la pagina di login UFFICIALE di ClasseViva in una WebView dedicata
 * ({@link SpaggiariLoginActivity}). Lo studente si autentica con il proprio gestore SPID o
 * con la CIE: le credenziali restano tra lui, ClasseViva e il gestore. Quando una pagina di
 * ClasseViva successiva al login è caricata, il plugin legge il cookie di sessione PHPSESSID
 * (HttpOnly, quindi invisibile a JavaScript) dal CookieManager di Android e lo invia alla pagina
 * con l'evento "sessionCandidate". La pagina lo fa verificare al backend e chiama close().
 *
 * Eventi: "sessionCandidate" {phpsessid, url}, "closed" {}.
 */
@CapacitorPlugin(name = "SpaggiariLogin")
public class SpaggiariLoginPlugin extends Plugin {

    static final String SPAGGIARI_URL = "https://web.spaggiari.eu";
    static final String DEFAULT_LOGIN_URL = SPAGGIARI_URL + "/home/app/default/login.php";

    private static WeakReference<SpaggiariLoginPlugin> instance = new WeakReference<>(null);

    @Override
    public void load() {
        instance = new WeakReference<>(this);
    }

    static void emitSessionCandidate(String phpsessid, String url) {
        SpaggiariLoginPlugin plugin = instance.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("phpsessid", phpsessid);
        data.put("url", url);
        plugin.notifyListeners("sessionCandidate", data);
    }

    static void emitClosed() {
        SpaggiariLoginPlugin plugin = instance.get();
        if (plugin == null) return;
        plugin.notifyListeners("closed", new JSObject());
    }

    /** Cancella i cookie di ClasseViva, così il login riparte da zero. */
    static void clearSpaggiariCookies() {
        CookieManager cm = CookieManager.getInstance();
        String raw = cm.getCookie(SPAGGIARI_URL);
        if (raw == null) return;
        for (String part : raw.split(";")) {
            String name = part.split("=", 2)[0].trim();
            if (name.isEmpty()) continue;
            String expired = name + "=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
            cm.setCookie(SPAGGIARI_URL, expired);
            cm.setCookie(SPAGGIARI_URL, expired + "; Domain=.spaggiari.eu");
        }
        cm.flush();
    }

    static String readPhpSessId() {
        return readPhpSessId(SPAGGIARI_URL);
    }

    /** PHPSESSID valido per l'URL indicato (o, in mancanza, per web.spaggiari.eu). */
    static String readPhpSessId(String url) {
        String[] sources = {url, SPAGGIARI_URL};
        for (String source : sources) {
            if (source == null) continue;
            String raw = CookieManager.getInstance().getCookie(source);
            if (raw == null) continue;
            for (String part : raw.split(";")) {
                String[] kv = part.trim().split("=", 2);
                if (kv.length == 2 && kv[0].equals("PHPSESSID") && !kv[1].isEmpty()) return kv[1];
            }
        }
        return null;
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", DEFAULT_LOGIN_URL);
        if (url == null || !url.startsWith(SPAGGIARI_URL + "/")) {
            call.reject("URL non consentito");
            return;
        }
        if (call.getBoolean("clearSession", true)) clearSpaggiariCookies();
        Intent intent = new Intent(getActivity(), SpaggiariLoginActivity.class);
        intent.putExtra(SpaggiariLoginActivity.EXTRA_URL, url);
        getActivity().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        SpaggiariLoginActivity.finishCurrent();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        SpaggiariLoginActivity.resumeCurrent();
        call.resolve();
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        clearSpaggiariCookies();
        call.resolve();
    }
}
