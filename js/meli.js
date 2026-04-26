// ─── MELI INTEGRATION ────────────────────────────────────────────────────────
// Archivo independiente: no modifica datos existentes de Firebase.
// Nuevas colecciones: meta/meliConfig · meta/meliIgnored

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const MELI_AUTH_URL    = 'https://auth.mercadolibre.com.ar/authorization';
const MELI_TOKEN_URL   = 'https://api.mercadolibre.com/oauth/token';
const MELI_API_BASE    = 'https://api.mercadolibre.com';
const MELI_POLL_MS     = 15 * 60 * 1000;
const LS_MELI_TOKENS   = 'fs_meli_tokens_v1';
const LS_MELI_IGNORED  = 'fs_meli_ignored_v1';
const LS_MELI_APPID    = 'fs_meli_appid_v1';
const LS_MELI_SECRET   = 'fs_meli_secret_v1';

// ─── ESTADO ───────────────────────────────────────────────────────────────────
let meliAppId       = '';
let meliSecret      = '';
let meliTokens      = { capi: null, enano: null };
let meliIgnoredIds  = new Set();
let meliSuggestions = [];
let meliPollTimer   = null;
let meliSelectedSug = null;
let meliAuthPopup   = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function meliInit() {
  _meliLoadLocal();
  await _meliLoadFirestore();
  updateMeliSettingsUI();
  startMeliPolling();
  if (meliTokens.capi || meliTokens.enano) syncMeli(false);
}

function _meliLoadLocal() {
  try { const v = localStorage.getItem(LS_MELI_APPID);   if (v) meliAppId  = v; } catch(e) {}
  try { const v = localStorage.getItem(LS_MELI_SECRET);  if (v) meliSecret = v; } catch(e) {}
  try {
    const t = JSON.parse(localStorage.getItem(LS_MELI_TOKENS) || 'null');
    if (t) { meliTokens.capi = t.capi || null; meliTokens.enano = t.enano || null; }
  } catch(e) {}
  try {
    const ig = JSON.parse(localStorage.getItem(LS_MELI_IGNORED) || 'null');
    if (ig) meliIgnoredIds = new Set(ig);
  } catch(e) {}
}

async function _meliLoadFirestore() {
  try {
    const s = await db.collection('meta').doc('meliConfig').get();
    if (s.exists) {
      const d = s.data();
      if (d.appId)  { meliAppId  = d.appId;  localStorage.setItem(LS_MELI_APPID,  d.appId);  }
      if (d.secret) { meliSecret = d.secret; localStorage.setItem(LS_MELI_SECRET, d.secret); }
      if (d.capi)  meliTokens.capi  = d.capi;
      if (d.enano) meliTokens.enano = d.enano;
      _meliSaveTokensLocal();
    }
  } catch(e) {}
  try {
    const s = await db.collection('meta').doc('meliIgnored').get();
    if (s.exists && Array.isArray(s.data().ids)) {
      meliIgnoredIds = new Set(s.data().ids);
      localStorage.setItem(LS_MELI_IGNORED, JSON.stringify([...meliIgnoredIds]));
    }
  } catch(e) {}
}

function _meliSaveTokensLocal() {
  try { localStorage.setItem(LS_MELI_TOKENS, JSON.stringify(meliTokens)); } catch(e) {}
}

function _meliSaveConfig() {
  _meliSaveTokensLocal();
  try { localStorage.setItem(LS_MELI_APPID,  meliAppId);  } catch(e) {}
  try { localStorage.setItem(LS_MELI_SECRET, meliSecret); } catch(e) {}
  db.collection('meta').doc('meliConfig').set({
    appId: meliAppId, secret: meliSecret || null,
    capi: meliTokens.capi || null, enano: meliTokens.enano || null,
  }).catch(() => {});
}

function _meliSaveIgnored() {
  try { localStorage.setItem(LS_MELI_IGNORED, JSON.stringify([...meliIgnoredIds])); } catch(e) {}
  db.collection('meta').doc('meliIgnored').set({ ids: [...meliIgnoredIds] }).catch(() => {});
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────
function _b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function _generatePKCE() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier  = _b64url(raw.buffer);
  const hashBuf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = _b64url(hashBuf);
  return { verifier, challenge };
}

