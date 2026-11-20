    async function analyzeShoeWithGemini(base64Data, targetMode) {
      const apiKey = archivioMasterCore.readGeminiKey();
      const cleanBase64 = base64Data.split(',')[1];
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64Data));
      const analysisKey = targetMode + ':' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (geminiPending.has(analysisKey)) return geminiPending.get(analysisKey);
      if (geminiResultCache.has(analysisKey)) {
        if (imagesByMode[targetMode] === base64Data) applyAIData(geminiResultCache.get(analysisKey), targetMode);
        return;
      }
      const pending = performGeminiAnalysis(base64Data, targetMode, apiKey, cleanBase64, analysisKey);
      geminiPending.set(analysisKey, pending);
      try { return await pending; } finally { geminiPending.delete(analysisKey); }
    }
    const geminiPending = new Map();
    const geminiResultCache = new Map();
    async function performGeminiAnalysis(base64Data, targetMode, apiKey, cleanBase64, analysisKey) {
      const analysisDeadline = Date.now() + 30000;
      const statusEl = document.getElementById(`${targetMode}ScanStatus`);
      const errorTextEl = document.getElementById(`${targetMode}ErrorText`);

      if (!apiKey) {
        const errorEl = document.getElementById(targetMode + 'ErrorText');
        if (errorEl) errorEl.textContent = 'Chiave Gemini mancante. Apri Sistema → Imposta AI per configurarla.';
        openApiKeyModal();
        return;
      }

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
        contents: [{ parts: [{ text: promptInstructions }, { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1600 }
      };
      let modelsToTry = [];
      let lastErrorMsg = "";
      const preferredFastModel = 'gemini-2.5-flash-lite';
      const cacheKey = 'kicks_gemini_models_v10';
      try {
        const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.time < 86400000) {
          modelsToTry = cached.models;
        } else {
          if (statusEl) statusEl.textContent = 'Ricerca rapida del modello AI...';
          const lc = new AbortController(); const lt = setTimeout(() => lc.abort(), 6000); let listing; try { listing = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {signal:lc.signal, headers: {'x-goog-api-key': apiKey}}); } finally {clearTimeout(lt);}
          const catalog = await listing.json();
          if (!listing.ok) throw new Error(catalog.error?.message || 'Impossibile ottenere i modelli Gemini.');
          const supported = (catalog.models || []).filter(model =>
            (model.supportedGenerationMethods || []).includes('generateContent') &&
            /gemini/i.test(model.name || '') &&
            !/embedding|tts|audio|image-generation|robotics|live|preview|image|transcribe|computer-use|nano-banana|omni/i.test(model.name || '')
          );
          const preference = name => {
            if (/gemini-2\.5-flash-lite$/.test(name)) return 0;
            if (/gemini-2\.5-flash$/.test(name)) return 1;
            if (/flash/i.test(name)) return 2;
            return 3;
          };
          modelsToTry = supported.sort((a,b) => preference(a.name)-preference(b.name))
            .map(model => model.name.replace(/^models\//, ''));
          if (!modelsToTry.length) throw new Error('Nessun modello Gemini generateContent disponibile per questa chiave.');
          sessionStorage.setItem(cacheKey, JSON.stringify({ time: Date.now(), models: modelsToTry}));
        }
        const recentSuccess = localStorage.getItem('kicks_gemini_last_success_v2');
        const firstModel = recentSuccess && modelsToTry.includes(recentSuccess) ? recentSuccess : preferredFastModel;
        modelsToTry = [...new Set([firstModel, preferredFastModel, ...modelsToTry])].slice(0, 4);
      } catch (listingError) {
        lastErrorMsg = listingError.message; modelsToTry = [preferredFastModel, 'gemini-2.5-flash'];
      }

      analysis: for (let i = 0; i < modelsToTry.length; i++) {
        const currentModel = modelsToTry[i];
        if (statusEl) statusEl.textContent = i === 0 ? "Analisi con Gemini AI..." : `Tentativo con modello alternativo (${i + 1}/${modelsToTry.length})...`;

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
              body: JSON.stringify({ ...requestBody, generationConfig: { ...requestBody.generationConfig, ...(/gemini-2\\.5/.test(currentModel) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } })
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
            if (geminiResultCache.size > 15) geminiResultCache.clear();
            geminiResultCache.set(analysisKey, parsed);
            if (imagesByMode[targetMode] !== base64Data) return;
            applyAIData(parsed, targetMode);
            if (targetMode === 'check') document.getElementById('recognitionProgress').textContent = 'Riconoscimento completato. Controlla il risultato e premi Memorizza se desideri.';
            return; // Successo, interrompe il ciclo

          } catch (err) {
            lastErrorMsg = err.name === 'AbortError' ? 'Il modello ' + currentModel + ' non ha risposto in tempo. Puoi compilare i dati manualmente.' : err.message;
            // Retry is user initiated.
          }
        }
      }

      // Se tutti i tentativi falliscono, mostra l'overlay di errore
      if (errorTextEl) {
        errorTextEl.textContent = /high demand|overloaded|sovraccaric/i.test(lastErrorMsg)
          ? "I server AI di Google sono momentaneamente sovraccarichi. Attendi qualche secondo e riprova."
          : `Errore: ${lastErrorMsg}`;
      }
      if (targetMode === 'check') { const progress = document.getElementById('recognitionProgress'); if (progress) progress.textContent = 'Identificazione AI non riuscita. Il confronto fotografico resta disponibile.'; document.getElementById('checkResultContainer').classList.remove('hidden'); }
      document.getElementById(`${targetMode}ErrorOverlay`).classList.remove('hidden');
    }

    function showRecognitionConfidence(data,mode){
      const fields = { marca: 'Brand', modello: 'Model', colori: 'Colors', colore: 'Colors', categoria: 'Category', sku: 'Sku' };
      const uncertain = Array.isArray(data.uncertainFields) ? data.uncertainFields.map(value => String(value).trim().toLowerCase()) : [];
      for (const suffix of new Set(Object.values(fields))) {
        const field = document.getElementById(mode + suffix);
        if (field) field.classList.toggle('ai-review-field', uncertain.some(name => fields[name] === suffix));
      }
      const el=document.getElementById(mode+'AiStatus');if(!el)return;
      const confidence=String(data.confidence||'bassa').toLowerCase();
      const unknown=Array.isArray(data.uncertainFields)?data.uncertainFields.filter(x=>typeof x==='string').slice(0,5):[];
      el.textContent='Identificazione AI: affidabilità stimata '+confidence+'. '+(unknown.length?'Controlla: '+unknown.join(', ')+'.':'Controlla il risultato prima di salvare.');
    }
    function applyAIData(data, targetMode) {
      showRecognitionConfidence(data,targetMode);
      const brand = data.marca || '';
      const model = data.modello || '';
      const category = data.categoria || 'Sport / Running';
      const notes = data.note || '';
      const sku = normalizeSku(data.sku);
      const colorsStr = data.colori || '';

      if (targetMode === 'add') {
        document.getElementById('addBrand').value = brand;
        document.getElementById('addModel').value = model;
        document.getElementById('addCategory').value = category;
        document.getElementById('addColors').value = colorsStr;
        document.getElementById('addNotes').value = notes;
        document.getElementById('addSku').value = sku;
        updateAddDuplicateNotice();
        if (!sku && !brand && !model && imagesByMode.add && !document.getElementById('addOcrText').value) {
          document.getElementById('addOcrStatus').textContent = 'SKU non rilevato: controllo OCR complementare in corso...';
          void runShoeOCR('add', true);
        }
      } else if (targetMode === 'check') {
        evaluatePurchase({
          brand: brand,
          model: model,
          category: category,
          colors: colorsStr.split(',').map(c => c.trim()),
          image: imagesByMode.check,
          sku,
          notes
        });
        if (!sku && !brand && !model && imagesByMode.check && !document.getElementById('checkOcrText').value) {
          document.getElementById('checkOcrStatus').textContent = 'SKU non rilevato: controllo OCR in corso...';
          void runShoeOCR('check', true);
        }
      }
    }

