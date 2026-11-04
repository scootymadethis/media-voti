# Accesso con SPID/CIE e collegamento del PC

Da settembre 2026 (Legge 182/2025) molte scuole consentono l'accesso a ClasseViva **solo**
con SPID o CIE: username e password non funzionano più. Aulera supporta questi utenti così:

1. **App Android**: lo studente tocca *Entra con SPID o CIE*. L'app apre la pagina di login
   **ufficiale** di ClasseViva in una WebView interna; lo studente si autentica col proprio
   gestore SPID o con la CIE. Aulera non vede mai le credenziali: quando ClasseViva ha creato
   la sessione, l'app legge il cookie `PHPSESSID` e lo manda al backend
   (`POST /api/login/web-session`), che lo verifica su `/rest/w1/misc/whoami`.
2. **PC**: sulla pagina di login si sceglie *Entra con SPID o CIE*; compaiono un QR e un
   codice (`XXXX-XXXX`, monouso, 5 minuti). Dal telefono, in **Dispositivi**, si inquadra il QR
   o si scrive il codice e si conferma. Il PC riceve una sessione Aulera propria che usa la
   stessa sessione ClasseViva del telefono.
3. **Dispositivi**: la pagina `/collega/` elenca i dispositivi collegati e permette di
   scollegarli. Se il telefono rifà l'accesso SPID, i dispositivi già collegati usano subito la
   nuova sessione.

## Come funziona lato backend

- `classeviva_client.WebSessionUtente`: utente autenticato dal cookie del sito. Le API web
  `/rest/w1` hanno gli stessi percorsi e formati di `/rest/v1` (verificato con
  `scripts/check_spid_session.py --schema`), quindi il resto di `main.py` non cambia: l'utente
  riscrive solo l'URL base e usa il cookie al posto del token. Unica differenza: la bacheca si
  legge in GET.
- Endpoint: `GET /auth/options`, `POST /login/web-session`, `POST /pair/start`,
  `POST /pair/status`, `POST /pair/lookup`, `POST /pair/confirm`, `GET /devices`,
  `POST /devices/revoke` (dietro Nginx: prefisso `/api`).
