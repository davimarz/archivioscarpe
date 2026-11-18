import { createClient } from 'npm:@supabase/supabase-js@2.84.0';

const headers = {
  'Access-Control-Allow-Origin': 'https://davimarz.github.io',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}

function windows(start, end) {
  const ranges = [];
  for (let from = start; from <= end;) {
    const to = Math.min(end, from + 30 * 86400000 - 1000);
    ranges.push([from, to]);
    from = to + 1000;
  }
  return ranges;
}

function summarize(transactions) {
  const currencies = new Map();
  for (const row of transactions) {
    const currency = row.commissionAmount?.currency;
    const amount = row.commissionAmount?.amount;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
        typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    if (!currencies.has(currency)) currencies.set(currency, { currency, approved: 0, pending: 0, declined: 0, other: 0 });
    const status = String(row.commissionStatus).toLowerCase();
    const bucket = ['approved', 'pending', 'declined'].includes(status) ? status : 'other';
    currencies.get(currency)[bucket] += amount;
  }
  return { transactions: transactions.length, commissions: [...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)) };
}

const footwearTerms = /\b(calzatur\w*|scarpa|scarpe|footwear|shoes?|sneakers?|trainers?|sandali?|sandals?|stival\w*|boots?|ciabatt\w*|slippers?|mocassin\w*|loafers?|espadrill\w*)\b/i;
const accessoryTerms = /\b(accessor\w*|lacc\w*|laces?|calzett\w*|socks?|solet\w*|insoles?|kit|spray|pulizia|cleaner|cura|shoe\s+care|shoe\s+bags?)\b/i;
const otherTerms = /\b(abbigliamento|clothing|apparel|magliett\w*|t\s*shirts?|pantalon\w*|trousers|jackets?|giacc\w*|felp\w*|zain\w*|bags?|borse|cappell\w*)\b/i;

function productKind(item) {
  const name = String(item?.productName || '');
  const category = String(item?.category || '');
  if (accessoryTerms.test(name) || otherTerms.test(name)) return 'other';
  if (footwearTerms.test(name)) return 'footwear';
  if (footwearTerms.test(category)) {
    return accessoryTerms.test(category) || otherTerms.test(category) ? 'unknown' : 'footwear';
  }
  return accessoryTerms.test(category) || otherTerms.test(category) ? 'other' : 'unknown';
}

function summarizeFootwear(sales, advertisers) {
  const shops = new Map();
  let unknownOrders = 0;
  let unpricedOrders = 0;
  let ordersWithoutCommissionBreakdown = 0;

  for (const sale of sales) {
    const id = String(sale.advertiserId);
    if (!advertisers.has(id)) continue;
    const basket = Array.isArray(sale.basketProducts) ? sale.basketProducts : [];
    const kinds = basket.map(productKind);
    const shoes = basket.filter((_, index) => kinds[index] === 'footwear');
    if (!basket.length || kinds.includes('unknown')) unknownOrders++;
    if (!shoes.length) continue;

    if (!shops.has(id)) shops.set(id, { name: advertisers.get(id), orders: 0, amounts: new Map(), commissionRows: [] });
    const shop = shops.get(id);
    shop.orders++;
    const currency = sale.saleAmount?.currency;
    const wholeBasket = shoes.length === basket.length;
    let amount = wholeBasket ? sale.saleAmount?.amount : undefined;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      amount = shoes.every(item => typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) &&
        item.unitPrice >= 0 && Number.isInteger(item.quantity) && item.quantity > 0)
        ? shoes.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) : undefined;
    }
    if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) && Number.isFinite(amount)) {
      shop.amounts.set(currency, (shop.amounts.get(currency) || 0) + amount);
    } else unpricedOrders++;
    if (wholeBasket) shop.commissionRows.push(sale);
    else ordersWithoutCommissionBreakdown++;
  }

  return {
    unknownOrders, unpricedOrders, ordersWithoutCommissionBreakdown,
    stores: [...shops.values()].map(shop => ({
      name: shop.name, orders: shop.orders,
      sales: [...shop.amounts].map(([currency, amount]) => ({ currency, amount })),
      commissions: summarize(shop.commissionRows).commissions,
    })).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name, 'it')),
  };
}

async function joinedAdvertisers(token) {
  const url = new URL('https://api.awin.com/publishers/3150312/programmes');
  url.search = new URLSearchParams({ relationship: 'joined', accessToken: token }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
  if (!response.ok) throw new Error('AWIN_PROGRAMMES_UNAVAILABLE');
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.some(row => row?.id == null || typeof row.name !== 'string')) {
    throw new Error('AWIN_PROGRAMMES_UNAVAILABLE');
  }
  return new Map(rows.map(row => [String(row.id), row.name]));
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply(405, { code: 'METHOD_NOT_ALLOWED' });

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return reply(401, { code: 'AUTH_REQUIRED' });
  try {
    const client = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await client.auth.getUser(authorization.slice(7));
    if (authError || !user) return reply(401, { code: 'AUTH_REQUIRED' });
    const { data, error } = await client.from('admin_access').select('id').eq('id',1).maybeSingle();
    if (error || !data) return reply(403, { code: 'ADMIN_REQUIRED' });

    let input;
    try { input = await req.json(); } catch { return reply(400, { code: 'INVALID_PERIOD' }); }
    const start = Math.floor(Date.parse(input?.since) / 1000) * 1000;
    const end = Math.floor(Date.now() / 1000) * 1000;
    if (!Number.isFinite(start) || start > end || end - start > 367 * 86400000) {
      return reply(400, { code: 'INVALID_PERIOD' });
    }
    const token = Deno.env.get('AWIN_API_TOKEN');
    if (!token) return reply(503, { code: 'AWIN_NOT_CONFIGURED' });

    const transactions = new Map();
    const ranges = windows(start, end);
    for (let i = 0; i < ranges.length; i += 3) {
      const batches = await Promise.all(ranges.slice(i, i + 3).map(async ([from, to]) => {
        const url = new URL('https://api.awin.com/publishers/3150312/transactions/');
        url.search = new URLSearchParams({
          startDate: new Date(from).toISOString().slice(0, 19),
          endDate: new Date(to).toISOString().slice(0, 19),
          timezone: 'UTC', dateType: 'transaction', accessToken: token,
          ...(input?.includeFootwear === true ? { showBasketProducts: 'true' } : {}),
        }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AWIN_AUTH' : 'AWIN_UNAVAILABLE');
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.some(row => !row || row.id == null)) throw new Error('AWIN_UNAVAILABLE');
        return rows;
      }));
      for (const rows of batches) for (const row of rows) transactions.set(String(row.id), row);
    }
    const all = [...transactions.values()];
    const site = all.filter(row => row.clickRefs?.clickRef6 === 'archivioscarpe');
    const report = { ...summarize(all), site: summarize(site) };
    if (input?.includeFootwear === true) {
      const sales = site.filter(row => /^(sale|mobile sale|mobile app purchase)$/i.test(String(row.type)) &&
        String(row.commissionStatus).toLowerCase() !== 'deleted');
      try {
        const advertisers = sales.length ? await joinedAdvertisers(token) : new Map();
        report.footwear = summarizeFootwear(sales, advertisers);
      } catch {
        report.footwear = { unavailable: true };
      }
    }
    return reply(200, report);
  } catch (error) {
    return reply(502, { code: error.message === 'AWIN_AUTH' ? 'AWIN_AUTH' : 'AWIN_UNAVAILABLE' });
  }
});

