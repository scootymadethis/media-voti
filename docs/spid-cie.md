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

## Setup dell'app Android

Serve il plugin `@capacitor/inappbrowser` 2.5.x (l'ultima versione compatibile con
Capacitor 7), già in `package.json`:

```bash
npm install
npx cap sync android
```

`CapacitorCookies` è incluso in `@capacitor/core`. Facoltativo, per il pulsante
*Inquadra il QR* nella pagina Dispositivi: `@capacitor-mlkit/barcode-scanning`
(senza, si inserisce il codice a mano oppure si inquadra il QR con la fotocamera del telefono,
che apre `/collega/?code=…`).

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

- **Non provato su un telefono reale.** Il flusso dell'app (WebView, lettura del cookie) è
  scritto sull'API documentata dei plugin ma va verificato su un dispositivo.
- **CIE**: il passaggio all'app CieID dalla WebView potrebbe non funzionare; SPID con gestori
  che usano notifiche push (es. PosteID) dovrebbe funzionare.
- **iOS**: non gestito (non c'è un progetto iOS).
- **Durata**: quanto resta valida una sessione ClasseViva non è ancora misurato
  (`scripts/check_spid_session.py --watch 240`). Quando scade, si rifà SPID dall'app.
- **Riavvii**: le sessioni sono in memoria, quindi un deploy scollega tutti i dispositivi.
