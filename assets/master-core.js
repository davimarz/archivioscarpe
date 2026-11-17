/* Funzioni di Archivio Scarpe Master usate dall’interfaccia Emergent. */
window.archivioMasterCore = (() => {
  'use strict';
    function createShoeSvgBase64(brand, model, bgHex) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
        <rect width="300" height="300" fill="${bgHex}"/>
        <circle cx="150" cy="130" r="70" fill="rgba(255,255,255,0.05)"/>
        <path d="M45 195 Q70 155 120 150 Q180 145 205 110 Q235 105 250 135 Q265 165 255 195 Z" fill="#ffffff" opacity="0.95"/>
        <path d="M40 195 L260 195 L255 215 L35 215 Z" fill="#0f172a"/>
        <text x="150" y="255" font-family="system-ui, sans-serif" font-size="15" font-weight="bold" fill="#f8fafc" text-anchor="middle">${brand}</text>
        <text x="150" y="275" font-family="system-ui, sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">${model}</text>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    function normalizeSku(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[‐‑–—]/g, '-'); }

    function normalizeShoeText(value) {
      return String(value || '').toLocaleLowerCase('it').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    }

    function canonicalShoeBrand(value) {
      const text = normalizeShoeText(value);
      if (/^(nb|new balance)$/.test(text)) return 'new balance';
      if (/^(nike|nike inc)$/.test(text)) return 'nike';
      if (/^(adidas|adi das)$/.test(text)) return 'adidas';
      if (/^(asics|asics tiger)$/.test(text)) return 'asics';
      if (/^(hoka|hoka one one)$/.test(text)) return 'hoka';
      if (/^(converse|converse all star)$/.test(text)) return 'converse';
      return text;
    }

    function canonicalShoeModel(value) {
      return normalizeShoeText(value)
        .replace(/\bnew balance\b|\bnb\b/g, ' ')
        .replace(/\bhoka one one\b|\bhoka\b/g, ' ')
        .replace(/\bnike\b|\badidas\b|\basics\b|\basics tiger\b|\bconverse\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
    }

    function canonicalShoeColor(value) {
      const text = normalizeShoeText(value);
      const equivalents = [
        [/\b(nero|nera|neri|nere|black|noir)\b/g, 'nero'],
        [/\b(bianco|bianca|bianchi|bianche|white)\b/g, 'bianco'],
        [/\b(grigio|grigia|grigi|grigie|grey|gray)\b/g, 'grigio'],
        [/\b(blu|blue)\b/g, 'blu'],
        [/\b(rosso|rossa|rossi|rosse|red)\b/g, 'rosso'],
        [/\b(verde|verdi|green)\b/g, 'verde'],
        [/\b(giallo|gialla|yellow)\b/g, 'giallo'],
        [/\b(rosa|pink)\b/g, 'rosa'],
        [/\b(marrone|brown)\b/g, 'marrone'],
        [/\b(viola|purple)\b/g, 'viola'],
        [/\b(arancione|arancio|orange)\b/g, 'arancione']
      ];
      return equivalents.reduce((result, [pattern, canonical]) => result.replace(pattern, canonical), text)
        .replace(/\s+/g, ' ').trim();
    }

    function shoeMatchesSmartSearch(shoe, query) {
      const raw = normalizeShoeText(query);
      if (!raw) return true;
      const brand = canonicalShoeBrand(shoe.brand);
      const model = canonicalShoeModel(shoe.model);
      const colors = (Array.isArray(shoe.colors) ? shoe.colors : String(shoe.colors || '').split(','))
        .map(canonicalShoeColor);
      const rawText = normalizeShoeText([shoe.brand, shoe.model, shoe.sku || '', ...colors].join(' '));
      const searchText = [brand, model, normalizeShoeText(shoe.sku), ...colors].join(' ');
      const normalizedQuery = canonicalShoeColor(raw);
      const brandQuery = canonicalShoeBrand(raw);
      const modelQuery = canonicalShoeModel(raw);
      if (rawText.includes(raw) || searchText.includes(normalizedQuery) ||
          brand.includes(brandQuery) || (modelQuery && model.includes(modelQuery))) return true;
      // Ogni termine deve essere presente: "NB 9060 grey" trova "New Balance 9060 grigio".
      const queryWords = normalizedQuery.replace(/\bnew balance\b|\bnb\b/g, 'newbalance').split(' ').filter(Boolean);
      const searchable = searchText.replace(/\bnew balance\b/g, 'newbalance');
      return queryWords.every(word => searchable.split(' ').some(token => token.startsWith(word)));
    }

      const readMoney = value => {
        if (value === null || value === undefined || String(value).trim() === '') return NaN;
        const raw = String(value).replace(/[^\d,.]/g, '');
        if (!raw) return NaN;
        const lastComma = raw.lastIndexOf(',');
        const lastDot = raw.lastIndexOf('.');
        let normalized;
        if (lastComma >= 0 && lastDot >= 0) {
          normalized = lastComma > lastDot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
        } else if (lastComma >= 0) {
          normalized = raw.replace(',', '.');
        } else {
          normalized = raw;
        }
        const parsed = Number(normalized);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
      };
      const originalPriceOf = product => {
        const fields = ['originalPrice', 'original_price', 'priceOriginal', 'price_original',
          'oldPrice', 'old_price', 'previousPrice', 'previous_price', 'regularPrice',
          'regular_price', 'retailPrice', 'retail_price', 'rrp', 'listPrice', 'list_price',
          'product_price_old', 'product_price_original', 'priceBeforeDiscount', 'price_before_discount'];
        for (const field of fields) {
          const value = readMoney(product[field]);
          if (Number.isFinite(value)) return value;
        }
        return NaN;
      };
      const discountFor = product => {
        const current = readMoney(product.price);
        const original = originalPriceOf(product);
        if (!Number.isFinite(current) || !Number.isFinite(original) || original <= current) return null;
        const percent = Math.round((original - current) / original * 100);
        return percent >= 1 && percent <= 99 ? { original, current, percent } : null;
      };

    const geminiKeyName = 'gemini_api_key';
    const geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
    const preferredFastModel = 'gemini-2.5-flash-lite';

    function readGeminiKey() {
      return (sessionStorage.getItem(geminiKeyName) || '').trim();
    }

    function storeGeminiKey(value) {
      const key = value.trim();
      if (key) sessionStorage.setItem(geminiKeyName, key);
      else sessionStorage.removeItem(geminiKeyName);
    }

    async function listGeminiModels(key) {
      if (!key?.trim()) throw Error('Incolla una chiave API di Google AI Studio.');
      const models = [];
      let pageToken = '';
      const signal = AbortSignal.timeout(10000);
      try {
        do {
          const url = new URL(geminiEndpoint);
          url.searchParams.set('pageSize', '100');
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          const response = await fetch(url, { headers: { 'x-goog-api-key': key.trim() }, signal });
          if (response.status === 400 || response.status === 401) throw Error('Google ha rifiutato la chiave. Copiala di nuovo da Google AI Studio.');
          if (response.status === 403) throw Error('Google ha negato l’accesso. Controlla le restrizioni della chiave in Google AI Studio.');
          if (response.status === 429) throw Error('Quota Gemini esaurita. Riprova più tardi.');
          if (!response.ok) throw Error('Gemini non disponibile (HTTP ' + response.status + ').');
          const data = await response.json();
          models.push(...(data.models || []));
          pageToken = data.nextPageToken;
        } while (pageToken);
      } catch (error) {
        if (error.name === 'TimeoutError' || error instanceof TypeError) {
          throw Error('Impossibile raggiungere Gemini. Controlla la connessione e riprova.');
        }
        throw error;
      }
      const priority = name => {
        if (name === preferredFastModel) return 0;
        if (name === 'gemini-2.5-flash') return 1;
        if (/flash/i.test(name)) return 2;
        return 3;
      };
      const supported = models.filter(model =>
        model.supportedGenerationMethods?.includes('generateContent') &&
        /^models\/gemini-[a-z0-9.-]+$/i.test(model.name) &&
        !/embedding|tts|audio|robotics|live|image|transcribe|computer-use|omni/i.test(model.name)
      ).map(model => model.name.replace(/^models\//, ''));
      if (!supported.length) throw Error('La chiave non ha accesso a un modello Gemini compatibile.');
      return supported.sort((first, second) => priority(first) - priority(second));
    }

    async function recognize(base64Data, apiKey) {
      const analysisDeadline = Date.now() + 30000;
      const [, mimeType, cleanBase64] = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/i.exec(base64Data) || [];
      if (!cleanBase64) throw Error('Formato della foto non supportato.');
      const promptInstructions = `Sei un esperto di scarpe e di etichette di scatole. Leggi PRIMA tutte le scritte visibili sull'etichetta, incluse le diciture in inglese, i codici prodotto, i codici colore e il nome della colorway. Poi considera l'aspetto della scarpa, se visibile. Non inventare informazioni non leggibili. Rispondi SOLO con un oggetto JSON con queste chiavi:
"marca": marca riportata sulla scatola (stringa, vuota se sconosciuta);
"modello": nome commerciale esatto e versione, se leggibile (stringa);
"categoria": una tra "Sport / Running", "Sneakers", "Eleganti", "Stivali", "Casual / Altro";
"colori": elenco dei colori della variante, separati da virgola, traducendo i nomi in italiano se possibile (stringa);
"sku": codice articolo del produttore (style code), NON EAN, UPC o seriale; vuoto se non leggibile (stringa);
"note": altri dettagli dell'etichetta (stringa);
"confidence": "alta", "media" o "bassa" secondo la leggibilità reale;
"uncertainFields": elenco JSON dei nomi dei campi non certi.
Se è visibile solo un'etichetta, privilegia i dati stampati. Se il codice colore è alfanumerico, non confonderlo con il colore visivo. Se un dato è incerto, lascialo vuoto.`;
      const requestBody = {
        contents: [{ parts: [{ text: promptInstructions }, { inlineData: { mimeType, data: cleanBase64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1600 }
      };
      let modelsToTry = [];
      let lastErrorMsg = "";
      const cacheKey = 'kicks_gemini_models_v9';
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && cached.keyHint === apiKey.slice(-6) && Date.now() - cached.time < 86400000) {
          modelsToTry = cached.models;
        } else {
          modelsToTry = await listGeminiModels(apiKey);
          localStorage.setItem(cacheKey, JSON.stringify({keyHint: apiKey.slice(-6), time: Date.now(), models: modelsToTry}));
        }
        const recentSuccess = localStorage.getItem('kicks_gemini_last_success_v2');
        if (recentSuccess && modelsToTry.includes(recentSuccess)) {
          modelsToTry = [recentSuccess, ...modelsToTry.filter(model => model !== recentSuccess)];
        }
        modelsToTry = modelsToTry.slice(0, 4);
      } catch (listingError) {
        lastErrorMsg = listingError.message; modelsToTry = [preferredFastModel, 'gemini-2.5-flash'];
      }

      analysis: for (let i = 0; i < modelsToTry.length; i++) {
        const currentModel = modelsToTry[i];

        // Max 2 tentativi per singolo modello in caso di sovraccarico temporaneo (503/429)
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const controller = new AbortController();
            const remaining = analysisDeadline - Date.now();
            if (remaining <= 0) { lastErrorMsg = 'Tempo massimo raggiunto. Puoi compilare i dati manualmente.'; break analysis; }
            const timeoutId = setTimeout(() => controller.abort(), Math.min(remaining, 12000));

            let data;
            try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
              signal: controller.signal,
              body: JSON.stringify({ ...requestBody, generationConfig: { ...requestBody.generationConfig, ...(/gemini-2\.5/.test(currentModel) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } })
            });

            data = await response.json();
            } finally { clearTimeout(timeoutId); }

            if (data.error) {
              const code = data.error.code;
              lastErrorMsg = data.error.message;
              if (/no longer available|not found|not supported/i.test(lastErrorMsg)) {
                lastErrorMsg = currentModel + ': ' + data.error.message;
              } else if (code === 429) {
                lastErrorMsg = 'Limite di richieste Gemini raggiunto. Attendi il ripristino della quota o verifica il piano in Google AI Studio.';
              } else if (code === 403 || code === 401) {
                lastErrorMsg = 'Chiave API non autorizzata. Controlla la chiave in Imposta AI.';
              }

              // 503 (Unavailable), 429 (Too Many Requests) o 500 sono errori transitori
              if ([401, 403, 429].includes(code)) break analysis;
              if ([503, 500].includes(code)) {
                if (attempt === 0) {
                  const delay = (1000 * Math.pow(2, attempt)) + (Math.random() * 500); // Backoff esponenziale con jitter
                  await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, analysisDeadline - Date.now()))));
                  continue;
                }
                break; // Passa al modello successivo
              }
              break; // Passa al modello successivo, se disponibile
            }

            const rawText = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
            if (!rawText) {
              lastErrorMsg = "L'AI non ha rilevato informazioni. Prova con una foto più nitida.";
              break;
            }

            let parsed;
            try {
              const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
              let result;
              try { result = JSON.parse(cleaned); }
              catch (e) { const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}'); if (start < 0 || end <= start) throw e; result = JSON.parse(cleaned.slice(start, end + 1)); }
              if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('JSON non valido');
              const str = value => typeof value === 'string' ? value.trim() : Array.isArray(value) ? value.join(', ') : '';
              const allowed = ["Sport / Running", "Sneakers", "Eleganti", "Stivali", "Casual / Altro"];
              parsed = {
                marca: str(result.marca || result.brand),
                modello: str(result.modello || result.model),
                categoria: allowed.find(cat => cat.toLowerCase() === str(result.categoria).toLowerCase()) || 'Casual / Altro',
                colori: str(result.colori || result.colore || result.colors),
                note: str(result.note),
                sku: str(result.sku || result.codice_articolo || result.style_code),
                confidence: ['alta','media','bassa'].includes(str(result.confidence).toLowerCase())?str(result.confidence).toLowerCase():'bassa',
                uncertainFields: Array.isArray(result.uncertainFields)?result.uncertainFields.filter(x=>typeof x==='string').slice(0,5):[]
              };
            } catch (parseError) {
              lastErrorMsg = 'Risposta Gemini incompleta o non valida. Provo un altro modello.';
              continue;
            }
            if (!parsed.marca && !parsed.modello && !parsed.colori) {
              lastErrorMsg = 'Nessuna informazione leggibile sulla scatola. Fotografa da vicino l’etichetta.';
              break;
            }
            localStorage.setItem('kicks_gemini_last_success_v2', currentModel);
            return parsed;

          } catch (err) {
            lastErrorMsg = err.name === 'AbortError' ? 'Il modello ' + currentModel + ' non ha risposto in tempo. Puoi compilare i dati manualmente.' : err.message;
            // Retry is user initiated.
          }
        }
      }

      throw Error(lastErrorMsg || 'Analisi non riuscita.');
    }

    return { createShoeSvgBase64, normalizeSku, canonicalShoeBrand, canonicalShoeModel, canonicalShoeColor, normalizeShoeText, shoeMatchesSmartSearch, readMoney, discountFor, recognize, readGeminiKey, storeGeminiKey, listGeminiModels };
})();
