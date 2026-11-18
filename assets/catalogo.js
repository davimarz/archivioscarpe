(function () {
  'use strict';

  // GitHub Pages supports byte ranges. Decode in order so UTF-8 characters
  // and JSON strings can span two network blocks.
  function openAwinCatalog(url, fetchBlock = fetch, blockSize = 32768) {
    let offset = 0;
    let etag;
    let total;
    let ended = false;
    let decoder = new TextDecoder('utf-8', { fatal: true });
    let partial = '';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let started = false;
    let closed = false;

    function readRows(text) {
      const rows = [];
      for (const character of text) {
        if (depth === 0) {
          if (/\s/.test(character)) continue;
          if (!started && character === '[') { started = true; continue; }
          if (started && !closed && character === ']') { closed = true; continue; }
          if (started && !closed && character === ',') continue;
          if (!started || closed || character !== '{') throw new Error('Catalogo non valido');
          partial = '{';
          depth = 1;
          continue;
        }
        partial += character;
        if (escaped) escaped = false;
        else if (quoted && character === '\\') escaped = true;
        else if (character === '"') quoted = !quoted;
        else if (!quoted && character === '{') depth++;
        else if (!quoted && character === '}' && --depth === 0) {
          rows.push(JSON.parse(partial));
          partial = '';
        }
      }
      return rows;
    }

    return {
      get ended() { return ended; },
      async next() {
        if (ended) return [];
        const headers = { Range: 'bytes=' + offset + '-' + (offset + blockSize - 1) };
        if (etag && !etag.startsWith('W/')) headers['If-Range'] = etag;
        const response = await fetchBlock(url, { headers, cache: 'no-cache', signal: AbortSignal.timeout(12000) });
        if (response.status === 200 && offset === 0) {
          const rows = await response.json();
          if (!Array.isArray(rows)) throw new Error('Catalogo non valido');
          ended = true;
          return rows;
        }
        const interval = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        const nextEtag = response.headers.get('ETag');
        if (response.status !== 206 || !interval || Number(interval[1]) !== offset ||
            (offset && (etag !== nextEtag || total !== Number(interval[3])))) {
          await response.body?.cancel();
          throw new Error('Catalogo cambiato o non disponibile. Ricarica la pagina.');
        }
        const bytes = await response.arrayBuffer();
        const nextOffset = Number(interval[2]) + 1;
        const nextTotal = Number(interval[3]);
        if (nextOffset - offset !== bytes.byteLength || !bytes.byteLength || nextOffset > nextTotal) {
          throw new Error('Blocco di catalogo incompleto');
        }
        const last = nextOffset === nextTotal;
        const rows = readRows(decoder.decode(bytes, { stream: !last }));
        if (last && (!closed || depth)) throw new Error('Catalogo incompleto');
        etag = nextEtag;
        total = nextTotal;
        offset = nextOffset;
        ended = last;
        return rows;
      }
    };
  }

  const liveCatalogUrl = 'https://davimarz.github.io/archivioscarpe/catalogo-awin.json';

  async function loadCurrentAwinCatalog() {
    for (const [url, origin] of [[liveCatalogUrl, 'online'], ['./catalogo-awin.json', 'snapshot']]) {
      try {
        const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(10000) });
        if (!response.ok) continue;
        const products = await response.json();
        if (Array.isArray(products) && products.some(product =>
          typeof product?.name === 'string' && typeof product.url === 'string')) return { products, origin };
      } catch {
        // If the online feed is unavailable, use the verified copy included with the site.
      }
    }
    throw Error('Catalogo Awin temporaneamente non disponibile.');
  }

  function shuffleProducts(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function openIndexedAwinCatalog(url, indexUrl, fetchBlock = fetch) {
    const bands = ['low', 'mid', 'high'];
    const sequential = openAwinCatalog(url, fetchBlock);
    let state;
    function request(start, end, etag) {
      const headers = { Range: 'bytes=' + start + '-' + (end - 1) };
      if (etag) headers['If-Range'] = etag;
      return fetchBlock(url, { headers, cache: 'no-cache', signal: AbortSignal.timeout(12000) });
    }
    async function setup() {
      try {
        if (!globalThis.crypto?.subtle) return null;
        const indexResponse = await fetchBlock(indexUrl, { cache: 'no-cache', signal: AbortSignal.timeout(5000) });
        if (!indexResponse.ok) return null;
        const index = await indexResponse.json();
        const prefix = await request(0, Math.min(index.size, 1024));
        const etag = prefix.headers.get('ETag');
        if (prefix.status !== 206 || !etag || etag.startsWith('W/') ||
            prefix.headers.get('Content-Range') !== 'bytes 0-' + (Math.min(index.size, 1024) - 1) + '/' + index.size) {
          await prefix.body?.cancel();
          return null;
        }
        const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await prefix.arrayBuffer()))]
          .map(n => n.toString(16).padStart(2, '0')).join('');
        if (fingerprint !== index.head) return null;
        const ranges = Object.fromEntries(bands.map(band => {
          const ordered = index.ranges[band];
          if (!Array.isArray(ordered) || ordered.some(range => !Array.isArray(range) || range.length !== 2 ||
              !range.every(Number.isSafeInteger) || range[0] < 1 || range[1] <= range[0] || range[1] > index.size)) {
            throw new Error('Indice non valido');
          }
          const offset = Math.floor(Math.random() * ordered.length);
          return [band, [...ordered.slice(offset), ...ordered.slice(0, offset)]];
        }));
        return { size: index.size, etag, ranges, started: new Set() };
      } catch {
        return null;
      }
    }
    return {
      ended(keys = bands) {
        return state ? keys.every(key => state.ranges[key].length === 0) : sequential.ended;
      },
      async next(keys = bands) {
        if (state === undefined) state = await setup();
        if (!state) return shuffleProducts(await sequential.next());
        const pending = keys.filter(key => state.ranges[key].length).map(key => {
          const choices = state.ranges[key];
          return { key, slots: !state.started.has(key) && choices.length > 1 ? [0, Math.floor(choices.length / 2)] : [0] };
        });
        const parts = await Promise.all(pending.flatMap(({ key, slots }) => slots.map(async slot => {
          const [start, end] = state.ranges[key][slot];
          const response = await request(start, end, state.etag);
          if (response.status !== 206 || response.headers.get('ETag') !== state.etag ||
              response.headers.get('Content-Range') !== 'bytes ' + start + '-' + (end - 1) + '/' + state.size) {
            await response.body?.cancel();
            throw new Error('Catalogo cambiato o non disponibile. Ricarica la pagina.');
          }
          return shuffleProducts(JSON.parse('[' + await response.text() + ']'));
        })));
        for (const { key, slots } of pending) {
          for (const slot of [...slots].reverse()) state.ranges[key].splice(slot, 1);
          state.started.add(key);
        }
        const rows = [];
        const length = Math.max(0, ...parts.map(part => part.length));
        for (let i = 0; i < length; i++) {
          for (const part of parts) if (i < part.length) rows.push(part[i]);
        }
        return rows;
      }
    };
  }

  function promotionProductKeys(product) {
    const normalize = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const parts = product.name.split(/\s+[-–—|]\s+/);
    const size = normalize(product.size);
    const last = normalize(parts.at(-1));
    if (parts.length > 1 && ((size && last === size) ||
      /^(?:taglia\s+|eu\s+|uk\s+|us\s+)\d{1,2}(?:\s+\d{1,2})?$/.test(last) ||
      /^(?:[1-6]\d(?:\s+\d{1,2})?|xxs|xs|s|m|l|xl|xxl|os)$/.test(last))) parts.pop();
    const brand = normalize(product.brand);
    const color = normalize(product.color);
    const title = normalize(parts.join(' '));
    const keys = [JSON.stringify(['title', title, color])];
    const model = normalize(product.model);
    if (brand && color && model && !/^\d{8,14}$/.test(model)) {
      keys.push(JSON.stringify(['model', brand, model, color]));
    }
    return keys;
  }

  function nextPromotionPage(bands, positions, filter, ended) {
    const keys = filter === 'all' ? ['low', 'mid', 'high'] : [filter];
    const take = filter === 'all' ? 2 : 6;
    if (!ended && keys.some(key => bands[key].length < positions[key] + take)) return null;

    const next = { ...positions };
    const items = [];
    for (const key of keys) {
      const group = bands[key].slice(next[key], next[key] + take);
      next[key] += group.length;
      items.push(...group);
    }
    for (const key of keys) {
      if (items.length >= 6) break;
      const extra = bands[key].slice(next[key], next[key] + 6 - items.length);
      next[key] += extra.length;
      items.push(...extra);
    }
    return { items, positions: next, hasMore: !ended || keys.some(key => next[key] < bands[key].length) };
  }

  const promotionRoutes = { all: '#promozioni', low: '#promozioni/sotto-50',
    mid: '#promozioni/50-150', midLower: '#promozioni/50-100', midUpper: '#promozioni/100-150', high: '#promozioni/oltre-150' };

  function promotionBandFromHash(hash) {
    return Object.keys(promotionRoutes).find(band => promotionRoutes[band] === hash);
  }

  function instagramCampaign(value) {
    const slug = (value || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(slug) ? slug : '';
  }

  const api = { loadCurrentAwinCatalog, openAwinCatalog, openIndexedAwinCatalog, nextPromotionPage, promotionProductKeys, promotionRoutes, promotionBandFromHash, instagramCampaign, shuffleProducts };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.awinCatalog = api;
})();
