    const lastAppEvent = new Map();
    (async () => { // data-awin-import
      const normalize = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
      const numericPrice = product => {
        const raw = String(product.price || '').replace(/[^\d,.]/g, '');
        const decimal = raw.lastIndexOf(',') > raw.lastIndexOf('.')
          ? raw.replace(/\./g, '').replace(',', '.')
          : raw.replace(/,/g, '');
        const value = Number(decimal);
        return Number.isFinite(value) && value > 0 ? value : Infinity;
      };
      // Prezzi promozionali: il solo prezzo attuale non dimostra uno sconto.
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
        const merchant = normalize(product.merchant);
        // Compatibilità con i listini già pubblicati: RRP confermato come barrato.
        const upcourtDirectVolley = merchant === 'direct volley it' &&
          /\bupcourt 6 gs\b/.test(normalize(product.name));
        if (merchant === 'marco cerullo' || upcourtDirectVolley) {
          return readMoney(product.referencePrice);
        }
        return NaN;
      };
      const discountFor = product => {
        const current = numericPrice(product);
        const original = originalPriceOf(product);
        if (!Number.isFinite(current) || !Number.isFinite(original) || original <= current) return null;
        const percent = Math.round((original - current) / original * 100);
        return percent >= 1 && percent <= 99 ? { original, current, percent } : null;
      };
      const compareOfferPriority = (a, b) =>
        (discountFor(b)?.percent || 0) - (discountFor(a)?.percent || 0);
      const euroFormatter = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
      const formatEuro = amount => euroFormatter.format(amount);
      const disabledMerchants = new Set(['voghion global', 'goicon global']);
      const bands = { low: [], mid: [], high: [] };
      let catalogLoaded = false;
      const catalog = {
        ended: () => catalogLoaded,
        async next() {
          if (catalogLoaded) return [];
          const { products } = await awinCatalog.loadCurrentAwinCatalog();
          catalogLoaded = true;
          return awinCatalog.shuffleProducts(products).sort(compareOfferPriority);
        }
      };
      const seen = new Set();
      let nextBlock;
      function readNextBlock(keys) {
        if (!nextBlock) {
          nextBlock = catalog.next(keys).then(items => {
            for (const product of items) {
              if (!product || typeof product.name !== 'string' || typeof product.merchant !== 'string' ||
                  !/^https:\/\//i.test(product.url) || !/^https:\/\//i.test(product.image) ||
                  disabledMerchants.has(normalize(product.merchant))) continue;
              const amount = numericPrice(product);
              if (!Number.isFinite(amount)) continue;
              const productKeys = awinCatalog.promotionProductKeys(product);
              if (productKeys.some(key => seen.has(key))) continue;
              productKeys.forEach(key => seen.add(key));
              bands[amount < 50 ? 'low' : amount <= 150 ? 'mid' : 'high'].push(product);
            }
          }).finally(() => { nextBlock = null; });
        }
        return nextBlock;
      }
      async function readUntil(ready, keys) {
        while (!ready(catalog.ended(keys)) && !catalog.ended(keys)) await readNextBlock(keys);
      }

      const slot = document.getElementById('cisalfaProducts');
      if (!slot) return;
      let discountedBannerPool = [];
      let bannerProducts = [];
      let pageCount = 0;
      const bannerProduct = index => bannerProducts[(index % pageCount + pageCount) % pageCount];
      let page = 0;
      function offerPhotoBounds(pixels, width, height) {
        let left = width, right = -1, top = height, bottom = -1;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (pixels[i + 3] < 16 || Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >= 253) continue;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }

        if (right < left || bottom < top) return null;
        const inset = Math.max(2, Math.ceil(Math.max(right - left + 1, bottom - top + 1) * 0.04));
        const cropLeft = Math.max(0, left - inset);
        const cropTop = Math.max(0, top - inset);
        const cropWidth = Math.min(width, right + 1 + inset) - cropLeft;
        const cropHeight = Math.min(height, bottom + 1 + inset) - cropTop;
        if (cropWidth < width * 0.18 || cropHeight < height * 0.18 ||
            (cropWidth >= width * 0.9 && cropHeight >= height * 0.9)) return null;
        return { x: cropLeft, y: cropTop, width: cropWidth, height: cropHeight };
      }

      async function trimOfferPhoto(img, photoFrame) {
        if (!img.isConnected || !img.naturalWidth || !img.naturalHeight) return;
        const source = new Image();
        source.crossOrigin = 'anonymous';
        source.src = img.currentSrc || img.src;
        try {
          await source.decode();
          if (!img.isConnected) return;
          const scale = Math.min(1, 640 / Math.max(source.naturalWidth, source.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          // Sample the original perimeter before cropping so letterboxing blends into the photo.
          const edgeColors = new Map();
          let samples = 0;
          for (let step = 0; step < 32; step++) {
            const x = Math.round(step * (pixels.width - 1) / 31);
            const y = Math.round(step * (pixels.height - 1) / 31);
            for (const offset of [x, (pixels.height - 1) * pixels.width + x, y * pixels.width, y * pixels.width + pixels.width - 1]) {
              samples++;
              const i = offset * 4;
              const [r, g, b, alpha] = pixels.data.subarray(i, i + 4);
              if (alpha < 250 || Math.min(r, g, b) < 225 || Math.max(r, g, b) - Math.min(r, g, b) > 14) continue;
              const bucket = [r, g, b].map(channel => Math.floor(channel / 4)).join(',');
              const color = edgeColors.get(bucket) || { count: 0, r: 0, g: 0, b: 0 };
              color.count++;
              color.r += r;
              color.g += g;
              color.b += b;
              edgeColors.set(bucket, color);
            }
          }
          const background = [...edgeColors.values()].sort((a, b) => b.count - a.count)[0];
          if (background && background.count >= samples / 2) {
            const rgb = [background.r, background.g, background.b].map(total => Math.round(total / background.count));
            photoFrame.style.backgroundColor = `rgb(${rgb.join(', ')})`;
          }
          const crop = offerPhotoBounds(pixels.data, pixels.width, pixels.height);
          if (!crop) return;

          const thumbnail = document.createElement('canvas');
          thumbnail.width = crop.width;
          thumbnail.height = crop.height;
          const output = thumbnail.getContext('2d');
          if (!output) return;
          output.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
          img.src = thumbnail.toDataURL('image/webp', 0.9);
        } catch {
          // Merchants can disallow access to image pixels. Keep their original.
        }
      }

      const safeOfferUrl = value => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
        } catch { return ''; }
      };
      const createCard = (product, showAction = false) => {
        const card = document.createElement('a');
        card.href = safeOfferUrl(product.url) || '#';
        if (card.href !== '#') {
          const affiliateUrl = new URL(card.href);
          if (['www.awin1.com', 'awin1.com'].includes(affiliateUrl.hostname) &&
              (affiliateUrl.searchParams.get('a') === '3150312' || affiliateUrl.searchParams.get('awinaffid') === '3150312')) {
            affiliateUrl.searchParams.set('clickref6', 'archivioscarpe');
            const tracking = new URLSearchParams(location.search);
            const source = /^(instagram|facebook|tiktok)$/i.test(tracking.get('utm_source') || '')
              ? tracking.get('utm_source').toLowerCase() : '';
            const campaign = awinCatalog.instagramCampaign(tracking.get('utm_campaign'));
            if (source) affiliateUrl.searchParams.set('clickref4', source);
            if (campaign) affiliateUrl.searchParams.set('clickref5', campaign);
            card.href = affiliateUrl.href;
          }
        }
        card.dataset.productUrl = product.url;
        card.dataset.merchant = String(product.merchant || '').slice(0, 120);
        card.dataset.productId = String(product.gtin || product.model || product.name || '').slice(0, 120);
        card.dataset.productName = String(product.name || '').slice(0, 240);
        card.target = '_blank';
        card.rel = 'sponsored noopener noreferrer';
        card.className = 'cisalfa-product-card';
        const photoFrame = document.createElement('div');
        photoFrame.className = 'product-photo-frame';
        const img = document.createElement('img');
        img.src = safeOfferUrl(product.image);
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('load', () => { void trimOfferPhoto(img, photoFrame); }, { once: true });
        img.addEventListener('error', () => {
          const placeholder = document.createElement('div');
          placeholder.className = 'h-full grid place-items-center p-2 text-center text-xs text-slate-600';
          placeholder.textContent = 'Foto non disponibile';
          img.replaceWith(placeholder);
        }, { once: true });
        const name = document.createElement('span');
        name.className = 'cisalfa-product-name';
        name.textContent = product.name;
        const price = document.createElement('strong');
        price.className = 'cisalfa-product-price';
        price.textContent = product.price + ' €';
        const merchant = document.createElement('span');
        merchant.className = 'text-[10px] font-semibold';
        merchant.textContent = product.merchant;
        // data-awin-variant-note
        const details = [];
        if (product.color) details.push('Colore: ' + product.color);
        if (product.size) details.push('Taglia: ' + product.size);
        const options = [];
        if (product.colorCount > 1) options.push(product.colorCount + ' colori');
        if (product.sizeCount > 1) options.push(product.sizeCount + ' taglie');
        const offer = discountFor(product);
        const discountBadge = document.createElement('span');
        discountBadge.className = 'awin-discount-badge';
        if (offer) discountBadge.textContent = '−' + offer.percent + '%';
        const previous = document.createElement('del');
        previous.className = 'awin-original-price';
        if (offer) previous.textContent = formatEuro(offer.original);
        price.textContent = formatEuro(offer ? offer.current : numericPrice(product));
        photoFrame.append(img);
        card.append(photoFrame, merchant);
        if (offer) {
          card.classList.add('has-verified-discount');
          discountBadge.setAttribute('aria-label', 'Sconto del ' + offer.percent + ' per cento');
          card.append(discountBadge);
        }
        card.append(name);
        const prices = document.createElement('div');
        prices.className = 'offer-prices';
        if (offer) prices.append(previous);
        prices.append(price);
        card.append(prices);
        if (details.length || options.length) {
          const note = document.createElement('small');
          note.className = 'text-[11px] offer-details';
          note.textContent = [...details, options.length ? options.join(' e ') + ' nel listino' : ''].filter(Boolean).join(' · ');
          card.append(note);
        }
        if (showAction) {
          const action = document.createElement('span');
          action.className = 'offer-cta';
          action.textContent = 'Vedi l’offerta';
          card.append(action);
          card.setAttribute('aria-label', product.name + ' · ' + formatEuro(numericPrice(product)) + ' · Vedi l’offerta da ' + product.merchant);
        }
        return card;
      };
      const render = () => {
        const slide = index => {
          const group = document.createElement('div');
          group.className = 'banner-slide';
          group.append(createCard(bannerProduct(index)));
          return group;
        };
        slot.replaceChildren(...Array.from({ length: pageCount === 1 ? 1 : 3 }, (_, offset) => slide(page + offset)));
      };
      let touchStart;
      const rotationButton = document.getElementById('bannerRotationButton');
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
      let rotationPaused = reducedMotion.matches;
      let slideTimer = null;
      let slideAnimation = null;
      function updateRotationButton() {
        rotationButton.textContent = rotationPaused ? 'Riprendi rotazione' : 'Pausa rotazione';
        rotationButton.setAttribute('aria-pressed', String(rotationPaused));
      }
      const canRotate = () => !rotationPaused && pageCount > 1 && !document.hidden &&
        slot.getClientRects().length && !touchStart && !slot.querySelector(':focus-visible') && !slot.matches(':focus-visible') &&
        !(window.matchMedia('(hover: hover)').matches && slot.matches(':hover'));
      const scheduleRotation = () => {
        clearTimeout(slideTimer);
        if (!canRotate()) {
          slideAnimation?.pause();
          return;
        }
        if (slideAnimation) {
          slideAnimation.play();
          return;
        }
        slideTimer = setTimeout(() => {
        if (!canRotate()) return;
        slideAnimation = slot.animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(-33.333333%)' }],
          { duration: 3000, easing: 'linear', fill: 'forwards' }
        );
        slideAnimation.onfinish = () => {
          const finished = slideAnimation;
          slideAnimation = null;
          finished?.cancel();
          page = (page + 1) % pageCount;
          render();
          scheduleRotation();
        };
        }, 3500);
      };
      reducedMotion.addEventListener('change', () => {
        rotationPaused = reducedMotion.matches;
        updateRotationButton();
        if (rotationPaused) { slideAnimation?.cancel(); slideAnimation = null; }
        scheduleRotation();
      });
      document.getElementById('bannerNext').addEventListener('click', () => moveBanner(1));
      const moveBanner = direction => {
        if (pageCount < 2) return;
        slideAnimation?.cancel();
        slideAnimation = null;
        page = (page + direction + pageCount) % pageCount;
        render();
        scheduleRotation();
      };
      slot.addEventListener('keydown', event => {
        if (event.target !== slot || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        moveBanner(event.key === 'ArrowRight' ? 1 : -1);
      });
      slot.addEventListener('touchstart', event => {
        touchStart = event.touches.length === 1 ? event.touches[0] : null;
        scheduleRotation();
      }, { passive: true });
      slot.addEventListener('touchcancel', () => { touchStart = null; scheduleRotation(); });
      slot.addEventListener('touchend', event => {
        const start = touchStart;
        touchStart = null;
        const end = event.changedTouches[0];
        if (!start || !end || start.identifier !== end.identifier || event.touches.length) {
          scheduleRotation();
          return;
        }
        const dx = end.clientX - start.clientX;
        const dy = end.clientY - start.clientY;
        if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          event.preventDefault();
          moveBanner(dx < 0 ? 1 : -1);
        } else scheduleRotation();
      }, { passive: false });
      slot.addEventListener('mouseenter', scheduleRotation);
      slot.addEventListener('mouseleave', scheduleRotation);
      slot.addEventListener('focusin', scheduleRotation);
      slot.addEventListener('focusout', () => requestAnimationFrame(scheduleRotation));
      document.addEventListener('visibilitychange', scheduleRotation);
      document.addEventListener('archive-open', refreshBanner);
      if (rotationButton) {
        updateRotationButton();
        rotationButton.addEventListener('click', () => {
          rotationPaused = !rotationPaused;
          updateRotationButton();
          scheduleRotation();
        });
      }
      function refreshBanner() {
        if (!discountedBannerPool.length) return;
        slideAnimation?.cancel();
        slideAnimation = null;
        const lower = awinCatalog.shuffleProducts(discountedBannerPool.filter(product => numericPrice(product) < 50));
        const upper = awinCatalog.shuffleProducts(discountedBannerPool.filter(product => numericPrice(product) >= 50));
        const pairs = Math.min(lower.length, upper.length, 12);
        bannerProducts = pairs
          ? lower.slice(0, pairs).flatMap((product, index) => [product, upper[index]])
          : (lower.length ? lower : upper).slice(0, 24);
        pageCount = bannerProducts.length;
        page = 0;
        render();
        slot.closest('aside').classList.remove('hidden');
        document.getElementById('bannerNext').hidden = pageCount < 2;
        if (rotationButton) rotationButton.hidden = pageCount < 2;
        scheduleRotation();
      }
      readUntil(ended => ended).then(() => {
        discountedBannerPool = [...bands.low, ...bands.mid, ...bands.high].filter(discountFor);
        refreshBanner();
      }).catch(() => slot.closest('aside').classList.add('hidden'));

      const grid = document.getElementById('promotionsGrid');
      const status = document.getElementById('promotionsStatus');
      const more = document.getElementById('promotionsMore');
      const pageNavs = [document.getElementById('promotionsPages')];
      const brandSelect = document.getElementById('promotionsBrand');
      const sortSelect = document.getElementById('promotionsSort');
      const searchInput = document.getElementById('promotionsSearch');
      const sizeSelect = document.getElementById('promotionsSize');
      const typeSelect = document.getElementById('promotionsType');
      const audienceSelect = document.getElementById('promotionsAudience');
      const resetButton = document.getElementById('promotionsReset');
      const brandAliases = new Map([
        ['hoka one one', 'hoka'], ['hey dude', 'heydude'], ['birkestock', 'birkenstock']
      ]);
      const brandLabels = new Map([
        ['hoka', 'HOKA'], ['heydude', 'HEYDUDE'], ['birkenstock', 'Birkenstock']
      ]);
      const canonicalBrand = value => {
        const key = normalize(value);
        return brandAliases.get(key) || key;
      };
      const promotionType = product => {
        const title = normalize(product.name);
        if (/\b(sneaker|sneakers|scarpe da ginnastica)\b/.test(title)) return 'Sneakers';
        if (/\b(running|corsa|trail)\b/.test(title)) return 'Running';
        if (/\b(stival\w*|boot\w*|anfibio\w*)\b/.test(title)) return 'Stivali e stivaletti';
        if (/\b(sandal\w*|ciabatt\w*|infradit\w*)\b/.test(title)) return 'Sandali e ciabatte';
        if (/\b(mocassin\w*|loafer\w*)\b/.test(title)) return 'Mocassini';
        if (/\b(decollet\w*|pump\w*|tacchi)\b/.test(title)) return 'Scarpe con tacco';
        return '';
      };
      const promotionAudience = product => {
        const title = normalize(product.name);
        if (/\b(bambin\w*|kids|junior)\b/.test(title)) return 'Bambini';
        if (/\b(donna|women|woman|femminile)\b/.test(title)) return 'Donna';
        if (/\b(uomo|men|man|maschile)\b/.test(title)) return 'Uomo';
        return '';
      };
      function updateSelect(select, labelId, entries, defaultText) {
        const selected = select.value;
        select.replaceChildren(new Option(defaultText, ''), ...entries.map(entry => new Option(entry, entry)));
        select.value = entries.includes(selected) ? selected : '';
        document.getElementById(labelId).hidden = entries.length === 0;
      }
      function diversifyFirstPage(products) {
        const selected = [], used = new Set();
        for (const product of products) {
          const family = product.family || normalize(product.name).replace(/\b(black|white|red|nero|nera|bianco|bianca|rosso|rossa|blu|beige)\b/g, '').trim();
          const key = family || product.url;
          if (used.has(key)) continue;
          used.add(key);
          selected.push(product);
          if (selected.length === 6) break;
        }
        if (selected.length < 6) return products;
        const chosen = new Set(selected);
        return [...selected, ...products.filter(product => !chosen.has(product))];
      }
      const priceFilterButtons = [...document.querySelectorAll('#promotionsPriceFilters [data-price-band]')];
      let activePriceBand = 'all';
      let promotionLoad = 0;
      let visiblePromotions = 6;
      let currentPromotionPage = 1;
      let promotionsReady = false;
      function updatePriceButtons() {
        for (const button of priceFilterButtons) {
          button.setAttribute('aria-pressed', String(button.dataset.priceBand === activePriceBand));
        }
      }
      function promotionPool() {
        const keys = ['all', 'discounted'].includes(activePriceBand) ? ['low', 'mid', 'high'] : [activePriceBand];
        const brand = brandSelect.value;
        const query = normalize(searchInput.value).split(' ').filter(Boolean);
        const products = keys.flatMap(key => bands[key]).filter(product => {
          const searchable = normalize([product.name, product.brand, product.model, product.color].join(' '));
          return (!brand || canonicalBrand(product.brand) === brand) &&
            (!sizeSelect.value || String(product.size || '').trim().replace(',', '.') === sizeSelect.value) &&
            (!typeSelect.value || promotionType(product) === typeSelect.value) &&
            (!audienceSelect.value || promotionAudience(product) === audienceSelect.value) &&
            (activePriceBand !== 'discounted' || Boolean(discountFor(product))) &&
            query.every(word => searchable.includes(word));
        });
        if (sortSelect.value === 'discount') {
          return diversifyFirstPage(products.sort((a, b) => compareOfferPriority(a, b) || numericPrice(a) - numericPrice(b)));
        }
        if (sortSelect.value === 'price-asc') return diversifyFirstPage(products.sort((a, b) => numericPrice(a) - numericPrice(b)));
        if (sortSelect.value === 'price-desc') return diversifyFirstPage(products.sort((a, b) => numericPrice(b) - numericPrice(a)));
        return products;
      }
      function populatePromotionFilters() {
        const products = Object.values(bands).flat();
        const names = new Map();
        for (const product of products) {
          const key = canonicalBrand(product.brand);
          if (!key || names.has(key)) continue;
          names.set(key, brandLabels.get(key) || String(product.brand).trim());
        }
        const selected = brandSelect.value;
        brandSelect.replaceChildren(new Option('Tutte le marche', ''),
          ...[...names].sort((a, b) => a[1].localeCompare(b[1], 'it', { sensitivity: 'base' }))
            .map(([key, name]) => new Option(name, key)));
        brandSelect.value = names.has(selected) ? selected : '';
        const values = field => [...new Set(products.map(field).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' }));
        updateSelect(sizeSelect, 'promotionsSizeLabel', values(product => { const size = String(product.size || '').trim(); return /^(3[0-9]|4[0-9]|50)(?:[.,]5)?$/.test(size) ? size.replace(',', '.') : ''; }), 'Tutti i numeri');
        updateSelect(typeSelect, 'promotionsTypeLabel', values(promotionType), 'Tutte le tipologie');
        updateSelect(audienceSelect, 'promotionsAudienceLabel', values(promotionAudience), 'Tutti');
      }
      function renderPageNavigation(total) {
        const loadedPages = Math.ceil(Math.min(visiblePromotions, total) / 6);
        const totalPages = Math.ceil(total / 6);
        for (const nav of pageNavs) {
          nav.hidden = loadedPages < 2;
          nav.replaceChildren();
          if (loadedPages < 2) continue;
          const summary = document.createElement('span');
          summary.className = 'page-summary';
          summary.textContent = 'Pagina ' + currentPromotionPage + ' di ' + totalPages + ' · ' + loadedPages + ' caricate';
          nav.append(summary);
          const pages = new Set([1, loadedPages, currentPromotionPage - 1, currentPromotionPage,
            currentPromotionPage + 1].filter(page => page >= 1 && page <= loadedPages));
          let previous = 0;
          for (const page of [...pages].sort((x, y) => x - y)) {
            if (previous && page - previous > 1) {
              const gap = document.createElement('span');
              gap.textContent = '…';
              gap.setAttribute('aria-hidden', 'true');
              nav.append(gap);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = String(page);
            button.setAttribute('aria-label', 'Vai alla pagina ' + page);
            if (page === currentPromotionPage) button.setAttribute('aria-current', 'page');
            button.addEventListener('click', () => {
              currentPromotionPage = page;
              renderPageNavigation(total);
              nav.querySelector('[aria-current=page]')?.focus({ preventScroll: true });
              grid.querySelector('[data-page-start="' + page + '"]')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
            });
            nav.append(button);
            previous = page;
          }
        }
      }
      const chips = document.getElementById('promotionChips');
      function renderChips() {
        chips.replaceChildren();
        const add = (label, clear) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label + ' ×';
          button.setAttribute('aria-label', 'Rimuovi filtro ' + label);
          button.onclick = () => {
            clear();
            visiblePromotions = 6;
            currentPromotionPage = 1;
            renderPromotions();
            searchInput.focus();
          };
          chips.append(button);
        };
        if (searchInput.value.trim()) add(searchInput.value.trim(), () => { searchInput.value = ''; });
        for (const [control, label] of [[brandSelect, 'Marca'], [sizeSelect, 'Numero'],
          [typeSelect, 'Tipologia'], [audienceSelect, 'Destinatario']]) {
          if (control.value) add(label + ' ' + control.selectedOptions[0].textContent, () => { control.value = ''; });
        }
        if (activePriceBand !== 'all') {
          const current = priceFilterButtons.find(button => button.dataset.priceBand === activePriceBand);
          add(current.textContent, () => {
            history.replaceState(null, '', awinCatalog.promotionRoutes.all);
            activePriceBand = 'all';
            updatePriceButtons();
          });
        }
      }
      let previousPromotionState;
      try { previousPromotionState = JSON.parse(sessionStorage.getItem('promotion-state-v1')); } catch {}
      function rememberPromotions() {
        if (!promotionsReady || document.getElementById('view-promotions').classList.contains('hidden')) return;
        try {
          sessionStorage.setItem('promotion-state-v1', JSON.stringify({
            hash: location.hash, filters: [searchInput, brandSelect, sizeSelect, typeSelect, audienceSelect, sortSelect].map(input => input.value),
            visible: visiblePromotions, page: currentPromotionPage, scroll: window.scrollY
          }));
        } catch {}
      }
      window.addEventListener('pagehide', rememberPromotions);
      grid.addEventListener('click', rememberPromotions);
      grid.addEventListener('auxclick', rememberPromotions);
      function renderPromotions(append = false) {
        const products = promotionPool();
        currentPromotionPage = Math.max(1, Math.min(currentPromotionPage, Math.ceil(Math.min(visiblePromotions, products.length) / 6)));
        const shown = products.slice(0, visiblePromotions);
        if (!append || grid.children.length > shown.length) grid.replaceChildren();
        for (let index = grid.children.length; index < shown.length; index++) {
          const card = createCard(shown[index], true);
          if (index % 6 === 0) card.dataset.pageStart = String(Math.floor(index / 6) + 1);
          grid.append(card);
        }
        resetButton.hidden = activePriceBand === 'all' && !searchInput.value.trim() &&
          !brandSelect.value && !sizeSelect.value && !typeSelect.value && !audienceSelect.value &&
          sortSelect.value === 'discount';
        status.textContent = shown.length
          ? shown.length + ' prodotti su ' + products.length
          : 'Nessun prodotto trovato. Prova altre parole oppure azzera i filtri.';
        rememberPromotions();
        renderChips();
        renderPageNavigation(products.length);
        more.classList.toggle('hidden', shown.length >= products.length);
        more.textContent = 'Mostra altri prodotti';
        more.disabled = false;
      }
      async function preparePromotions() {
        const current = ++promotionLoad;
        status.textContent = 'Caricamento delle promozioni…';
        more.disabled = true;
        try {
          await readUntil(ended => ended);
          if (current !== promotionLoad) return;
          promotionsReady = true;
          populatePromotionFilters();
          const saved = previousPromotionState;
          previousPromotionState = null;
          const restore = saved?.hash === location.hash && Array.isArray(saved.filters);
          if (restore) {
            [searchInput, brandSelect, sizeSelect, typeSelect, audienceSelect, sortSelect].forEach((input, index) => {
              const value = saved.filters[index];
              if (typeof value === 'string' && (!input.options || [...input.options].some(option => option.value === value))) input.value = value;
            });
            visiblePromotions = Math.max(6, Math.min(300, Number(saved.visible) || 6));
            currentPromotionPage = Math.min(Math.ceil(visiblePromotions / 6), Math.max(1, Number(saved.page) || 1));
          }
          renderPromotions();
          if (restore) requestAnimationFrame(() => window.scrollTo({ top: Number(saved.scroll) || 0, behavior: 'instant' }));
        } catch (error) {
          if (current !== promotionLoad) return;
          status.textContent = error.message.startsWith('Catalogo cambiato') ? error.message : 'Catalogo temporaneamente non disponibile.';
          more.textContent = 'Riprova';
          more.classList.remove('hidden');
          more.disabled = false;
        }
      }
      function selectPromotionBand() {
        updatePriceButtons();
        visiblePromotions = 6;
        currentPromotionPage = 1;
        if (promotionsReady) renderPromotions();
        else void preparePromotions();
      }
      function openPromotions() {
        if (promotionsReady) renderPromotions();
        else void preparePromotions();
      }
      function changePromotionBand(band) {
        if (activePriceBand === band && promotionsReady) return;
        activePriceBand = band;
        promotionScroll = 0;
        if (!document.getElementById('view-promotions').classList.contains('hidden')) selectPromotionBand();
        else updatePriceButtons();
      }
      priceFilterButtons.forEach(button => button.addEventListener('click', () => {
        const band = button.dataset.priceBand;
        if (band === activePriceBand) return;
        history.pushState(null, '', awinCatalog.promotionRoutes[band]);
        changePromotionBand(band);
      }));
      let searchTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { visiblePromotions = 6; currentPromotionPage = 1; renderPromotions(); }, 120);
      });
      for (const select of [brandSelect, sizeSelect, typeSelect, audienceSelect]) {
        select.addEventListener('change', () => { visiblePromotions = 6; currentPromotionPage = 1; renderPromotions(); });
      }
      resetButton.addEventListener('click', () => {
        searchInput.value = '';
        for (const select of [brandSelect, sizeSelect, typeSelect, audienceSelect]) select.value = '';
        sortSelect.value = 'discount';
        history.pushState(null, '', awinCatalog.promotionRoutes.all);
        activePriceBand = 'all';
        promotionScroll = 0;
        selectPromotionBand();
        searchInput.focus();
      });
      sortSelect.addEventListener('change', () => { visiblePromotions = 6; currentPromotionPage = 1; renderPromotions(); });
      more.addEventListener('click', () => {
        if (!promotionsReady) { void preparePromotions(); return; }
        visiblePromotions += 6;
        currentPromotionPage = Math.ceil(Math.min(visiblePromotions, promotionPool().length) / 6);
        renderPromotions(true);
        rememberPromotions();
      });
      fetch('./catalogo-awin-report.json', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
        .then(report => {
          if (!report?.updatedAt) return;
          const date = new Date(report.updatedAt);
          if (!Number.isNaN(date.getTime())) document.getElementById('promotionsUpdated').textContent =
            'Listino aggiornato il ' + new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeZone: 'Europe/Rome' }).format(date) + ' · Prezzi rilevati nei listini';
        }).catch(() => {});
      document.addEventListener('promotions-open', openPromotions);
      function openAddress() {
        const band = awinCatalog.promotionBandFromHash(location.hash);
        if (band) {
          changePromotionBand(band);
          switchTab('promotions', false);
        } else if (!document.getElementById('view-promotions').classList.contains('hidden')) {
          switchTab('archive', false);
        }
      }
      window.addEventListener('popstate', openAddress);
      window.addEventListener('hashchange', openAddress);
      openAddress();
    })();

    function appSessionId() {
      const key = 'archivio-scarpe-session';
      try {
        let id = sessionStorage.getItem(key);
        if (!/^[a-f0-9-]{36}$/.test(id || '')) {
          id = crypto.randomUUID();
          sessionStorage.setItem(key, id);
        }
        return id;
      } catch { return crypto.randomUUID(); }
    }
    const analyticsSessionId = appSessionId();
    function recordAppEvent(event_type, dimension, campaign = '', details = {}) {
      if (location.hostname.endsWith('.chatgpt.site') || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
      const key = event_type + ':' + dimension;
      const now = Date.now();
      if (now - (lastAppEvent.get(key) ?? 0) < 1200) return;
      lastAppEvent.set(key, now);
      fetch('https://psjnqiqobidvyljrzjuh.supabase.co/rest/v1/app_events', {
        method: 'POST',
        headers: { apikey: 'sb_publishable_GEV4zSghYUbUbpQeEpeySg__rbHWeZ5', 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ event_type, dimension, session_id: analyticsSessionId,
          ...(campaign && { campaign }), ...details }),
        keepalive: true,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      }).catch(() => {});
    }

    (() => {
      let referrerHost = '';
      try { if (document.referrer) referrerHost = new URL(document.referrer).hostname; } catch {}
      const params = new URLSearchParams(location.search);
      const source = params.get('utm_source') || '';
      const fromInstagram = /^instagram$/i.test(source) || /(?:^|\.)instagram\.com$/i.test(referrerHost);
      const fromFacebook = /^facebook$/i.test(source) || /(?:^|\.)facebook\.com$/i.test(referrerHost) || /(?:^|\.)fb\.com$/i.test(referrerHost);
      const fromTikTok = /^tiktok$/i.test(source) || /(?:^|\.)tiktok\.com$/i.test(referrerHost);
      const channel = fromInstagram ? 'instagram' : fromFacebook ? 'facebook' : fromTikTok ? 'tiktok' : 'other';
      const campaign = channel !== 'other' ? awinCatalog.instagramCampaign(params.get('utm_campaign')) : '';
      recordAppEvent('visit', channel, campaign);
      const recordAffiliateClick = link => recordAppEvent('affiliate_click', 'awin', campaign, {
        source: channel,
        ...(link.dataset.merchant && link.dataset.productId && link.dataset.productName ? {
          merchant: link.dataset.merchant,
          product_id: link.dataset.productId,
          product_name: link.dataset.productName,
        } : {})
      });
      document.addEventListener('click', event => {
        const link = event.target.closest('a[rel~="sponsored"]');
        if (link) recordAffiliateClick(link);
      });
      document.addEventListener('auxclick', event => {
        const link = event.target.closest('a[rel~="sponsored"]');
        if (event.button === 1 && link) recordAffiliateClick(link);
      });
    })();
