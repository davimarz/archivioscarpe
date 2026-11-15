# archivioscarpe
## Aggiornamento del catalogo Awin

Lo script [aggiorna-archivio-scarpe.cjs](tools/awin/aggiorna-archivio-scarpe.cjs) scarica i listini con il flusso già configurato e usa l’importatore della copia aggiornata del repository. Richiede Node.js, Git e l’accesso al proprio account Awin.

Promozioni può essere aperta direttamente con `#promozioni`, `#promozioni/sotto-50`, `#promozioni/50-150` oppure `#promozioni/oltre-150`. Per distinguere una campagna nel pannello aggiungi `?utm_source=instagram&utm_campaign=nome-campagna` prima del cancelletto. Usa nomi brevi senza dati personali.

### Compilazione degli stili

Dalla radice del repository, rigenera il CSS locale dopo aver modificato le classi Tailwind:

```sh
printf '@tailwind base;
@tailwind components;
@tailwind utilities;
' > /tmp/archivio-tailwind.css
npx --yes tailwindcss@3.4.17 -i /tmp/archivio-tailwind.css --content index.html,assets/catalogo.js -m -o assets/app.css
```