- **Sessioni da 30 giorni** (dall'ultimo utilizzo), salvate su SQLite da `session_store.py`
  (tabella `auth_sessions`): sopravvivono a riavvii e deploy e vengono ricaricate alla prima
  richiesta di ogni dispositivo. Il session id del browser è salvato solo come SHA-256; il cookie
  ClasseViva è cifrato (keystream HMAC-SHA256 + tag HMAC, solo libreria standard). Il segreto
  arriva da `AULERA_SECRET_KEY` oppure dal file `aulera-secret.key` creato accanto al database
  (permessi 600): non perderlo, o le sessioni salvate diventano illeggibili (si rifà SPID).
  I codici di collegamento restano in memoria (durano 5 minuti).
- **Keep-alive**: ogni `CLASSEVIVA_KEEPALIVE_SECONDS` (10 min) il server chiama `/misc/whoami`
  per ogni sessione ClasseViva in uso, così non scade per inattività. Se ClasseViva la rifiuta,
  Aulera chiude tutti i dispositivi che la usano (al prossimo accesso chiede di rifare SPID).
  Solo un vero 401 chiude la sessione: errori di rete, 429 e 5xx no.
- **Misura**: `cvv_session_stats` registra nascita, ultimo controllo riuscito e fine di ogni
  sessione ClasseViva; il pannello admin (Panoramica → "Durata sessioni ClasseViva") mostra durata
  mediana e massima (`GET /admin/session-stats`).

Variabili d'ambiente (tutte opzionali):

| Variabile | Default | Uso |
|---|---|---|
| `SESSION_TTL_DAYS` | `30` | durata della sessione Aulera dall'ultimo utilizzo |
| `CLASSEVIVA_KEEPALIVE_SECONDS` | `600` | intervallo del keep-alive (0 = disattivato) |
| `AULERA_SECRET_KEY` | file `aulera-secret.key` | segreto per cifrare i cookie salvati (consigliato in produzione) |
| `CLASSEVIVA_WEB_BASE_URL` | `https://web.spaggiari.eu/rest/w1` | API web |
| `CLASSEVIVA_WEB_USER_AGENT` | UA di Chrome Android | User-Agent verso le API web |
| `PAIRING_TTL` | `300` | durata del codice di collegamento (secondi) |
| `PAIRING_LOOKUP_MAX` | `20` | tentativi di codice per 5 minuti |
| `WEB_SESSION_LOGIN_RATE_MAX` | `60` | verifiche di sessione per IP ogni 5 minuti |
| `ALLOW_MANUAL_WEB_SESSION_LOGIN` | `false` | **solo sviluppo**: mostra nel pannello SPID un campo per incollare `PHPSESSID` |

## App Android e iPhone

Le app (Capacitor 7, cartelle `android/` e `ios/`) aprono direttamente il sito
`https://spaggiari2.federicoscutariu.it` (`server.url` in `capacitor.config.json`): l'interfaccia è
sempre quella pubblicata e i cookie di Aulera sono di prima parte. `app-shell/` contiene solo la
pagina mostrata se il sito non è raggiungibile.

Il login SPID/CIE usa il plugin nativo `SpaggiariLogin` (stessa API JavaScript sulle due piattaforme,
usata da `public/spid-app.js`):

| | Android (`android/app/src/main/java/.../SpaggiariLogin*.java`) | iPhone (`ios/App/App/SpaggiariLoginPlugin.swift`) |
|---|---|---|
| WebView | `SpaggiariLoginActivity` | `SpaggiariLoginViewController` (WKWebView) |
| Cookie HttpOnly | `CookieManager` di Android | `WKHTTPCookieStore` |
| CIE con app CieID | indirizzi con `/OpenApp` → `it.ipzs.cieid` (`startActivityForResult`, extra `URL` al ritorno) | `CIEID://<url>&sourceApp=aulera`, ritorno con lo schema `aulera://` |
| App dei gestori SPID | `intent://` e altri schemi aperti con l'app esterna | schemi non http aperti con `UIApplication.open` |

Appena ClasseViva mostra una pagina successiva al login, il plugin copre la WebView con
"Accesso ad Aulera in corso…" e passa `PHPSESSID` alla pagina (evento `sessionCandidate`); se il
backend la accetta la WebView si chiude (`close()`), altrimenti riappare (`resume()`, o dopo 9 s).
`openExternal({url})` apre i file (allegati, materiali) nel browser di sistema tramite i link
temporanei `/api/file/{token}`. *Inquadra il QR* usa `@capacitor-mlkit/barcode-scanning`.

### Build Android

Serve JDK 21 e l'Android SDK con platform 35:

```bash
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

L'APK è firmato con `android/app/aulera-debug.keystore` (chiave di debug, password `android`): ogni
build si installa come aggiornamento della precedente. Per il Play Store serve una chiave release.

### Build iPhone (serve un Mac con Xcode 16 e CocoaPods)

```bash
npm install
npx cap sync ios        # esegue anche pod install
npx cap open ios        # apre Xcode
```

In Xcode: *Signing & Capabilities* → scegli il tuo team (basta un Apple ID gratuito per installarla sul
tuo iPhone per 7 giorni; per distribuirla serve l'Apple Developer Program), collega l'iPhone e premi Run.
Il progetto iOS è stato generato e scritto senza un Mac: va compilato e provato su Xcode.

## Come provarlo senza l'app

1. Avvia il backend con `ALLOW_MANUAL_WEB_SESSION_LOGIN=true`.
2. Accedi a `web.spaggiari.eu` con SPID/CIE e copia il cookie `PHPSESSID` (F12 → Cookie).
3. Sul telefono apri Aulera → *Entra con SPID o CIE* → *Sviluppo: accedi con un cookie
   PHPSESSID* → incolla.
4. Sul PC apri Aulera → *Entra con SPID o CIE*, poi conferma il codice dal telefono in
   **Dispositivi**.

Non attivare `ALLOW_MANUAL_WEB_SESSION_LOGIN` in produzione: abituare gli utenti a incollare
cookie di sessione è pericoloso.

## Limiti noti

- **Non provato su un telefono reale.** La parte JavaScript è provata con il plugin simulato;
  la parte nativa (WebView, CieID, lettura del cookie) compila ma va verificata su un dispositivo.
- **CIE**: il passaggio all'app CieID segue la documentazione IPZS ma non è stato provato.
  SPID con gestori che usano notifiche push (es. PosteID) dovrebbe funzionare.
- **iPhone**: il progetto non è mai stato compilato (scritto su Linux, senza Xcode). Il flusso CIE su
  iOS (schema `CIEID://`) segue la documentazione IPZS ma non è verificato.
- **L'app usa il sito pubblicato**: funziona solo dopo il deploy di queste modifiche.
- **Durata massima di ClasseViva**: il keep-alive evita la scadenza per inattività, ma se
  ClasseViva impone una durata massima fissa la sessione finisce comunque (lo dirà la statistica nel
  pannello admin). L'app ufficiale arriva a 30 giorni probabilmente con un rinnovo dedicato
  (`rest/v1/auth/spidrf`), non documentato.
