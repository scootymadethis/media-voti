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
- Tutto è in memoria, come le sessioni esistenti: un riavvio del backend (anche un deploy)
  scollega tutti.

Variabili d'ambiente (tutte opzionali):

| Variabile | Default | Uso |
|---|---|---|
| `CLASSEVIVA_WEB_BASE_URL` | `https://web.spaggiari.eu/rest/w1` | API web |
| `CLASSEVIVA_WEB_USER_AGENT` | UA di Chrome Android | User-Agent verso le API web |
| `PAIRING_TTL` | `300` | durata del codice di collegamento (secondi) |
| `PAIRING_LOOKUP_MAX` | `20` | tentativi di codice per 5 minuti |
| `WEB_SESSION_LOGIN_RATE_MAX` | `60` | verifiche di sessione per IP ogni 5 minuti |
| `ALLOW_MANUAL_WEB_SESSION_LOGIN` | `false` | **solo sviluppo**: mostra nel pannello SPID un campo per incollare `PHPSESSID` |

## App Android

L'app (Capacitor 7, cartella `android/`) apre direttamente il sito
`https://spaggiari2.federicoscutariu.it` (`server.url` in `capacitor.config.json`): l'interfaccia
è sempre quella pubblicata e i cookie di Aulera sono di prima parte. `app-shell/` contiene solo
la pagina mostrata se il sito non è raggiungibile.

Il login SPID/CIE usa un plugin nativo dell'app, `SpaggiariLogin`
(`android/app/src/main/java/it/federicoscutariu/spaggiari2/`):

- `SpaggiariLoginActivity` apre `https://web.spaggiari.eu/home/app/default/login.php` in una
  WebView dedicata. I link `intent://` e gli schemi delle app dei gestori SPID aprono l'app
  esterna. Per la CIE, gli indirizzi con `/OpenApp` vengono passati all'app CieID
  (`it.ipzs.cieid`) e l'URL che CieID restituisce (extra `URL`) viene ricaricato, come da
  documentazione IPZS.
- Dopo ogni pagina di ClasseViva successiva al login, il plugin legge `PHPSESSID` dal
  `CookieManager` di Android (è HttpOnly: JavaScript non lo vede, e `CapacitorCookies` su
  Android legge solo `document.cookie`) e lo manda alla pagina con l'evento `sessionCandidate`.
  `public/spid-app.js` lo fa verificare al backend e chiude la WebView.
- Pagina Dispositivi: *Inquadra il QR* usa `@capacitor-mlkit/barcode-scanning` (scanner Google,
  nessun permesso fotocamera).

Build (serve JDK 21 e l'Android SDK con platform 35):

```bash
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

L'APK di debug è firmato con la chiave di debug: va bene per installarlo a mano, non per il
Play Store.

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
- **iOS**: non gestito (non c'è un progetto iOS).
- **L'app usa il sito pubblicato**: funziona solo dopo il deploy di queste modifiche.
- **Durata**: quanto resta valida una sessione ClasseViva non è ancora misurato
  (`scripts/check_spid_session.py --watch 240`). Quando scade, si rifà SPID dall'app.
- **Riavvii**: le sessioni sono in memoria, quindi un deploy scollega tutti i dispositivi.
