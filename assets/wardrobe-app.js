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

    // Un nuovo utente parte con l'armadio vuoto: nessuna scarpa dimostrativa.
    const DEFAULT_SHOES = [];

    // Conserva il dato originale anche quando il JSON locale non è leggibile.
    function readShoeArchive() {
      try {
        const raw = localStorage.getItem('kicks_archive_v17');
        if (!raw) return DEFAULT_SHOES;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('Formato archivio non valido');
        return parsed;
      } catch (error) {
        console.error('Archivio locale non leggibile; dati originali conservati.', error);
        return [];
      }
    }
    let shoes = [];
    let selectedImageBase64 = null;
    let addExtraImages = [];
    let editingImages = [];
    const imagesByMode = { add: null, check: null };
    let currentCategory = 'all';

    let archiveState;
    let archiveSaving = false;
    const archiveReady = new Promise(resolve => {
      window.addEventListener('DOMContentLoaded', async () => {
        try { await initializeArchive(); }
        catch (error) {
          shoes = readShoeArchive();
          showToast('Archivio in sola lettura: ' + error.message);
        } finally { resolve(); }
        renderArchive();
        updateKeyUI();
        initLocalBackupStatus();
        updateOfflineStatus();
      }, { once: true });
    });


    function createShoeBackupFile() {
      const backup = { format: 'kicksarchive-backup', version: 1, exportedAt: new Date().toISOString(), shoes, collections: collectionNames };
      const filename = 'archivio scarpe ' + new Date().toLocaleDateString('it-IT').split('/').reverse().join('-') + ' N.' + shoes.length + '.json';
      return new File([JSON.stringify(backup, null, 2)], filename, { type: 'application/json' });
    }

    function downloadShoeBackup(file) {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    async function exportShoeBackup() {
      await archiveReady;
      const feedback = document.getElementById('backupFeedback');
      try {
        downloadShoeBackup(createShoeBackupFile());
        feedback.textContent = 'Download del backup avviato. Conserva il file JSON in un luogo sicuro.';
        showToast('Backup esportato.');
      } catch (error) {
        feedback.textContent = 'Impossibile esportare: ' + error.message;
      }
    }

    async function importShoeBackup(input) {
      const feedback = document.getElementById('backupFeedback');
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return false;
      await archiveReady;
      try {
        if (file.size > 100 * 1024 * 1024) throw new Error('File troppo grande (massimo 100 MB).');
        const parsed = JSON.parse(await file.text());
        if (!parsed || parsed.format !== 'kicksarchive-backup' || parsed.version !== 1 || !Array.isArray(parsed.shoes)) {
          throw new Error('Il file non è un backup KicksArchive valido.');
        }
        if (parsed.shoes.length > 10000 || !parsed.shoes.every(item =>
          item && typeof item === 'object' && !Array.isArray(item) &&
          (typeof item.id === 'string' || typeof item.id === 'number') &&
          typeof item.brand === 'string' && typeof item.model === 'string' &&
          (Array.isArray(item.colors) ? item.colors.every(c => typeof c === 'string') : typeof item.colors === 'string') &&
          (!item.image || isSafeShoeImageUrl(item.image)) &&
          (!item.images || (Array.isArray(item.images) && item.images.every(isSafeShoeImageUrl)))
        )) throw new Error('Il backup contiene dati non validi.');
        const ids = parsed.shoes.map(item => String(item.id));
        if (new Set(ids).size !== ids.length) throw new Error('Il backup contiene identificativi duplicati.');
        if (!confirm('Ripristinare ' + parsed.shoes.length + (parsed.shoes.length === 1 ? ' paio' : ' paia') + '? Le ' + shoes.length + ' scarpe attualmente nell’archivio saranno sostituite. Esporta prima un backup se vuoi conservarle.')) {
          feedback.textContent = 'Ripristino annullato.';
          return false;
        }
        const restoredCollections = Array.isArray(parsed.collections)
          ? parsed.collections.filter(value => typeof value === 'string') : [];
        await commitArchive(parsed.shoes, restoredCollections);
        resetArchiveFilters();
        feedback.textContent = 'Ripristino completato: ' + shoes.length + (shoes.length === 1 ? ' paio recuperato.' : ' paia recuperate.');
        return true;
      } catch (error) {
        feedback.textContent = 'Ripristino non eseguito: ' + error.message;
        return false;
      }
    }

    let collectionNames = (() => {
      try { const saved = JSON.parse(localStorage.getItem('kicks_archive_collections_v1') || '[]'); return Array.isArray(saved) ? saved.filter(v => typeof v === 'string') : []; }
      catch { return []; }
    })();

    function parseCollectionNames(value) {
      return [...new Set(String(value || '').split(',').map(v => v.trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
    }

    function updateCollectionOptions() {
      const select = document.getElementById('collectionFilter');
      const selected = select.value;
      const categories = [...new Set(shoes.map(shoe => String(shoe.category || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'it'));
      select.replaceChildren(new Option('Tutte le tipologie', ''));
      categories.forEach(name => select.add(new Option(name, 'category:' + name)));
      select.value = categories.some(name => 'category:' + name === selected) ? selected : '';
    }

    function updateOfflineStatus(){const el=document.getElementById('offlineStatus');if(el)el.classList.toggle('hidden',navigator.onLine);}
    window.addEventListener('online',updateOfflineStatus);window.addEventListener('offline',updateOfflineStatus);
    // La cache offline si attiva automaticamente; nessuna preparazione manuale richiesta.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=28', { scope: './', updateViaCache: 'none' })
          .catch(error => console.warn('Cache offline non disponibile:', error));
      });
    }


    async function initializeArchive() {
      let stored = await shoeArchiveStorage.get();
      if (!stored) {
        const raw = localStorage.getItem('kicks_archive_v17');
        const legacy = raw ? JSON.parse(raw) : [];
        if (!isValidShoeArchive(legacy)) throw new Error('Archivio precedente da recuperare.');
        let previous = null;
        for (const key of ['kicks_archive_previous_v1', 'kicks_archive_snapshot_v1']) {
          try {
            const copy = JSON.parse(localStorage.getItem(key) || 'null');
            const items = Array.isArray(copy) ? copy : copy?.shoes;
            if (isValidShoeArchive(items)) {
              previous = { shoes: items, collections: Array.isArray(copy.collections) ? copy.collections : collectionNames };
              break;
            }
          } catch {}
        }
        const migrated = { revision: crypto.randomUUID(), current: { shoes: legacy, collections: collectionNames }, previous, savedAt: Date.now() };
        try { await shoeArchiveStorage.commit(migrated, null); }
        catch (error) { if (!await shoeArchiveStorage.get()) throw error; }
        stored = await shoeArchiveStorage.get();
        if (!stored) throw new Error('Migrazione non verificata.');
      }
      if (!isValidShoeArchive(stored.current?.shoes)) throw new Error('Copia locale da recuperare.');
      archiveState = stored;
      shoes = stored.current.shoes;
      collectionNames = Array.isArray(stored.current.collections) ? stored.current.collections : [];
    }

    function initLocalBackupStatus() {
      const status = document.getElementById('autoBackupStatus');
      status.textContent = archiveState?.previous
        ? 'Copia locale precedente disponibile · ' + new Date(archiveState.savedAt).toLocaleString('it-IT')
        : 'La copia precedente sarà disponibile dopo il prossimo salvataggio.';
    }

    async function commitArchive(nextShoes, nextCollections = collectionNames) {
      if (!archiveState) throw new Error('Archivio non disponibile per la scrittura.');
      if (archiveSaving) throw new Error('Attendi il salvataggio in corso.');
      archiveSaving = true;
      try {
        const next = {
          revision: crypto.randomUUID(),
          current: { shoes: nextShoes, collections: nextCollections },
          previous: archiveState.current,
          savedAt: Date.now()
        };
        await shoeArchiveStorage.commit(next, archiveState.revision);
        archiveState = next;
        shoes = nextShoes;
        collectionNames = nextCollections;
        initLocalBackupStatus();
        renderArchive();
      } finally { archiveSaving = false; }
    }

    async function saveToStorage(nextShoes, nextCollections) {
      try { await commitArchive(nextShoes, nextCollections); return true; }
      catch (error) { showToast('Salvataggio non riuscito. ' + error.message); return false; }
    }

    function isValidShoeArchive(items) {
      return Array.isArray(items) && items.length <= 10000 && items.every(item =>
        item && typeof item === 'object' && !Array.isArray(item) &&
        (typeof item.id === 'string' || typeof item.id === 'number') &&
        typeof item.brand === 'string' && typeof item.model === 'string' &&
        (typeof item.colors === 'string' || (Array.isArray(item.colors) && item.colors.every(color => typeof color === 'string'))) &&
        (!item.image || isSafeShoeImageUrl(item.image)) &&
        (!item.images || (Array.isArray(item.images) && item.images.every(isSafeShoeImageUrl)))
      ) && new Set(items.map(item => String(item.id))).size === items.length;
    }

    async function restoreAutomaticSnapshot() {
      await archiveReady;
      const copy = archiveState?.previous;
      if (!isValidShoeArchive(copy?.shoes)) { showToast('Nessuna copia locale disponibile.'); return; }
      if (!confirm('Ripristinare la copia di ' + copy.shoes.length + ' paia? L’archivio corrente contiene ' + shoes.length + ' paia.')) return;
      if (await saveToStorage(copy.shoes, copy.collections)) {
        resetArchiveFilters();
        showToast('Copia locale ripristinata.');
      }
    }

    let toastTimer;
    function showToast(message) {
      const el = document.getElementById('appToast');
      el.textContent = message;
      el.classList.remove('hidden');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
    }

    function focusArchiveSearch() {
      switchTab('archive');
      document.getElementById('searchInput').focus();
    }
    function updatePhotoAiStatus() {
      const ready = Boolean(archivioMasterCore.readGeminiKey());
      for (const mode of ['add','check']) {
        const el = document.getElementById(mode + 'AiStatus');
        if (!el) continue;
        el.replaceChildren();
        if (ready) el.append(document.createTextNode('Gemini configurato per questa sessione.'));
        if (!ready) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'underline font-semibold text-amber-300';
          button.textContent = 'Configura Gemini'; button.onclick = openApiKeyModal;
          el.appendChild(button);
        }
      }
    }
    let promotionScroll = 0;
    function switchTab(tabId, updateAddress = true) {
      if (!['archive', 'check', 'add', 'settings', 'promotions'].includes(tabId)) tabId = 'archive';
      if (document.getElementById('view-' + tabId).classList.contains('hidden')) {
        recordAppEvent('section', tabId);
      }
      if (updateAddress) {
        const currentBand = awinCatalog.promotionBandFromHash(location.hash);
        if (tabId === 'promotions' && !currentBand) {
          const band = document.querySelector('#promotionsPriceFilters [aria-pressed="true"]')?.dataset.priceBand || 'all';
          history.pushState(null, '', awinCatalog.promotionRoutes[band]);
        } else if (tabId !== 'promotions' && currentBand) {
          history.pushState(null, '', location.pathname + location.search);
        }
      }
      const promotionsWasOpen = !document.getElementById('view-promotions').classList.contains('hidden');
      if (promotionsWasOpen && tabId !== 'promotions') promotionScroll = window.scrollY;
      ['archive', 'check', 'add', 'settings', 'promotions'].forEach(t => {
        document.getElementById('view-' + t).classList.toggle('hidden', t !== tabId);
        const btn = document.getElementById('tab-' + t);
        if (btn) {
          btn.classList.toggle('text-amber-400', t === tabId);
          btn.classList.toggle('text-slate-400', t !== tabId);
          btn.setAttribute('aria-current', t === tabId ? 'page' : 'false');
        }
      });
      if (tabId === 'archive') { updateQuickSearchResults(); document.dispatchEvent(new Event('archive-open')); }
      if (tabId === 'promotions' && !promotionsWasOpen) document.dispatchEvent(new Event('promotions-open'));
      updatePhotoAiStatus();
      window.scrollTo({ top: tabId === 'promotions' ? promotionScroll : 0, behavior: 'instant' });
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
    }

    // Accetta solo URL di immagini compatibili con le fotografie archiviate.
    function isSafeShoeImageUrl(value) {
      if (typeof value !== 'string' || value.length > 12000000) return false;
      if (/^data:image\/(?:jpeg|jpg|png|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(value)) return true;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch { return false; }
    }
    function safeShoeImageUrl(value) {
      return isSafeShoeImageUrl(value) ? escapeHtml(value) : '';
    }

    // Raggruppa varianti cromatiche senza modificare i colori originali archiviati.
    function normalizeColorGroup(value) {
      const text = String(value || '').toLocaleLowerCase('it').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const groups = [
        ['Nero', /\b(nero|nera|neri|nere|black|noir)\b/],
        ['Bianco', /\b(bianco|bianca|bianchi|bianche|white|avorio|ivory|panna|crema)\b/],
        ['Grigio', /\b(grigio|grigia|grigi|grigie|grey|gray|antracite|silver|argento)\b/],
        ['Giallo', /\b(giallo|gialla|gialli|gialle|yellow|ocra|senape|mustard|oro|gold)\b/],
        ['Rosso', /\b(rosso|rossa|rossi|rosse|red|bordeaux|burgundy|vinaccia|amaranto)\b/],
        ['Blu', /\b(blu|blue|navy|azzurro|azzurra|azzurri|azzurre|celeste|cobalto)\b/],
        ['Verde', /\b(verde|verdi|green|oliva|olive|smeraldo|menta|militare|khaki)\b/],
        ['Rosa', /\b(rosa|pink|fucsia|fuchsia|magenta)\b/],
        ['Viola', /\b(viola|purple|lilla|lavanda|violet)\b/],
        ['Arancione', /\b(arancione|arancio|orange|corallo|coral)\b/],
        ['Marrone', /\b(marrone|marroni|brown|cuoio|testa di moro|caffe|cioccolato|tan)\b/],
        ['Beige', /\b(beige|sabbia|sand|nude|tortora|taupe|ecru)\b/]
      ];
      const found = groups.find(([, pattern]) => pattern.test(text));
      return found ? found[0] : (text ? text.charAt(0).toLocaleUpperCase('it') + text.slice(1) : '');
    }

    function updateArchiveFilterOptions() {
      const brandSelect = document.getElementById('brandFilter');
      const colorSelect = document.getElementById('colorFilter');
      if (!brandSelect || !colorSelect) return;
      const normalize = value => String(value || '').trim().toLocaleLowerCase('it');
      const brands = new Map();
      const colors = new Map();
      shoes.forEach(shoe => {
        const brand = String(shoe.brand || '').trim();
        if (brand && !brands.has(normalize(brand))) brands.set(normalize(brand), brand);
        const parts = Array.isArray(shoe.colors) ? shoe.colors : String(shoe.colors || '').split(',');
        parts.forEach(part => {
          const color = normalizeColorGroup(part);
          if (color && !colors.has(normalize(color))) colors.set(normalize(color), color);
        });
      });
      [[brandSelect, brands, 'Tutte le marche'], [colorSelect, colors, 'Tutti i colori']].forEach(([select, values, allLabel]) => {
        const selected = select.value;
        select.replaceChildren(new Option(allLabel, ''));
        [...values.entries()].sort((a,b) => a[1].localeCompare(b[1], 'it')).forEach(([key, label]) => select.add(new Option(label, key)));
        select.value = values.has(selected) ? selected : '';
      });
    }

    function resetArchiveFilters() {
      document.getElementById('collectionFilter').value = '';
      document.getElementById('searchInput').value = '';
      document.getElementById('brandFilter').value = '';
      document.getElementById('colorFilter').value = '';
      setCategoryFilter('all');
    }

    // Ricerca locale: sinonimi di marche, modelli e colori, senza chiamate API.
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

    function renderArchive() {
      const grid = document.getElementById('shoesGrid');
      const emptyMsg = document.getElementById('emptyArchiveMsg');
      const searchVal = document.getElementById('searchInput').value.toLowerCase().trim();
      const badge = document.getElementById('shoesCountBadge');
      updateArchiveFilterOptions();
      const brandFilter = document.getElementById('brandFilter').value;
      const colorFilter = document.getElementById('colorFilter').value;
      const collectionFilter = document.getElementById('collectionFilter').value;
      updateCollectionOptions();

      const filtered = shoes.filter(shoe => {
        const matchesCat = currentCategory === 'all' || shoe.category === currentCategory;
        const colorString = Array.isArray(shoe.colors) ? shoe.colors.join(' ') : (shoe.colors || '');
        const matchesSearch = shoeMatchesSmartSearch(shoe, searchVal);
        const matchesBrand = !brandFilter || String(shoe.brand || '').trim().toLocaleLowerCase('it') === brandFilter;
        const colors = Array.isArray(shoe.colors) ? shoe.colors : String(shoe.colors || '').split(',');
        const matchesColor = !colorFilter || colors.some(c => normalizeColorGroup(c).toLocaleLowerCase('it') === colorFilter);
        const matchesCollection = !collectionFilter ||
          (collectionFilter.startsWith('category:') && shoe.category === collectionFilter.slice(9));
        return matchesCat && matchesSearch && matchesBrand && matchesColor && matchesCollection;
      });

      // Data effettiva di inserimento, non data d'acquisto o nome della scarpa.
      // Per gli archivi precedenti usa l'ID timestamp; per record senza
      // timestamp conserva l'ordine originale di memorizzazione.
      const insertionOrder = new Map(shoes.map((shoe, index) => [shoe, index]));
      const insertionTime = shoe => {
        const explicit = Date.parse(shoe.createdAt || '');
        if (Number.isFinite(explicit)) return explicit;
        const id = String(shoe.id || '');
        if (/^\d{13}$/.test(id)) return Number(id);
        const legacy = Date.parse(shoe.dateAdded || '');
        return Number.isFinite(legacy) ? legacy : null;
      };
      filtered.sort((a, b) => {
        const aTime = insertionTime(a);
        const bTime = insertionTime(b);
        if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
        if (aTime !== null && bTime === null) return -1;
        if (bTime !== null && aTime === null) return 1;
        return insertionOrder.get(a) - insertionOrder.get(b);
      });
      badge.textContent = `${shoes.length} ${shoes.length === 1 ? 'paio' : 'paia'}`;
      document.getElementById('archiveResultCount').textContent = `${filtered.length} di ${shoes.length} ${shoes.length === 1 ? 'paio' : 'paia'} ${filtered.length === 1 ? 'visualizzato' : 'visualizzati'}`;
      updateActiveFiltersBadge();
      updateQuickSearchResults();

      if (filtered.length === 0) {
        grid.innerHTML = '';
        const filteredEmpty = shoes.length > 0;
        document.getElementById('emptyArchiveTitle').textContent = filteredEmpty ? 'Nessuna scarpa corrisponde ai filtri' : 'Nessuna scarpa archiviata';
        document.getElementById('emptyArchiveDescription').textContent = filteredEmpty ? 'Modifica o azzera i filtri per visualizzare le scarpe salvate.' : 'Scatta una foto o caricala per archiviare il tuo primo paio.';
        const emptyAction = document.getElementById('emptyArchiveAction');
        emptyAction.onclick = filteredEmpty ? resetArchiveFilters : () => switchTab('add');
        emptyAction.textContent = filteredEmpty ? 'Azzera filtri' : 'Aggiungi ora';
        emptyMsg.classList.remove('hidden');
        return;
      }

      emptyMsg.classList.add('hidden');
      grid.innerHTML = filtered.map(shoe => {
        const colorsList = Array.isArray(shoe.colors) ? shoe.colors : [shoe.colors || 'N/D'];
        return `
          <div class="shoe-card bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg group">
            <div class="shoe-card-photo relative bg-slate-950 overflow-hidden">
              <img src="${safeShoeImageUrl(shoe.image)}" alt="${escapeHtml(shoe.brand)} ${escapeHtml(shoe.model)}" loading="lazy" decoding="async" class="w-full h-full object-cover">
            </div>
            <div class="shoe-card-info p-3 flex flex-col min-w-0">
              <div class="min-w-0">
                <p class="text-[11px] font-bold text-amber-400 uppercase tracking-wider">${escapeHtml(shoe.brand)}</p>
                <h3 class="text-sm font-semibold text-slate-100 break-words">${escapeHtml(shoe.model)}</h3>
                <p class="text-xs text-slate-400">${escapeHtml(shoe.category)}</p>
                <p class="text-xs text-slate-400 break-words">${escapeHtml([shoe.size ? "EU "+shoe.size : "",shoe.price != null ? Number(shoe.price).toLocaleString("it-IT",{style:"currency",currency:"EUR"}) : "",shoe.store || ""].filter(Boolean).join(" · "))}</p>
                ${shoe.sku ? `<p class="text-[10px] text-slate-400 break-all">SKU: ${escapeHtml(shoe.sku)}</p>` : ''}
                <div class="flex flex-wrap gap-1 mt-1">
                  ${colorsList.map(c => `<span class="text-[10px] bg-slate-800 border border-slate-700 text-slate-300 px-1.5 py-0.5 rounded-md font-medium">${escapeHtml(String(c).trim())}</span>`).join('')}
                </div>
              </div>
              <div class="shoe-card-actions flex items-center gap-2 mt-auto pt-3">
                <button type="button" data-view-shoe-photos="${escapeHtml(shoe.id)}" aria-label="Apri ${shoePhotos(shoe).length} fotografie" title="Fotografie" class="w-10 h-10 bg-slate-800 border border-slate-600 text-slate-700 rounded-xl flex items-center justify-center gap-1"><i class="fa-solid fa-images"></i><span class="text-xs">${shoePhotos(shoe).length}</span></button>
                <button type="button" data-edit-shoe="${escapeHtml(shoe.id)}" aria-label="Modifica scarpa" title="Modifica scarpa" class="w-10 h-10 bg-slate-800 border border-slate-600 text-cyan-700 rounded-xl flex items-center justify-center"><i class="fa-solid fa-pen text-sm"></i></button>
                <button type="button" data-delete-shoe="${escapeHtml(shoe.id)}" aria-label="Elimina scarpa" title="Elimina scarpa" class="w-10 h-10 bg-red-50 border border-red-200 text-red-600 rounded-xl flex items-center justify-center"><i class="fa-solid fa-trash text-sm"></i></button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    function setCategoryFilter(cat) {
      currentCategory = cat;
      document.querySelectorAll('.cat-pill').forEach(btn => {
        if (btn.getAttribute('data-cat') === cat) {
          btn.classList.add('bg-amber-500', 'text-slate-950', 'active');
          btn.setAttribute('aria-pressed','true');
          btn.classList.remove('bg-slate-800', 'text-slate-300');
        } else {
          btn.classList.remove('bg-amber-500', 'text-slate-950', 'active');
          btn.setAttribute('aria-pressed','false');
          btn.classList.add('bg-slate-800', 'text-slate-300');
        }
      });
      renderArchive();
    }

    function filterArchive() { renderArchive(); }

    function updateActiveFiltersBadge() {
      const count = [
        document.getElementById('brandFilter').value,
        document.getElementById('colorFilter').value,
        document.getElementById('collectionFilter').value,
        currentCategory !== 'all' ? currentCategory : ''
      ].filter(Boolean).length;
      document.getElementById('activeFiltersBadge').textContent = count ? count + (count === 1 ? ' filtro attivo' : ' filtri attivi') : '';
    }

    function updateQuickSearchResults() {
      const container = document.getElementById('quickSearchResults');
      if (!container) return;
      const query = document.getElementById('searchInput').value.trim();
      if (!query) { container.replaceChildren(); return; }
      const matches = shoes.filter(shoe => shoeMatchesSmartSearch(shoe, query)).slice(0, 20);
      container.innerHTML = '<p class="text-xs text-slate-400">' + matches.length + (matches.length === 20 ? '+' : '') + (matches.length === 1 ? ' risultato' : ' risultati') + ' nell’archivio</p>' +
        (matches.length ? matches.map(shoe => '<button type="button" data-edit-shoe="' + escapeHtml(shoe.id) + '" class="w-full flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 p-2 text-left min-h-14"><img src="' + safeShoeImageUrl(shoe.image || '') + '" alt="" class="w-12 h-12 object-cover rounded-lg"><span class="min-w-0 flex-1"><strong class="block text-sm truncate">' + escapeHtml(shoe.brand) + ' · ' + escapeHtml(shoe.model) + '</strong><span class="text-xs text-slate-400">' + escapeHtml(Array.isArray(shoe.colors) ? shoe.colors.join(', ') : shoe.colors || '') + '</span></span><i class="fa-solid fa-chevron-right text-slate-500"></i></button>').join('') : '<p class="text-xs text-slate-400">Nessuna scarpa trovata.</p>');
    }

    function getAddDuplicates() {
      const brand = canonicalShoeBrand(document.getElementById('addBrand').value);
      const model = canonicalShoeModel(document.getElementById('addModel').value);
      const sku = normalizeSku(document.getElementById('addSku').value);
      const colors = document.getElementById('addColors').value.split(',').map(canonicalShoeColor).filter(Boolean).sort().join('|');
      if (!brand || (!model && !sku)) return [];
      return shoes.filter(shoe => canonicalShoeBrand(shoe.brand) === brand && (
        (sku && normalizeSku(shoe.sku) === sku) ||
        (model && canonicalShoeModel(shoe.model) === model &&
          colors && (Array.isArray(shoe.colors) ? shoe.colors : String(shoe.colors || '').split(',')).map(canonicalShoeColor).filter(Boolean).sort().join('|') === colors)
      ));
    }

    function updateAddDuplicateNotice() {
      const el = document.getElementById('addDuplicateNotice');
      if (!el) return;
      const duplicates = getAddDuplicates();
      el.classList.toggle('hidden', !duplicates.length);
      el.replaceChildren();
      if (duplicates.length) {
        const heading = document.createElement('p');
        heading.className = 'font-bold';
        heading.textContent = 'Possibile doppione: questa scarpa potrebbe essere già presente.';
        el.appendChild(heading);
        for (const shoe of duplicates.slice(0,2)) {
          const btn = document.createElement('button');
          btn.type='button';btn.className='flex items-center gap-2 rounded-lg border border-amber-500/40 p-2 w-full text-left';
          btn.textContent = shoe.brand + ' · ' + shoe.model + ' · ' + (Array.isArray(shoe.colors) ? shoe.colors.join(', ') : shoe.colors || '');
          btn.dataset.duplicateShoe = String(shoe.id);
          el.appendChild(btn);
        }
        const note = document.createElement('p');
        note.textContent = 'Tocca la scarpa per visualizzarne le fotografie. Puoi comunque salvarne un altro paio dopo la conferma.';
        el.appendChild(note);
      }
    }

    function openEditShoeModal(id) {
      const shoe = shoes.find(item => String(item.id) === String(id));
      if (!shoe) return;
      document.getElementById('editShoeId').value = String(shoe.id);
      document.getElementById('editShoeBrand').value = shoe.brand || '';
      document.getElementById('editShoeModel').value = shoe.model || '';
      document.getElementById('editShoeColors').value = Array.isArray(shoe.colors) ? shoe.colors.join(', ') : (shoe.colors || '');
      document.getElementById('editShoeSku').value = shoe.sku || '';
      document.getElementById('editShoeSize').value = shoe.size || '';
      document.getElementById('editShoePrice').value = shoe.price ?? '';
      document.getElementById('editPurchaseDate').value = shoe.purchaseDate || '';
      document.getElementById('editShoeStore').value = shoe.store || '';
      document.getElementById('editShoeCategory').value = shoe.category || 'Casual / Altro';
      document.getElementById('editShoeNotes').value = shoe.notes || '';
      document.getElementById('editShoeCollections').value = Array.isArray(shoe.collections) ? shoe.collections.join(', ') : '';
      editingImages = shoePhotos(shoe).slice();
      renderPhotoThumbnails('edit');
      document.getElementById('editShoeModal').classList.remove('hidden');
      document.getElementById('editShoeBrand').focus();
    }

    function closeEditShoeModal() {
      document.getElementById('editShoeModal').classList.add('hidden');
    }

    async function saveEditedShoe(event) {
      event.preventDefault();
      await archiveReady;
      const id = document.getElementById('editShoeId').value;
      const shoe = shoes.find(item => String(item.id) === id);
      if (!shoe) { closeEditShoeModal(); return; }
      const brand = document.getElementById('editShoeBrand').value.trim();
      const model = document.getElementById('editShoeModel').value.trim();
      const colors = document.getElementById('editShoeColors').value.split(',').map(c => c.trim()).filter(Boolean);
      if (!brand || !model || !colors.length) return;
      const edited = { ...shoe, brand, model, colors };
      edited.sku = normalizeSku(document.getElementById('editShoeSku').value);
      edited.category = document.getElementById('editShoeCategory').value;
      edited.notes = document.getElementById('editShoeNotes').value.trim();
      Object.assign(edited, readShoePurchaseFields('edit'));
      edited.collections = parseCollectionNames(document.getElementById('editShoeCollections').value);
      edited.image = editingImages[0] || shoe.image;
      edited.images = editingImages.slice();
      const updatedCollections = [...new Set([...collectionNames, ...edited.collections])];
      if (!await saveToStorage(shoes.map(item => item === shoe ? edited : item), updatedCollections)) return;
      renderArchive();
      closeEditShoeModal();
    }

    document.addEventListener('click', event => {
      const duplicateButton = event.target.closest('[data-duplicate-shoe]');
      if (duplicateButton) { openShoeGallery(duplicateButton.dataset.duplicateShoe); return; }
      const photoButton = event.target.closest('[data-view-shoe-photos]');
      if (photoButton) { openShoeGallery(photoButton.dataset.viewShoePhotos); return; }
      const editButton = event.target.closest('[data-edit-shoe]');
      if (editButton) { openEditShoeModal(editButton.dataset.editShoe); return; }
      const deleteButton = event.target.closest('[data-delete-shoe]');
      if (deleteButton) deleteShoe(deleteButton.dataset.deleteShoe);
    });

    async function deleteShoe(id) {
      await archiveReady;
      const shoe = shoes.find(s => String(s.id) === String(id));
      if (shoe && confirm('Eliminare definitivamente ' + shoe.brand + ' ' + shoe.model + ' dall’archivio?')) {
        await saveToStorage(shoes.filter(item => item !== shoe));
      }
    }

    function shoePhotos(shoe) {
      const photos = Array.isArray(shoe.images) ? shoe.images.filter(isSafeShoeImageUrl) : [];
      if (isSafeShoeImageUrl(shoe.image) && !photos.includes(shoe.image)) photos.unshift(shoe.image);
      return photos;
    }

    function renderPhotoThumbnails(mode) {
      const images = mode === 'edit' ? editingImages : addExtraImages;
      const target = document.getElementById(mode === 'edit' ? 'editShoePhotosPreview' : 'addExtraPhotosPreview');
      target.replaceChildren();
      images.forEach((src, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-600';
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'Foto ' + (index + 1);
        img.className = 'w-full h-full object-cover';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'absolute top-0 right-0 bg-red-900 text-white rounded-bl-md w-7 h-7 text-xs';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Rimuovi foto ' + (index + 1));
        remove.onclick = () => {
          if (mode === 'edit' && images.length <= 1) { alert('Conserva almeno una fotografia.'); return; }
          images.splice(index, 1);
          renderPhotoThumbnails(mode);
        };
        wrapper.append(img, remove);
        target.appendChild(wrapper);
      });
    }

    function resizePhotoAsync(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Lettura foto non riuscita'));
        reader.onload = event => {
          const img = new Image();
          img.onerror = () => reject(new Error('Immagine non valida'));
          img.onload = () => {
            const ratio = Math.min(1, 700 / img.width);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * ratio));
            canvas.height = Math.max(1, Math.round(img.height * ratio));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.68));
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    async function addExtraPhotos(input, mode) {
      const target = mode === 'edit' ? editingImages : addExtraImages;
      const max = mode === 'edit' ? 5 : 4;
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      if (target.length + files.length > max) {
        alert('Massimo ' + max + ' foto ' + (mode === 'edit' ? 'totali' : 'aggiuntive') + ' per scarpa.');
        return;
      }
      try {
        for (const file of files) target.push(await resizePhotoAsync(file));
        renderPhotoThumbnails(mode);
      } catch (error) { alert('Impossibile caricare le foto: ' + error.message); }
    }

    function openShoeGallery(id) {
      const shoe = shoes.find(item => String(item.id) === String(id));
      if (!shoe) return;
      const photos = shoePhotos(shoe);
      const container = document.getElementById('shoeGalleryPhotos');
      container.replaceChildren();
      photos.forEach((src, index) => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'Foto ' + (index + 1) + ' di ' + shoe.brand + ' ' + shoe.model;
        img.className = 'w-full rounded-xl object-contain max-h-[65vh] bg-slate-950';
        img.loading = 'lazy';
        container.appendChild(img);
      });
      document.getElementById('shoeGalleryTitle').textContent = shoe.brand + ' ' + shoe.model + ' — ' + photos.length + ' foto' + (shoe.size ? ' · EU ' + shoe.size : '') + (shoe.purchaseDate ? ' · ' + shoe.purchaseDate : '') + (shoe.store ? ' · ' + shoe.store : '');
      document.getElementById('shoeGalleryModal').classList.remove('hidden');
    }

    // OCR locale nel browser: Tesseract è caricato solo su richiesta, senza chiavi API.
    let shoeOcrLoader = null;
    function loadShoeOcr() {
      if (window.Tesseract) return Promise.resolve(window.Tesseract);
      if (shoeOcrLoader) return shoeOcrLoader;
      shoeOcrLoader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Libreria OCR non disponibile'));
        script.onerror = () => reject(new Error('Impossibile scaricare OCR: verifica la connessione'));
        document.head.appendChild(script);
      }).catch(error => { shoeOcrLoader = null; throw error; });
      return shoeOcrLoader;
    }

    function suggestSkuFromOcr(text) {
      const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      // Solo candidati alfanumerici, mai codici a barre numerici o numeri seriali.
      const candidates = [];
      for (const line of lines) {
        const labeled = line.match(/(?:SKU|STYLE(?:\s*(?:NO|CODE|#))?|ARTICLE|ART(?:ICOLO)?\.?|ITEM(?:\s*(?:NO|#))?|COD(?:ICE)?\.?\s*ART(?:ICOLO)?\.?)[\s:=-]*([A-Z0-9][A-Z0-9-]{4,22})/i);
        if (labeled) candidates.push(labeled[1]);
      }
      for (const candidate of candidates) {
        const sku = normalizeSku(candidate);
        if (/[A-Z]/.test(sku) && /\d/.test(sku) && !/^\d{8,14}$/.test(sku)) return sku;
      }
      return '';
    }

    async function runShoeOCR(mode, automatic = false) {
      const src = imagesByMode[mode];
      const status = document.getElementById(mode + 'OcrStatus');
      const button = document.getElementById(mode + 'OcrButton');
      const output = document.getElementById(mode + 'OcrText');
      const skuPanel = document.getElementById(mode + 'OcrSkuPanel');
      if (!src) { status.textContent = 'Carica prima una fotografia dell’etichetta.'; return; }
      if (button.disabled) return;
      const sourceAtStart = src;
      button.disabled = true;
      output.classList.add('hidden');
      skuPanel.classList.add('hidden');
      try {
        status.textContent = 'Caricamento motore OCR...';
        const engine = await loadShoeOcr();
        status.textContent = 'Lettura del testo in corso...';
        const worker = await engine.createWorker('eng');
        let result;
        try { result = await worker.recognize(src); }
        finally { await worker.terminate(); }
        if (imagesByMode[mode] !== sourceAtStart) return;
        const text = (result.data?.text || '').trim();
        output.value = text;
        output.classList.remove('hidden');
        const sku = suggestSkuFromOcr(text);
        if (sku) {
          document.getElementById(mode + 'OcrSku').value = sku;
          skuPanel.classList.remove('hidden');
        }
        status.textContent = text ? (sku ? 'Testo letto. Controlla il codice suggerito prima di applicarlo.' : 'Testo letto. Nessuno SKU sicuro individuato; verifica il testo manualmente.') : 'Nessun testo riconosciuto: riprova con una foto più nitida.';
        if (automatic && sku) status.textContent = 'OCR: possibile SKU ' + sku + '. Controlla l’etichetta e premi Usa SKU per confermarlo.';
      } catch (error) {
        status.textContent = 'OCR non disponibile: ' + error.message + '. Gemini continua a funzionare normalmente.';
      } finally { button.disabled = false; }
    }

    function applyOcrSku(mode) {
      const sku = normalizeSku(document.getElementById(mode + 'OcrSku').value);
      if (!sku || !/[A-Z]/.test(sku) || !/\d/.test(sku)) { alert('Verifica il codice articolo prima di utilizzarlo.'); return; }
      if (mode === 'add') {
        const input = document.getElementById('addSku');
        if (input.value && normalizeSku(input.value) !== sku && !confirm('Sostituire lo SKU già individuato da Gemini?')) return;
        input.value = sku;
      } else {
        if (!lastCheckedCandidate) { alert('Completa prima il riconoscimento della scarpa con Gemini, poi applica lo SKU OCR.'); return; }
        if (lastCheckedCandidate.sku && normalizeSku(lastCheckedCandidate.sku) !== sku && !confirm('Sostituire lo SKU rilevato da Gemini?')) return;
        const candidate = { ...lastCheckedCandidate, sku };
        evaluatePurchase(candidate);
      }
      document.getElementById(mode + 'OcrStatus').textContent = 'SKU applicato. Verifica che corrisponda all’etichetta originale.';
    }

    function resizeImage(file, maxWidth, callback) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          const scale = Math.min(1, maxWidth / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          callback(canvas.toDataURL('image/jpeg', 0.68));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    // dHash: firma percettiva compatta, calcolata solo in memoria.
    // Confronta l'aspetto complessivo delle foto, non l'identità del modello.
    function visualHashFromPixels(pixels, width = 9, height = 8) {
      const gray = [];
      for (let y = 0; y < height; y++) {
        const row = [];
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          row.push(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
        }
        gray.push(row);
      }
      let hash = '';
      for (let y = 0; y < height; y++) for (let x = 0; x < width - 1; x++) hash += gray[y][x] > gray[y][x + 1] ? '1' : '0';
      return hash;
    }

    function visualHashDistance(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return 64;
      let distance = 0;
      for (let i = 0; i < 64; i++) if (a[i] !== b[i]) distance++;
      return distance;
    }

    function imageVisualHash(src) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 9;
            canvas.height = 8;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0, 9, 8);
            resolve(visualHashFromPixels(ctx.getImageData(0, 0, 9, 8).data));
          } catch (error) { reject(error); }
        };
        image.onerror = () => reject(new Error('Impossibile leggere una fotografia.'));
        image.src = src;
      });
    }

    let activeVisualRun = 0;
    let latestVisualMatches = [];
    const visualHashCache = new Map();
    function cachedVisualHash(src) {
      if (!visualHashCache.has(src)) {
        if (visualHashCache.size > 350) visualHashCache.clear();
        const task = imageVisualHash(src);
        visualHashCache.set(src, task);
        task.catch(() => visualHashCache.delete(src));
      }
      return visualHashCache.get(src);
    }
    async function findVisuallySimilarShoes() {
      const status = document.getElementById('visualSearchStatus');
      const output = document.getElementById('visualSearchResults');
      const runId = activeVisualRun;
      const src = imagesByMode.check;
      latestVisualMatches = [];
      output.replaceChildren();
      if (!src) { status.textContent = 'Prima scatta o carica una fotografia nella sezione Ricerche.'; return; }
      if (!shoes.length) { status.textContent = 'L’archivio è vuoto.'; return; }
      status.textContent = 'Confronto visivo in corso...';
      try {
        const queryHash = await cachedVisualHash(src);
        const found = [];
        let skipped = 0;
        // Yield periodicamente per mantenere reattiva l'interfaccia mobile.
        for (let index = 0; index < shoes.length; index++) {
          const shoe = shoes[index];
          let best = 64;
          if (runId !== activeVisualRun) return;
          for (const photo of shoePhotos(shoe)) {
            try {
              const distance = visualHashDistance(queryHash, await cachedVisualHash(photo));
              best = Math.min(best, distance);
            } catch { skipped++; }
          }
          if (best <= 18) found.push({ shoe, distance: best });
          if (index % 8 === 7) {
            status.textContent = 'Confrontate ' + (index + 1) + ' di ' + shoes.length + ' scarpe...';
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
        if (runId !== activeVisualRun) return;
        found.sort((a, b) => a.distance - b.distance);
        latestVisualMatches = found.slice(0, 8);
        const matches = latestVisualMatches;
        status.textContent = matches.length
          ? matches.length + ' possibili somiglianze visive, da verificare.' + (skipped ? ' Alcune foto non sono state lette.' : '')
          : 'Nessuna fotografia sufficientemente simile trovata.' + (skipped ? ' Alcune foto non sono state lette.' : '');
        if (lastCheckedCandidate && imagesByMode.check === src && runId === activeVisualRun) evaluatePurchase(lastCheckedCandidate);
        else if (imagesByMode.check === src && runId === activeVisualRun) document.getElementById('recognitionProgress').textContent = 'Confronto fotografico pronto. Gemini sta identificando la scarpa...';
        if (runId !== activeVisualRun) return;
        for (const { shoe, distance } of matches) {
          const row = document.createElement('div');
          row.className = 'flex gap-3 items-center rounded-xl bg-slate-950 border border-slate-700 p-2';
          const img = document.createElement('img');
          img.src = shoePhotos(shoe)[0] || '';
          img.alt = 'Foto scarpa';
          img.className = 'w-16 h-16 rounded-lg object-cover';
          const details = document.createElement('div');
          details.className = 'flex-1 min-w-0';
          const name = document.createElement('p');
          name.className = 'text-xs font-bold text-white break-words';
          name.textContent = [shoe.brand, shoe.model].filter(Boolean).join(' ') || 'Scarpa senza nome';
          const desc = document.createElement('p');
          desc.className = 'text-[11px] text-slate-400';
          desc.textContent = distance <= 5 ? 'Foto molto simile' : distance <= 11 ? 'Foto simile' : 'Somiglianza possibile';
          details.append(name, desc);
          const view = document.createElement('button');
          view.type = 'button';
          view.className = 'px-3 py-2 bg-indigo-600 rounded-lg text-xs font-bold text-white';
          view.textContent = 'Modifica';
          view.onclick = () => openEditShoeModal(shoe.id);
          row.append(img, details, view);
          output.appendChild(row);
        }
      } catch (error) { if (runId === activeVisualRun) status.textContent = 'Confronto non riuscito: ' + error.message; }
    }

    async function captureMasterPhoto(mode) {
      if (archivioCamera.useNativeCapture()) {
        document.getElementById(mode + 'CameraInput').click();
        return;
      }
      try {
        const photo = await archivioCamera.takeDesktopPhoto({
          gallery: () => document.getElementById(mode + 'GalleryInput').click()
        });
        if (photo) processSelectedPhoto(photo, mode);
      } catch (error) {
        alert(error.message);
      }
    }

    function handleImageSelected(input, mode) {
      const file = input.files[0];
      if (!file) return;
      input.value = '';
      processSelectedPhoto(file, mode);
    }

    function processSelectedPhoto(file, mode) {
      resizeImage(file, 560, async (base64Url) => {
        selectedImageBase64 = base64Url;
        imagesByMode[mode] = base64Url;
        if (mode === 'check') { activeVisualRun++; latestVisualMatches = []; lastCheckedCandidate = null; document.getElementById('checkResultContainer').classList.add('hidden'); document.getElementById('visualSearchResults').replaceChildren(); document.getElementById('visualSearchStatus').textContent = ''; document.getElementById('recognitionProgress').textContent = 'Confronto fotografico avviato. Riconoscimento Gemini in corso...'; void findVisuallySimilarShoes(); }
        document.getElementById(mode + 'OcrText').value = '';
        document.getElementById(mode + 'OcrText').classList.add('hidden');
        document.getElementById(mode + 'OcrSkuPanel').classList.add('hidden');
        document.getElementById(mode + 'OcrStatus').textContent = '';
        document.getElementById(`${mode}ErrorOverlay`).classList.add('hidden');

        if (mode === 'add') {
          document.getElementById('addPreviewImg').src = base64Url;
          document.getElementById('addPreviewImg').classList.remove('hidden');
          document.getElementById('addPlaceholder').classList.add('hidden');
          document.getElementById('addScanningAnim').classList.remove('hidden');
          try {
            await analyzeShoeWithGemini(base64Url, 'add');
          } finally {
            document.getElementById('addScanningAnim').classList.add('hidden');
          }
        } else if (mode === 'check') {
          document.getElementById('checkPreviewImg').src = base64Url;
          document.getElementById('checkPreviewImg').classList.remove('hidden');
          document.getElementById('checkPlaceholder').classList.add('hidden');
          document.getElementById('checkScanningAnim').classList.remove('hidden');
          // Keep the local photographic report visible.
          try {
            await analyzeShoeWithGemini(base64Url, 'check');
          } finally {
            document.getElementById('checkScanningAnim').classList.add('hidden');
          }
        }
      });
    }

    function retryAnalysis(mode) {
      if (!imagesByMode[mode]) {
        alert("Nessuna immagine da riprovare. Carica nuovamente la foto.");
        return;
      }
      document.getElementById(`${mode}ErrorOverlay`).classList.add('hidden');
      document.getElementById(`${mode}ScanningAnim`).classList.remove('hidden');
      if (mode === 'check') document.getElementById('recognitionProgress').textContent = 'Nuovo tentativo Gemini in corso...';

      analyzeShoeWithGemini(imagesByMode[mode], mode).finally(() => {
        document.getElementById(`${mode}ScanningAnim`).classList.add('hidden');
      });
    }

    function readShoePurchaseFields(prefix) {
      const rawPrice = document.getElementById(prefix + 'ShoePrice').value;
      const price = rawPrice === '' ? null : Number(rawPrice);
      return {size:document.getElementById(prefix + 'ShoeSize').value.trim().slice(0,20),price:Number.isFinite(price)&&price>=0?price:null,purchaseDate:document.getElementById(prefix + 'PurchaseDate').value,store:document.getElementById(prefix + 'ShoeStore').value.trim().slice(0,120)};
    }
    async function saveShoe(e) {
      e.preventDefault();
      await archiveReady;
      const rawColors = document.getElementById('addColors').value;
      const colorsArray = rawColors.split(',').map(c => c.trim()).filter(Boolean);
      const brand = document.getElementById('addBrand').value.trim();
      const model = document.getElementById('addModel').value.trim();

      const newShoe = {
        id: Date.now().toString(),
        brand: brand,
        model: model,
        category: document.getElementById('addCategory').value,
        colors: colorsArray.length > 0 ? colorsArray : ['N/D'],
        notes: document.getElementById('addNotes').value.trim(),
        sku: normalizeSku(document.getElementById('addSku').value),
        collections: [],
        image: imagesByMode.add || createShoeSvgBase64(brand, model, '#1e293b'),
        images: [imagesByMode.add || createShoeSvgBase64(brand, model, '#1e293b'), ...addExtraImages].slice(0, 5),
        createdAt: new Date().toISOString(),
        dateAdded: new Date().toISOString().split('T')[0],
        ...readShoePurchaseFields('add')
      };

      const duplicates = getAddDuplicates();
      if (duplicates.length && !confirm('Possibile doppione: ' + duplicates.slice(0, 2).map(shoe => shoe.brand + ' ' + shoe.model).join(', ') + '. Vuoi aggiungere comunque un altro paio?')) return;
      if (!await saveToStorage([newShoe, ...shoes])) return;

      document.getElementById('addShoeForm').reset();
      updateAddDuplicateNotice();
      document.getElementById('addPreviewImg').classList.add('hidden');
      document.getElementById('addPlaceholder').classList.remove('hidden');
      document.getElementById('addErrorOverlay').classList.add('hidden');
      selectedImageBase64 = null;
      imagesByMode.add = null;
      addExtraImages = [];
      document.getElementById('addExtraPhotosInput').value = '';
      renderPhotoThumbnails('add');
      showToast('Scarpa salvata nell’archivio.');
      switchTab('archive');
    }

    let lastCheckedCandidate = null;

    function addComparedShoe() {
      const candidate = lastCheckedCandidate || {};
      const photo = imagesByMode.check;
      if (!photo) { showToast('Scatta prima una foto nella pagina Confronta.'); return; }
      document.getElementById('addShoeForm').reset();
      addExtraImages = [];
      imagesByMode.add = photo;
      selectedImageBase64 = photo;
      document.getElementById('addPreviewImg').src = photo;
      document.getElementById('addPreviewImg').classList.remove('hidden');
      document.getElementById('addPlaceholder').classList.add('hidden');
      document.getElementById('addBrand').value = candidate.brand || '';
      document.getElementById('addModel').value = candidate.model || '';
      document.getElementById('addColors').value = Array.isArray(candidate.colors) ? candidate.colors.join(', ') : (candidate.colors || '');
      document.getElementById('addSku').value = candidate.sku || '';
      document.getElementById('addNotes').value = candidate.notes || '';
      const category = document.getElementById('addCategory');
      if (candidate.category && [...category.options].some(option => option.value === candidate.category)) category.value = candidate.category;
      renderPhotoThumbnails('add');
      updateAddDuplicateNotice();
      switchTab('add');
    }

    function completeCheckedShoe() {
      if (!lastCheckedCandidate) return;
      const brand = prompt('Marca della scarpa:', lastCheckedCandidate.brand || '');
      if (brand === null) return;
      const model = prompt('Modello della scarpa (puoi indicare "Modello sconosciuto"):', lastCheckedCandidate.model || '');
      if (model === null) return;
      const colors = prompt('Colori, separati da virgola:', Array.isArray(lastCheckedCandidate.colors) ? lastCheckedCandidate.colors.join(', ') : (lastCheckedCandidate.colors || ''));
      if (colors === null) return;
      const sku = prompt('Codice articolo / SKU (facoltativo):', lastCheckedCandidate.sku || '');
      if (sku === null) return;
      const updated = { ...lastCheckedCandidate, brand: brand.trim(), model: model.trim(), sku: normalizeSku(sku), colors: colors.split(',').map(c => c.trim()).filter(Boolean) };
      if (!updated.brand || !updated.model || !updated.colors.length) {
        alert('Compila tutti i campi prima di salvare.');
        return;
      }
      evaluatePurchase(updated);
      saveCheckedShoe();
    }

    async function saveCheckedShoe() {
      await archiveReady;
      const candidate = lastCheckedCandidate;
      if (!candidate) return;
      const brand = String(candidate.brand || '').trim();
      const model = String(candidate.model || '').trim();
      const colors = (Array.isArray(candidate.colors) ? candidate.colors : String(candidate.colors || '').split(','))
        .map(color => String(color || '').trim()).filter(Boolean);
      if (!brand || !model || !colors.length) {
        alert('Completa marca, modello e colori prima di salvare.');
        return;
      }
      const candidateSku = normalizeSku(candidate.sku);
      const sameColors = (a, b) => a.map(canonicalShoeColor).sort().join('|') === b.map(canonicalShoeColor).sort().join('|');
      const alreadyOwned = shoes.some(shoe => {
        if (canonicalShoeBrand(shoe.brand) !== canonicalShoeBrand(brand)) return false;
        return canonicalShoeModel(shoe.model) === canonicalShoeModel(model) &&
          sameColors(Array.isArray(shoe.colors) ? shoe.colors : String(shoe.colors || '').split(','), colors);
      });
      if (alreadyOwned && !confirm('Questa scarpa è già presente nell’archivio. Vuoi aggiungere comunque un altro paio identico?')) return;
      const newShoe = {
        id: Date.now().toString(),
        brand, model,
        category: candidate.category || 'Casual / Altro',
        colors,
        notes: candidate.notes || '',
        sku: normalizeSku(candidate.sku),
        collections: [],
        image: candidate.image || imagesByMode.check || createShoeSvgBase64(brand, model, '#1e293b'),
        images: [candidate.image || imagesByMode.check || createShoeSvgBase64(brand, model, '#1e293b')],
        createdAt: new Date().toISOString(),
        dateAdded: new Date().toISOString().split('T')[0]
      };
      if (!await saveToStorage([newShoe, ...shoes])) return;
      lastCheckedCandidate = null;
      switchTab('archive');
    }

    function renderSideBySideComparison(candidate,existing){
      const newImg=safeShoeImageUrl(candidate.image||imagesByMode.check||'');
      const oldImg=safeShoeImageUrl(existing.image||'');
      return '<div class="mt-3 grid grid-cols-2 gap-2"><div class="rounded-xl bg-slate-950 p-2"><p class="text-xs text-slate-300 mb-2">Da verificare</p><img src="'+newImg+'" alt="Scarpa da verificare" class="w-full aspect-square object-contain rounded-lg"><p class="text-xs mt-1">'+escapeHtml([candidate.brand,candidate.model].filter(Boolean).join(' '))+'</p></div><div class="rounded-xl bg-slate-950 p-2"><p class="text-xs text-slate-300 mb-2">Nel tuo archivio</p><img src="'+oldImg+'" alt="Scarpa già archiviata" class="w-full aspect-square object-contain rounded-lg"><p class="text-xs mt-1">'+escapeHtml([existing.brand,existing.model].filter(Boolean).join(' '))+'</p></div></div>';
    }
    function evaluatePurchase(candidate) {
      const container = document.getElementById('checkResultContainer');
      lastCheckedCandidate = null;
      container.classList.remove('hidden');

      const candColors = (Array.isArray(candidate.colors) ? candidate.colors : String(candidate.colors || '').split(',')).map(c => String(c).toLowerCase().trim()).filter(Boolean);
      const candBrand = (candidate.brand || '').toLowerCase().trim();
      const candModel = (candidate.model || '').toLowerCase().trim();

      let exactMatches = [];
      let highSimilarity = [];
      let mediumSimilarity = [];

      const normalizeColors = values => (Array.isArray(values) ? values : String(values || '').split(','))
        .map(canonicalShoeColor).filter(Boolean).sort();
      const sameColors = (a, b) => a.length > 0 && b.length > 0 &&
        a.length === b.length && a.every((color, index) => color === b[index]);
      const candidateColors = normalizeColors(candidate.colors);
      const candidateBrand = canonicalShoeBrand(candidate.brand);
      const candidateModel = canonicalShoeModel(candidate.model);
      const candidateSku = normalizeSku(candidate.sku);
      shoes.forEach(myShoe => {
        const brandEqual = candidateBrand && canonicalShoeBrand(myShoe.brand) === candidateBrand;
        const ownedSku = normalizeSku(myShoe.sku);
        const skuEqual = Boolean(candidateSku && ownedSku && candidateSku === ownedSku);
        const skuDifferent = Boolean(candidateSku && ownedSku && candidateSku !== ownedSku);
        const modelEqual = candidateModel && canonicalShoeModel(myShoe.model) === candidateModel;
        const ownedColors = normalizeColors(myShoe.colors);
        const colorsEqual = sameColors(candidateColors, ownedColors);
        const shared = candidateColors.filter(color => ownedColors.includes(color));
        if (brandEqual && modelEqual && colorsEqual) {
          exactMatches.push({ shoe: myShoe, reason: 'Stessa marca, modello e colori' });
        } else if (brandEqual && skuEqual) {
          highSimilarity.push({ shoe: myShoe, reason: 'Stesso SKU: verifica il modello e la colorazione' });
        } else if (brandEqual && modelEqual) {
          highSimilarity.push({ shoe: myShoe, reason: skuDifferent ? 'Stesso modello, SKU differente' : 'Stesso modello, colorazione differente' });
        } else if (brandEqual && shared.length && myShoe.category === candidate.category) {
          mediumSimilarity.push({ shoe: myShoe, reason: 'Stessa marca e tipologia · colori in comune: ' + shared.join(', ') });
        }
      });

      const matchedIds = new Set([...exactMatches, ...highSimilarity, ...mediumSimilarity].map(m => String(m.shoe.id)));
      latestVisualMatches.forEach(v => {
        if (!matchedIds.has(String(v.shoe.id))) mediumSimilarity.push({ shoe: v.shoe, reason: 'Foto visivamente simile (non prova di doppione)' });
      });
      let status = {
        border: 'border-emerald-500/40',
        text: 'text-emerald-400',
        bg: 'bg-emerald-500/20',
        icon: 'fa-circle-check',
        badge: 'NESSUNA CORRISPONDENZA RILEVATA',
        title: 'Nessuna corrispondenza nei dati disponibili',
        desc: 'Nessuna corrispondenza rilevata nei dati disponibili. Il confronto fotografico può essere ancora in corso e non esclude tutti i doppioni.'
      };

      if (!candidateBrand || !candidateModel || candidateColors.length === 0) {
        status = { border: 'border-amber-500/40', text: 'text-amber-400', bg: 'bg-amber-500/20', icon: 'fa-circle-exclamation', badge: 'VERIFICA NECESSARIA', title: 'Identificazione incompleta', desc: 'Conferma marca, modello e colori prima di decidere.' };
      } else if (exactMatches.length > 0) {
        status = {
          border: 'border-red-500/40',
          text: 'text-red-400',
          bg: 'bg-red-500/20',
          icon: 'fa-triangle-exclamation',
          badge: 'SCARPA GIÀ PRESENTE',
          title: 'Ce l\'hai già nel tuo armadio!',
          desc: 'Marca, modello e colori coincidono con una scarpa già memorizzata.'
        };
      } else if (highSimilarity.length > 0 || mediumSimilarity.length > 0) {
        status = {
          border: 'border-amber-500/40',
          text: 'text-amber-400',
          bg: 'bg-amber-500/20',
          icon: 'fa-circle-exclamation',
          badge: 'POSSIBILI CORRISPONDENZE',
          title: 'Hai già scarpe simili nell’archivio',
          desc: 'Sono presenti somiglianze nei dati o nelle fotografie. Controlla le corrispondenze prima di salvare.'
        };
      }

      const allMatches = [...exactMatches, ...highSimilarity, ...mediumSimilarity];
      const sideBySide=allMatches.length?renderSideBySideComparison(candidate,allMatches[0].shoe):'';
      const incomplete = !candidateBrand || !candidateModel || candidateColors.length === 0;
      const canSave = Boolean(imagesByMode.check);
      const saveLevel = incomplete ? 'similar' : exactMatches.length ? 'identical' : (highSimilarity.length || mediumSimilarity.length ? 'similar' : 'new');
      const saveButtonClass = saveLevel === 'identical'
        ? 'bg-red-600 hover:bg-red-500 text-white'
        : saveLevel === 'similar'
          ? 'bg-orange-500 hover:bg-orange-400 text-slate-950'
          : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950';
      const saveButtonText = 'Memorizza';
      if (canSave) lastCheckedCandidate = { ...candidate, image: imagesByMode.check };
      else lastCheckedCandidate = null;

      container.innerHTML = `
        <div class="bg-slate-900 border ${status.border} rounded-2xl p-4 shadow-xl">
          <div class="flex items-start gap-3">
            <div class="w-10 h-10 rounded-xl ${status.bg} ${status.text} flex items-center justify-center text-xl shrink-0">
              <i class="fa-solid ${status.icon}"></i>
            </div>
            <div>
              <span class="text-[10px] font-black uppercase tracking-wider ${status.text}">${status.badge}</span>
              <h3 class="text-sm font-bold text-slate-100">${status.title}</h3>
              <p class="text-xs text-slate-400 mt-0.5">${status.desc}</p>
            </div>
          </div>

          <div class="mt-4 p-3 bg-slate-950 rounded-xl border border-slate-800">
            <p class="text-[10px] text-slate-500 uppercase font-semibold">Scarpa valutata</p>
            <p class="text-xs font-bold text-slate-200">${escapeHtml(candidate.brand || 'Marca n.d.')} - ${escapeHtml(candidate.model || 'Modello n.d.')}</p>
            <p class="text-[11px] text-amber-400">Colori: ${escapeHtml(candColors.join(', ') || 'n.d.')}</p>
            <p class="text-[11px] text-slate-300">SKU: ${escapeHtml(candidateSku || 'non rilevato')}</p>
            <p class="text-[11px] text-slate-400 mt-1">Verifica incrociata: SKU, marca, modello, colori e fotografie. La somiglianza visiva da sola non prova un doppione.</p>
          </div>

          ${canSave ? `
            <button type="button" onclick="addComparedShoe()" class="mt-4 w-full min-h-12 rounded-xl ${saveButtonClass} font-bold text-sm flex items-center justify-center gap-2 transition">
              <i class="fa-solid fa-plus"></i> Aggiungi all’armadio
            </button>
            <p class="mt-2 text-[11px] text-slate-400 text-center">${incomplete ? 'Completa i dati nella schermata successiva. La foto sarà già inserita.' : saveLevel === 'identical' ? 'Scarpa già presente: per salvare un altro paio identico verrà richiesta conferma.' : saveLevel === 'similar' ? 'Sono presenti scarpe simili: puoi aggiungere comunque questa colorazione o modello.' : 'La foto verrà trasferita automaticamente al modulo di inserimento.'}</p>
          ` : ''}

          ${sideBySide}
          ${allMatches.length > 0 ? `
            <div class="mt-4 pt-3 border-t border-slate-800 space-y-2">
              <p class="text-xs font-semibold text-slate-300">Confronto con le tue scarpe:</p>
              ${allMatches.map(m => `
                <div class="flex items-center gap-3 p-2 bg-slate-950/70 border border-slate-800 rounded-xl">
                  <img src="${safeShoeImageUrl(m.shoe.image)}" class="w-12 h-12 object-cover rounded-lg border border-slate-800 shrink-0">
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-bold text-slate-200 truncate">${escapeHtml(m.shoe.brand)} ${escapeHtml(m.shoe.model)}</p>
                    <p class="text-[11px] text-amber-300/90 truncate">${escapeHtml(m.reason)}</p>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    function openApiKeyModal() {
      document.getElementById('apiKeyInput').value = archivioMasterCore.readGeminiKey() || '';
      document.getElementById('apiKeyInput').type = 'password';
      document.getElementById('toggleApiKeyBtn').setAttribute('aria-pressed', 'false');
      document.getElementById('toggleApiKeyBtn').setAttribute('aria-label', 'Mostra chiave API');
      document.getElementById('apiKeyEyeIcon').className = 'fa-solid fa-eye';
      document.getElementById('apiKeyModal').classList.remove('hidden');
    }
    function toggleApiKeyVisibility() {
      const input = document.getElementById('apiKeyInput');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      document.getElementById('toggleApiKeyBtn').setAttribute('aria-pressed', String(visible));
      document.getElementById('toggleApiKeyBtn').setAttribute('aria-label', visible ? 'Nascondi chiave API' : 'Mostra chiave API');
      document.getElementById('apiKeyEyeIcon').className = visible ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }
    function closeApiKeyModal() { document.getElementById('apiKeyModal').classList.add('hidden'); }
    function saveApiKey() {
      const key = document.getElementById('apiKeyInput').value.trim();
      if (!key) {
        alert("Inserisci una chiave valida.");
        return;
      }
      archivioMasterCore.storeGeminiKey(key);
      updateKeyUI();
      closeApiKeyModal();
    }
    async function testAiConnection() {
      const key = document.getElementById('apiKeyInput').value.trim() || archivioMasterCore.readGeminiKey();
      const output = document.getElementById('aiTestResult');
      const button = document.getElementById('testAiBtn');
      output.classList.remove('hidden');
      output.textContent = 'Verifica della chiave e dei modelli in corso...';
      if (!key) { output.textContent = 'Inserisci prima una chiave API.'; return; }
      button.disabled = true;
      try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': key } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Errore HTTP ' + response.status);
        const models = (data.models || []).filter(m =>
          (m.supportedGenerationMethods || []).includes('generateContent') &&
          /gemini/i.test(m.name || '') &&
          !/embedding|tts|audio|image-generation|robotics|live|preview|image|transcribe|computer-use|nano-banana|omni/i.test(m.name || '')
        );
        if (!models.length) { output.textContent = 'Chiave accettata, ma nessun modello Gemini compatibile con generateContent.'; return; }
        output.textContent = 'Chiave accettata. Modelli candidati:\n' + models.map(m => '• ' + m.name.replace('models/', '')).join('\n') + '\n\nVerifica generazione e comprensione immagini...';
        // Pixel PNG 1x1 di prova: controlla la capacità di elaborare un input immagine.
        const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mXcAAAAASUVORK5CYII=';
        let errors = [];
        let working = '';
        for (const m of models.slice(0, 6)) {
          const test = await fetch('https://generativelanguage.googleapis.com/v1beta/' + m.name + ':generateContent', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'Descrivi brevemente questa immagine.' }, { inlineData: { mimeType: 'image/png', data: tinyPng } }] }], generationConfig: { maxOutputTokens: 60 } })
          });
          const result = await test.json();
          if (test.ok && (result.candidates || []).some(c => (c.content?.parts || []).some(p => typeof p.text === 'string' && p.text.trim()))) { working = m.name.replace('models/', ''); sessionStorage.setItem('kicks_gemini_last_success', working); break; }
          errors.push(m.name.replace('models/', '') + ': ' + (result.error?.message || 'Risposta senza contenuto').slice(0, 130));
        }
        output.textContent = working
          ? 'Connessione e analisi immagini riuscite.\nModello funzionante: ' + working + '\n\nPuoi riprovare a fotografare la scatola.'
          : 'Chiave riconosciuta, ma nessun modello ha superato il test immagini.\n' + errors.join('\n');
      } catch (error) {
        output.textContent = 'Test non riuscito: ' + error.message;
      } finally { button.disabled = false; }
    }
    function clearApiKey() {
      archivioMasterCore.storeGeminiKey('');
      localStorage.removeItem('gemini_account_email');
      document.getElementById('apiKeyInput').value = '';
      updateKeyUI();
      closeApiKeyModal();
    }
    function updateKeyUI() {
      const key = archivioMasterCore.readGeminiKey();
      const label = document.getElementById('keyLabel');
      const btn = document.getElementById('keyStatusBtn');
      updatePhotoAiStatus();
      if (key) {
        label.textContent = 'AI Attiva';
        btn.classList.add('text-emerald-400', 'border-emerald-500/40');
        btn.classList.remove('text-amber-400');
      } else {
        label.textContent = 'Imposta AI';
        btn.classList.remove('text-emerald-400', 'border-emerald-500/40');
        btn.classList.add('text-amber-400');
      }
    }
