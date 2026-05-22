# Come inserire il gioco Godot (export Web)

Questa app apre il gioco da **`/game/`** in un iframe che carica i file in:

```text
public/game/godot/
```

Finché non sostituisci quella cartella con l'export reale, vedrai solo il placeholder.

---

## 1. Prepara il progetto in Godot

Consigliato: **Godot 4.x** (funziona anche Godot 3 con export HTML5, i file cambiano leggermente).

1. Apri il tuo progetto in Godot.
2. **Project → Project Settings → Application → Run**
   - Imposta una scena principale valida.
3. **Project → Export…**
4. Aggiungi preset **Web** (se manca, installa i template Web dal manager export di Godot).

### Impostazioni export utili

- **Export Path**: scegli una cartella temporanea sul PC, es. `C:\export\spaggiari2-game\`
- Il nome del file di output sarà qualcosa come `index.html` (Godot 4) o `index.html` + `index.js` (Godot 3).
- **Custom HTML Shell** (opzionale): di default va bene.
- Per fullscreen nel sito, il gioco gira già dentro un iframe su `/game/`; non è obbligatorio modificare la shell.

4. Clicca **Export Project** (o **Export All** se Godot propone più file).

---

## 2. Copia i file sul server / nel repo

Dopo l'export avrai una cartella con file simili a:

**Godot 4 (tipico)**

```text
index.html
index.js
index.wasm
index.pck
index.icon.png
index.apple-touch-icon.png
… (altri asset generati)
```

**Godot 3 (tipico)**

```text
index.html
index.js
index.pck
…
```

### Cosa fare

1. **Svuota** (o sovrascrivi) tutto il contenuto di `public/game/godot/` nel repository.
2. **Copia dentro** tutti i file generati dall'export, incluso `index.html`.
3. Verifica che esista `public/game/godot/index.html` e che **non** contenga più il testo del placeholder.

4. Commit e deploy come al solito (`git push`, poi sulla VPS `git pull` + restart se serve solo static).

> Non rinominare la cartella `godot`: il backend e il frontend puntano a `/game/godot/index.html`.

---

## 3. Deploy sulla VPS (Nginx)

Il frontend è in `/var/www/media-voti-prod/public` (o il tuo path). Dopo `git pull`, i file del gioco sono in:

```text
.../public/game/godot/
```

### MIME type per WebAssembly (importante)

Se il gioco non parte e in console vedi errori sul file `.wasm`, aggiungi in Nginx:

```nginx
types {
    application/wasm wasm;
}
```

oppure nel blocco `server`:

```nginx
location ~* \.wasm$ {
    types { application/wasm wasm; }
    default_type application/wasm;
}
```

Poi:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Non serve riavviare `media-voti-prod` solo per file statici nuovi; basta che Nginx serva la cartella `public`.

---

## 4. Chi vede il pulsante easter egg

Solo questi username (login ClasseViva):

- `S10371217U`
- `aaronrai829@gmail.com`
- `S10371278X`
- `510371115`
- `S9456217C`
- `S10371066B`

Pulsante in navbar: **🤫** (shush). Apre `/game/`.

Per aggiungere utenti senza modificare il codice, imposta su server:

```env
EASTER_EGG_USERNAMES=user1,user2,user3
```

---

## 5. Test in locale (Windows / dev)

Con `DEV_MODE=true` e uvicorn su `http://localhost:8000`:

1. Login con uno username della lista.
2. Clic su 🤫 oppure vai su `http://localhost:8000/game/`.
3. Se l'export è presente, parte l'iframe; altrimenti vedi le istruzioni di setup.

---

## 6. Problemi comuni

| Problema | Soluzione |
|----------|-----------|
| Schermo nero | Controlla console browser (F12); spesso manca `.wasm` o path sbagliati |
| 404 su `.pck` / `.wasm` | Tutti i file export devono stare in `public/game/godot/`, stessa cartella di `index.html` |
| Gioco lento | Riduci risoluzione export o qualità asset |
| CORS | Usa sempre lo stesso dominio (`/game/godot/…`), non aprire `index.html` da `file://` |

---

## 7. Aggiornare il gioco

1. Modifica il progetto in Godot.
2. Nuovo export Web nella cartella temporanea.
3. Sostituisci **tutto** il contenuto di `public/game/godot/`.
4. Deploy (`git pull` sulla VPS).

Fine.