// ─── OAUTH — Authorization Code + PKCE ───────────────────────────────────────
window.meliOpenAuth = async (account) => {
  const inp = document.getElementById('meli-app-id-input');
  const appId = inp?.value?.trim() || meliAppId;
  if (!appId) { toast('Primero ingresá el App ID de MELI'); return; }
  meliAppId = appId;
  localStorage.setItem(LS_MELI_APPID, appId);

  const redirectUri = window.location.origin + window.location.pathname;
  const state = `${account}_${Date.now()}`;
  const { verifier, challenge } = await _generatePKCE();

  // Guardar verifier para el intercambio de código
  localStorage.setItem('meli_pkce_verifier', verifier);
  localStorage.setItem('meli_pkce_account', account);

  const url = `${MELI_AUTH_URL}?response_type=code`
    + `&client_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`
    + `&code_challenge=${encodeURIComponent(challenge)}`
    + `&code_challenge_method=S256`;

  console.log('[MELI] App ID:', appId);
  console.log('[MELI] Redirect URI:', redirectUri);
  console.log('[MELI] Auth URL:', url);

  if (meliAuthPopup && !meliAuthPopup.closed) meliAuthPopup.close();
  meliAuthPopup = window.open(url, 'meli_auth', 'width=620,height=740,left=100,top=60');
  if (!meliAuthPopup) { toast('Habilitá pop-ups para conectar MELI'); return; }

  toast('Esperando autorización MELI...');

  // Pollear hasta que el popup vuelva a nuestro dominio con ?code=
  const poll = setInterval(async () => {
    try {
      if (!meliAuthPopup || meliAuthPopup.closed) { clearInterval(poll); return; }
      const qs = meliAuthPopup.location.search; // solo funciona cuando ya es same-origin
      if (qs && qs.includes('code=')) {
        clearInterval(poll);
        const params = new URLSearchParams(qs.substring(1));
        const code   = params.get('code');
        meliAuthPopup.close();
        if (code) await _meliExchangeCode(account, code, verifier, redirectUri);
        else toast('No se recibió código de MELI');
      }
    } catch(e) { /* Popup en dominio de MELI, seguir esperando */ }
  }, 600);
};

async function _meliExchangeCode(account, code, verifier, redirectUri) {
  try {
    const params = {
      grant_type:    'authorization_code',
      client_id:     meliAppId,
      code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    };
    if (meliSecret) params.client_secret = meliSecret;
    const res = await fetch(MELI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    });
    const data = await res.json();
    console.log('[MELI] exchange response:', res.status, JSON.stringify(data));
    if (!res.ok || !data.access_token) {
      toast(`Error MELI: ${data.message || data.error || res.status}`);
      return;
    }
    meliTokens[account] = {
      token:        data.access_token,
      refreshToken: data.refresh_token || null,
      userId:       String(data.user_id),
      expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
    };
    _meliSaveConfig();
    localStorage.removeItem('meli_pkce_verifier');
    localStorage.removeItem('meli_pkce_account');
    updateMeliSettingsUI();
    toast(`✓ MELI ${account.toUpperCase()} conectado`);
    syncMeli(false);
  } catch(e) {
    toast('Error al conectar con MELI — revisá el App ID');
    console.error('MELI exchange:', e);
  }
}

async function _meliRefreshToken(account) {
  const ac = meliTokens[account];
  if (!ac?.refreshToken) return false;
  try {
    const params = {
      grant_type:    'refresh_token',
      client_id:     meliAppId,
      refresh_token: ac.refreshToken,
    };
    if (meliSecret) params.client_secret = meliSecret;
    const res = await fetch(MELI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) return false;
    meliTokens[account] = {
      ...ac,
      token:        data.access_token,
      refreshToken: data.refresh_token || ac.refreshToken,
      expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
    };
    _meliSaveConfig();
    updateMeliSettingsUI();
    return true;
  } catch(e) { return false; }
}

// Obtener token válido (renueva automáticamente con refresh_token)
async function _meliGetToken(account) {
  const ac = meliTokens[account];
  if (!ac) return null;
  if (Date.now() < ac.expiresAt) return ac.token;
  // Intentar renovar
  const ok = await _meliRefreshToken(account);
  if (ok) return meliTokens[account].token;
  // Sin refresh_token o falló: pedir reconexión
  meliTokens[account] = null;
  _meliSaveConfig();
  updateMeliSettingsUI();
  toast(`Sesión MELI ${account.toUpperCase()} expirada — reconectá`);
  return null;
}

