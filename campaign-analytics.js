/* Statistiche locali, anonime, limitate a questo browser.
   Nessun dato dell'armadio, fotografia o URL affiliato viene registrato. */
(() => {
  'use strict';
  const KEY = 'archivioscarpe_campaign_stats_v1';
  const ATTR = 'archivioscarpe_campaign_attribution_v1';
  const ALLOWED = new Set(['instagram','facebook','direct','other']);
  const campaignUrl = 'https://davimarz.github.io/archivioscarpe/';
  const safe = value => String(value || '').slice(0, 70).replace(/[^a-zA-Z0-9_-]/g, '');
  const read = () => {
    try { const data = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(data) ? data : []; }
    catch { return []; }
  };
  const current = (() => {
    const q = new URLSearchParams(location.search);
    const source = safe(q.get('utm_source'));
    const content = safe(q.get('utm_content'));
    const campaign = safe(q.get('utm_campaign'));
    if (source || content || campaign) {
      const attr = { source: ALLOWED.has(source) ? source : 'other', content, campaign };
      try { sessionStorage.setItem(ATTR, JSON.stringify(attr)); } catch {}
      return attr;
    }
    try { return JSON.parse(sessionStorage.getItem(ATTR) || 'null') || {source:'direct',content:'',campaign:''}; }
    catch { return {source:'direct',content:'',campaign:''}; }
  })();
  const record = (type, merchant = '') => {
    try {
      const events = read();
      events.push({ t: Date.now(), type, source: current.source, content: current.content, campaign: current.campaign, merchant: safe(merchant) });
      localStorage.setItem(KEY, JSON.stringify(events.slice(-1500)));
    } catch {}
    render();
  };
  const count = (events, type) => events.filter(e => e.type === type).length;
  const render = () => {
    const root = document.getElementById('campaignAdminPanel');
    if (!root || root.hidden) return;
    const events = read();
    const selected = document.getElementById('campaignPeriod')?.value || '30';
    const days = Number(selected);
    const filtered = days ? events.filter(e => e.t >= Date.now() - days * 86400000) : events;
    const instagram = filtered.filter(e => e.source === 'instagram');
    const map = {
      statVisits: count(instagram,'visit'),
      statArchive: count(instagram,'archive_open'),
      statCheck: count(instagram,'check_open'),
      statPromotions: count(instagram,'promotions_open'),
      statAffiliate: count(instagram,'affiliate_click'),
      statAllClicks: count(filtered,'affiliate_click')
    };
    Object.entries(map).forEach(([id,value]) => { const el = document.getElementById(id); if (el) el.textContent = value.toLocaleString('it-IT'); });
    const groups = {};
    instagram.forEach(e => {
      const key = e.content || '(senza utm_content)';
      groups[key] ||= {visits:0,clicks:0};
      if (e.type === 'visit') groups[key].visits++;
      if (e.type === 'affiliate_click') groups[key].clicks++;
    });
    const table = document.getElementById('campaignBreakdown');
    if (table) {
      table.replaceChildren();
      Object.entries(groups).sort((a,b)=>b[1].visits-a[1].visits).forEach(([name,counts]) => {
        const row = document.createElement('tr');
        [name,String(counts.visits),String(counts.clicks)].forEach(v => {
          const cell = document.createElement('td'); cell.textContent = v; cell.className = 'px-2 py-2 border-b border-slate-200'; row.appendChild(cell);
        });
        table.appendChild(row);
      });
      if (!table.children.length) {
        const row = document.createElement('tr'); const cell = document.createElement('td');
        cell.colSpan=3; cell.textContent='Nessun evento Instagram registrato su questo dispositivo.'; cell.className='p-3';row.appendChild(cell);table.appendChild(row);
      }
    }
  };
  const createLink = () => {
    const url = new URL(campaignUrl);
    url.searchParams.set('utm_source','instagram');
    url.searchParams.set('utm_medium','paid_social');
    url.searchParams.set('utm_campaign','archivio_scarpe');
    url.searchParams.set('utm_content',safe(document.getElementById('campaignCreative')?.value) || 'reel_video_02');
    const output = document.getElementById('campaignLink');
    if (output) output.value = url.toString();
  };
  window.toggleCampaignAdmin = () => {
    const el = document.getElementById('campaignAdminPanel');
    if (!el) return;
    el.hidden = !el.hidden;
    const button = document.getElementById('campaignAdminToggle');
    button?.setAttribute('aria-expanded',String(!el.hidden));
    if (!el.hidden) { createLink(); render(); }
  };
  window.exportCampaignStats = () => {
    const header = ['data_ora','evento','sorgente','campagna','creativita','negozio'];
    const rows = read().map(e => [new Date(e.t).toISOString(),e.type,e.source,e.campaign,e.content,e.merchant]);
    const csv = [header,...rows].map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');a.href=url;a.download='statistiche-archivio-scarpe.csv';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  window.copyCampaignLink = async () => {
    createLink();
    const input = document.getElementById('campaignLink');
    if (!input) return;
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); document.execCommand('copy'); }
    const msg = document.getElementById('campaignCopyStatus');
    if (msg) msg.textContent='Link copiato.';
  };
  document.addEventListener('DOMContentLoaded', () => {
    try {
      if (!sessionStorage.getItem('archivioscarpe_visit_counted_v1')) {
        record('visit');
        sessionStorage.setItem('archivioscarpe_visit_counted_v1','1');
      }
    } catch { record('visit'); }
    document.getElementById('campaignPeriod')?.addEventListener('change',render);
    document.getElementById('campaignCreative')?.addEventListener('input',createLink);
    document.addEventListener('click',event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[data-product-url]');
      if (link && /^https:\/\//i.test(link.href)) {
        const merchant = link.dataset.merchant || '';
        record('affiliate_click',merchant);
      }
      const button = target.closest('button');
      if (!button) return;
      const action = button.getAttribute('onclick') || '';
      if (action.includes("switchTab('archive')")) record('archive_open');
      if (action.includes("switchTab('check')")) record('check_open');
      if (action.includes("switchTab('promotions')")) record('promotions_open');
    },{capture:true});
  });
})();
