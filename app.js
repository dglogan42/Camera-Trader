/**
 * Camera Trade Hub — Auckland MVP
 * LocalStorage client + simulated Stripe Connect + stolen-serial + shutter depreciation
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'camera-trade-hub-v1';

const STORES = [
  {
    id: 'photogear',
    name: 'Photogear',
    suburb: 'Mt Eden',
    address: '6 Akepiro St',
    payout: 'credit_only',
    note: 'Trade-in for store credit only (no cash). Email photos: sales@photogear.co.nz',
    email: 'sales@photogear.co.nz',
  },
  {
    id: 'acc',
    name: 'Auckland Camera Centre',
    suburb: 'Morningside',
    address: '646 New North Rd',
    payout: 'both',
    note: 'Trade-ins accepted; contact for rates.',
  },
  {
    id: 'photowarehouse',
    name: 'Photo Warehouse',
    suburb: 'Ponsonby / CBD',
    address: 'Auckland CBD',
    payout: 'both',
    note: 'Trade value toward new gear (e.g. Sony promos).',
  },
];

const CONDITION_MULT = {
  mint: 0.95,
  excellent: 0.85,
  good: 0.7,
  fair: 0.55,
  poor: 0.35,
};

/** Platform fee on cash (3rd-party) payouts */
const PLATFORM_FEE_RATE = 0.05;
const PLATFORM_FEE_FIXED = 0.5;

/**
 * Stolen gear check API config.
 * Prefer proxy (keeps keys server-side). Set url/key only for direct calls.
 */
const STOLEN_CHECK_API = {
  proxyUrl: '/api/stolen-check', // Express / Cloudflare Worker proxy
  url: null,
  key: null,
};

/** Local mock serials known stolen (fallback) */
const STOLEN_SERIALS = new Set(['SN12345678', 'STOLEN999', 'HOTCAM001']);

/**
 * NZ stolen-goods resources (no public Police camera serial API).
 * @see https://www.police.govt.nz/faq/questions-by-category/lost-stolen-found-property
 * @see https://ecotechnologies.nz/resources/knowledge-base/stolen-goods/
 */
const NZ_POLICE = {
  faqLostStolenFound:
    'https://www.police.govt.nz/faq/questions-by-category/lost-stolen-found-property',
  serialNumbers:
    'https://www.police.govt.nz/faq/it-worth-keeping-serial-numbers-case-property-lost-or-stolen',
  reportStolen: 'https://www.police.govt.nz/use-105/stolen-property',
  reportStolenForm: 'https://webforms.police.govt.nz/en/form/stolen-property',
  reportFound: 'https://www.police.govt.nz/use-105/found-property',
  reportLost: 'https://www.police.govt.nz/use-105/lost-property',
  use105: 'https://www.police.govt.nz/use-105',
  secondhandDealers:
    'https://www.police.govt.nz/advice-services/businesses-and-organisations/secondhand-dealers-and-pawnbrokers/secondhand-dealers',
  stolenVehicles: 'https://www.police.govt.nz/can-you-help-us/stolen-vehicles',
  // Commercial / third-party (from Ecotechnologies knowledge base)
  ecoStolenGoods: 'https://ecotechnologies.nz/resources/knowledge-base/stolen-goods/',
  seriSafe: 'https://serisafe.com/',
  stoleMe: 'http://www.stoleme.co.nz/',
  tcfStolenPhones:
    'https://www.tcf.org.nz/consumers/mobile/lost-stolen-phones/check-your-handsets-status/',
  // SNAP (Serial Number Action Partnership) — Police site decommissioned 15 Dec 2021
  snapDecommissioned:
    'https://www.police.govt.nz/about-site-and-nz-police-app/other-sites/snap-decommissioning',
  snapOrgNz: 'https://snap.org.nz/',
};

// ---------------------------------------------------------------------------
// Pure business logic (exported via window for tests)
// ---------------------------------------------------------------------------

/**
 * Detect camera tier / shutter life expectancy from model string.
 * Ratings are manufacturer MTBF-style medians (actuations).
 */
