# Installare Skoolio su iPhone senza l'Apple Developer Program

Si può, con un **Apple ID gratuito**. Limiti di Apple per gli account gratuiti:

- l'app firmata vale **7 giorni**, poi va rifirmata (AltStore lo fa da solo, Sideloadly con un clic);
- massimo **3 app** installate così per Apple ID;
- ognuno la installa sul **proprio** iPhone, con il **proprio** Apple ID (non puoi firmarla tu per gli altri senza pagare).

Per i tester va benissimo; per distribuirla davvero (TestFlight, App Store) servono i 99 €/anno.

## 1. Scarica il file .ipa (nessun Mac necessario)

Il workflow GitHub Actions **"iOS IPA (non firmato)"** compila l'app su un Mac di GitHub a ogni modifica
di `ios/` su `main` (o a mano: *Actions → iOS IPA (non firmato) → Run workflow*). Alla fine, nella pagina
dell'esecuzione, scarica l'artefatto **Skoolio-iOS** ed estrai `Skoolio-non-firmato.ipa`.

## 2. Installalo

### Con Sideloadly (Windows o Mac) — il più semplice

1. Installa [Sideloadly](https://sideloadly.io) e, su Windows, iTunes e iCloud **dal sito Apple** (non dal Microsoft Store).
2. Collega l'iPhone con il cavo e tocca *Autorizza* sull'iPhone.
3. Trascina `Skoolio-non-firmato.ipa` in Sideloadly, inserisci il tuo Apple ID e premi **Start**.
4. Sull'iPhone: *Impostazioni → Generali → VPN e gestione dispositivi* → tocca il tuo Apple ID → *Autorizza*.
5. Da iOS 16: *Impostazioni → Privacy e sicurezza → Modalità sviluppatore* → attiva e riavvia.

Ogni 7 giorni ricollega l'iPhone e ripeti il punto 3 (le impostazioni e l'accesso restano).

### Con AltStore (rinnovo automatico)

1. Installa [AltServer](https://altstore.io) sul computer e da lì *Install AltStore* sull'iPhone (con il tuo Apple ID).
2. Autorizza il profilo come al punto 4 sopra e attiva la Modalità sviluppatore.
3. Apri il file `.ipa` sull'iPhone con AltStore (*My Apps → +*).
4. AltStore rinnova l'app da solo quando iPhone e computer (con AltServer aperto) sono sulla stessa Wi-Fi.

### Con un Mac e Xcode

```bash
npm install
npx cap sync ios
npx cap open ios
```

In Xcode: *Signing & Capabilities* → *Team* → il tuo Apple ID, collega l'iPhone e premi **Run**.

## Note

- L'app iPhone carica il sito pubblicato, come quella Android: le novità del sito arrivano senza reinstallarla.
- L'accesso con CIE sull'iPhone passa dall'app CieID (schema `CIEID://`): è la parte meno collaudata.
- Le notifiche ad app chiusa su iPhone richiederebbero le push di Apple (account a pagamento): con l'Apple ID
  gratuito le novità si vedono aprendo l'app (campanella e centro notifiche).
