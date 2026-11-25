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
      function cheapestMerchantOffers(products) {
        const groups = new Map();
        const sharedVariants = new Map();
        const find = group => {
          while (group.parent) {
            if (group.parent.parent) group.parent = group.parent.parent;
            group = group.parent;
          }
          return group;
        };
        const entries = products.map(product => {
          const merchant = normalize(product.merchant);
          const brand = normalize(product.brand);
          const color = normalize(product.color);
          const size = String(product.size || '').trim();
          const title = normalize(size && product.name.toLowerCase().endsWith(size.toLowerCase())
            ? product.name.slice(0, -size.length) : product.name);
          // A retailer typically reuses the same photo and title for all sizes of a colorway.
          const localKey = JSON.stringify([merchant, brand, title, color, product.image]);
          let group = groups.get(localKey);
          if (!group) {
            group = { parent: null, cheapest: null };
            groups.set(localKey, group);
          }
          const gtin = String(product.gtin || '').trim();
          const keys = [];
          if (/^\d{8,14}$/.test(gtin)) keys.push('gtin:' + gtin.padStart(14, '0'));
          if (brand && color && title) keys.push(JSON.stringify([brand, title, color]));
          for (const key of keys) {
            const other = sharedVariants.get(key);
            if (other) {
              const root = find(group);
              const target = find(other);
              if (root !== target) root.parent = target;
            } else {
              sharedVariants.set(key, group);
            }
          }
          return { product, merchant, group, price: numericPrice(product) };
        });
        for (const entry of entries) {
          const group = find(entry.group);
          const best = group.cheapest;
          if (!best || entry.price < best.price ||
              (entry.price === best.price && entry.merchant < best.merchant)) group.cheapest = entry;
        }
        return entries.filter(entry => entry.merchant === find(entry.group).cheapest.merchant)
          .map(entry => entry.product);
      }

      const seen = new Set();
      const sizeCache = new Map();
      const sizeOptions = new Set();
      const randomOrder = new WeakMap();
      const discountedOffers = new WeakSet();
      let nextBlock;
      function readNextBlock(keys) {
        if (!nextBlock) {
          nextBlock = catalog.next(keys).then(items => {
            const eligible = items.filter(product => {
              if (!product || typeof product.name !== 'string' || typeof product.merchant !== 'string' ||
                  !/^https:\/\//i.test(product.url) || !/^https:\/\//i.test(product.image) ||
                  disabledMerchants.has(normalize(product.merchant)) ||
                  !window.isCatalogFootwear(product.name, product.footwear === true ? 'calzature' : '')) return false;
              return Boolean(discountFor(product));
            });
            for (const product of cheapestMerchantOffers(eligible).sort((a, b) => numericPrice(a) - numericPrice(b))) {
              const amount = numericPrice(product);
              const sizes = promotionSizes(product.size);
              const size = sizes.join('|') || product.size;
              const productKeys = awinCatalog.promotionProductKeys(product).map(key => JSON.stringify([normalize(product.merchant), key, normalize(product.color), size]));
              if (productKeys.some(key => seen.has(key))) continue;
              productKeys.forEach(key => seen.add(key));
              sizes.forEach(key => sizeOptions.add(key));
              randomOrder.set(product, Math.random());
              if (discountFor(product)) discountedOffers.add(product);
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
      const createCard = (product, showAction = false, availability) => {
        const card = document.createElement('a');
        card.href = safeOfferUrl(product.url) || '#';
        if (card.href !== '#') {
          const affiliateUrl = new URL(card.href);
          if (['www.awin1.com', 'awin1.com'].includes(affiliateUrl.hostname) &&
              (affiliateUrl.searchParams.get('a') === '3150312' || affiliateUrl.searchParams.get('awinaffid') === '3150312')) {
            affiliateUrl.searchParams.set('clickref6', 'archivioscarpe');
            const tracking = new URLSearchParams(location.search);
            const source = /^(instagram|facebook|tiktok|threads)$/i.test(tracking.get('utm_source') || '')
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
        if (availability) {
          details.push('Colori a listino: ' + (availability.colors.join(', ') || 'non indicati'));
          details.push('Taglie a listino: ' + (availability.sizes.join(', ') || 'non indicate'));
          details.push('Verifica colori e taglie sul sito del negozio.');
        } else {
          if (product.color) details.push('Colore: ' + product.color);
          if (product.size) details.push('Taglia: ' + product.size);
        }
        const options = [];
        if (!availability && product.colorCount > 1) options.push(product.colorCount + ' colori');
        if (!availability && product.sizeCount > 1) options.push(product.sizeCount + ' taglie');
        const offer = discountFor(product);
        const discountBadge = document.createElement('span');
        discountBadge.className = 'awin-discount-badge';
        if (offer) discountBadge.textContent = '−' + offer.percent + '%';
        const previous = document.createElement('del');
        previous.className = 'awin-original-price';
        if (offer) {
          previous.textContent = formatEuro(offer.original) + (product.originalPriceEstimated ? ' (stimato)' : '');
        }
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
      let slideAnimation = null;
      function updateRotationButton() {
        rotationButton.textContent = rotationPaused ? 'Riprendi rotazione' : 'Pausa rotazione';
        rotationButton.setAttribute('aria-pressed', String(rotationPaused));
      }
      const canRotate = () => !rotationPaused && pageCount > 1 && !document.hidden &&
        slot.getClientRects().length && !touchStart && !slot.querySelector(':focus-visible') && !slot.matches(':focus-visible');
      const scheduleRotation = () => {
        if (!canRotate()) {
          slideAnimation?.pause();
          return;
        }
        if (slideAnimation) {
          slideAnimation.play();
          return;
        }
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
      };
      reducedMotion.addEventListener('change', () => {
        rotationPaused = reducedMotion.matches;
        updateRotationButton();
        if (rotationPaused) { slideAnimation?.cancel(); slideAnimation = null; }
        scheduleRotation();
      });
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
      const foreignSizes = document.getElementById('promotionsForeignSizes');
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
      const filterDialog = document.getElementById('promotionsFilterDialog');
      const filterOpen = document.getElementById('promotionsFilterOpen');
      const applyButton = document.getElementById('promotionsApply');
      const relaxButton = document.getElementById('promotionsRelax');
      const priceSelect = document.getElementById('promotionsPrice');
      const discountInput = document.getElementById('promotionsDiscount');
      const filterSelects = [sizeSelect, brandSelect, priceSelect, typeSelect, audienceSelect, sortSelect];
      let draftSnapshot;
      const readFilters = () => filterSelects.map(select => select.value).concat(discountInput.checked, foreignSizes.checked);
      function restoreFilters(values) {
        foreignSizes.checked = Boolean(values[7]);
        renderSizeOptions();
        filterSelects.forEach((select, index) => { select.value = values[index]; });
        discountInput.checked = values[6];
      }
      let promotionLoad = 0;
      let visiblePromotions = 6;
      let currentPromotionPage = 1;
      let promotionsReady = false;
      function promotionSizes(value) {
        if (sizeCache.has(value)) return sizeCache.get(value);
        const raw = String(value ?? '').toUpperCase().trim()
          .replace(/([½⅓⅔¼¾])/g, fraction => ' ' + ({ '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4' })[fraction])
          .replace(/\s+/g, ' ');
        const sizes = new Set();
        const add = (system, text) => {
          const parts = text.match(/^(\d+(?:[.,]\d+)?)(?:\s+(1\/2|[12]\/3|[13]\/4))?([CYK]?)$/);
          if (!parts) return;
          let number = Number(parts[1].replace(',', '.'));
          let fraction = parts[2];
          if (fraction && !fraction.endsWith('/3')) {
            const [numerator, denominator] = fraction.split('/').map(Number);
            number += numerator / denominator;
            fraction = '';
          }
          if (system === 'EU' && (parts[3] || number < 15 || number > 55)) return;
          sizes.add(system + ' ' + number + (fraction ? ' ' + fraction : '') + parts[3]);
        };
        const systems = [...raw.matchAll(/\b(EUR?|IT|UK|US|BRASIL|BR|JP|CM)\b/g)];
        if (!systems.length && /^[\d., /-]+$/.test(raw)) {
          const parts = raw.split(/\s*[-–]\s*|(?<=\d{2})\/(?=\d{2}\b)/);
          parts.forEach(part => add('EU', part));
        }
        systems.forEach((match, index) => {
          const system = /^(EU|EUR|IT)$/.test(match[0]) ? 'EU' : match[0];
          if (!['EU', 'UK', 'US'].includes(system)) return;
          const end = systems[index + 1]?.index ?? raw.length;
          const label = raw.slice(match.index + match[0].length, end).replace(/^[\s:]+|[\s/–-]+$/g, '');
          label.split(/\s*[-–]\s*|(?<=\d{2})\/(?=\d{2}\b)/).forEach(part => add(system, part));
        });
        const keys = [...sizes];
        sizeCache.set(value, keys);
        return keys;
      }
      function renderSizeOptions() {
        const selected = sizeSelect.value;
        const groups = ['EU', ...(foreignSizes.checked ? ['UK', 'US'] : [])].flatMap(system => {
          const group = document.createElement('optgroup');
          group.label = system;
          const options = [...sizeOptions].filter(key => key.startsWith(system + ' '));
          const numeric = key => {
            const [, number, fraction] = key.split(' ');
            return parseFloat(number) + (fraction ? Number(fraction[0]) / Number(fraction[2]) : 0);
          };
          options.sort((a, b) => numeric(a) - numeric(b) || a.localeCompare(b));
          if (!options.length) return [];
          group.append(...options.map(key => new Option(
            (system === 'EU' ? '' : system + ' ') + key.slice(3).replace('.', ',').replace(' 1/3', '⅓').replace(' 2/3', '⅔'), key
          )));
          return [group];
        });
        sizeSelect.replaceChildren(new Option('Tutte le taglie', ''), ...groups);
        sizeSelect.value = [...sizeSelect.options].some(option => option.value === selected) ? selected : '';
        document.getElementById('promotionsSizeLabel').hidden = !groups.length;
      }
      const modelKeys = new WeakMap();
      const promotionAvailability = new Map();
      function promotionModelKey(product) {
        if (modelKeys.has(product)) return modelKeys.get(product);
        const size = String(product.size || '').trim();
        const name = size && product.name.toLowerCase().endsWith(size.toLowerCase())
          ? product.name.slice(0, -size.length) : product.name;
        const brand = canonicalBrand(product.brand);
        const audience = promotionAudience(product);
        const parts = name.split(/\s+[-–—|]\s+/);
        const colors = new Set(normalize(product.color).split(' ').filter(Boolean));
        const lastPart = normalize(parts.at(-1));
        if (parts.length > 1 && (lastPart === normalize(product.color) ||
            /^(nero|bianco|beige|rosa|lilla|blu|verde|giallo|grigio|rosso|arancio|marrone|color mix)$/.test(lastPart))) parts.pop();
        const words = normalize(parts.join(' ')).split(' ');
        const title = words.filter(word => !colors.has(word) &&
          !/^(scarpa|scarpe|running|corsa|donna|uomo|women|men|taglia)$/.test(word)).join(' ')
          .replace(/\b(nova)\s+(blast)\b/g, '$1$2');
        const model = /\basics\s+novablast\s+\d+\b/.test(title) && audience
          ? title.match(/\basics\s+novablast\s+\d+(?:\s+(?:gtx|lite show|rise shine))?/)[0]
          : title;
        const key = JSON.stringify([brand, audience, model || product.url]);
        modelKeys.set(product, key);
        return key;
      }
      function indexPromotionAvailability(products) {
        const groups = new Map();
        for (const product of products) {
          const key = promotionModelKey(product);
          if (!groups.has(key)) groups.set(key, { colors: new Map(), sizes: new Set() });
          const group = groups.get(key);
          if (product.color) group.colors.set(normalize(product.color), product.color);
          for (const size of promotionSizes(product.size)) group.sizes.add(size);
        }
        const compare = new Intl.Collator('it', { numeric: true }).compare;
        for (const [key, group] of groups) {
          promotionAvailability.set(key, {
            colors: [...group.colors.values()].sort(compare),
            sizes: [...group.sizes].sort((a, b) => {
              const [systemA, numberA, fractionA = '0/1'] = a.split(' ');
              const [systemB, numberB, fractionB = '0/1'] = b.split(' ');
              const numeric = (number, fraction) => parseFloat(number) + Number(fraction[0]) / Number(fraction[2]);
              return compare(systemA, systemB) || numeric(numberA, fractionA) - numeric(numberB, fractionB) || compare(a, b);
            }).map(size => size.replace(/^EU /, '').replace('.', ',').replace(' 1/3', '⅓').replace(' 2/3', '⅔'))
          });
        }
      }
      function promotionPool(preview = false) {
        const [size, brand, price, type, audience, sort, discounted] = !preview && draftSnapshot ? draftSnapshot : readFilters();
        const keys = price === 'all' ? ['low', 'mid', 'high'] : [price];
        const query = normalize(searchInput.value).split(' ').filter(Boolean);
        const matching = keys.flatMap(key => bands[key]).filter(product => {
          const searchable = normalize([product.name, product.brand, product.model, product.color].join(' '));
          return (!brand || canonicalBrand(product.brand) === brand) &&
            (!size || promotionSizes(product.size).includes(size)) &&
            (!type || promotionType(product) === type) &&
            (!audience || promotionAudience(product) === audience) &&
            (!discounted || discountedOffers.has(product)) &&
            query.every(word => searchable.includes(word));
        });
        const representatives = new Map();
        for (const product of matching) {
          const key = promotionModelKey(product);
          const current = representatives.get(key);
          if (!current || numericPrice(product) < numericPrice(current) ||
              (numericPrice(product) === numericPrice(current) && compareOfferPriority(product, current) < 0)) {
            representatives.set(key, product);
          }
        }
        const products = [...representatives.values()];
        if (preview) return products;
        if (sort === 'random') {
          return products.sort((a, b) => Number(discountedOffers.has(b)) - Number(discountedOffers.has(a)) || randomOrder.get(a) - randomOrder.get(b));
        }
        if (sort === 'discount') {
          return products.sort((a, b) => compareOfferPriority(a, b) || numericPrice(a) - numericPrice(b));
        }
        if (sort === 'price-asc') return products.sort((a, b) => numericPrice(a) - numericPrice(b));
        if (sort === 'price-desc') return products.sort((a, b) => numericPrice(b) - numericPrice(a));
        return products;
      }
      function populatePromotionFilters() {
        const products = Object.values(bands).flat();
        indexPromotionAvailability(products);
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
        renderSizeOptions();
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
      let previousPromotionState;
      try { previousPromotionState = JSON.parse(sessionStorage.getItem('promotion-state-v2')); } catch {}
      function rememberPromotions() {
        if (!promotionsReady || document.getElementById('view-promotions').classList.contains('hidden')) return;
        try {
          sessionStorage.setItem('promotion-state-v2', JSON.stringify({
            hash: location.hash, filters: [searchInput, brandSelect, sizeSelect, typeSelect, audienceSelect, sortSelect].map(input => input.value),
            discounted: (draftSnapshot || readFilters())[6], foreignSizes: (draftSnapshot || readFilters())[7], visible: visiblePromotions, page: currentPromotionPage, scroll: window.scrollY
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
          const card = createCard(shown[index], true, promotionAvailability.get(promotionModelKey(shown[index])));
          if (index % 6 === 0) card.dataset.pageStart = String(Math.floor(index / 6) + 1);
          grid.append(card);
        }
        const [size, brand, price, type, audience, , discounted] = draftSnapshot || readFilters();
        const count = [size, brand, price !== 'all', type, audience, discounted].filter(Boolean).length;
        filterOpen.textContent = count ? 'Filtri · ' + count : 'Filtri';
        status.textContent = shown.length
          ? shown.length + ' prodotti su ' + products.length
          : 'Nessuna offerta corrisponde a questi filtri.';
        relaxButton.hidden = Boolean(shown.length) || !(size || count || searchInput.value.trim());
        relaxButton.textContent = size ? 'Rimuovi taglia ' + size.replace('.', ',') : 'Azzera la ricerca e i filtri';
        rememberPromotions();
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
          filterOpen.disabled = false;
          const saved = previousPromotionState;
          previousPromotionState = null;
          const restore = saved?.hash === location.hash && Array.isArray(saved.filters);
          if (restore) {
            foreignSizes.checked = saved.foreignSizes === true;
            renderSizeOptions();
            [searchInput, brandSelect, sizeSelect, typeSelect, audienceSelect, sortSelect].forEach((input, index) => {
              const value = saved.filters[index];
              if (typeof value === 'string' && (!input.options || [...input.options].some(option => option.value === value))) input.value = value;
            });
            if (typeof saved.discounted === 'boolean') discountInput.checked = saved.discounted;
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
        priceSelect.value = band === 'discounted' ? 'all' : band;
        discountInput.checked = band === 'discounted';
        promotionScroll = 0;
        if (!document.getElementById('view-promotions').classList.contains('hidden')) selectPromotionBand();
      }
      function updatePreview() {
        const count = promotionPool(true).length;
        applyButton.textContent = count === 1 ? 'Mostra 1 risultato' : 'Mostra ' + count + ' risultati';
      }
      filterOpen.addEventListener('click', () => {
        draftSnapshot = readFilters();
        updatePreview();
        filterDialog.showModal();
      });
      function dismissFilters() {
        if (draftSnapshot) restoreFilters(draftSnapshot);
        draftSnapshot = null;
        filterDialog.close();
      }
      document.getElementById('promotionsFilterClose').addEventListener('click', dismissFilters);
      filterDialog.addEventListener('cancel', event => {
        event.preventDefault();
        dismissFilters();
      });
      foreignSizes.addEventListener('change', renderSizeOptions);
      filterDialog.addEventListener('change', updatePreview);
      function resetFilters() {
        restoreFilters(['', '', 'all', '', '', 'random', false]);
      }
      resetButton.addEventListener('click', () => {
        resetFilters();
        updatePreview();
      });
      function applyFilters() {
        const band = priceSelect.value === 'all' && discountInput.checked ? 'discounted' : priceSelect.value;
        history.replaceState(null, '', awinCatalog.promotionRoutes[band]);
        promotionScroll = 0;
        selectPromotionBand();
        status.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
      applyButton.addEventListener('click', () => {
        draftSnapshot = null;
        filterDialog.close();
        applyFilters();
      });
      relaxButton.addEventListener('click', () => {
        if (sizeSelect.value) sizeSelect.value = '';
        else { searchInput.value = ''; resetFilters(); }
        applyFilters();
      });
      let searchTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(selectPromotionBand, 120);
      });
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
        if (filterDialog.open) dismissFilters();
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
      const source = (params.get('utm_source') || '').trim();
      const clickId = params.has('ttclid') || params.has('tik_tok_click_id');
      const fromInstagram = /^(instagram|ig)$/i.test(source) || /(?:^|\.)instagram\.com$/i.test(referrerHost);
      const fromFacebook = /^(facebook|fb|meta)$/i.test(source) || /(?:^|\.)(facebook|fb)\.com$/i.test(referrerHost);
      const fromTikTok = clickId || /^(tiktok|tik_tok|tt)$/i.test(source)
        || /(?:^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com)$/i.test(referrerHost);
      const fromThreads = /^threads$/i.test(source) || /(?:^|\.)threads\.(net|com)$/i.test(referrerHost);
      let channel = fromThreads ? 'threads' : fromInstagram ? 'instagram' : fromFacebook ? 'facebook' : fromTikTok ? 'tiktok' : 'other';
      try {
        const attributionKey = 'archivio-scarpe-traffic-source';
        if (channel !== 'other') sessionStorage.setItem(attributionKey, channel);
        else {
          const stored = sessionStorage.getItem(attributionKey);
          if (/^(instagram|facebook|tiktok|threads)$/.test(stored || '')) channel = stored;
        }
      } catch {}
      let campaign = channel !== 'other' ? awinCatalog.instagramCampaign(params.get('utm_campaign')) : '';
      if (channel === 'tiktok') {
        const medium = (params.get('utm_medium') || '').trim().toLowerCase();
        const paid = clickId || /^(paid[_-]?social|paid|cpc|cpm|ppc)$/.test(medium);
        const organic = /^(organic[_-]?social|organic)$/.test(medium);
        if (paid || organic) campaign = (paid ? 'tt-paid-' : 'tt-organic-') + (campaign || 'generale').slice(0, 37);
      }
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