function detectShutterLife(model = '') {
  const m = String(model).toLowerCase();

  // Fully electronic / no mechanical shutter wear
  if (/\bz9\b|\ba9\s*iii\b|a9iii|global\s*shutter/.test(m)) {
    return { tier: 'electronic', life: Infinity, label: 'No mechanical shutter' };
  }

  // Flagship
  if (/\br1\b|\ba1\b|\bz9\b|\bd6\b|\b1dx\b/.test(m)) {
    return { tier: 'flagship', life: 500_000, label: 'Flagship ~500k' };
  }
  if (/canon.*r1|r1\b/.test(m)) {
    return { tier: 'flagship', life: 800_000, label: 'Flagship ~800k' };
  }

  // Pro / high-res
  if (/\br5\b|\br3\b|\bz8\b|\ba7r\s*v\b|\ba9\b|\bz7\s*ii\b|\bd850\b|\b5d\s*iv\b/.test(m)) {
    return { tier: 'pro', life: 400_000, label: 'Pro ~400k' };
  }

  // Enthusiast / mid full-frame
  if (
    /\br6\b|\br7\b|\bz6\b|\bzf\b|\ba7\s*iv\b|\ba7\s*iii\b|\ba7c\b|\br8\b|\bz5\b|\bd780\b/.test(m)
  ) {
    return { tier: 'enthusiast', life: 200_000, label: 'Enthusiast ~200k' };
  }

  // Entry
  if (
    /\br50\b|\br10\b|\br100\b|\bz30\b|\bz50\b|\ba6[0-9]{3}\b|\ba6400\b|\ba6700\b|rebel|eos\s*m|d3500|d5600/.test(
      m
    )
  ) {
    return { tier: 'entry', life: 100_000, label: 'Entry ~100k' };
  }

  return { tier: 'unknown', life: 150_000, label: 'Default ~150k' };
}

/**
 * Continuous ease-out shutter depreciation.
 * life = expected actuations; floor = 0.45; allows over-life up to ~1.8×
 */
function shutterDepreciationFactor(count, life = 150_000) {
  if (life === Infinity || count == null || count === '' || Number.isNaN(Number(count))) {
    return 1;
  }
  const c = Math.max(0, Number(count));
  if (c === 0) return 1;
  if (!life || life <= 0) life = 150_000;

  const ratio = Math.min(c / life, 1.8);
  // ease-out cubic: starts near 1, decays smoothly
  const t = Math.min(ratio / 1.8, 1);
  const ease = 1 - Math.pow(1 - t, 3);
  const floor = 0.45;
  return Math.max(floor, 1 - ease * (1 - floor));
}

function platformFee(amount) {
  const gross = Math.max(0, Number(amount) || 0);
  const fee = gross * PLATFORM_FEE_RATE + PLATFORM_FEE_FIXED;
  const net = Math.max(0, Math.round((gross - fee) * 100) / 100);
  const feeRounded = Math.round(fee * 100) / 100;
  return { gross, fee: feeRounded, net };
}

/**
 * Calculate trade offer.
 * @returns {{ tradeValue, cashNet, cashFee, conditionMult, shutterFactor, shutterLife, tier }}
 */
function calcOffer({ marketValue, condition, model, shutterCount, payout }) {
  const mv = Math.max(0, Number(marketValue) || 0);
  const conditionMult = CONDITION_MULT[condition] ?? 0.7;
  const lifeInfo = detectShutterLife(model);
  const shutterFactor = shutterDepreciationFactor(shutterCount, lifeInfo.life);
  const tradeValue = Math.round(mv * conditionMult * shutterFactor * 100) / 100;
  const feeInfo = platformFee(tradeValue);
  return {
    tradeValue,
    cashNet: feeInfo.net,
    cashFee: feeInfo.fee,
    conditionMult,
    shutterFactor,
    shutterLife: lifeInfo.life,
    tier: lifeInfo.tier,
    tierLabel: lifeInfo.label,
    payout: payout || 'credit',
  };
}