// ─── API HELPERS ──────────────────────────────────────────────────────────────
async function _meliGet(path, token) {
  const res = await fetch(`${MELI_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`MELI ${res.status} ${path}`);
  return res.json();
}

// ─── FETCH ÓRDENES DEL DÍA ────────────────────────────────────────────────────
async function _fetchTodayOrders(account) {
  const token = await _meliGetToken(account);
  if (!token) return [];
  const ac = meliTokens[account];
  if (!ac?.userId) return [];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = today.toISOString().replace(/\.\d{3}Z$/, '.000Z');

  try {
    const data = await _meliGet(
      `/orders/search?seller=${ac.userId}&order.status=paid&order.date_created.from=${encodeURIComponent(from)}&limit=50&sort=date_desc`,
      token
    );
    return (data.results || []).map(o => ({ ...o, _account: account }));
  } catch(e) {
    console.warn(`MELI ${account} orders:`, e.message);
    return [];
  }
}

// ─── SYNC PRINCIPAL ───────────────────────────────────────────────────────────
async function syncMeli(showToast = true) {
  if (!meliTokens.capi && !meliTokens.enano) {
    if (showToast) toast('MELI no conectado — configurá en ajustes');
    return;
  }
  const syncBtn = document.getElementById('btn-sync');
  if (syncBtn) syncBtn.classList.add('syncing');
  if (showToast) toast('Sincronizando MELI...');

  try {
    const [capiOrders, enanoOrders] = await Promise.all([
      _fetchTodayOrders('capi'),
      _fetchTodayOrders('enano'),
    ]);
    const all = [...capiOrders, ...enanoOrders];

    const suggestions = [];
    for (const o of all) {
      const id = String(o.id);
      if (meliIgnoredIds.has(id))  continue;
      if (_isMeliOrderLoaded(id))  continue;
      if (_isMeliDispatched(o))    continue;
      suggestions.push(_buildSuggestion(o));
    }
    meliSuggestions = suggestions;
    updateMeliBadge();

    if (suggestions.length > 0 && document.hidden) _notifyNewOrders(suggestions.length);
    await _updateTracking(all);

    if (showToast) {
      toast(suggestions.length > 0
        ? `${suggestions.length} pedido${suggestions.length > 1 ? 's' : ''} nuevo${suggestions.length > 1 ? 's' : ''} en MELI ✓`
        : 'MELI sincronizado ✓'
      );
    }
  } catch(e) {
    console.warn('MELI sync:', e);
    if (showToast) toast('Error al sincronizar con MELI');
  } finally {
    if (syncBtn) syncBtn.classList.remove('syncing');
  }
}
window.syncMeli = syncMeli;

// ─── FILTROS ──────────────────────────────────────────────────────────────────
function _isMeliOrderLoaded(meliId) {
  return orders.some(o => String(o.meliOrderId) === meliId);
}
function _isMeliDispatched(order) {
  return ['shipped', 'delivered', 'not_delivered', 'cancelled'].includes(order.shipping?.status);
}

// ─── CONSTRUIR SUGERENCIA ─────────────────────────────────────────────────────
function _buildSuggestion(order) {
  const tipoEnvio = _detectShipping(order);
  return {
    meliOrderId: String(order.id),
    account:     order._account,
    nombre:      _getBuyerName(order),
    tipoEnvio,
    localidad:   _getLocality(order),
    provincia:   _getProvince(order),
    importe:     _getAmount(order, tipoEnvio),
    items:       _parseItems(order.order_items),
    dateCreated: order.date_created,
  };
}

function _detectShipping(order) {
  const logistic = order.shipping?.logistic_type || '';
  const tags = order.tags || [];
  if (logistic === 'self_service' || tags.includes('self_service_in') || tags.includes('fulfillment'))
    return 'FLEX';
  return 'PE';
}
function _getBuyerName(order) {
  const rec = order.shipping?.receiver_address;
  if (rec?.receiver_name) return titleCase(rec.receiver_name.trim());
  const b = order.buyer;
  if (b?.first_name) return titleCase(`${b.first_name} ${b.last_name || ''}`.trim());
  if (b?.nickname)   return titleCase(b.nickname.trim());
  return '';
}
function _getLocality(order) {
  const a = order.shipping?.receiver_address;
  return a?.city?.name || a?.municipality?.name || '';
}
function _getProvince(order) {
  const a = order.shipping?.receiver_address;
  return a?.state?.name || '';
}
function _getAmount(order, tipoEnvio) {
  const pay = (order.payments || [])[0];
  if (!pay) return 0;
  return tipoEnvio === 'FLEX'
    ? (pay.total_paid_amount || pay.transaction_amount || 0)
    : (pay.net_received_amount || pay.total_paid_amount || 0);
}

// ─── PARSEO DE ÍTEMS ─────────────────────────────────────────────────────────
function _parseSku(sku) {
  if (!sku) return null;
  const c = sku.replace(/-/g, '').toUpperCase();
  let product = null;
  if (/MEDIAMOST|MEDIAMOSTAZA/.test(c)) product = 'Media caña';
  else if (/MOST/.test(c))             product = 'Mostaza';
  else if (/TOTAL/.test(c))            product = 'Total Black';
  else if (/CARAM/.test(c))            product = 'Caramelo';
  else if (/BORCEG/.test(c))           product = 'Borcegos';
  else if (/BANDERA/.test(c))          product = 'Banderas';
  else if (/COLAP/.test(c))            product = 'Remeras Colapinto';
  if (!product) return null;
  const numMatch = sku.match(/(\d{2})$/);
  let talle = numMatch ? parseInt(numMatch[1], 10) : null;
  if (!talle && product === 'Remeras Colapinto') talle = 'L';
  return { product, talle };
}
function _parseTalleFromVariant(name) {
  if (!name) return null;
  const mMatch = name.match(/(\d+x\d+)/i);
  if (mMatch) return mMatch[1];
  const nMatch = name.match(/\|\s*(\d{2})\s*AR/i) || name.match(/\b(3[89]|4[0-5])\b/);
  return nMatch ? parseInt(nMatch[1], 10) : null;
}
function _parseProductFromTitle(title) {
  const c = (title || '').replace(/-/g, '').toUpperCase();
  if (/MEDIAMOST|MEDIAMOSTAZA/.test(c)) return 'Media caña';
  if (/TOTAL/.test(c))  return 'Total Black';
  if (/MOST/.test(c))   return 'Mostaza';
  if (/CARAM/.test(c))  return 'Caramelo';
  if (/BORCEG/.test(c)) return 'Borcegos';
  if (/BANDERA/.test(c))return 'Banderas';
  if (/COLAP/.test(c))  return 'Remeras Colapinto';
  return null;
}
function _parseItems(orderItems) {
  const result = [];
  for (const item of (orderItems || [])) {
    const qty = item.quantity || 1;
    let parsed = _parseSku(item.item?.seller_sku);
    if (!parsed || !parsed.talle) {
      const varAttr = (item.item?.variation_attributes || []).find(a =>
        /SIZE|talle|número|number/i.test(a.id || a.name || '')
      );
      const variantName = varAttr?.value_name || item.item?.title || '';
      if (!parsed) {
        const product = _parseProductFromTitle(item.item?.seller_sku || item.item?.title || '');
        parsed = product ? { product, talle: null } : null;
      }
      if (parsed && !parsed.talle) {
        parsed.talle = _parseTalleFromVariant(variantName);
        if (!parsed.talle && parsed.product === 'Remeras Colapinto') parsed.talle = 'L';
      }
    }
    if (parsed?.product) {
      for (let i = 0; i < qty; i++) result.push({ producto: parsed.product, talle: parsed.talle });
    }
  }
  return result;
}

// ─── BADGE ────────────────────────────────────────────────────────────────────
function updateMeliBadge() {
  const badge = document.getElementById('meli-badge');
  if (!badge) return;
  const n = meliSuggestions.length;
  badge.textContent = n > 0 ? String(n) : '';
  badge.classList.toggle('show', n > 0);
}
window.updateMeliBadge = updateMeliBadge;

function _notifyNewOrders(count) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('FullSports — Pedidos nuevos', {
    body: `${count} pedido${count > 1 ? 's' : ''} sin cargar`,
    icon: 'icons/icon-192.png',
    tag: 'meli-new-orders', renotify: true,
  });
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
function startMeliPolling() {
  if (meliPollTimer) clearInterval(meliPollTimer);
  meliPollTimer = setInterval(() => syncMeli(false), MELI_POLL_MS);
}

// ─── SUGERENCIAS EN FORMULARIO ────────────────────────────────────────────────
window.renderMeliSuggestions = function() {
  const panel = document.getElementById('meli-suggestions-panel');
  const list  = document.getElementById('meli-suggestions-list');
  if (!panel || !list) return;
  if (!meliSuggestions.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  list.innerHTML = meliSuggestions.map(sug => {
    const itemsTxt = sug.items.length
      ? sug.items.map(i => `${i.producto}${i.talle ? ' T'+i.talle : ' (talle?)'}`).join(', ')
      : '';
    const importeTxt = sug.importe ? `$${Math.round(sug.importe).toLocaleString('es-AR')}` : '';
    return `
      <div class="meli-sug-item">
        <div class="meli-sug-body" onclick="meliSelectSuggestion('${sug.meliOrderId}')">
          <div class="meli-sug-row1">
            <span class="meli-sug-account ${sug.account}">${sug.account.toUpperCase()}</span>
            <span class="meli-sug-name">${sug.nombre || '—'}</span>
            <span class="meli-sug-tag ${sug.tipoEnvio.toLowerCase()}">${sug.tipoEnvio}</span>
          </div>
          ${sug.localidad || importeTxt ? `
          <div class="meli-sug-row2">
            ${sug.localidad ? `<span>📍 ${sug.localidad}</span>` : ''}
            ${importeTxt ? `<span>💰 ${importeTxt}</span>` : ''}
          </div>` : ''}
          ${itemsTxt ? `<div class="meli-sug-items">${itemsTxt}</div>` : ''}
        </div>
        <button class="meli-sug-dismiss" onclick="event.stopPropagation();meliDismiss('${sug.meliOrderId}')" title="Descartar">✕</button>
      </div>`;
  }).join('');
};

window.meliSelectSuggestion = function(meliOrderId) {
  const sug = meliSuggestions.find(s => s.meliOrderId === meliOrderId);
  if (!sug) return;
  meliSelectedSug = sug;
  _fillFormFromSuggestion(sug);
  document.getElementById('meli-suggestions-panel')?.classList.add('collapsed');
};

function _fillFormFromSuggestion(sug) {
  setCuenta(sug.account || 'capi');
  setEnvio(sug.tipoEnvio || 'FLEX');
  V('f-nombre').value = sug.nombre || '';
  if (sug.tipoEnvio === 'FLEX') {
    if (sug.importe) V('f-importe-flex').value = Math.round(sug.importe);
    if (sug.localidad) {
      const norm = normalizeStr(sug.localidad.toLowerCase());
      const zone = zones.find(z =>
        normalizeStr(z.localidad.toLowerCase()).includes(norm) ||
        norm.includes(normalizeStr(z.localidad.toLowerCase()))
      );
      if (zone) { formEnvio = { localidad: zone.localidad, zona: zone.zona, importe: zone.importe }; showZoneSelected(); }
      else V('f-localidad').value = sug.localidad;
      updateNeto();
    }
  } else {
    if (sug.importe) V('f-importe-pe').value = Math.round(sug.importe);
  }
  if (sug.account === 'enano' && sug.provincia) V('f-provincia').value = sug.provincia;
  const validItems = sug.items.filter(i => i.talle);
  if (validItems.length) { formItems = validItems; renderFormItems(); }
  haptic([10, 30, 10]);
  toast('Datos cargados desde MELI ✓');
}

window.meliDismiss = function(meliOrderId) {
  meliIgnoredIds.add(String(meliOrderId));
  _meliSaveIgnored();
  meliSuggestions = meliSuggestions.filter(s => s.meliOrderId !== String(meliOrderId));
  updateMeliBadge();
  window.renderMeliSuggestions();
};

function meliMarkLoaded(meliOrderId) {
  if (!meliOrderId) return;
  meliSuggestions = meliSuggestions.filter(s => s.meliOrderId !== String(meliOrderId));
  meliSelectedSug = null;
  updateMeliBadge();
}
window.meliMarkLoaded = meliMarkLoaded;

function meliGetSelectedId()  { return meliSelectedSug?.meliOrderId || null; }
function meliResetSelected()  { meliSelectedSug = null; }
window.meliGetSelectedId  = meliGetSelectedId;
window.meliResetSelected  = meliResetSelected;

// ─── ALERTA DESPACHO INCONSISTENTE ───────────────────────────────────────────
async function meliCheckDispatch(pendOrders) {
  const withMeli = pendOrders.filter(o => o.meliOrderId);
  if (!withMeli.length) return;
  const inconsistentes = [];
  for (const order of withMeli) {
    const token = await _meliGetToken(order.cuenta);
    if (!token) continue;
    try {
      const mo = await _meliGet(`/orders/${order.meliOrderId}`, token);
      const st = mo.shipping?.status;
      if (!['shipped', 'delivered', 'handling', 'ready_to_ship'].includes(st))
        inconsistentes.push(order.nombreComprador);
    } catch(e) { console.warn('MELI dispatch check:', e.message); }
  }
  if (inconsistentes.length)
    toast(`⚠️ Sin despacho en MELI: ${inconsistentes.join(', ')}`, 6000);
}
window.meliCheckDispatch = meliCheckDispatch;

// ─── TRACKING ────────────────────────────────────────────────────────────────
async function _updateTracking(freshMeliOrders) {
  const inTransit = orders.filter(o => o.status === 'camino' && o.meliOrderId);
  if (!inTransit.length) return;
  let changed = false;
  for (const order of inTransit) {
    const mo = freshMeliOrders.find(m => String(m.id) === String(order.meliOrderId));
    if (mo?.shipping?.status === 'delivered') {
      const f = new Date().toLocaleDateString('es-AR');
      mutateOrder(order.id, { status: 'entregado', fechaEntrega: f, deliveredAt: Date.now() });
      try { await db.collection('orders').doc(order.id).update({ status: 'entregado', deliveredAt: TS(), fechaEntrega: f }); } catch(e) {}
      changed = true;
    }
  }
  if (changed) renderPedidos();
}

// ─── SETTINGS UI ─────────────────────────────────────────────────────────────
function updateMeliSettingsUI() {
  _setStatusEl('meli-capi-status',  meliTokens.capi,  'CAPI');
  _setStatusEl('meli-enano-status', meliTokens.enano, 'ENANO');
  const inpId  = document.getElementById('meli-app-id-input');
  if (inpId  && meliAppId  && !inpId.value)  inpId.value  = meliAppId;
  const inpSec = document.getElementById('meli-secret-input');
  if (inpSec && meliSecret && !inpSec.value) inpSec.value = meliSecret;
  const uriEl = document.getElementById('meli-redirect-uri');
  if (uriEl && !uriEl.textContent) uriEl.textContent = window.location.origin + window.location.pathname;
}
function _setStatusEl(elId, ac, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (ac && Date.now() < ac.expiresAt) {
    const mins = Math.round((ac.expiresAt - Date.now()) / 60000);
    el.textContent = `✓ Conectado (${mins < 60 ? mins + 'min' : Math.round(mins/60) + 'h'})`;
    el.className = 'meli-conn-status connected';
  } else if (ac?.refreshToken) {
    el.textContent = 'Renovando...';
    el.className = 'meli-conn-status connected';
  } else {
    el.textContent = 'No conectado';
    el.className = 'meli-conn-status';
  }
}
window.meliSaveAppId = function() {
  const inp = document.getElementById('meli-app-id-input');
  const val = inp?.value?.trim();
  if (!val) { toast('Ingresá el App ID'); return; }
  meliAppId = val; _meliSaveConfig(); toast('App ID guardado ✓');
};
window.meliSaveSecret = function() {
  const inp = document.getElementById('meli-secret-input');
  const val = inp?.value?.trim();
  if (!val) { toast('Ingresá el Secret Key'); return; }
  meliSecret = val; _meliSaveConfig(); toast('Secret Key guardado ✓');
};
