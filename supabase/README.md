# Sincronizzazione cloud opzionale

L'app funziona senza account e salva i dati nel browser. La sincronizzazione tra dispositivi richiede un progetto Supabase dell'utente: **non è attiva automaticamente dopo il deploy GitHub Pages**.

1. Crea un progetto Supabase e abilita l'accesso via email (OTP / magic link) in Authentication.
2. Esegui `supabase/schema.sql` nel SQL Editor. La tabella `shoe_archives` ha RLS: ogni utente autenticato legge e modifica solo il proprio record.
3. In Authentication → URL Configuration, aggiungi `https://davimarz.github.io/archivioscarpe/` ai redirect consentiti.
4. Nell'app, Impostazioni → Sincronizzazione cloud, inserisci URL progetto, **chiave pubblica anon/publishable** e email. **Non inserire mai la service_role o una secret key.**
5. Richiedi l'email di accesso, apri il link, poi scegli **Invia archivio al cloud** sul primo dispositivo. Sul secondo dispositivo effettua l'accesso e premi **Scarica dal cloud**.
6. La sincronizzazione automatica è facoltativa e parte dopo un primo caricamento riuscito. In caso di conflitto rilevato, viene sospesa per evitare sovrascritture silenziose. Per motivi di sicurezza la sessione scade e potrebbe essere necessario accedere nuovamente.

## Limitazioni

- Il backup locale è nel browser: non sostituisce il download JSON su un altro supporto.
- La sincronizzazione è una **copia completa dell'archivio**, non un merge per singola scarpa. Il download sostituisce il contenuto locale solo dopo conferma; l'upload manuale può sostituire la copia cloud dopo conferma.
- I dati e le foto sono caricati sul progetto Supabase configurato dall'utente, non sono crittografati end-to-end dall'app. Supabase applica RLS e HTTPS; proteggi l'accesso al progetto.
- Il piano Supabase ha limiti di spazio e richieste. Foto numerose potrebbero superare il limite del database: in quel caso usare Storage con policy RLS e una migrazione dedicata.
- La chiave pubblica viene salvata nel browser; non è una credenziale segreta. Il token di accesso è conservato in sessionStorage e scade.
- Il riconoscimento Gemini richiede connessione; offline restano consultazione e ricerca dei dati già caricati e le funzioni locali compatibili con la cache.