function normalizeSerial(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function isStolenLocal(serial) {
  const n = normalizeSerial(serial);
  if (!n) return false;
  return STOLEN_SERIALS.has(n);
}

/** Generate Stripe-style idempotency key */
function generateIdempotencyKey(prefix = 'trade') {
  const rand =
    (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${rand}`;
}

// ESM exports (tests + optional imports)
export {
  detectShutterLife,
  shutterDepreciationFactor,
  platformFee,
  calcOffer,
  isStolenLocal,
  generateIdempotencyKey,
  normalizeSerial,
  CONDITION_MULT,
  PLATFORM_FEE_RATE,
  PLATFORM_FEE_FIXED,
  STOLEN_SERIALS,
  STORES,
};

if (typeof window !== 'undefined') {
  window.CameraTradeLogic = {
    detectShutterLife,
    shutterDepreciationFactor,
    platformFee,
    calcOffer,
    isStolenLocal,
    generateIdempotencyKey,
    normalizeSerial,
    CONDITION_MULT,
    PLATFORM_FEE_RATE,
    PLATFORM_FEE_FIXED,
    STOLEN_SERIALS,
  };
}

// ---------------------------------------------------------------------------
// App state (browser only)
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {
      activeStoreId: 'photogear',
      trades: [],
      inventory: [],
      credits: {}, // customerKey -> { balance, history[] }
      stripeAccounts: {}, // storeId -> { accountId, chargesEnabled, payoutsEnabled }
      transfers: [],
      idempotencyKeys: {}, // key -> { result, createdAt }
      webhookLog: [],
    };
  }

  let state = loadState();

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function toast(msg, type = 'ok') {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', type === 'error');
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function storeById(id) {
    return STORES.find((s) => s.id === id);
  }

  function fillStoreSelects() {
    const opts = STORES.map(
      (s) => `<option value="${s.id}">${s.name} (${s.suburb})</option>`
    ).join('');
    $('#tradeStore').innerHTML = opts;
    $('#invStoreFilter').innerHTML =
      `<option value="all">All stores</option>` + opts;
    $('#tradeStore').value = state.activeStoreId;
    updateStorePill();
  }

  function updateStorePill() {
    const s = storeById(state.activeStoreId);
    $('#activeStorePill').textContent = s
      ? `${s.name} · ${s.suburb}`
      : 'Select a store';
  }

  function renderStores() {
    $('#storeCards').innerHTML = STORES.map((s) => {
      const connected = state.stripeAccounts[s.id];
      const active = s.id === state.activeStoreId;
      return `
        <div class="store-card ${active ? 'active' : ''}" data-store="${s.id}">
          <h3>${s.name}</h3>
          <p>${s.address}, ${s.suburb}</p>
          <p>${s.note}</p>
          <p>
            <span class="badge ${s.payout === 'credit_only' ? 'warn' : 'ok'}">
              ${s.payout === 'credit_only' ? 'Credit only' : 'Credit + cash'}
            </span>
            ${
              connected
                ? `<span class="badge ok">${connected.accountId}</span>`
                : `<span class="badge">Not onboarded</span>`
            }
          </p>
          <button type="button" class="btn secondary" data-activate="${s.id}">Use this store</button>
        </div>`;
    }).join('');
  }

  function previewOffer() {
    const marketValue = $('#marketValue').value;
    const condition = $('#condition').value;
    const model = $('#model').value;
    const shutterCount = $('#shutterCount').value;
    const payout = document.querySelector('input[name="payout"]:checked')?.value || 'credit';
    const store = storeById($('#tradeStore').value);

    if (!marketValue) {
      $('#offerPreview').innerHTML =
        '<span class="muted">Fill the form to preview offer…</span>';
      return;
    }

    const o = calcOffer({ marketValue, condition, model, shutterCount, payout });
    let cashNote = '';
    if (payout === 'cash') {
      if (store?.payout === 'credit_only') {
        cashNote = `<div class="hint danger">⚠ ${store.name} is credit-only — cash payout disabled at accept.</div>`;
      } else {
        cashNote = `Cash after fees: <strong>$${o.cashNet.toFixed(2)}</strong> (fee $${o.cashFee.toFixed(2)})`;
      }
    }

    $('#offerPreview').innerHTML = `
      Trade offer: <strong>$${o.tradeValue.toFixed(2)}</strong> NZD<br/>
      Condition ×${o.conditionMult} · Shutter ×${o.shutterFactor.toFixed(3)}
      (${o.tierLabel})<br/>
      ${payout === 'credit' ? 'Payout: <strong>store credit</strong> (full amount)' : cashNote}
    `;
  }

  // ---- Stolen check ----
  async function checkStolen(serial) {
    const n = normalizeSerial(serial);
    if (!n) return { stolen: false, source: 'empty' };

    // 1) Prefer proxy
    if (STOLEN_CHECK_API.proxyUrl) {
      try {
        const res = await fetch(STOLEN_CHECK_API.proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: n }),
        });
        if (res.ok) {
          const data = await res.json();
          return { stolen: !!data.stolen, source: data.source || 'proxy', detail: data };
        }
      } catch (_) {
        /* fall through */
      }
    }

    // 2) Direct API if configured
    if (STOLEN_CHECK_API.url) {
      try {
        const res = await fetch(STOLEN_CHECK_API.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(STOLEN_CHECK_API.key
              ? { Authorization: `Bearer ${STOLEN_CHECK_API.key}` }
              : {}),
          },
          body: JSON.stringify({ serial: n }),
        });
        if (res.ok) {
          const data = await res.json();
          return { stolen: !!data.stolen, source: 'api', detail: data };
        }
      } catch (_) {
        /* fall through */
      }
    }

    // 3) Local mock
    return {
      stolen: isStolenLocal(n),
      source: 'local-mock',
    };
  }

  // ---- Stripe / idempotency ----
  function ensureIdempotent(key, compute) {
    if (state.idempotencyKeys[key]) {
      return { ...state.idempotencyKeys[key].result, replayed: true };
    }
    const result = compute();
    state.idempotencyKeys[key] = {
      result,
      createdAt: new Date().toISOString(),
    };
    save();
    return { ...result, replayed: false };
  }

  function onboardStore(storeId) {
    const s = storeById(storeId);
    if (!s) return;
    if (state.stripeAccounts[storeId]) {
      toast('Store already onboarded');
      return state.stripeAccounts[storeId];
    }
    const accountId = `acct_${storeId}_${Math.random().toString(36).slice(2, 10)}`;
    state.stripeAccounts[storeId] = {
      accountId,
      type: 'express',
      chargesEnabled: true,
      payoutsEnabled: true,
      createdAt: new Date().toISOString(),
    };
    save();
    toast(`Onboarded ${s.name} → ${accountId}`);
    renderStripe();
    renderStores();
    return state.stripeAccounts[storeId];
  }

  function createCashTransfer(trade, { idempotencyKey } = {}) {
    const key =
      idempotencyKey ||
      generateIdempotencyKey(`payout_${trade.id}`);

    return ensureIdempotent(key, () => {
      let acct = state.stripeAccounts[trade.storeId];
      if (!acct) {
        acct = onboardStore(trade.storeId);
      }
      const fee = platformFee(trade.offer.tradeValue);
      const transfer = {
        id: `tr_${Date.now().toString(36)}`,
        tradeId: trade.id,
        storeId: trade.storeId,
        accountId: acct.accountId,
        amount: fee.net,
        fee: fee.fee,
        currency: 'nzd',
        status: 'paid',
        idempotencyKey: key,
        createdAt: new Date().toISOString(),
      };
      state.transfers.unshift(transfer);
      return transfer;
    });
  }

  function logWebhook(type, payload) {
    const entry = {
      id: `evt_${Date.now().toString(36)}`,
      type,
      payload,
      receivedAt: new Date().toISOString(),
    };
    state.webhookLog.unshift(entry);
    state.webhookLog = state.webhookLog.slice(0, 50);
    save();
    renderWebhookLog();
    return entry;
  }

  function simulateWebhook(type) {
    const store = storeById(state.activeStoreId);
    const acct = state.stripeAccounts[state.activeStoreId];
    const lastTransfer = state.transfers[0];
    const payloads = {
      'account.updated': {
        id: acct?.accountId || 'acct_pending',
        charges_enabled: true,
        payouts_enabled: true,
        store: store?.name,
      },
      'transfer.created': lastTransfer || { note: 'no transfers yet' },
      'transfer.paid': lastTransfer
        ? { ...lastTransfer, status: 'paid' }
        : { note: 'no transfers yet' },
      'payout.paid': {
        id: `po_${Date.now().toString(36)}`,
        amount: lastTransfer?.amount || 0,
        account: acct?.accountId,
      },
      'charge.succeeded': {
        id: `ch_${Date.now().toString(36)}`,
        amount: lastTransfer?.amount || 0,
        currency: 'nzd',
      },
    };
    const entry = logWebhook(type, payloads[type] || {});
    toast(`Webhook: ${type}`);
    return entry;
  }

  // ---- Trade accept ----
  async function acceptTrade(e) {
    e.preventDefault();
    const storeId = $('#tradeStore').value;
    const store = storeById(storeId);
    const brand = $('#brand').value.trim();
    const model = $('#model').value.trim();
    const marketValue = Number($('#marketValue').value);
    const condition = $('#condition').value;
    const serial = normalizeSerial($('#serial').value);
    const shutterCount = $('#shutterCount').value
      ? Number($('#shutterCount').value)
      : null;
    const customer = $('#customer').value.trim();
    const notes = $('#notes').value.trim();
    let payout = document.querySelector('input[name="payout"]:checked')?.value || 'credit';
    const category = $('#category').value;

    if (payout === 'cash' && store.payout === 'credit_only') {
      toast(`${store.name} only offers store credit`, 'error');
      payout = 'credit';
    }

    if (serial) {
      const check = await checkStolen(serial);
      if (check.stolen) {
        toast('STOLEN SERIAL — do not accept this trade', 'error');
        $('#stolenResult').textContent =
          `⚠ STOLEN (${check.source}) — DO NOT ACCEPT`;
        $('#stolenResult').className = 'hint danger';
        const box = $('#stolenPoliceActions');
        if (box) {
          box.classList.remove('hidden', 'clean');
          box.innerHTML = `
            <strong>Trade blocked.</strong> Contact NZ Police:
            <a href="${NZ_POLICE.reportStolen}" target="_blank" rel="noopener">105 Online</a>
            · <a href="tel:105">105</a>
            · <a href="${NZ_POLICE.faqLostStolenFound}" target="_blank" rel="noopener">FAQs</a>
          `;
        }
        return;
      }
    }

    const offer = calcOffer({ marketValue, condition, model, shutterCount, payout });

    const trade = {
      id: `t_${Date.now().toString(36)}`,
      storeId,
      brand,
      model,
      category,
      marketValue,
      condition,
      serial: serial || null,
      shutterCount,
      customer,
      notes,
      payout,
      offer,
      createdAt: new Date().toISOString(),
      status: 'accepted',
    };

    state.trades.unshift(trade);

    // Inventory
    state.inventory.unshift({
      id: `inv_${trade.id}`,
      tradeId: trade.id,
      storeId,
      title: `${brand} ${model}`,
      category,
      condition,
      serial: serial || null,
      shutterCount,
      cost: offer.tradeValue,
      listPrice: Math.round(offer.tradeValue * 1.35 * 100) / 100,
      status: 'in_stock',
      createdAt: trade.createdAt,
    });

    // Credits
    if (payout === 'credit') {
      const key = `${storeId}::${customer.toLowerCase()}`;
      if (!state.credits[key]) {
        state.credits[key] = { customer, storeId, balance: 0, history: [] };
      }
      state.credits[key].balance =
        Math.round((state.credits[key].balance + offer.tradeValue) * 100) / 100;
      state.credits[key].history.unshift({
        tradeId: trade.id,
        amount: offer.tradeValue,
        at: trade.createdAt,
      });
    } else {
      // Cash via Connect
      const transfer = createCashTransfer(trade);
      trade.transferId = transfer.id;
      trade.idempotencyKey = transfer.idempotencyKey;
      logWebhook('transfer.created', transfer);
      logWebhook('transfer.paid', { ...transfer, status: 'paid' });
    }

    state.activeStoreId = storeId;
    save();
    toast(
      payout === 'credit'
        ? `Trade accepted · $${offer.tradeValue.toFixed(2)} credit`
        : `Trade accepted · cash net $${offer.cashNet.toFixed(2)}`
    );
    renderAll();
    $('#tradeForm').reset();
    $('#tradeStore').value = storeId;
    previewOffer();
  }

  // ---- Renderers ----
  function renderInventory() {
    const filter = $('#invStoreFilter').value || 'all';
    const items = state.inventory.filter(
      (i) => filter === 'all' || i.storeId === filter
    );
    if (!items.length) {
      $('#inventoryList').innerHTML = '<div class="empty">No inventory yet.</div>';
      return;
    }
    $('#inventoryList').innerHTML = items
      .map((i) => {
        const store = storeById(i.storeId);
        return `
        <div class="item">
          <div class="meta">
            <div class="title">${i.title}</div>
            <div class="sub">
              ${store?.name || i.storeId} · ${i.condition} · cost $${i.cost}
              ${i.serial ? ` · SN ${i.serial}` : ''}
              ${i.shutterCount != null ? ` · shutter ${i.shutterCount}` : ''}
            </div>
            <div class="sub">List $${i.listPrice} · <span class="badge ${i.status === 'listed' ? 'ok' : ''}">${i.status}</span></div>
          </div>
          <div>
            ${
              i.status === 'in_stock'
                ? `<button type="button" class="btn secondary" data-list="${i.id}">List for resale</button>`
                : `<button type="button" class="btn ghost" data-sold="${i.id}">Mark sold</button>`
            }
          </div>
        </div>`;
      })
      .join('');
  }

  function renderCredits() {
    const entries = Object.values(state.credits);
    if (!entries.length) {
      $('#creditList').innerHTML = '<div class="empty">No customer credits yet.</div>';
      return;
    }
    $('#creditList').innerHTML = entries
      .map((c) => {
        const store = storeById(c.storeId);
        return `
        <div class="item">
          <div class="meta">
            <div class="title">${c.customer}</div>
            <div class="sub">${store?.name || c.storeId} · ${c.history.length} trade(s)</div>
          </div>
          <strong>$${c.balance.toFixed(2)}</strong>
        </div>`;
      })
      .join('');
  }

  function renderStripe() {
    const accts = Object.entries(state.stripeAccounts);
    $('#stripeAccounts').innerHTML = accts.length
      ? accts
          .map(([sid, a]) => {
            const s = storeById(sid);
            return `<div class="item"><div class="meta"><div class="title">${s?.name || sid}</div>
              <div class="sub">${a.accountId} · Express · charges ${a.chargesEnabled ? 'on' : 'off'}</div></div>
              <span class="badge ok">connected</span></div>`;
          })
          .join('')
      : '<div class="empty">No stores onboarded yet.</div>';

    $('#transferList').innerHTML = state.transfers.length
      ? state.transfers
          .map(
            (t) => `<div class="item"><div class="meta"><div class="title">$${t.amount} → ${t.accountId}</div>
            <div class="sub">fee $${t.fee} · ${t.idempotencyKey} · ${new Date(t.createdAt).toLocaleString()}</div></div>
            <span class="badge ok">${t.status}</span></div>`
          )
          .join('')
      : '<div class="empty">No transfers yet.</div>';

    const keys = Object.entries(state.idempotencyKeys);
    $('#idempotencyList').innerHTML = keys.length
      ? keys
          .slice(0, 20)
          .map(
            ([k, v]) =>
              `<div class="item"><div class="meta"><div class="title">${k}</div>
              <div class="sub">${v.createdAt}</div></div></div>`
          )
          .join('')
      : '<div class="empty">No idempotency keys used yet.</div>';

    renderWebhookLog();
  }

  function renderWebhookLog() {
    $('#webhookLog').textContent = state.webhookLog.length
      ? state.webhookLog
          .map((e) => `[${e.receivedAt}] ${e.type}\n${JSON.stringify(e.payload, null, 2)}`)
          .join('\n\n')
      : 'No webhook events yet. Use simulator buttons.';
  }

  function renderAll() {
    updateStorePill();
    renderStores();
    renderInventory();
    renderCredits();
    renderStripe();
    previewOffer();
  }

  // ---- EXIF upload (optional backend) ----
  async function extractShutterFromFile(file) {
    // Prefer local server endpoint if running
    try {
      const fd = new FormData();
      fd.append('photo', file);
      const res = await fetch('/api/exif-shutter', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch (_) {}
    return null;
  }

  // ---- Events ----
  function bind() {
    $$('#tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#tabs button').forEach((b) => b.classList.remove('active'));
        $$('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $(`#tab-${btn.dataset.tab}`).classList.add('active');
      });
    });

    ['marketValue', 'condition', 'model', 'shutterCount'].forEach((id) => {
      $(`#${id}`).addEventListener('input', previewOffer);
    });
    $$('input[name="payout"]').forEach((r) =>
      r.addEventListener('change', previewOffer)
    );
    $('#tradeStore').addEventListener('change', () => {
      state.activeStoreId = $('#tradeStore').value;
      save();
      updateStorePill();
      previewOffer();
    });

    $('#tradeForm').addEventListener('submit', acceptTrade);
    $('#btnResetTrade').addEventListener('click', () => {
      $('#tradeForm').reset();
      $('#stolenResult').textContent = '';
      previewOffer();
    });

    function showPoliceActions(stolen, source) {
      const box = $('#stolenPoliceActions');
      if (!box) return;
      box.classList.remove('hidden');
      if (stolen) {
        box.classList.remove('clean');
        box.innerHTML = `
          <strong>Do not accept this trade.</strong>
          Suspected stolen goods should be reported to NZ Police (not handled only in-app).<br/>
          <a href="${NZ_POLICE.reportStolen}" target="_blank" rel="noopener">Report stolen (105 Online)</a>
          · <a href="${NZ_POLICE.reportStolenForm}" target="_blank" rel="noopener">Stolen property form</a>
          · call <a href="tel:105">105</a>
          · emergency <a href="tel:111">111</a><br/>
          <span class="muted">Demo match source: ${source}. No public Police camera serial API
          (old <a href="${NZ_POLICE.snapDecommissioned}" target="_blank" rel="noopener">SNAP</a> was shut 2021).
          <a href="${NZ_POLICE.faqLostStolenFound}" target="_blank" rel="noopener">Police FAQs</a>
          · <a href="${NZ_POLICE.seriSafe}" target="_blank" rel="noopener">SeriSafe</a>
          · <a href="${NZ_POLICE.ecoStolenGoods}" target="_blank" rel="noopener">Ecotechnologies</a>.</span>
        `;
      } else {
        box.classList.add('clean');
        box.innerHTML = `
          No match on the <em>demo / mock</em> list (${source}). This is <strong>not</strong> a Police clearance.
          SNAP (<a href="${NZ_POLICE.snapDecommissioned}" target="_blank" rel="noopener">decommissioned 2021</a>) is offline.
          Record serials + photos; optional commercial check:
          <a href="${NZ_POLICE.seriSafe}" target="_blank" rel="noopener">SeriSafe</a>
          · <a href="${NZ_POLICE.secondhandDealers}" target="_blank" rel="noopener">dealer duties</a>
          · <a href="${NZ_POLICE.ecoStolenGoods}" target="_blank" rel="noopener">stolen goods guide</a>
        `;
      }
    }

    $('#btnStolenCheck').addEventListener('click', async () => {
      const serial = $('#serial').value;
      if (!serial.trim()) {
        toast('Enter a serial number', 'error');
        return;
      }
      $('#stolenResult').textContent = 'Checking…';
      $('#stolenResult').className = 'hint';
      $('#stolenPoliceActions')?.classList.add('hidden');
      const r = await checkStolen(serial);
      if (r.stolen) {
        $('#stolenResult').textContent = `⚠ MATCH — STOLEN (${r.source}). Do not accept.`;
        $('#stolenResult').className = 'hint danger';
        showPoliceActions(true, r.source);
        toast('Stolen gear warning — see NZ Police links', 'error');
      } else {
        $('#stolenResult').textContent = `✓ No mock match (${r.source}) — not a Police clearance`;
        $('#stolenResult').className = 'hint ok';
        showPoliceActions(false, r.source);
      }
    });

    $('#exifFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      toast('Reading EXIF…');
      const data = await extractShutterFromFile(file);
      if (data?.shutterCount != null) {
        $('#shutterCount').value = data.shutterCount;
        if (data.model && !$('#model').value) $('#model').value = data.model;
        if (data.serial && !$('#serial').value) $('#serial').value = data.serial;
        if (data.make && !$('#brand').value) $('#brand').value = data.make;
        $('#shutterHint').textContent = `EXIF: shutter ${data.shutterCount}${data.model ? ` · ${data.model}` : ''}`;
        $('#shutterHint').className = 'hint ok';
        previewOffer();
        toast('Shutter count loaded from EXIF');
      } else {
        $('#shutterHint').textContent =
          'Could not read shutter count (start local server for ExifTool, or enter manually).';
        $('#shutterHint').className = 'hint warn';
        toast('EXIF read failed — enter count manually', 'error');
      }
    });

    $('#storeCards').addEventListener('click', (e) => {
      const id = e.target.dataset?.activate;
      if (!id) return;
      state.activeStoreId = id;
      $('#tradeStore').value = id;
      save();
      renderAll();
      toast(`Active store: ${storeById(id).name}`);
    });

    $('#inventoryList').addEventListener('click', (e) => {
      const listId = e.target.dataset?.list;
      const soldId = e.target.dataset?.sold;
      if (listId) {
        const item = state.inventory.find((i) => i.id === listId);
        if (item) {
          item.status = 'listed';
          save();
          renderInventory();
          toast('Listed for resale');
        }
      }
      if (soldId) {
        const item = state.inventory.find((i) => i.id === soldId);
        if (item) {
          item.status = 'sold';
          save();
          renderInventory();
          toast('Marked sold');
        }
      }
    });

    $('#invStoreFilter').addEventListener('change', renderInventory);
    $('#btnListAll').addEventListener('click', () => {
      state.inventory.forEach((i) => {
        if (i.status === 'in_stock') i.status = 'listed';
      });
      save();
      renderInventory();
      toast('All in-stock items listed');
    });

    $('#btnOnboardStore').addEventListener('click', () => {
      onboardStore(state.activeStoreId);
    });

    $('#btnSimPayout').addEventListener('click', () => {
      const trade = state.trades.find((t) => t.payout === 'cash');
      if (!trade) {
        toast('No cash trades to pay out', 'error');
        return;
      }
      // Force same idempotency key to demo replay
      const key = trade.idempotencyKey || generateIdempotencyKey(`payout_${trade.id}`);
      const result = createCashTransfer(trade, { idempotencyKey: key });
      toast(
        result.replayed
          ? 'Idempotent replay — no duplicate transfer'
          : `Transfer ${result.id} · $${result.amount}`
      );
      renderStripe();
    });

    $$('[data-webhook]').forEach((btn) => {
      btn.addEventListener('click', () => simulateWebhook(btn.dataset.webhook));
    });
  }

  // init
  fillStoreSelects();
  bind();
  renderAll();
}
