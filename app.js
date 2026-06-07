'use strict';

// ── Google Sheets Config ───────────────────────────────────────
let SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwpnWWC_FLbbSj5WU5pVOT5-62VRt0YNjzlNhTwGgDu9JmNdHLD9o5gYX8Zvje1fY3X/exec';

const STORAGE_KEY    = 'biz_mastermind_data';
const QE_GRID_KEY    = 'biz_qe_grid';
const QE_EXP_KEY     = 'biz_qe_exp';
const UI_STATE_KEY   = 'biz_ui_state';
const VAT_RATE       = 0.24;

// ── Storage helpers ────────────────────────────────────────────
// Primary: IndexedDB via idb-keyval (no size limit, stores JS objects natively).
// Fallback: compressed localStorage (lz-string) if IDB unavailable.
// Migration: first idbGet transparently moves old localStorage data to IDB.

// ── localStorage helpers (small keys: UI state, sync IDs) ──────
function lsSet(key, obj) {
  try {
    const json = JSON.stringify(obj);
    const out  = (typeof LZString !== 'undefined') ? LZString.compressToUTF16(json) : json;
    localStorage.setItem(key, out);
  } catch(_) {}
}
function lsGet(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  if (typeof LZString !== 'undefined') {
    try { const d = LZString.decompressFromUTF16(raw); if (d) return JSON.parse(d); } catch(_) {}
  }
  try { return JSON.parse(raw); } catch(_) {}
  return null;
}

// ── IndexedDB helpers (main data: income, expenses, QE drafts) ─
async function idbSet(key, value) {
  try {
    await idbKeyval.set(key, value);
  } catch(e) {
    lsSet(key, value); // fallback to compressed localStorage
  }
}
async function idbGet(key) {
  try {
    const val = await idbKeyval.get(key);
    if (val !== undefined) return val;
    // One-time migration: move old compressed-localStorage data into IDB
    const legacy = lsGet(key);
    if (legacy !== null) {
      await idbKeyval.set(key, legacy);
      localStorage.removeItem(key); // free the old space
      return legacy;
    }
  } catch(e) {
    return lsGet(key); // IDB unavailable — fall back
  }
  return null;
}

// Prune QE grid draft keys older than 6 months (they accumulate forever)
function pruneQEGridData() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  Object.keys(qeGridData).forEach(k => {
    const parts = k.split('|');
    if (parts.length >= 3 && parts[2] < cutoffStr) delete qeGridData[k];
  });
  Object.keys(qeExpenseGridData).forEach(d => {
    if (d < cutoffStr) delete qeExpenseGridData[d];
  });
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const DEFAULT_SERVICES = [
  'Social Media Management','Videography','Video Editing',
  'Video + Editing Package','Shorts Editing','Photo + Video Content',
  'Reels / Short Content','Story Management','Social Media Strategy',
  'Full Agency Package',
];

const CATEGORY_ICONS = {
  'Rent':'🏠','Subscriptions':'📱','Phone':'📞','Electricity':'⚡','Gas':'🔥',
  'Food & Entertainment':'🍽️','Equipment':'🎥','Professional Services':'💼',
  'Travel':'✈️','Investments':'📈','Social Insurance (EFKA)':'🛡️','Gifts':'🎁','Other Expenses':'📦',
};

const CLIENT_COLORS = [
  '#1565C0','#2E7D32','#6A1B9A','#00838F','#558B2F','#E65100','#AD1457',
  '#4527A0','#00695C','#F9A825','#37474F','#BF360C','#283593','#1B5E20',
  '#880E4F','#0277BD','#2e86ab','#f18f01','#c73e1d','#6d2b97',
];

const DEFAULT_CLIENTS = [
  { id:'C001', name:'Nikos Editing',      type:'Agency', color:'#1565C0', subclients:['Orfeas','Celfie','vasalos','alexandraki','rawhouse','elina','RAWOUSE','minicooper + TT','MERCEDES GLE','bmw','mercedes','Ginger - Backstage','Ginger - EP 5','Ginger - EP 6'] },
  { id:'C002', name:'1511',               type:'Direct', color:'#2E7D32', subclients:[] },
  { id:'C003', name:'onlynet',            type:'Agency', color:'#6A1B9A', subclients:['Sub-client 1','Sub-client 2','Sub-client 3'] },
  { id:'C004', name:'fipster',            type:'Direct', color:'#00838F', subclients:[] },
  { id:'C005', name:'plytarias',          type:'Direct', color:'#558B2F', subclients:[] },
  { id:'C006', name:'maron',              type:'Direct', color:'#E65100', subclients:[] },
  { id:'C007', name:'susuro',             type:'Agency', color:'#AD1457', subclients:['Sub-client 1','Sub-client 2'] },
  { id:'C008', name:'theodosiou leather', type:'Direct', color:'#4527A0', subclients:[] },
  { id:'C009', name:'gr2me theo',         type:'Direct', color:'#00695C', subclients:[] },
  { id:'C010', name:'Artist',             type:'Direct', color:'#F9A825', subclients:[] },
  { id:'C011', name:'livadeia',           type:'Direct', color:'#37474F', subclients:[] },
  { id:'C012', name:'vasilis social',     type:'Direct', color:'#BF360C', subclients:[] },
  { id:'C013', name:'barber',             type:'Direct', color:'#283593', subclients:[] },
  { id:'C014', name:'Mousikos',           type:'Direct', color:'#1B5E20', subclients:[] },
];

// ── State ──────────────────────────────────────────────────────
let state = { clients:[], income:[], expenses:[], services:[] };
let currentView = 'dashboard';

// Auto-sync
let autoSyncEnabled  = false;
let autoSyncInterval = null;

// Entry editing
let editingEntryId   = null;
let editingEntryType = null;

// Dashboard filter
let dashMonth = 'all';

// Income filters
let incMonth='all', incClient='all', incStatus='all', incPayType='all';
let incViewMode = 'detailed'; // 'byclient' | 'detailed' | 'cards'

// Expense filters
let expMonth='all', expCategory='all';
let expViewMode = 'detailed';

// Split payment
let incSplitMode = false;

// Qty × Price mode in income form
let incQtyMode = false;

// Report filter
let reportPayFilter = 'all';
let reportSubMode   = 'separated'; // 'combined' | 'separated'

// Print options dialog
let _printSubMode   = 'separated';
let _printPayFilter = 'all';

// Quick entry tab
let qeTab = 'income';

// QE Grid / Spreadsheet state
let qeGridMonth = '';
let qeGridSelectedClients = [];
let qeGridService = 'Video Editing'; // default for new client columns
let qeClientServices = {}; // clientId → service override

// sub = subclient name (agency) or '' (direct)
// Fallback chain: subclient override → client override → global default
function getClientService(cid, sub) {
  if (sub) {
    const subKey = cid + '|' + sub;
    if (qeClientServices[subKey]) return qeClientServices[subKey].trim();
  }
  return (qeClientServices[cid] || qeGridService || 'Video Editing').trim();
}
// setClientService(cid, '', svc)  → client-level default (direct clients & agency default)
// setClientService(cid, sub, svc) → per-subclient override (agency subclients)
function setClientService(cid, sub, svc) {
  const key = sub ? (cid + '|' + sub) : cid;
  qeClientServices[key] = svc;
  saveUIState();
}
let qeGridStatus = 'Pending';
let qeGridPayType = 'cash';
let qeGridData = {}; // persistent grid state: key = "type|clientId|date|sub", value = string
let qeExpenseGridData = {}; // expense QE: { date: [{id,category,amount,note}] }
let qeExpPayMethod = 'Cash';

// Bulk select state — income
let incBulkMode = false;
let incSelectedIds = new Set();

// ── Undo Stack ─────────────────────────────────────────────────
// In-memory only (cleared on page reload). Captures snapshots before
// bulk actions and individual entry saves so the user can reverse mistakes.
const UNDO_MAX = 20;
let undoStack = []; // [{income, expenses, description, ts}]
let _undoToastTimer = null;

function pushUndo(description) {
  undoStack.push({
    income:   JSON.parse(JSON.stringify(state.income   || [])),
    expenses: JSON.parse(JSON.stringify(state.expenses || [])),
    description,
    ts: Date.now()
  });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  showUndoToast(description);
}

function performUndo() {
  if (!undoStack.length) { showToast('Nothing to undo', 'error'); return; }
  const snap = undoStack.pop();
  state.income   = snap.income;
  state.expenses = snap.expenses;
  saveData();
  renderView(currentView);
  showToast(`↩ Undone: ${snap.description}`);
  // update or hide the undo toast
  if (undoStack.length) showUndoToast(undoStack[undoStack.length-1].description);
  else hideUndoToast();
}

function showUndoToast(description) {
  clearTimeout(_undoToastTimer);
  let bar = document.getElementById('undoFloatBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'undoFloatBar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span class="undo-label">↩ Undo: ${description}</span><button class="undo-btn" onclick="performUndo()">Undo</button><button class="undo-close" onclick="hideUndoToast()">✕</button>`;
  bar.classList.add('visible');
  _undoToastTimer = setTimeout(hideUndoToast, 30000); // auto-hide after 30s
}

function hideUndoToast() {
  clearTimeout(_undoToastTimer);
  const bar = document.getElementById('undoFloatBar');
  if (bar) bar.classList.remove('visible');
}

// Form state
let incomePaymentType = 'invoice';
let incomeStatus      = 'Paid';
let expPaymentMethod  = 'Credit Card';
let expRecurring      = false;
let expHasVAT         = false;
let incRecurring      = false;
let incomeDateMode    = 'exact'; // 'exact' | 'month'
let expDateMode       = 'exact';

// Edit client state
let editClientType      = 'Direct';
let editClientColor     = '#1565C0';
let editClientSubclients = [];
let addClientType       = 'Direct';
let addClientColor      = '#1565C0';

// Modal
let activeSheet       = null;
let pendingDeleteType = null;
let pendingDeleteId   = null;

// Charts
let chartByClient = null;
let chartMonthly  = null;
let chartExpCat   = null;

// ── Persistence ────────────────────────────────────────────────
async function loadData() {
  try {
    const p = await idbGet(STORAGE_KEY);
    if (p) {
      state.clients      = p.clients  || DEFAULT_CLIENTS;
      state.income       = p.income   || [];
      state.expenses     = p.expenses || [];
      state.services     = p.services || [...DEFAULT_SERVICES];
      state.lastModified = p.lastModified || 0;
    } else {
      state.clients  = DEFAULT_CLIENTS;
      state.services = [...DEFAULT_SERVICES];
    }
  } catch(e) { state.clients = DEFAULT_CLIENTS; state.services = [...DEFAULT_SERVICES]; }
  state.clients.forEach(c => {
    if (!c.paymentType) c.paymentType = 'invoice';
    if (!c.subclientPaymentTypes) c.subclientPaymentTypes = {};
  });
  try { const qg = await idbGet(QE_GRID_KEY); if (qg) qeGridData = qg; } catch(e) {}
  try { const qe = await idbGet(QE_EXP_KEY);  if (qe) qeExpenseGridData = qe; } catch(e) {}
  pruneQEGridData();
  deduplicateIncome();    // remove any doubled QE entries (same client+date+sub)
  deduplicateExpenses();  // remove any doubled recurring expense entries (same category+vendor+month)
  loadUIState();
}

// Remove duplicate income entries sharing the same clientId+date+subClient.
// Priority: Pending > Paid (keep the Pending one). Tiebreak: newer createdAt.
// After cleaning, bumps lastModified and schedules a Firebase push so the
// cleanup propagates to the cloud and autoPull can't re-introduce deleted entries.
function deduplicateIncome() {
  const seen = new Map(); // key → index of the entry we want to keep
  const toRemove = new Set();

  function isBetter(a, b) {
    // Pending beats Paid; then newer createdAt wins
    if (a.status === 'Pending' && b.status !== 'Pending') return true;
    if (b.status === 'Pending' && a.status !== 'Pending') return false;
    return (a.createdAt||0) >= (b.createdAt||0);
  }

  state.income.forEach((e, i) => {
    const key = (e.clientId||'') + '|' + (e.date||'') + '|' + (e.subClient||'');
    if (seen.has(key)) {
      const prevIdx = seen.get(key);
      const prev = state.income[prevIdx];
      if (isBetter(e, prev)) {
        toRemove.add(prevIdx);
        seen.set(key, i);
      } else {
        toRemove.add(i);
      }
    } else {
      seen.set(key, i);
    }
  });

  if (toRemove.size > 0) {
    console.log('Dedup: removed', toRemove.size, 'duplicate income entries');
    state.income = state.income.filter((_, i) => !toRemove.has(i));
    // Bump timestamp so autoPull sees local as newer than cloud
    state.lastModified = Date.now();
    idbSet(STORAGE_KEY, state);
    // Push cleaned data to Firebase so deleted entries don't come back
    scheduleAutoPush();
  }
}

// Remove duplicate recurring expense entries sharing the same category+vendor+month.
// Non-recurring expenses are never touched (same vendor on same day is valid).
// Priority: newer createdAt wins. After cleaning, bumps lastModified and pushes to Firebase.
function deduplicateExpenses() {
  const seen = new Map();    // key → index of keeper
  const toRemove = new Set();

  state.expenses.forEach((e, i) => {
    if (!e.recurring) return; // only deduplicate recurring entries
    const key = (e.category||'') + '|' + (e.vendor||'') + '|' + monthKey(e.date||'');
    if (seen.has(key)) {
      const prevIdx = seen.get(key);
      // Keep the one with a newer createdAt
      if ((e.createdAt||0) >= (state.expenses[prevIdx].createdAt||0)) {
        toRemove.add(prevIdx);
        seen.set(key, i);
      } else {
        toRemove.add(i);
      }
    } else {
      seen.set(key, i);
    }
  });

  if (toRemove.size > 0) {
    console.log('Dedup: removed', toRemove.size, 'duplicate recurring expense entries');
    state.expenses = state.expenses.filter((_, i) => !toRemove.has(i));
    state.lastModified = Date.now();
    idbSet(STORAGE_KEY, state);
    scheduleAutoPush();
  }
}

function saveUIState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      currentView, dashMonth,
      incMonth, incClient, incStatus, incPayType, incViewMode,
      expMonth, expCategory, expViewMode,
      qeTab, qeGridMonth, qeGridService, qeGridStatus, qeGridPayType,
      qeGridSelectedClients, qeExpPayMethod, reportPayFilter, reportSubMode, qeClientServices
    }));
  } catch(e) {}
}

function loadUIState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.currentView)           currentView           = s.currentView;
    if (s.dashMonth)             dashMonth             = s.dashMonth;
    if (s.incMonth)              incMonth              = s.incMonth;
    if (s.incClient)             incClient             = s.incClient;
    if (s.incStatus)             incStatus             = s.incStatus;
    if (s.incPayType)            incPayType            = s.incPayType;
    if (s.incViewMode)           incViewMode           = s.incViewMode;
    if (s.expMonth)              expMonth              = s.expMonth;
    if (s.expCategory)           expCategory           = s.expCategory;
    if (s.expViewMode)           expViewMode           = s.expViewMode;
    if (s.qeTab)                 qeTab                 = s.qeTab;
    if (s.qeGridMonth)           qeGridMonth           = s.qeGridMonth;
    if (s.qeGridService)         qeGridService         = s.qeGridService;
    if (s.qeGridStatus)          qeGridStatus          = s.qeGridStatus;
    if (s.qeGridPayType)         qeGridPayType         = s.qeGridPayType;
    if (s.qeExpPayMethod)        qeExpPayMethod        = s.qeExpPayMethod;
    if (s.reportPayFilter)       reportPayFilter       = s.reportPayFilter;
    if (s.reportSubMode)         reportSubMode         = s.reportSubMode;
    if (s.qeClientServices && typeof s.qeClientServices === 'object') qeClientServices = s.qeClientServices;
    if (Array.isArray(s.qeGridSelectedClients)) qeGridSelectedClients = s.qeGridSelectedClients;
  } catch(e) {}
}

function saveData() {
  state.lastModified = Date.now();
  idbSet(STORAGE_KEY, state); // fire-and-forget — IndexedDB has no size limit
  scheduleAutoPush();
}

// ── Google Sheets Sync ─────────────────────────────────────────
function syncEnabled() { return SCRIPT_URL && SCRIPT_URL.length > 10; }

function setSyncStatus(status) {
  const el = document.getElementById('syncBadge');
  if (!el) return;
  if (!syncEnabled()) { el.style.display='none'; return; }
  el.style.display = 'flex';
  const map = {
    idle:    { cls:'',         icon:'☁', text:'Google Sheets' },
    syncing: { cls:'syncing',  icon:'⟳', text:'Syncing…' },
    synced:  { cls:'synced',   icon:'✓', text:'Synced' },
    error:   { cls:'sync-err', icon:'!', text:'Sync error — retry' },
  };
  const s = map[status] || map.idle;
  el.className = 'sync-badge ' + s.cls;
  el.innerHTML = `<span class="sync-icon">${s.icon}</span><span>${s.text}</span>`;
}

async function sheetsSync() {
  if (!syncEnabled()) return;
  setSyncStatus('syncing');
  try {
    const resp = await fetch(SCRIPT_URL + '?action=getData&t=' + Date.now());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    if (Array.isArray(data.income)) {
      state.income   = data.income.map(normalizeIncome);
      state.expenses = (data.expenses||[]).map(normalizeExpense);
      saveData();
      if (!activeSheet) renderView(currentView);
    }
    setSyncStatus('synced');
    setTimeout(() => setSyncStatus('idle'), 3000);
  } catch(e) {
    console.error('Sheets sync error:', e);
    setSyncStatus('error');
  }
}

function instantSync() {
  sheetsSync();
}

function toggleAutoSync() {
  autoSyncEnabled = !autoSyncEnabled;
  const btn = document.getElementById('autoSyncBtn');
  if (autoSyncEnabled) {
    if (btn) { btn.classList.add('active'); btn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> Auto Sync: ON'; }
    autoSyncInterval = setInterval(()=>{ if(!document.hidden&&!activeSheet) sheetsSync(); }, 90000);
    sheetsSync();
  } else {
    if (btn) { btn.classList.remove('active'); btn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> Auto Sync: OFF'; }
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
  }
}

function normalizeIncome(e) {
  return {
    id: String(e.id||genId()), clientId: String(e.clientId||''),
    subClient: String(e.subClient||''), service: String(e.service||''),
    amount: parseFloat(e.amount)||0, vatAmount: parseFloat(e.vatAmount)||0,
    paymentType: String(e.paymentType||'cash'), date: String(e.date||''),
    status: String(e.status||'Paid'), notes: String(e.notes||''),
    createdAt: Number(e.createdAt)||Date.now(),
  };
}

function normalizeExpense(e) {
  return {
    id: String(e.id||genId()), category: String(e.category||''),
    vendor: String(e.vendor||''), description: String(e.description||''),
    amount: parseFloat(e.amount)||0, vatAmount: parseFloat(e.vatAmount)||0,
    paymentMethod: String(e.paymentMethod||'Cash'),
    recurring: e.recurring===true||e.recurring==='TRUE'||e.recurring==='true',
    date: String(e.date||''), createdAt: Number(e.createdAt)||Date.now(),
  };
}

function sheetsAdd(type, entry) {
  if (!syncEnabled()) return;
  const action = type==='income' ? 'addIncome' : 'addExpense';
  fetch(`${SCRIPT_URL}?action=${action}&data=${encodeURIComponent(JSON.stringify(entry))}`).catch(()=>{});
}

function sheetsDelete(type, id) {
  if (!syncEnabled()) return;
  const action = type==='income' ? 'deleteIncome' : 'deleteExpense';
  fetch(`${SCRIPT_URL}?action=${action}&id=${encodeURIComponent(id)}`).catch(()=>{});
}

// ── Helpers ────────────────────────────────────────────────────
function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function fmt(n)  { return '€'+Number(n||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function toDateStr(s) {
  if (!s) return '';
  // Strip time portion if ISO datetime (e.g. "2026-05-10T21:00:00.000Z" → "2026-05-10")
  const clean = s.slice(0, 10);
  const [,m, d] = clean.split('-');
  return `${parseInt(d)}/${parseInt(m)}`;  // e.g. "10/5"
}
function todayVal()   { return new Date().toISOString().slice(0,10); }
function monthKey(s)  { return s?s.slice(0,7):''; }
function monthLabel(k){ const[y,m]=k.split('-'); return MONTH_NAMES[parseInt(m)-1]+' '+y; }
function clientById(id){ return state.clients.find(c=>c.id===id); }
function initials(n)  { return n.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2); }

function allMonths() {
  const keys = new Set();
  state.income.forEach(e=>{if(e.date)keys.add(monthKey(e.date));});
  state.expenses.forEach(e=>{if(e.date)keys.add(monthKey(e.date));});
  return Array.from(keys).sort((a,b)=>b.localeCompare(a));
}

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg, type='success') {
  let t = document.getElementById('globalToast');
  if (!t) { t=document.createElement('div'); t.id='globalToast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast '+type+' show';
  clearTimeout(t._t);
  t._t = setTimeout(()=>t.classList.remove('show'), 2800);
}

// ── Modal System ───────────────────────────────────────────────
function _openSheet(id) {
  activeSheet = id;
  document.getElementById('modalOverlay').classList.remove('hidden');
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('open')));
  // Hide bottom nav so it never blocks the sheet's save button
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
}

function _closeSheetSync(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  el.classList.add('hidden');
}

function closeAllModals() {
  document.querySelectorAll('.sheet').forEach(s=>{s.classList.remove('open');s.classList.add('hidden');});
  activeSheet = null;
  document.getElementById('modalOverlay').classList.add('hidden');
  const cd = document.getElementById('confirmDialog');
  if (cd) cd.classList.remove('open');
  document.getElementById('clientDropdown').classList.add('hidden');
  // Restore bottom nav
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = '';
}

function openAddPicker()  { closeAllModals(); _openSheet('sheetPicker'); }
function openAddIncome() {
  _closeSheetSync('sheetPicker');
  resetIncomeForm();
  _openSheet('sheetIncome');
  filterServicePills('incomeService','incServicePills');
  // Always start at top so client/service/amount are visible first
  requestAnimationFrame(() => {
    const s = document.querySelector('#sheetIncome .form-scroll');
    if (s) s.scrollTop = 0;
  });
}
function openAddExpense() {
  _closeSheetSync('sheetPicker');
  resetExpenseForm();
  _openSheet('sheetExpense');
  // Always start at top so category/vendor are visible first
  requestAnimationFrame(() => {
    const s = document.querySelector('#sheetExpense .form-scroll');
    if (s) s.scrollTop = 0;
  });
}
function backToPicker()   { _closeSheetSync('sheetIncome'); _closeSheetSync('sheetExpense'); _openSheet('sheetPicker'); }

function closeSheet(id) {
  _closeSheetSync(id);
  activeSheet = null;
  const anyOpen = document.querySelectorAll('.sheet.open').length;
  if (!anyOpen) document.getElementById('modalOverlay').classList.add('hidden');
}

// ── Search ─────────────────────────────────────────────────────
let searchQuery = '';

function onSearchInput() {
  searchQuery = document.getElementById('globalSearch').value.trim().toLowerCase();
  document.getElementById('searchClear').classList.toggle('hidden', !searchQuery);
  const panel = document.getElementById('searchResultsPanel');
  if (!searchQuery) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  renderSearchResults();
}

function clearSearch() {
  searchQuery = '';
  document.getElementById('globalSearch').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  document.getElementById('searchResultsPanel').classList.add('hidden');
}

function renderSearchResults() {
  const panel = document.getElementById('searchResultsPanel');
  const q = searchQuery;

  const incMatches = state.income.filter(e => {
    const c = clientById(e.clientId);
    return [c?.name||'', e.service, e.subClient||'', String(e.amount), e.notes||'', e.date||'']
      .some(s=>s.toLowerCase().includes(q));
  }).slice(0,8);

  const expMatches = state.expenses.filter(e =>
    [e.vendor, e.category, e.description||'', String(e.amount)].some(s=>s.toLowerCase().includes(q))
  ).slice(0,5);

  let html = '';
  if (!incMatches.length && !expMatches.length) {
    html = `<div class="search-empty">No results for "${q}"</div>`;
  }
  if (incMatches.length) {
    html += `<div class="search-section-title">Income</div>`;
    incMatches.forEach(e => {
      const c = clientById(e.clientId);
      html += `<div class="search-result" onclick="navigate('income');clearSearch()">
        <div class="search-dot" style="background:${c?.color||'#888'}"></div>
        <div class="search-info">
          <div class="search-main">${c?.name||'Unknown'} — ${e.service}</div>
          <div class="search-sub">${toDateStr(e.date)} · ${e.status}${e.subClient?' · '+e.subClient:''}</div>
        </div>
        <div class="search-amt">${fmt(e.amount)}</div>
      </div>`;
    });
  }
  if (expMatches.length) {
    html += `<div class="search-section-title">Expenses</div>`;
    expMatches.forEach(e => {
      html += `<div class="search-result" onclick="navigate('expenses');clearSearch()">
        <div class="search-icon-sm">${CATEGORY_ICONS[e.category]||'📦'}</div>
        <div class="search-info">
          <div class="search-main">${e.vendor} — ${e.category}</div>
          <div class="search-sub">${toDateStr(e.date)}</div>
        </div>
        <div class="search-amt" style="color:var(--red)">${fmt(e.amount)}</div>
      </div>`;
    });
  }
  panel.innerHTML = html;
}

// ── Navigation ─────────────────────────────────────────────────
function navigate(view) {
  currentView = view;
  saveUIState();
  clearSearch();
  closeMobileSidebar();
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  document.querySelectorAll('.bottom-nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  document.querySelectorAll('.view').forEach(el=>el.classList.add('hidden'));
  document.getElementById('view-'+view).classList.remove('hidden');
  const titles={dashboard:'Dashboard',income:'Income',expenses:'Expenses',clients:'Clients',quickentry:'Quick Entry',reports:'Reports',services:'Services'};
  document.getElementById('topbarTitle').textContent = titles[view]||'';
  renderView(view);
}

function renderView(v) {
  if      (v==='dashboard') renderDashboard();
  else if (v==='income')    renderIncome();
  else if (v==='expenses')  renderExpenses();
  else if (v==='clients')   renderClients();
  else if (v==='quickentry')renderQuickEntry();
  else if (v==='reports')   renderReports();
  else if (v==='services')  renderServices();
}

// ── Client Management ──────────────────────────────────────────
function renderColorSwatches(containerId, selectedColor, callbackFn) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = CLIENT_COLORS.map(c=>`
    <div class="color-swatch ${c===selectedColor?'selected':''}" style="background:${c}"
      onclick="${callbackFn}('${c}')">
      ${c===selectedColor?'<i class="fa-solid fa-check"></i>':''}
    </div>`).join('');
}

function openAddClient() {
  addClientType  = 'Direct';
  addClientColor = CLIENT_COLORS[Math.floor(Math.random()*CLIENT_COLORS.length)];
  document.getElementById('addClientName').value = '';
  document.getElementById('addTypeDirect').classList.add('active');
  document.getElementById('addTypeAgency').classList.remove('active');
  const imgData = document.getElementById('addClientImgData');
  if (imgData) imgData.value = '';
  const prev = document.getElementById('addClientImgPreview');
  if (prev) prev.innerHTML = '<i class="fa-solid fa-camera"></i>';
  renderColorSwatches('addColorSwatches', addClientColor, 'setAddColor');
  _openSheet('sheetAddClient');
}

function setAddClientType(t) {
  addClientType = t;
  document.getElementById('addTypeDirect').classList.toggle('active', t==='Direct');
  document.getElementById('addTypeAgency').classList.toggle('active', t==='Agency');
}

function setAddColor(color) {
  addClientColor = color;
  renderColorSwatches('addColorSwatches', color, 'setAddColor');
}

function saveNewClient() {
  const name = document.getElementById('addClientName').value.trim();
  if (!name) { showToast('Please enter a client name','error'); return; }
  if (state.clients.find(c=>c.name.toLowerCase()===name.toLowerCase())) {
    showToast('A client with this name already exists','error'); return;
  }
  const nc = { id:'C'+Date.now(), name, type:addClientType, color:addClientColor, subclients:[] };
  const imgData = document.getElementById('addClientImgData')?.value;
  if (imgData) nc.image = imgData;
  state.clients.push(nc);
  saveData();
  closeAllModals();
  showToast(`Client "${name}" added`);
  renderClients();
}

function openEditClient(clientId) {
  const c = clientById(clientId);
  if (!c) return;
  document.getElementById('editClientId').value    = clientId;
  document.getElementById('editClientName').value  = c.name;
  editClientType       = c.type;
  editClientColor      = c.color;
  editClientSubclients = [...c.subclients];
  document.getElementById('editTypeDirect').classList.toggle('active', c.type==='Direct');
  document.getElementById('editTypeAgency').classList.toggle('active', c.type==='Agency');
  const scGroup = document.getElementById('editSubclientGroup');
  scGroup.style.display = c.type==='Agency' ? '' : 'none';
  renderColorSwatches('editColorSwatches', editClientColor, 'setEditColor');
  renderEditSubclients();
  // Set payment type toggle
  const pt = c.paymentType || 'invoice';
  const invBtn  = document.getElementById('editPayTypeInvoice');
  const cashBtn = document.getElementById('editPayTypeCash');
  if (invBtn && cashBtn) {
    invBtn.classList.toggle('active',  pt === 'invoice');
    cashBtn.classList.toggle('active', pt === 'cash');
  }
  // Image preview
  const imgData = document.getElementById('editClientImgData');
  if (imgData) imgData.value = '';
  const prev = document.getElementById('editClientImgPreview');
  if (prev) prev.innerHTML = c.image
    ? `<img src="${c.image}">`
    : '<i class="fa-solid fa-camera"></i>';
  _openSheet('sheetEditClient');
}

function handleClientImageUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  const isAdd  = input.id === 'addClientImgFile';
  const dataId = isAdd ? 'addClientImgData'    : 'editClientImgData';
  const prevId = isAdd ? 'addClientImgPreview' : 'editClientImgPreview';
  reader.onload = e => {
    const data = e.target.result;
    const dataEl = document.getElementById(dataId);
    if (dataEl) dataEl.value = data;
    const prev = document.getElementById(prevId);
    if (prev) prev.innerHTML = `<img src="${data}">`;
  };
  reader.readAsDataURL(file);
}

function setEditClientType(t) {
  editClientType = t;
  document.getElementById('editTypeDirect').classList.toggle('active', t==='Direct');
  document.getElementById('editTypeAgency').classList.toggle('active', t==='Agency');
  document.getElementById('editSubclientGroup').style.display = t==='Agency' ? '' : 'none';
}

function setEditColor(color) {
  editClientColor = color;
  renderColorSwatches('editColorSwatches', color, 'setEditColor');
}

function renderEditSubclients() {
  const c = clientById(document.getElementById('editClientId').value);
  const spts = (c && c.subclientPaymentTypes) ? c.subclientPaymentTypes : {};
  document.getElementById('editSubclientList').innerHTML = editClientSubclients.map((sc,i)=>{
    const pt = spts[sc] || 'invoice';
    return `
    <div class="subclient-edit-row">
      <input type="text" class="form-input sc-edit-input" value="${sc}"
        onchange="editClientSubclients[${i}]=this.value;renderEditSubclients()" style="flex:1;padding:8px 12px;font-size:14px" />
      <div class="sc-pay-toggle">
        <button class="sc-pay-btn ${pt==='invoice'?'active':''}" onclick="setSubclientPayType('${sc}','invoice',this)">INV</button>
        <button class="sc-pay-btn ${pt==='cash'?'active':''}" onclick="setSubclientPayType('${sc}','cash',this)">CASH</button>
      </div>
      <button class="btn-remove-sub" onclick="removeSubclientEdit(${i})"><i class="fa-solid fa-times"></i></button>
    </div>`;
  }).join('');
}

function setSubclientPayType(scName, pt, btn) {
  const c = clientById(document.getElementById('editClientId').value);
  if (!c) return;
  if (!c.subclientPaymentTypes) c.subclientPaymentTypes = {};
  c.subclientPaymentTypes[scName] = pt;
  // Update button states
  const row = btn.closest('.subclient-edit-row');
  row.querySelectorAll('.sc-pay-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  saveData();
}

function addSubclientToEdit() {
  const inp = document.getElementById('newSubclientInput');
  const name = inp.value.trim();
  if (!name) return;
  editClientSubclients.push(name);
  inp.value = '';
  renderEditSubclients();
  inp.focus();
}

function removeSubclientEdit(i) {
  editClientSubclients.splice(i,1);
  renderEditSubclients();
}

function saveClientEdit() {
  const id   = document.getElementById('editClientId').value;
  const name = document.getElementById('editClientName').value.trim();
  if (!name) { showToast('Please enter a client name','error'); return; }
  const c = clientById(id);
  if (!c) return;
  c.name       = name;
  c.type       = editClientType;
  c.color      = editClientColor;
  c.subclients = editClientType==='Agency' ? editClientSubclients.filter(s=>s.trim()) : [];
  const editPTInv  = document.getElementById('editPayTypeInvoice');
  const editPTCash = document.getElementById('editPayTypeCash');
  if (editPTInv && editPTCash) {
    c.paymentType = editPTCash.classList.contains('active') ? 'cash' : 'invoice';
  }
  const imgData = document.getElementById('editClientImgData')?.value;
  if (imgData) c.image = imgData;
  saveData();
  closeSheet('sheetEditClient');
  showToast(`Client "${name}" updated`);
  renderClients();
}

function deleteClientFromEdit() {
  const id = document.getElementById('editClientId').value;
  const c  = clientById(id);
  if (!c) return;
  if (state.income.some(e=>e.clientId===id)) {
    showToast('Cannot delete client with existing income entries','error'); return;
  }
  state.clients = state.clients.filter(cl=>cl.id!==id);
  saveData();
  closeSheet('sheetEditClient');
  showToast(`"${c.name}" deleted`);
  renderClients();
}

// ── Services Management ────────────────────────────────────────
function renderServices() {
  if (!state.services || !state.services.length) state.services = [...DEFAULT_SERVICES];
  const html = state.services.map((s,i)=>`
    <div class="service-card" id="svc-card-${i}">
      <div class="service-icon"><i class="fa-solid fa-briefcase"></i></div>
      <div class="service-name-wrap">
        <span class="service-name" id="svc-name-${i}">${s}</span>
        <input class="service-edit-inp hidden" id="svc-inp-${i}" value="${s.replace(/"/g,'&quot;')}"
          onkeydown="if(event.key==='Enter'){event.preventDefault();saveServiceEdit(${i});}if(event.key==='Escape')cancelServiceEdit(${i});"
          onblur="saveServiceEdit(${i})" />
      </div>
      <button class="service-edit-btn" onclick="startServiceEdit(${i})" title="Rename"><i class="fa-solid fa-pen"></i></button>
      <button class="service-del-btn" onclick="deleteService(${i})" title="Remove"><i class="fa-solid fa-times"></i></button>
    </div>`).join('');
  document.getElementById('servicesGrid').innerHTML = html || '<div class="ov-empty">No services yet</div>';
  updateServicesDatalist();
}

function startServiceEdit(i) {
  const span = document.getElementById('svc-name-'+i);
  const inp  = document.getElementById('svc-inp-'+i);
  if (!span || !inp) return;
  span.classList.add('hidden');
  inp.classList.remove('hidden');
  inp.value = state.services[i];
  inp.focus();
  inp.select();
}

function saveServiceEdit(i) {
  const inp = document.getElementById('svc-inp-'+i);
  if (!inp) return;
  const newName = inp.value.trim();
  if (!newName) { cancelServiceEdit(i); return; }
  const oldName = state.services[i];
  if (newName === oldName) { cancelServiceEdit(i); return; }
  if (state.services.some((s,j)=>j!==i && s.toLowerCase()===newName.toLowerCase())) {
    showToast('Service name already exists','error');
    cancelServiceEdit(i); return;
  }
  // Update all income entries using the old service name
  let updated = 0;
  state.income.forEach(e => { if (e.service === oldName) { e.service = newName; updated++; } });
  state.services[i] = newName;
  saveData();
  renderServices();
  showToast(`Renamed "${oldName}" → "${newName}"${updated?' ('+updated+' entries updated)':''}`);
}

function cancelServiceEdit(i) {
  const span = document.getElementById('svc-name-'+i);
  const inp  = document.getElementById('svc-inp-'+i);
  if (span) span.classList.remove('hidden');
  if (inp)  inp.classList.add('hidden');
}

function addService() {
  const inp = document.getElementById('newServiceInput');
  const name = inp.value.trim();
  if (!name) return;
  if (!state.services) state.services = [...DEFAULT_SERVICES];
  if (state.services.find(s=>s.toLowerCase()===name.toLowerCase())) { showToast('Service already exists','error'); return; }
  state.services.push(name);
  saveData(); inp.value = '';
  renderServices();
  showToast(`"${name}" added`);
}

function deleteService(i) {
  const name = state.services[i];
  state.services.splice(i,1);
  saveData(); renderServices();
  showToast(`"${name}" removed`);
}

function updateServicesDatalist() {
  const dl = document.getElementById('servicesList');
  if (!dl) return;
  const svcs = state.services || DEFAULT_SERVICES;
  dl.innerHTML = svcs.map(s=>`<option value="${s}">`).join('');
  // Also refresh any visible service pill lists
  ['incomeService','qeServiceInput'].forEach(id => {
    const inp = document.getElementById(id);
    const pillsId = id === 'incomeService' ? 'incServicePills' : null;
    if (inp && pillsId) filterServicePills(id, pillsId);
  });
}

function filterServicePills(inputId, pillsId) {
  const inp   = document.getElementById(inputId);
  const pills = document.getElementById(pillsId);
  if (!inp || !pills) return;
  const q    = (inp.value || '').toLowerCase();
  const svcs = state.services || DEFAULT_SERVICES;
  const hits = q ? svcs.filter(s => s.toLowerCase().includes(q)) : svcs;
  pills.innerHTML = hits.map(s =>
    `<button type="button" class="service-pill${inp.value===s?' selected':''}"
      onclick="pickService('${inputId}','${pillsId}','${s.replace(/'/g,"\\'")}')">
      ${s}
    </button>`
  ).join('');
  pills.style.display = hits.length ? 'flex' : 'none';
}

function pickService(inputId, pillsId, service) {
  const inp = document.getElementById(inputId);
  if (inp) inp.value = service;
  filterServicePills(inputId, pillsId);
}

// ── Client Combo (Income Form) ─────────────────────────────────
function filterClientDropdown() {
  const q   = document.getElementById('incomeClientSearch').value.toLowerCase();
  const dd  = document.getElementById('clientDropdown');
  const hits = state.clients.filter(c=>c.name.toLowerCase().includes(q));
  if (!hits.length) {
    dd.innerHTML = '<div class="client-dd-empty">No clients found</div>';
  } else {
    dd.innerHTML = hits.map(c=>{
      const av = c.image
        ? `<img src="${c.image}" style="width:28px;height:28px;object-fit:cover;border-radius:50%;flex-shrink:0">`
        : `<div class="client-dd-avatar" style="background:${c.color}">${initials(c.name)}</div>`;
      return `<div class="client-dd-item" onclick="selectClient('${c.id}')">${av}<span>${c.name}</span></div>`;
    }).join('');
  }
  dd.classList.remove('hidden');
}

function showClientDropdown() {
  document.getElementById('incomeClientSearch').select?.();
  filterClientDropdown();
}

function selectClient(clientId) {
  const c = clientById(clientId);
  if (!c) return;
  document.getElementById('incomeClientId').value         = clientId;
  document.getElementById('incomeClientSearch').value     = c.name;
  document.getElementById('clientDot').style.background   = c.color;
  document.getElementById('clientDropdown').classList.add('hidden');

  // Auto-set payment type from client default
  setPaymentType(c.paymentType || 'invoice');

  const subGroup = document.getElementById('subClientGroup');
  const subSel   = document.getElementById('incomeSubClient');
  if (c.type==='Agency' && c.subclients.length) {
    subSel.innerHTML = '<option value="">None / General</option>' +
      c.subclients.map(sc=>`<option value="${sc}">${sc}</option>`).join('');
    subGroup.classList.remove('hidden');
  } else {
    subGroup.classList.add('hidden');
  }
}

function onSubClientChange(sel) {
  const clientId = document.getElementById('incomeClientId').value;
  const c = clientById(clientId);
  if (!c) return;
  const sub = sel.value;
  if (sub && c.subclientPaymentTypes && c.subclientPaymentTypes[sub]) {
    setPaymentType(c.subclientPaymentTypes[sub]);
  } else {
    setPaymentType(c.paymentType || 'invoice');
  }
}

// ── Income Form ────────────────────────────────────────────────
function resetIncomeForm() {
  document.getElementById('incomeClientSearch').value = '';
  document.getElementById('incomeClientId').value     = '';
  document.getElementById('clientDot').style.background = 'transparent';
  document.getElementById('clientDropdown').classList.add('hidden');
  document.getElementById('subClientGroup').classList.add('hidden');
  document.getElementById('incomeService').value = '';
  document.getElementById('incomeAmount').value  = '';
  document.getElementById('incomeNotes').value   = '';

  incomePaymentType = 'invoice';
  document.getElementById('toggleInvoice').classList.add('active');
  document.getElementById('toggleCash').classList.remove('active');

  incomeStatus = 'Paid';
  document.getElementById('statusPaid').classList.add('active');
  document.getElementById('statusPending').classList.remove('active');
  incRecurring = false;
  document.getElementById('incRecurringYes').classList.remove('active');
  document.getElementById('incRecurringNo').classList.add('active');

  // Reset split mode
  incSplitMode = false;
  document.getElementById('splitYes').classList.remove('active');
  document.getElementById('splitNo').classList.add('active');
  document.getElementById('splitAmountsGroup').classList.add('hidden');
  document.getElementById('incAmountGroup').classList.remove('hidden');
  document.getElementById('incPayTypeGroup').classList.remove('hidden');
  document.getElementById('splitInvoiceAmt').value = '';
  document.getElementById('splitCashAmt').value    = '';

  // Reset qty mode
  incQtyMode = false;
  const qmYes = document.getElementById('qtyModeYes');
  const qmNo  = document.getElementById('qtyModeNo');
  const qpg   = document.getElementById('qtyPriceGroup');
  if (qmYes) qmYes.classList.remove('active');
  if (qmNo)  qmNo.classList.add('active');
  if (qpg)   qpg.classList.add('hidden');
  const qtyTot = document.getElementById('incQtyTotal');
  if (qtyTot) qtyTot.textContent = '€0.00';
  const qtyEl = document.getElementById('incQty');
  const upEl  = document.getElementById('incUnitPrice');
  if (qtyEl) qtyEl.value = '';
  if (upEl)  upEl.value  = '';
  document.getElementById('incAmountGroup').classList.remove('hidden');

  setIncomeDateMode('exact');
  updateVATPreview();
  editingEntryId = null; editingEntryType = null;
  const titleEl = document.querySelector('#sheetIncome .sheet-title');
  const saveEl  = document.querySelector('#sheetIncome .btn-save');
  if (titleEl) titleEl.textContent = 'Add Income';
  if (saveEl)  saveEl.innerHTML = '<i class="fa-solid fa-check"></i> Save Income Entry';
}

function setIncomeDateMode(mode) {
  incomeDateMode = mode;
  document.getElementById('incDateModeExact').classList.toggle('active', mode==='exact');
  document.getElementById('incDateModeMonth').classList.toggle('active', mode==='month');
  const inp = document.getElementById('incomeDate');
  const val = inp.value;
  inp.type = mode==='month' ? 'month' : 'date';
  if (mode==='month') inp.value = todayVal().slice(0,7);
  else inp.value = todayVal();
}

function setExpDateMode(mode) {
  expDateMode = mode;
  document.getElementById('expDateModeExact').classList.toggle('active', mode==='exact');
  document.getElementById('expDateModeMonth').classList.toggle('active', mode==='month');
  const inp = document.getElementById('expenseDate');
  inp.type = mode==='month' ? 'month' : 'date';
  if (mode==='month') inp.value = todayVal().slice(0,7);
  else inp.value = todayVal();
}

function setIncRecurring(v) {
  incRecurring = v;
  document.getElementById('incRecurringYes').classList.toggle('active',  v);
  document.getElementById('incRecurringNo').classList.toggle('active',  !v);
}

function setIncSplit(v) {
  incSplitMode = v;
  document.getElementById('splitYes').classList.toggle('active',  v);
  document.getElementById('splitNo').classList.toggle('active',  !v);
  document.getElementById('splitAmountsGroup').classList.toggle('hidden', !v);
  document.getElementById('incAmountGroup').classList.toggle('hidden', v || incQtyMode);
  document.getElementById('incPayTypeGroup').classList.toggle('hidden', v);
  if (v) { updateSplitPreview(); }
  else   { updateVATPreview(); }
}

function setIncQtyMode(v) {
  incQtyMode = v;
  document.getElementById('qtyModeYes').classList.toggle('active',  v);
  document.getElementById('qtyModeNo').classList.toggle('active',  !v);
  document.getElementById('qtyPriceGroup').classList.toggle('hidden', !v);
  document.getElementById('incAmountGroup').classList.toggle('hidden', v);
  if (v) recalcQtyAmount();
  else   updateVATPreview();
}

function recalcQtyAmount() {
  const qty = parseFloat(document.getElementById('incQty').value) || 0;
  const up  = parseFloat(document.getElementById('incUnitPrice').value) || 0;
  const total = qty * up;
  document.getElementById('incQtyTotal').textContent = `€${total.toFixed(2)}`;
  document.getElementById('incomeAmount').value = total > 0 ? total.toFixed(2) : '';
  updateVATPreview();
}

function updateSplitPreview() {
  const inv  = parseFloat(document.getElementById('splitInvoiceAmt').value)||0;
  const cash = parseFloat(document.getElementById('splitCashAmt').value)||0;
  const vat  = inv * VAT_RATE;
  document.getElementById('splitVATText').textContent   = `Invoice VAT: ${fmt(vat)}`;
  document.getElementById('splitTotalText').textContent = `Client pays total: ${fmt(inv + vat + cash)}`;
}

function setIncViewMode(m) { incViewMode = m; saveUIState(); renderIncome(); }
function setExpViewMode(m) { expViewMode = m; saveUIState(); renderExpenses(); }
function toggleClientGroup(cid) {
  document.querySelector('.byclient-group[data-cid="'+cid+'"]')?.classList.toggle('expanded');
}
function copyExcelTable(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const range = document.createRange(); range.selectNode(el);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  try { document.execCommand('copy'); showToast('Table copied — paste into Excel / Google Sheets'); }
  catch(e) { showToast('Select the table manually to copy','error'); }
  window.getSelection().removeAllRanges();
}

function setPaymentType(t) {
  incomePaymentType = t;
  document.getElementById('toggleInvoice').classList.toggle('active', t==='invoice');
  document.getElementById('toggleCash').classList.toggle('active',    t==='cash');
  updateVATPreview();
}

function setStatus(s) {
  incomeStatus = s;
  document.getElementById('statusPaid').classList.toggle('active',    s==='Paid');
  document.getElementById('statusPending').classList.toggle('active', s==='Pending');
}

function updateVATPreview() {
  const amt = parseFloat(document.getElementById('incomeAmount').value)||0;
  const vat = incomePaymentType==='invoice' ? amt*VAT_RATE : 0;
  document.getElementById('vatPreviewText').textContent = `VAT: ${fmt(vat)}`;
  document.getElementById('vatGrossText').textContent   = `Client pays: ${fmt(amt+vat)}`;
}

function showPersistentError(msg) {
  let bar = document.getElementById('persistentErrorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'persistentErrorBar';
    bar.addEventListener('click', () => { bar.style.display = 'none'; });
    document.body.appendChild(bar);
  }
  Object.assign(bar.style, {
    position:'fixed', top:'0', left:'0', right:'0', zIndex:'999999',
    background:'#ef4444', color:'#fff', padding:'20px 24px',
    fontSize:'17px', fontWeight:'700', textAlign:'center',
    boxShadow:'0 4px 24px rgba(0,0,0,0.7)', display:'block',
    borderBottom:'3px solid #b91c1c', cursor:'pointer',
    letterSpacing:'0.2px'
  });
  bar.innerHTML = msg + '<br><span style="font-size:13px;font-weight:400;opacity:0.85">Tap to dismiss</span>';
}

function sheetError(fieldId, msg) {
  const field = document.getElementById(fieldId);
  // Highlight the field red
  if (field) {
    field.style.borderColor = '#ef4444';
    field.style.boxShadow   = '0 0 0 3px rgba(239,68,68,0.4)';
    setTimeout(() => { field.style.borderColor = ''; field.style.boxShadow = ''; }, 3500);
    // Scroll the form-scroll container to the field
    const formScroll = field.closest('.form-scroll');
    if (formScroll) {
      const fieldTop = field.getBoundingClientRect().top - formScroll.getBoundingClientRect().top + formScroll.scrollTop - 20;
      formScroll.scrollTo({ top: fieldTop, behavior: 'smooth' });
    }
  }
  // Giant red banner that can't be missed — fixed at top of screen
  let bar = document.getElementById('sheetErrorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'sheetErrorBar';
    document.body.appendChild(bar);
  }
  Object.assign(bar.style, {
    position:'fixed', top:'0', left:'0', right:'0', zIndex:'99999',
    background:'#ef4444', color:'#fff', padding:'16px 24px',
    fontSize:'16px', fontWeight:'700', textAlign:'center',
    boxShadow:'0 4px 24px rgba(0,0,0,0.5)', display:'block',
    borderBottom:'3px solid #b91c1c', letterSpacing:'0.2px'
  });
  bar.textContent = msg;
  clearTimeout(bar._t);
  bar._t = setTimeout(() => { bar.style.display = 'none'; }, 3500);
}

function saveIncome() {
  // Blur any focused input/textarea so values are committed (don't blur buttons)
  try {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  } catch(_) {}
  const clientId = document.getElementById('incomeClientId').value;
  const service  = document.getElementById('incomeService').value.trim();
  const amount   = parseFloat(document.getElementById('incomeAmount').value);
  const date     = document.getElementById('incomeDate').value;

  if (!clientId) { sheetError('incomeClientSearch', '⚠ Select a client first'); return; }
  if (!service)  { sheetError('incomeService', '⚠ Enter or pick a service'); return; }
  if (!date)     { sheetError('incomeDate', '⚠ Select a date'); return; }

  const rawDate   = incomeDateMode==='month' ? date+'-01' : date;
  const subClient = document.getElementById('incomeSubClient').value||'';
  const notes     = document.getElementById('incomeNotes').value.trim();

  // ── Split payment mode ────────────────────────────────────────
  if (incSplitMode) {
    const invAmt  = parseFloat(document.getElementById('splitInvoiceAmt').value)||0;
    const cashAmt = parseFloat(document.getElementById('splitCashAmt').value)||0;
    if (invAmt<=0 && cashAmt<=0) { showToast('Enter at least one amount','error'); return; }
    const base = { clientId, subClient, service, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, createdAt:Date.now() };
    const entries = [];
    if (invAmt>0)  entries.push({ ...base, id:genId(), amount:invAmt,  vatAmount:invAmt*VAT_RATE, paymentType:'invoice' });
    if (cashAmt>0) entries.push({ ...base, id:genId(), amount:cashAmt, vatAmount:0,               paymentType:'cash' });
    entries.forEach(e=>{ state.income.push(e); sheetsAdd('income',e); });
    saveData(); closeAllModals();
    showToast(`Split saved — Invoice ${fmt(invAmt)} + Cash ${fmt(cashAmt)}`);
    renderView(currentView);
    return;
  }

  if (!amount||amount<=0){ sheetError('incomeAmount', '⚠ Enter a valid amount (€)'); return; }
  const vatAmount = incomePaymentType==='invoice' ? amount*VAT_RATE : 0;

  // qty meta (optional)
  const qty       = incQtyMode ? (parseFloat(document.getElementById('incQty').value)||null) : null;
  const unitPrice = incQtyMode ? (parseFloat(document.getElementById('incUnitPrice').value)||null) : null;

  if (editingEntryId) {
    const idx = state.income.findIndex(e=>e.id===editingEntryId);
    if (idx>=0) {
      const prev = state.income[idx];
      pushUndo(`Edit: ${(state.clients.find(c=>c.id===prev.clientId)||{}).name||'entry'}`);
      let paidDate = prev.paidDate;
      if (incomeStatus === 'Paid' && !paidDate) paidDate = Date.now();
      else if (incomeStatus !== 'Paid') paidDate = undefined;
      const updated = { ...prev, clientId, subClient, service, amount, vatAmount, paymentType:incomePaymentType, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, qty, unitPrice };
      if (paidDate) updated.paidDate = paidDate; else delete updated.paidDate;
      state.income[idx] = updated;
    }
    editingEntryId = null; editingEntryType = null;
    saveData();
    closeAllModals();
    showToast('Income entry updated');
  } else {
    const entry = { id:genId(), clientId, subClient, service, amount, vatAmount, paymentType:incomePaymentType, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, qty, unitPrice, createdAt:Date.now() };
    if (incomeStatus === 'Paid') entry.paidDate = Date.now();
    try {
      state.income.push(entry);
      saveData();
    } catch(e) {
      // Rollback in-memory state so UI doesn't show unsaved data
      state.income = state.income.filter(x => x.id !== entry.id);
      showPersistentError('❌ Could not save — storage full. Clear some space and try again.');
      return;
    }
    sheetsAdd('income', entry);
    closeAllModals();
    showToast(`✓ Income saved — ${fmt(amount)}`);
    renderView(currentView);
  }
}

// ── Expense Form ───────────────────────────────────────────────
function resetExpenseForm() {
  document.getElementById('expenseCategory').value    = '';
  document.getElementById('expenseVendor').value      = '';
  document.getElementById('expenseDescription').value = '';
  document.getElementById('expenseAmount').value      = '';
  document.getElementById('expenseVAT').value         = '';
  document.getElementById('expenseDate').value        = todayVal();

  expPaymentMethod = 'Credit Card';
  document.getElementById('pmCard').classList.add('active');
  document.getElementById('pmCash').classList.remove('active');

  expRecurring = false;
  document.getElementById('recurringYes').classList.remove('active');
  document.getElementById('recurringNo').classList.add('active');

  expHasVAT = false;
  document.getElementById('expVATYes').classList.remove('active');
  document.getElementById('expVATNo').classList.add('active');
  document.getElementById('expVATPreview').classList.add('hidden');
  document.getElementById('expVATManualGroup').classList.add('hidden');
  setExpDateMode('exact');
  editingEntryId = null; editingEntryType = null;
  const titleEl = document.querySelector('#sheetExpense .sheet-title');
  const saveEl  = document.querySelector('#sheetExpense .btn-save');
  if (titleEl) titleEl.textContent = 'Add Expense';
  if (saveEl)  saveEl.innerHTML = '<i class="fa-solid fa-check"></i> Save Expense Entry';
}

function setExpHasVAT(v) {
  expHasVAT = v;
  document.getElementById('expVATYes').classList.toggle('active',  v);
  document.getElementById('expVATNo').classList.toggle('active',  !v);
  document.getElementById('expVATPreview').classList.toggle('hidden', !v);
  document.getElementById('expVATManualGroup').classList.toggle('hidden', !v);
  onExpAmountChange();
}

function onExpAmountChange() {
  if (!expHasVAT) return;
  const total = parseFloat(document.getElementById('expenseAmount').value)||0;
  const vat   = total - (total/1.24);
  const net   = total/1.24;
  document.getElementById('expVATAmt').textContent = `VAT (24%): ${fmt(vat)}`;
  document.getElementById('expNetAmt').textContent = `Net: ${fmt(net)}`;
  document.getElementById('expenseVAT').value = vat.toFixed(2);
}

function setPaymentMethod(m) {
  expPaymentMethod = m;
  document.getElementById('pmCard').classList.toggle('active', m==='Credit Card');
  document.getElementById('pmCash').classList.toggle('active', m==='Cash');
}

function setRecurring(v) {
  expRecurring = v;
  document.getElementById('recurringYes').classList.toggle('active',  v);
  document.getElementById('recurringNo').classList.toggle('active',  !v);
}

function saveExpense() {
  try {
    const ae2 = document.activeElement;
    if (ae2 && (ae2.tagName === 'INPUT' || ae2.tagName === 'TEXTAREA' || ae2.tagName === 'SELECT')) ae2.blur();
  } catch(_) {}
  const category = document.getElementById('expenseCategory').value;
  const vendor   = document.getElementById('expenseVendor').value.trim();
  const amount   = parseFloat(document.getElementById('expenseAmount').value);
  const date     = document.getElementById('expenseDate').value;
  if (!category)         { sheetError('expenseCategory', '⚠ Select a category'); return; }
  if (!vendor)           { sheetError('expenseVendor',   '⚠ Enter a type/supplier'); return; }
  if (!amount||amount<=0){ sheetError('expenseAmount',   '⚠ Enter a valid amount (€)'); return; }
  if (!date)             { sheetError('expenseDate',     '⚠ Select a date'); return; }

  const rawDate     = expDateMode==='month' ? date+'-01' : date;
  const description = document.getElementById('expenseDescription').value.trim();
  const vatAmount   = parseFloat(document.getElementById('expenseVAT').value)||0;

  if (editingEntryId) {
    const idx = state.expenses.findIndex(e=>e.id===editingEntryId);
    if (idx>=0) {
      pushUndo(`Edit expense: ${state.expenses[idx].vendor||state.expenses[idx].category}`);
      state.expenses[idx] = { ...state.expenses[idx], category, vendor, description, amount, vatAmount, paymentMethod:expPaymentMethod, recurring:expRecurring, date:rawDate };
    }
    editingEntryId = null; editingEntryType = null;
    saveData();
    closeAllModals();
    showToast('Expense entry updated');
  } else {
    const entry = { id:genId(), category, vendor, description, amount, vatAmount, paymentMethod:expPaymentMethod, recurring:expRecurring, date:rawDate, createdAt:Date.now() };
    try {
      state.expenses.push(entry);
      saveData();
    } catch(e) {
      state.expenses = state.expenses.filter(x => x.id !== entry.id);
      showPersistentError('❌ Could not save — storage full. Clear some space and try again.');
      return;
    }
    sheetsAdd('expense', entry);
    closeAllModals();
    showToast(`✓ Expense saved — ${fmt(amount)}`);
    renderView(currentView);
    return;
  }
  // editing path
  renderView(currentView);
}

// ── Entry Detail / Edit ────────────────────────────────────────
function openEntryDetail(type, id) {
  let html, title;
  if (type==='income') {
    const e = state.income.find(x=>x.id===id); if (!e) return;
    const c = clientById(e.clientId);
    title = 'Income Details';
    html = `
      <div class="ed-row"><span>Client</span><strong>${c?.name||'?'}</strong></div>
      ${e.subClient?`<div class="ed-row"><span>Sub-Client</span><strong>${e.subClient}</strong></div>`:''}
      <div class="ed-row"><span>Service</span><strong>${e.service}</strong></div>
      <div class="ed-row"><span>Amount</span><strong style="color:var(--green)">${fmt(e.amount)}</strong></div>
      ${e.vatAmount>0?`<div class="ed-row"><span>VAT</span><strong>${fmt(e.vatAmount)}</strong></div>`:''}
      <div class="ed-row"><span>Date</span><strong>${toDateStr(e.date)}</strong></div>
      <div class="ed-row"><span>Status</span><strong>${e.status}</strong></div>
      ${e.paidDate?`<div class="ed-row"><span>Paid on</span><strong style="color:var(--green)">${toDateStr(new Date(e.paidDate).toISOString().slice(0,10))}</strong></div>`:''}
      <div class="ed-row"><span>Type</span><strong>${e.paymentType==='invoice'?'Invoice':'Cash'}</strong></div>
      ${e.recurring?'<div class="ed-row"><span>Recurring</span><strong>Yes</strong></div>':''}
      ${e.notes?`<div class="ed-row"><span>Notes</span><strong>${e.notes}</strong></div>`:''}`;
  } else {
    const e = state.expenses.find(x=>x.id===id); if (!e) return;
    title = 'Expense Details';
    html = `
      <div class="ed-row"><span>Category</span><strong>${e.category}</strong></div>
      <div class="ed-row"><span>Type</span><strong>${e.vendor}</strong></div>
      ${e.description?`<div class="ed-row"><span>Description</span><strong>${e.description}</strong></div>`:''}
      <div class="ed-row"><span>Amount</span><strong style="color:var(--red)">${fmt(e.amount)}</strong></div>
      ${e.vatAmount>0?`<div class="ed-row"><span>VAT</span><strong>${fmt(e.vatAmount)}</strong></div>`:''}
      <div class="ed-row"><span>Date</span><strong>${toDateStr(e.date)}</strong></div>
      <div class="ed-row"><span>Payment</span><strong>${e.paymentMethod}</strong></div>
      ${e.recurring?'<div class="ed-row"><span>Recurring</span><strong>Yes</strong></div>':''}`;
  }

  let d = document.getElementById('entryDetailDialog');
  if (!d) { d = document.createElement('div'); d.id='entryDetailDialog'; d.className='copy-dialog'; document.body.appendChild(d); }
  d.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h3 style="margin:0;font-size:15px">${title}</h3>
      <button onclick="closeEntryDetail()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:0"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="ed-rows">${html}</div>
    <div class="copy-dialog-btns" style="margin-top:16px">
      <button class="btn-cancel" style="flex:1;gap:5px" onclick="closeEntryDetail();openCopyDialog('${type}','${id}')"><i class="fa-solid fa-copy"></i> Copy</button>
      <button class="btn-cancel" style="flex:1;gap:5px" onclick="openEditEntry('${type}','${id}')"><i class="fa-solid fa-pen"></i> Edit</button>
      <button class="btn-confirm-delete" onclick="closeEntryDetail();confirmDelete('${type}','${id}')"><i class="fa-solid fa-trash"></i></button>
    </div>`;
  document.getElementById('modalOverlay').classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>d.classList.add('open')));
}

function closeEntryDetail() {
  const d = document.getElementById('entryDetailDialog');
  if (d) d.classList.remove('open');
  if (!activeSheet) document.getElementById('modalOverlay').classList.add('hidden');
}

function openEditEntry(type, id) {
  closeEntryDetail();
  if (type==='income') {
    const e = state.income.find(x=>x.id===id); if (!e) return;
    resetIncomeForm();
    editingEntryId = id; editingEntryType = type;
    selectClient(e.clientId);
    document.getElementById('incomeSubClient').value = e.subClient||'';
    document.getElementById('incomeService').value   = e.service;
    document.getElementById('incomeAmount').value    = e.amount;
    document.getElementById('incomeNotes').value     = e.notes||'';
    setPaymentType(e.paymentType);
    setStatus(e.status);
    setIncRecurring(e.recurring||false);
    setIncomeDateMode('exact');
    document.getElementById('incomeDate').value = e.date.slice(0,10);
    updateVATPreview();
    document.querySelector('#sheetIncome .sheet-title').textContent = 'Edit Income';
    document.querySelector('#sheetIncome .btn-save').innerHTML = '<i class="fa-solid fa-check"></i> Save Changes';
    _openSheet('sheetIncome');
  } else {
    const e = state.expenses.find(x=>x.id===id); if (!e) return;
    resetExpenseForm();
    editingEntryId = id; editingEntryType = type;
    document.getElementById('expenseCategory').value    = e.category;
    document.getElementById('expenseVendor').value      = e.vendor;
    document.getElementById('expenseDescription').value = e.description||'';
    document.getElementById('expenseAmount').value      = e.amount;
    setPaymentMethod(e.paymentMethod);
    setRecurring(e.recurring||false);
    if (e.vatAmount>0) { setExpHasVAT(true); document.getElementById('expenseVAT').value = e.vatAmount.toFixed(2); }
    setExpDateMode('exact');
    document.getElementById('expenseDate').value = e.date.slice(0,10);
    document.querySelector('#sheetExpense .sheet-title').textContent = 'Edit Expense';
    document.querySelector('#sheetExpense .btn-save').innerHTML = '<i class="fa-solid fa-check"></i> Save Changes';
    _openSheet('sheetExpense');
  }
}

// ── Delete ─────────────────────────────────────────────────────
function confirmDelete(type, id) {
  pendingDeleteType = type; pendingDeleteId = id;
  let d = document.getElementById('confirmDialog');
  if (!d) {
    d = document.createElement('div');
    d.id = 'confirmDialog'; d.className = 'confirm-dialog';
    d.innerHTML = `<h3>Delete Entry?</h3><p>This cannot be undone.</p>
      <div class="confirm-btns">
        <button class="btn-cancel" onclick="cancelDelete()">Cancel</button>
        <button class="btn-confirm-delete" onclick="doDelete()">Delete</button>
      </div>`;
    document.body.appendChild(d);
  }
  document.getElementById('modalOverlay').classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>d.classList.add('open')));
}

function cancelDelete() {
  const d = document.getElementById('confirmDialog');
  if (d) d.classList.remove('open');
  pendingDeleteType = pendingDeleteId = null;
  if (!activeSheet) document.getElementById('modalOverlay').classList.add('hidden');
}

function doDelete() {
  if (pendingDeleteType === 'income') {
    // Clear QE grid draft data for this entry so it doesn't reappear
    const entry = state.income.find(e => e.id === pendingDeleteId);
    pushUndo(`Delete: ${entry ? ((state.clients.find(c=>c.id===entry.clientId)||{}).name||'entry') : 'entry'}`);
    if (entry) {
      const cid = entry.clientId;
      const dt  = entry.date;
      Object.keys(qeGridData).forEach(k => {
        if (k.includes('|' + cid + '|' + dt + '|')) delete qeGridData[k];
      });
      idbSet(QE_GRID_KEY, qeGridData);
    }
    state.income = state.income.filter(e => e.id !== pendingDeleteId);
    showToast('Income entry deleted');
  } else if (pendingDeleteType === 'expense') {
    const expEntry = state.expenses.find(e => e.id === pendingDeleteId);
    pushUndo(`Delete expense: ${expEntry ? (expEntry.vendor||expEntry.category) : 'entry'}`);
    state.expenses = state.expenses.filter(e => e.id !== pendingDeleteId);
    showToast('Expense entry deleted');
  }
  saveData();
  sheetsDelete(pendingDeleteType, pendingDeleteId);
  cancelDelete();
  renderView(currentView);
}

// ── QUICK ENTRY ────────────────────────────────────────────────
function setQETab(tab) {
  qeTab = tab;
  document.getElementById('qeTabIncome').classList.toggle('active',  tab==='income');
  document.getElementById('qeTabExpense').classList.toggle('active', tab==='expense');
  renderQuickEntry();
}

function renderQuickEntry() {
  const cont = document.getElementById('qeContent');
  if (qeTab==='income') renderQEIncome(cont);
  else renderQEExpense(cont);
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return 'rgba('+r+','+g+','+b+','+alpha+')';
}

function captureQEGridData() {
  const table = document.getElementById('qeSpreadsheet');
  if (!table) return;
  table.querySelectorAll('input[data-client][data-date]').forEach(inp => {
    const key = (inp.dataset.type||'')+'|'+(inp.dataset.client||'')+'|'+(inp.dataset.date||'')+'|'+(inp.dataset.sub||'');
    const isNumeric = ['qty','price','subqty','subprice'].includes(inp.dataset.type);
    if (inp.value !== '') {
      qeGridData[key] = inp.value;
    } else if (isNumeric) {
      // Store empty sentinel so restoreQEGridData can override loadQEFromState for cleared cells
      qeGridData[key] = '';
    } else {
      delete qeGridData[key];
    }
    if (inp.dataset.type === 'subnote') {
      const visKey = 'notevis|'+(inp.dataset.client||'')+'|'+(inp.dataset.date||'')+'|'+(inp.dataset.sub||'');
      const isVisible = inp.style.display !== 'none' && inp.style.display !== '';
      if (isVisible) {
        qeGridData[visKey] = '1';
      } else {
        delete qeGridData[visKey];
      }
    }
  });
  // Persist draft to localStorage so it survives refresh
  idbSet(QE_GRID_KEY, qeGridData);
}

/* Load permanent income entries for the current month into the grid.
   Service is NOT used as a filter here — one entry per client+date+sub is shown
   regardless of which service it was saved under. */
function loadQEFromState(table) {
  if (!table) return;
  const monthEntries = state.income.filter(e => e.date && e.date.startsWith(qeGridMonth));
  if (!monthEntries.length) return;

  // Purge stale zero/empty sentinels in qeGridData for any cell that has a
  // real saved value in state.income.  A sentinel of 0 or '' left over from a
  // previous session would otherwise overwrite the saved value in Layer 2 and
  // trick saveQEGrid into deleting the entry.
  monthEntries.forEach(e => {
    const cid = e.clientId; const ds = e.date; const sub = e.subClient||'';
    const numericTypes = e.subClient ? ['subqty','subprice'] : ['qty','price'];
    numericTypes.forEach(t => {
      const key = t+'|'+cid+'|'+ds+'|'+sub;
      if (key in qeGridData && (parseFloat(qeGridData[key])||0) <= 0) {
        delete qeGridData[key];
      }
    });
  });

  table.querySelectorAll('tbody tr[data-date]').forEach(tr => {
    const dateStr = tr.dataset.date;
    const dayEntries = monthEntries.filter(e => e.date === dateStr);
    if (!dayEntries.length) return;

    const byClient = {};
    dayEntries.forEach(e => { (byClient[e.clientId] = byClient[e.clientId]||[]).push(e); });

    Object.entries(byClient).forEach(([cid, allClientEntries]) => {
      const hasSubclients = allClientEntries.some(e => e.subClient);
      // No service filter: show whatever is stored for this client+date+sub
      const entries = allClientEntries;

      if (hasSubclients) {
        // Agency: find shared price from saved entries, set it; then per-subclient qty + override
        const withShared = entries.filter(e => e.sharedPrice != null);
        const sharedPrice = withShared.length ? withShared[withShared.length-1].sharedPrice : 0;
        const sharedInp = tr.querySelector('[data-client="'+cid+'"][data-type="price"]');
        if (sharedInp) sharedInp.value = sharedPrice || '';

        entries.filter(e => e.subClient).forEach(entry => {
          const sub = entry.subClient;
          const subqtyInp = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subqty"]');
          if (subqtyInp) {
            if (entry.qty != null) {
              subqtyInp.value = entry.qty;
            } else if (entry.unitPrice && entry.amount) {
              subqtyInp.value = Math.round(entry.amount / entry.unitPrice * 100) / 100;
            }
          }
          // Subprice override: only if different from shared
          if (entry.unitPrice != null && entry.unitPrice !== sharedPrice) {
            const subpriceInp = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subprice"]');
            if (subpriceInp) subpriceInp.value = entry.unitPrice;
          }
          if (entry.notes) {
            const ni = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subnote"]');
            if (ni) { ni.value = entry.notes; ni.style.display='block'; const p=ni.previousElementSibling; if(p?.classList.contains('qe-note-pen')) p.style.display='none'; }
          }
        });

      } else {
        // Direct client — use last/most-recent entry
        const entry = entries[entries.length-1];
        const qi = tr.querySelector('[data-client="'+cid+'"][data-type="qty"]');
        const pi = tr.querySelector('[data-client="'+cid+'"][data-type="price"]');
        if (entry.qty != null) {
          if (qi) qi.value = entry.qty;
        } else if (entry.amount > 0) {
          // Income added via Add Entry (no qty) — display as 1 × amount so total shows correctly
          if (qi) qi.value = 1;
        }
        if (entry.unitPrice != null) {
          if (pi) pi.value = entry.unitPrice;
        } else if (entry.amount > 0) {
          if (pi) pi.value = entry.amount;
        }
        if (entry.notes) {
          const ni = tr.querySelector('[data-client="'+cid+'"][data-type="subnote"]');
          if (ni) { ni.value = entry.notes; ni.style.display='block'; const p=ni.previousElementSibling; if(p?.classList.contains('qe-note-pen')) p.style.display='none'; }
        }
      }
    });
  });
}

function restoreQEGridData() {
  const table = document.getElementById('qeSpreadsheet');
  if (!table) return;

  // Layer 1: permanent saved data
  loadQEFromState(table);

  // Layer 2: overlay in-session edits (higher priority — includes cleared values)
  // Skip empty sentinels for numeric cells when the input already has a real value
  // from Layer 1 (prevents stale blank sentinels from wiping out saved amounts)
  table.querySelectorAll('input[data-client][data-date]').forEach(inp => {
    const key = (inp.dataset.type||'')+'|'+(inp.dataset.client||'')+'|'+(inp.dataset.date||'')+'|'+(inp.dataset.sub||'');
    if (key in qeGridData) {
      const sentinel = qeGridData[key];
      const isNumeric = ['qty','price','subqty','subprice'].includes(inp.dataset.type);
      // Skip zero/empty sentinel if Layer 1 already loaded a real positive value.
      // This prevents a stale "I cleared this cell" sentinel from wiping out a
      // saved entry that the user didn't intend to delete.
      if (isNumeric && (parseFloat(sentinel)||0) <= 0 && (parseFloat(inp.value)||0) > 0) return;
      inp.value = sentinel;
      if (inp.dataset.type === 'subnote') {
        const visKey = 'notevis|'+(inp.dataset.client||'')+'|'+(inp.dataset.date||'')+'|'+(inp.dataset.sub||'');
        const visible = visKey in qeGridData ? !!qeGridData[visKey] : (inp.value !== '');
        inp.style.display = (visible && inp.value) ? 'block' : 'none';
        const pen = inp.previousElementSibling;
        if (pen?.classList.contains('qe-note-pen')) pen.style.display = inp.style.display==='block' ? 'none' : '';
      }
    }
  });

  // Recalculate all totals once
  const seen = new Set();
  table.querySelectorAll('[data-type="subqty"],[data-type="qty"]').forEach(inp => {
    const k = inp.dataset.client+'|'+inp.dataset.date;
    if (!seen.has(k)) { seen.add(k); updateQEClientTotal(inp); }
  });
  updateQEColTotals();
  // Color the day total cells based on saved entry status
  document.querySelectorAll('.qe-td-total[data-date]').forEach(cell => {
    const status = getQERowStatus(cell.dataset.date);
    applyQETotalColor(cell, status);
  });
  // Color per-client-per-day total cells
  document.querySelectorAll('.qe-client-total[data-client][data-date]').forEach(ct => {
    const cid = ct.dataset.client; const ds = ct.dataset.date;
    // No service filter — service can differ per subclient; match by clientId+date only
    const entries = state.income.filter(e => e.clientId===cid && e.date===ds);
    if (!entries.length) return;
    const hasPending = entries.some(e=>e.status==='Pending');
    // If there is an unsaved draft value for this cell (any numeric qeGridData key
    // for this client+date that is non-empty), keep orange — the draft is pending
    // regardless of what the saved entry status says.
    const hasDraft = Object.keys(qeGridData).some(k => {
      const p = k.split('|');
      return ['price','qty','subqty','subprice'].includes(p[0]) &&
             p[1] === cid && p[2] === ds && qeGridData[k] !== '';
    });
    const isOrange = hasPending || hasDraft;
    ct.style.color      = isOrange ? '#f59e0b' : 'var(--green)';
    ct.style.fontWeight = '700';
    ct.title = isOrange ? 'Pending — tap to mark Paid' : 'Paid — tap to mark Pending';
  });
}

// Clears stale QE draft cache and reloads grid from saved income entries.
// Use when grid appears empty but data exists in the income records.
function reloadQEFromData() {
  qeGridData = {};
  idbSet(QE_GRID_KEY, {});
  renderQEIncome(document.getElementById('qeContent'));
  showToast('✓ Grid reloaded from saved data');
}

function renderQEIncome(cont) {
  captureQEGridData();
  if (!qeGridMonth) qeGridMonth = todayVal().slice(0,7);
  const [yr, mo] = qeGridMonth.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const today = todayVal();

  if (!qeGridSelectedClients.length && state.clients.length)
    qeGridSelectedClients = state.clients.slice(0, 6).map(c=>c.id);

  const selCols = state.clients.filter(c=>qeGridSelectedClients.includes(c.id));

  const moOpts = (()=>{
    const ms = allMonths();
    if (!ms.includes(qeGridMonth)) ms.unshift(qeGridMonth);
    return ms.map(m=>`<option value="${m}" ${m===qeGridMonth?'selected':''}>${monthLabel(m)}</option>`).join('');
  })();

  const clientToggles = state.clients.map(c=>`
    <label class="qe-client-toggle ${qeGridSelectedClients.includes(c.id)?'active':''}">
      <input type="checkbox" style="display:none" ${qeGridSelectedClients.includes(c.id)?'checked':''}
        onchange="toggleQEGridClient('${c.id}',this.checked)" />
      <span class="qe-ct-dot" style="background:${c.color}"></span>
      <span>${c.name}</span>
    </label>`).join('');

  // For each client: agency gets one column per subclient (qty+subprice) + SharedPrice + Total
  //                  direct gets Qty + Price + Total
  const clientColCount = c => (c.subclients||[]).length > 0 ? (c.subclients.length + 2) : 3;

  // Header row 1: client name + service (direct) or client name + default service (agency)
  const hRow1 = selCols.map(c=>{
    const bg = hexToRgba(c.color, 0.09);
    const subs = c.subclients||[];
    const svcVal = (qeClientServices[c.id] || qeGridService || 'Video Editing').replace(/'/g,'&#39;');
    const placeholder = subs.length > 0 ? 'Default service…' : 'Service…';
    return '<th colspan="'+clientColCount(c)+'" class="qe-th-client" style="border-top:3px solid '+c.color+';border-left:2px solid '+c.color+';background:'+bg+';text-align:center">'
      +'<div style="font-weight:700;margin-bottom:4px">'+c.name+'</div>'
      +'<input class="qe-client-svc-inp" list="servicesList" value="'+svcVal+'" placeholder="'+placeholder+'" '
      +'oninput="setClientService(\''+c.id+'\',\'\',this.value)" />'
      +'</th>';
  }).join('');

  // Header row 2: per-subclient name + service input (agency) or Qty/Price/Total (direct)
  const hRow2 = selCols.map(c=>{
    const subs = c.subclients||[];
    const bg = hexToRgba(c.color, 0.06);
    if (subs.length > 0) {
      return subs.map((s,si)=>{
        const subSvcVal = getClientService(c.id, s).replace(/'/g,'&#39;');
        const bl = si===0 ? 'border-left:2px solid '+c.color+';' : '';
        return '<th class="qe-sh" style="'+bl+' background:'+bg+';vertical-align:top">'
          +'<div>'+s+'</div>'
          +'<input class="qe-client-svc-inp" list="servicesList" value="'+subSvcVal+'" placeholder="Service…" '
          +'oninput="setClientService(\''+c.id+'\',\''+s.replace(/'/g,"\\'")+'\',this.value)" />'
          +'</th>';
      }).join('')
        +'<th class="qe-sh qe-sh-price" style="background:'+bg+'">€/unit</th>'
        +'<th class="qe-sh qe-sh-total" style="background:'+bg+'">Total</th>';
    }
    return '<th class="qe-sh" style="border-left:2px solid '+c.color+';background:'+bg+'">Qty</th>'
      +'<th class="qe-sh qe-sh-price" style="background:'+bg+'">Price</th>'
      +'<th class="qe-sh qe-sh-total" style="background:'+bg+'">Total</th>';
  }).join('');

  // Body rows
  const bodyRows = Array.from({length:daysInMonth},(_,i)=>{
    const day = i+1;
    const ds = qeGridMonth+'-'+String(day).padStart(2,'0');
    const isToday = ds===today;
    const clientCells = selCols.map(c=>{
      const subs = c.subclients||[];
      const bg = hexToRgba(c.color, 0.05);
      if (subs.length > 0) {
        // Agency: one column per subclient (qty + subprice + pencil note) + shared price + total
        const subCells = subs.map((s,si)=>{
          const bl = si===0 ? 'border-left:2px solid '+c.color+';' : '';
          return '<td class="qe-td-n" style="'+bl+'background:'+bg+';text-align:center;vertical-align:middle">'
            +'<div class="qe-sub-cell">'
            +'<input class="qe-sp-inp qe-sp-qty" type="number" placeholder="—" min="0" step="1" data-client="'+c.id+'" data-date="'+ds+'" data-sub="'+s+'" data-type="subqty" oninput="updateQEClientTotal(this)" />'
            +'<input class="qe-sp-inp qe-sp-subprice" type="number" placeholder="—" min="0" step="0.01" data-client="'+c.id+'" data-date="'+ds+'" data-sub="'+s+'" data-type="subprice" oninput="updateQEClientTotal(this)" />'
            +'<button class="qe-note-pen" onclick="toggleSubNote(this)" title="Add note"><i class="fa-solid fa-pencil"></i></button>'
            +'<input class="qe-sp-inp qe-sp-subnote" type="text" placeholder="note…" data-client="'+c.id+'" data-date="'+ds+'" data-sub="'+s+'" data-type="subnote" style="display:none" onblur="qeSubNoteBlur(this)" />'
            +'</div></td>';
        }).join('');
        return subCells
          +'<td class="qe-td-n" style="background:'+bg+';text-align:center;vertical-align:middle"><input class="qe-sp-inp qe-sp-price" type="number" placeholder="—" min="0" step="0.01" data-client="'+c.id+'" data-date="'+ds+'" data-type="price" oninput="updateQEClientTotal(this)" onkeydown="qeSpreadsheetNav(event,this)" /></td>'
          +'<td class="qe-client-total qe-client-total-click" style="background:'+bg+'" data-client="'+c.id+'" data-date="'+ds+'" data-value="0" onclick="toggleQEClientDayStatus(\''+c.id+'\',\''+ds+'\')" title="Tap to toggle Paid/Pending">—</td>';
      } else {
        // Direct: qty (with note) + price + total
        return '<td class="qe-td-n" style="border-left:2px solid '+c.color+';background:'+bg+';text-align:center;vertical-align:middle">'
          +'<div class="qe-sub-cell">'
          +'<input class="qe-sp-inp qe-sp-qty" type="number" placeholder="—" min="0" step="1" data-client="'+c.id+'" data-date="'+ds+'" data-type="qty" oninput="updateQEClientTotal(this)" />'
          +'<button class="qe-note-pen" onclick="toggleSubNote(this)" title="Add note"><i class="fa-solid fa-pencil"></i></button>'
          +'<input class="qe-sp-inp qe-sp-subnote" type="text" placeholder="note…" data-client="'+c.id+'" data-date="'+ds+'" data-type="subnote" style="display:none" onblur="qeSubNoteBlur(this)" />'
          +'</div></td>'
          +'<td class="qe-td-n" style="background:'+bg+';text-align:center;vertical-align:middle"><input class="qe-sp-inp qe-sp-price" type="number" placeholder="—" min="0" step="0.01" data-client="'+c.id+'" data-date="'+ds+'" data-type="price" oninput="updateQEClientTotal(this)" onkeydown="qeSpreadsheetNav(event,this)" /></td>'
          +'<td class="qe-client-total qe-client-total-click" style="background:'+bg+'" data-client="'+c.id+'" data-date="'+ds+'" data-value="0" onclick="toggleQEClientDayStatus(\''+c.id+'\',\''+ds+'\')" title="Tap to toggle Paid/Pending">—</td>';
      }
    }).join('');
    return '<tr class="qe-sp-row'+(isToday?' qe-today-row':'')+'" data-date="'+ds+'">'
      +'<td class="qe-td-day'+(isToday?' qe-today-day':'')+'">'+day+'</td>'
      +clientCells
      +'<td class="qe-td-total qe-td-total-click" data-date="'+ds+'" onclick="toggleQERowStatus(\''+ds+'\')" title="Tap to toggle Paid/Pending">—</td></tr>';
  }).join('');

  // Footer
  const footCells = selCols.map(c=>'<td colspan="'+clientColCount(c)+'" class="qe-tf-coltotal qe-tf-coltotal-click" data-client="'+c.id+'" onclick="toggleQEClientStatus(\''+c.id+'\')" title="Tap to toggle all Paid/Pending for this client">—</td>').join('');

  cont.innerHTML = `
    <div class="qe-grid-controls">
      <div class="qe-ctrl-row">
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">Month</label>
          <select class="form-select" style="padding:7px 10px;font-size:13px" onchange="qeGridMonth=this.value;renderQEIncome(document.getElementById('qeContent'))">${moOpts}</select>
        </div>
        <div class="qe-ctrl-field" style="flex:2">
          <label class="qe-ctrl-label">Default Service</label>
          <input type="text" class="form-input" style="padding:7px 10px;font-size:13px" value="${qeGridService}" list="servicesList" placeholder="e.g. Video Editing" oninput="qeGridService=this.value" onchange="renderQEIncome(document.getElementById('qeContent'))" />
        </div>
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">Type</label>
          <select class="form-select" style="padding:7px 10px;font-size:13px" onchange="qeGridPayType=this.value">
            <option value="cash" ${qeGridPayType==='cash'?'selected':''}>Cash</option>
            <option value="invoice" ${qeGridPayType==='invoice'?'selected':''}>Invoice</option>
          </select>
        </div>
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">Status</label>
          <select class="form-select" style="padding:7px 10px;font-size:13px" onchange="qeGridStatus=this.value">
            <option value="Paid" ${qeGridStatus==='Paid'?'selected':''}>Paid</option>
            <option value="Pending" ${qeGridStatus==='Pending'?'selected':''}>Pending</option>
          </select>
        </div>
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">&nbsp;</label>
          <button class="btn-secondary" style="padding:7px 12px;font-size:12px;white-space:nowrap" onclick="reloadQEFromData()" title="Reload grid values from saved income entries (fixes empty grid)"><i class="fa-solid fa-rotate-right"></i> Reload Data</button>
        </div>
      </div>
      <div class="qe-client-row">
        <span class="qe-ctrl-label" style="flex-shrink:0">Clients:</span>
        <div class="qe-toggles-wrap">${clientToggles}</div>
      </div>
    </div>
    <div class="qe-spreadsheet-wrapper">
      <table class="qe-spreadsheet" id="qeSpreadsheet">
        <thead>
          <tr>
            <th class="qe-th-day" rowspan="2">Day</th>
            ${hRow1}
            <th class="qe-th-total" rowspan="2">Day Total</th>
          </tr>
          <tr>${hRow2}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr class="qe-sp-tfoot">
          <td class="qe-tf-label">TOTAL</td>
          ${footCells}
          <td class="qe-tf-grand">—</td>
        </tr></tfoot>
      </table>
    </div>
    <button class="qe-save-grid-btn" onclick="saveQEGrid()"><i class="fa-solid fa-check"></i> Save All Filled Entries</button>
  `;
  restoreQEGridData();
}

// Returns the status of saved income entries for a given date in QE context
function getQERowStatus(dateStr) {
  // Aggregate across all selected clients — no service filter (service can vary per subclient)
  const entries = state.income.filter(e =>
    qeGridSelectedClients.includes(e.clientId) && e.date === dateStr
  );
  if (!entries.length) return null;
  return entries.some(e => e.status === 'Pending') ? 'Pending' : 'Paid';
}

// Toggle all saved income entries for a date between Paid and Pending
function toggleQERowStatus(dateStr) {
  const entries = state.income.filter(e =>
    qeGridSelectedClients.includes(e.clientId) && e.date === dateStr
  );
  if (!entries.length) return;
  const currentStatus = entries.some(e => e.status === 'Pending') ? 'Pending' : 'Paid';
  const newStatus = currentStatus === 'Paid' ? 'Pending' : 'Paid';
  entries.forEach(e => { e.status = newStatus; });
  saveData();
  const cell = document.querySelector('.qe-td-total[data-date="' + dateStr + '"]');
  if (cell) applyQETotalColor(cell, newStatus);
  showToast(newStatus === 'Paid' ? '✓ Marked as Paid' : '⏳ Marked as Pending');
}

// Toggle a single client's entries for one specific day
function toggleQEClientDayStatus(cid, dateStr) {
  const entries = state.income.filter(e =>
    e.clientId === cid && e.date === dateStr
  );
  if (!entries.length) return; // nothing saved yet
  const currentStatus = entries.some(e => e.status === 'Pending') ? 'Pending' : 'Paid';
  const newStatus = currentStatus === 'Paid' ? 'Pending' : 'Paid';
  entries.forEach(e => { e.status = newStatus; });
  saveData();
  // Update this client total cell color
  const ct = document.querySelector('.qe-client-total[data-client="'+cid+'"][data-date="'+dateStr+'"]');
  if (ct) {
    ct.style.color      = newStatus === 'Paid' ? 'var(--green)' : '#f59e0b';
    ct.style.fontWeight = '700';
    ct.title = newStatus === 'Paid' ? 'Paid — tap to mark Pending' : 'Pending — tap to mark Paid';
  }
  // Update day total
  const dt = document.querySelector('.qe-td-total[data-date="'+dateStr+'"]');
  if (dt) applyQETotalColor(dt, getQERowStatus(dateStr));
  updateQEColTotals();
  showToast(newStatus === 'Paid' ? '✓ Marked as Paid' : '⏳ Marked as Pending');
}

// Get combined status for all entries of a client in current QE month
function getQEClientStatus(cid) {
  const entries = state.income.filter(e =>
    e.clientId === cid && e.date && e.date.startsWith(qeGridMonth)
  );
  if (!entries.length) return null;
  return entries.some(e => e.status === 'Pending') ? 'Pending' : 'Paid';
}

// Toggle ALL saved entries for a client (entire month) between Paid and Pending
function toggleQEClientStatus(cid) {
  const entries = state.income.filter(e =>
    e.clientId === cid && e.date && e.date.startsWith(qeGridMonth)
  );
  if (!entries.length) { showToast('No saved entries for this client yet','error'); return; }
  const currentStatus = entries.some(e => e.status === 'Pending') ? 'Pending' : 'Paid';
  const newStatus = currentStatus === 'Paid' ? 'Pending' : 'Paid';
  entries.forEach(e => { e.status = newStatus; });
  saveData();
  // Refresh all day-total colors for the affected dates
  const affectedDates = new Set(entries.map(e => e.date));
  affectedDates.forEach(dateStr => {
    const cell = document.querySelector('.qe-td-total[data-date="' + dateStr + '"]');
    if (cell) applyQETotalColor(cell, getQERowStatus(dateStr));
  });
  updateQEColTotals();
  showToast(newStatus === 'Paid' ? '✓ All entries marked Paid' : '⏳ All entries marked Pending');
}

// Apply color to a .qe-td-total (DAY TOTAL) cell.
// Day total is always neutral — it's just a sum, not a status indicator.
// Per-client totals have their own coloring via .qe-client-total.
function applyQETotalColor(cell, status) {
  // Neutral regardless of status — the day total should not imply Paid/Pending
  cell.style.color = 'var(--text-muted)';
  cell.style.fontWeight = '600';
  cell.title = status === 'Paid' ? 'All paid — tap to mark Pending'
             : status === 'Pending' ? 'Has pending — tap to mark Paid'
             : 'Tap to toggle status';
}

function updateQEClientTotal(inp) {
  // Auto-save draft so values survive a refresh
  captureQEGridData();
  const cid = inp.dataset.client;
  const tr = inp.closest('tr');
  const sharedPrice = parseFloat(tr.querySelector('[data-client="'+cid+'"][data-type="price"]')?.value) || 0;
  let clientTotal = 0;
  const subqtys = tr.querySelectorAll('[data-client="'+cid+'"][data-type="subqty"]');
  if (subqtys.length > 0) {
    subqtys.forEach(sq=>{
      const qty = parseFloat(sq.value) || 0;
      if (qty <= 0) return;
      const sub = sq.dataset.sub;
      const subPriceEl = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subprice"]');
      const effectivePrice = parseFloat(subPriceEl?.value) || sharedPrice;
      if (effectivePrice > 0) clientTotal += Math.round(qty * effectivePrice * 100) / 100;
    });
  } else {
    const qty = parseFloat(tr.querySelector('[data-client="'+cid+'"][data-type="qty"]')?.value) || 0;
    const price = sharedPrice;
    if (qty > 0 && price > 0) clientTotal = Math.round(qty * price * 100) / 100;
  }
  const dateStr = inp.dataset.date || tr.dataset.date;
  const ct = tr.querySelector('.qe-client-total[data-client="'+cid+'"]');
  if (ct) {
    ct.textContent = clientTotal > 0 ? fmt(clientTotal) : '—';
    ct.dataset.value = clientTotal;
    // Color the client-total cell: orange the moment a value is typed,
    // green only if saved entries already show Paid
    if (clientTotal > 0) {
      // No service filter — match by clientId+date only so subclient entries are found
      const saved = state.income.filter(e => e.clientId===cid && e.date===dateStr);
      const st = saved.length ? (saved.some(e=>e.status==='Pending') ? 'Pending' : 'Paid') : 'Pending';
      ct.style.color      = st === 'Paid' ? 'var(--green)' : '#f59e0b';
      ct.style.fontWeight = '700';
      ct.title = st === 'Paid' ? 'Paid — tap to mark Pending' : 'Pending — tap to mark Paid';
    } else {
      ct.style.color = ''; ct.style.fontWeight = ''; ct.title = 'Tap to toggle Paid/Pending';
    }
  }
  // Day total
  let dayTotal = 0;
  tr.querySelectorAll('.qe-client-total').forEach(c=>{ dayTotal += parseFloat(c.dataset.value)||0; });
  const dt = tr.querySelector('.qe-td-total');
  if (dt) {
    dt.textContent = dayTotal > 0 ? fmt(dayTotal) : '—';
    applyQETotalColor(dt, getQERowStatus(dateStr));
  }
  updateQEColTotals();
}

function updateQEColTotals() {
  const table = document.getElementById('qeSpreadsheet');
  if (!table) return;
  const service = (qeGridService||'').trim();
  let grand = 0;
  table.querySelectorAll('.qe-tf-coltotal').forEach(foot=>{
    const cid = foot.dataset.client;
    let col = 0;
    table.querySelectorAll('.qe-client-total[data-client="'+cid+'"]').forEach(c=>{ col += parseFloat(c.dataset.value)||0; });
    foot.textContent = col > 0 ? fmt(col) : '—';
    grand += col;
    // Color by payment status — orange if any pending, any draft, or no saved status yet
    const clientStatus = getQEClientStatus(cid);
    const hasDraftForClient = Object.keys(qeGridData).some(k => {
      const p = k.split('|');
      return ['price','qty','subqty','subprice'].includes(p[0]) &&
             p[1] === cid && qeGridData[k] !== '';
    });
    if (clientStatus === 'Paid' && !hasDraftForClient) {
      foot.style.color      = 'var(--green)';
      foot.style.fontWeight = '700';
    } else if (col > 0 || clientStatus) {
      foot.style.color      = '#f59e0b';
      foot.style.fontWeight = '700';
    } else {
      foot.style.color      = '';
      foot.style.fontWeight = '';
    }
  });
  const g = table.querySelector('.qe-tf-grand');
  if (g) g.textContent = grand > 0 ? fmt(grand) : '—';
}

function qeSpreadsheetNav(e, inp) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const cid = inp.dataset.client;
    const type = inp.dataset.type;
    const tbody = inp.closest('tbody');
    const same = Array.from(tbody.querySelectorAll('[data-client="'+cid+'"][data-type="'+type+'"]'));
    const next = same[same.indexOf(inp)+1];
    if (next) { next.focus(); next.select(); }
  }
}

function toggleSubNote(btn) {
  const inp = btn.nextElementSibling;
  if (!inp) return;
  btn.style.display = 'none';
  inp.style.display = 'block';
  inp.focus();
}

function qeSubNoteBlur(inp) {
  if (!inp.value.trim()) {
    inp.style.display = 'none';
    const pen = inp.previousElementSibling;
    if (pen?.classList.contains('qe-note-pen')) pen.style.display = '';
  }
  captureQEGridData();
}

function closeMobileSidebar() {
  if (window.innerWidth > 768) return;
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  if (sidebar) sidebar.classList.remove('mobile-open');
  if (overlay) overlay.style.display = 'none';
}

function toggleSidebar() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    const isOpen = sidebar.classList.toggle('mobile-open');
    if (overlay) overlay.style.display = isOpen ? 'block' : 'none';
  } else {
    document.body.classList.toggle('sidebar-hidden');
  }
}

function toggleQEGridClient(id, checked) {
  if (checked) { if (!qeGridSelectedClients.includes(id)) qeGridSelectedClients.push(id); }
  else { qeGridSelectedClients = qeGridSelectedClients.filter(c=>c!==id); }
  renderQEIncome(document.getElementById('qeContent'));
}

function saveQEGrid() {
  const table = document.getElementById('qeSpreadsheet');
  if (!table) return;
  let savedCount = 0; let savedTotal = 0;
  table.querySelectorAll('tbody tr').forEach(tr=>{
    const dateStr = tr.dataset.date;
    const done = new Set();
    tr.querySelectorAll('[data-type="price"]').forEach(priceInp=>{
      const cid = priceInp.dataset.client;
      if (done.has(cid)) return; done.add(cid);
      const price = parseFloat(priceInp.value) || 0;
      const subqtys = tr.querySelectorAll('[data-client="'+cid+'"][data-type="subqty"]');
      if (subqtys.length > 0) {
        subqtys.forEach(sq=>{
          const qty = parseFloat(sq.value) || 0;
          if (qty <= 0) return;
          const sub = sq.dataset.sub;
          const service = getClientService(cid, sub); // per-subclient service
          const subPriceEl = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subprice"]');
          const subNoteEl  = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subnote"]');
          const effectivePrice = parseFloat(subPriceEl?.value) || price;
          if (effectivePrice <= 0) return;
          const subNote = subNoteEl?.value.trim() || '';
          const amount = Math.round(qty * effectivePrice * 100) / 100;
          // Upsert: update existing entry or create new
          // Match on client+date+sub only — service can change, we update it in-place
          const xi = state.income.findIndex(e=>e.clientId===cid && e.date===dateStr && (e.subClient||'')===(sub||''));
          const cPayType = clientById(cid)?.paymentType || qeGridPayType || 'invoice';
          if (xi >= 0) {
            state.income[xi] = { ...state.income[xi], service, amount, qty, unitPrice:effectivePrice, sharedPrice:price, notes:subNote, vatAmount:cPayType==='invoice'?amount*VAT_RATE:0, paymentType:cPayType };
            // status is intentionally NOT overwritten — preserve any manual Paid/Pending toggle
          } else {
            const entry = { id:genId(), clientId:cid, subClient:sub||'', service, amount, qty, unitPrice:effectivePrice, sharedPrice:price,
              vatAmount:cPayType==='invoice'?amount*VAT_RATE:0,
              paymentType:cPayType, date:dateStr, status:qeGridStatus, notes:subNote, createdAt:Date.now() };
            state.income.push(entry); sheetsAdd('income',entry);
          }
          savedCount++; savedTotal += amount;
        });
      } else {
        const service = getClientService(cid); // direct client — client-level service
        const qty = parseFloat(tr.querySelector('[data-client="'+cid+'"][data-type="qty"]')?.value) || 0;
        if (qty <= 0) return;
        const subNoteEl = tr.querySelector('[data-client="'+cid+'"][data-type="subnote"]');
        const subNote = subNoteEl?.value.trim() || '';
        const amount = Math.round(qty * price * 100) / 100;
        if (amount <= 0) return;
        // Match on client+date+sub only — service can change, update it in-place
        const xi = state.income.findIndex(e=>e.clientId===cid && e.date===dateStr && (e.subClient||'')==='');
        const cPayType2 = clientById(cid)?.paymentType || qeGridPayType || 'invoice';
        if (xi >= 0) {
          state.income[xi] = { ...state.income[xi], service, amount, qty, unitPrice:price, notes:subNote, vatAmount:cPayType2==='invoice'?amount*VAT_RATE:0, paymentType:cPayType2 };
          // status is intentionally NOT overwritten — preserve any manual Paid/Pending toggle
        } else {
          const entry = { id:genId(), clientId:cid, subClient:'', service, amount, qty, unitPrice:price,
            vatAmount:cPayType2==='invoice'?amount*VAT_RATE:0,
            paymentType:cPayType2, date:dateStr, status:qeGridStatus, notes:subNote, createdAt:Date.now() };
          state.income.push(entry); sheetsAdd('income',entry);
        }
        savedCount++; savedTotal += amount;
      }
    });
  });
  // Delete entries for cells that are now zero/empty (user cleared them)
  table.querySelectorAll('tbody tr').forEach(tr => {
    const ds = tr.dataset.date;
    const done3 = new Set();
    tr.querySelectorAll('[data-type="price"]').forEach(priceInp => {
      const cid2 = priceInp.dataset.client;
      if (done3.has(cid2)) return; done3.add(cid2);
      const subqtys2 = tr.querySelectorAll('[data-client="'+cid2+'"][data-type="subqty"]');
      if (subqtys2.length > 0) {
        subqtys2.forEach(sq2 => {
          if ((parseFloat(sq2.value)||0) <= 0) {
            const sub2 = sq2.dataset.sub;
            // Only delete PENDING entries — never auto-delete Paid entries from QE
            state.income = state.income.filter(e =>
              !(e.clientId===cid2 && e.date===ds && (e.subClient||'')===(sub2||'') && e.status!=='Paid')
            );
          }
        });
      } else {
        const qi2 = tr.querySelector('[data-client="'+cid2+'"][data-type="qty"]');
        if ((parseFloat(qi2?.value)||0) <= 0 && (parseFloat(priceInp.value)||0) <= 0) {
          // Only delete PENDING entries — never auto-delete Paid entries from QE
          state.income = state.income.filter(e =>
            !(e.clientId===cid2 && e.date===ds && (e.subClient||'')==='' && e.status!=='Paid')
          );
        }
      }
    });
  });

  if (!savedCount) { showToast('No entries to save','error'); return; }
  try {
    saveData();
  } catch(e) {
    showPersistentError('❌ Could not save QE — storage full. Export data first then clear space.');
    return;
  }
  showToast(savedCount+' entries saved — '+fmt(savedTotal));
  // Keep all values visible — do NOT clear the grid
}

function toggleQEDate(btn) {
  const wrap = btn.closest('.qe-date-wrap') || btn.parentElement;
  const inp  = wrap.querySelector('input');
  if (inp.type === 'date') {
    inp.type  = 'month';
    inp.value = todayVal().slice(0,7);
    btn.textContent = 'D';
    btn.classList.add('month-mode');
  } else {
    inp.type  = 'date';
    inp.value = todayVal();
    btn.textContent = 'M';
    btn.classList.remove('month-mode');
  }
}

/* ── Expense QE Grid ────────────────────────────────────────── */

function captureQEExpGridData() {
  const table = document.getElementById('qeExpSpreadsheet');
  if (!table) return;
  // Reset only days of the current month
  const [yr,mo] = qeGridMonth.split('-').map(Number);
  const dim = new Date(yr,mo,0).getDate();
  for (let i=1;i<=dim;i++) {
    const ds = qeGridMonth+'-'+String(i).padStart(2,'0');
    qeExpenseGridData[ds] = [];
  }
  table.querySelectorAll('.qe-exp-slot[data-date]').forEach(slotEl=>{
    const ds = slotEl.dataset.date;
    const cat  = slotEl.querySelector('[data-type="expcategory"]')?.value||'';
    const amt  = slotEl.querySelector('[data-type="expamount"]');
    const note = slotEl.querySelector('[data-type="expnote"]')?.value||'';
    // Only save slots that have at least a category or an amount (skip empty trailing slots)
    if (!cat && !(amt?.value||'')) return;
    if (!qeExpenseGridData[ds]) qeExpenseGridData[ds]=[];
    qeExpenseGridData[ds].push({ id:amt?.dataset.entryId||'', category:cat, amount:amt?.value||'', note });
  });
  // Drop fully-empty date buckets so they reload fresh from state next time
  Object.keys(qeExpenseGridData).forEach(ds=>{
    if ((qeExpenseGridData[ds]||[]).every(s=>!s.category&&!s.amount&&!s.note)) delete qeExpenseGridData[ds];
  });
  // Persist draft to localStorage so it survives refresh
  idbSet(QE_EXP_KEY, qeExpenseGridData);
}

function initQEExpFromState() {
  const [yr,mo] = qeGridMonth.split('-').map(Number);
  const dim = new Date(yr,mo,0).getDate();
  for (let i=1;i<=dim;i++) {
    const ds = qeGridMonth+'-'+String(i).padStart(2,'0');
    if (!qeExpenseGridData[ds]) {
      const saved = state.expenses.filter(e=>e.date===ds);
      if (saved.length) qeExpenseGridData[ds] = saved.map(e=>({
        id:e.id, category:e.category||'', amount:e.amount?String(e.amount):'', note:e.vendor||e.description||''
      }));
    }
  }
}

function renderQEExpSlotHTML(ds, slot, si) {
  const catOpts = Object.keys(CATEGORY_ICONS).map(cat=>
    '<option value="'+cat+'" '+(slot.category===cat?'selected':'')+'>'+CATEGORY_ICONS[cat]+' '+cat+'</option>'
  ).join('');
  const hasNote = !!slot.note;
  return '<div class="qe-exp-slot" data-date="'+ds+'" data-slot="'+si+'">'
    +'<select class="qe-sp-inp qe-exp-cat" data-type="expcategory" onchange="updateQEExpDayTotal(\''+ds+'\')">'
      +'<option value="">Cat…</option>'+catOpts+'</select>'
    +'<input class="qe-sp-inp qe-exp-amt" type="number" placeholder="—" min="0" step="0.01"'
      +' value="'+(slot.amount||'')+'" data-type="expamount" data-entry-id="'+(slot.id||'')+'"'
      +' oninput="updateQEExpDayTotal(\''+ds+'\')" />'
    +'<button class="qe-note-pen" onclick="toggleSubNote(this)" title="Vendor/Note"'
      +' style="'+(hasNote?'display:none':'')+'"><i class="fa-solid fa-pencil"></i></button>'
    +'<input class="qe-sp-inp qe-sp-subnote" type="text" placeholder="vendor / note…"'
      +' value="'+(slot.note||'')+'" data-type="expnote"'
      +' style="display:'+(hasNote?'block':'none')+'" onblur="qeSubNoteBlur(this)" />'
    +'<button class="qe-exp-remove" onclick="removeQEExpSlot(this)" title="Remove"><i class="fa-solid fa-xmark"></i></button>'
  +'</div>';
}

function renderQEExpense(cont) {
  captureQEExpGridData();
  if (!qeGridMonth) qeGridMonth = todayVal().slice(0,7);
  const [yr,mo] = qeGridMonth.split('-').map(Number);
  const daysInMonth = new Date(yr,mo,0).getDate();
  const today = todayVal();

  initQEExpFromState();

  const moOpts = (()=>{
    const ms = allMonths(); if (!ms.includes(qeGridMonth)) ms.unshift(qeGridMonth);
    return ms.map(m=>`<option value="${m}" ${m===qeGridMonth?'selected':''}>${monthLabel(m)}</option>`).join('');
  })();

  const bodyRows = Array.from({length:daysInMonth},(_,i)=>{
    const day=i+1, ds=qeGridMonth+'-'+String(day).padStart(2,'0'), isToday=ds===today;
    const slots = [...(qeExpenseGridData[ds]||[]), {id:'',category:'',amount:'',note:''}];
    const slotsHtml = slots.map((s,si)=>renderQEExpSlotHTML(ds,s,si)).join('');
    return '<tr class="qe-sp-row'+(isToday?' qe-today-row':'')+'" data-date="'+ds+'">'
      +'<td class="qe-td-day'+(isToday?' qe-today-day':'')+'">'+day+'</td>'
      +'<td class="qe-exp-day-td">'
        +'<div class="qe-exp-slots" id="qe-slots-'+ds+'">'+slotsHtml+'</div>'
        +'<button class="qe-exp-add-slot-btn" onclick="addQEExpSlot(\''+ds+'\')"><i class="fa-solid fa-plus"></i></button>'
      +'</td>'
      +'<td class="qe-exp-day-total qe-td-total" data-date="'+ds+'" data-value="0">—</td>'
    +'</tr>';
  }).join('');

  cont.innerHTML = `
    <div class="qe-grid-controls">
      <div class="qe-ctrl-row">
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">Month</label>
          <select class="form-select" style="padding:7px 10px;font-size:13px" onchange="qeGridMonth=this.value;renderQEExpense(document.getElementById('qeContent'))">${moOpts}</select>
        </div>
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">Payment</label>
          <select class="form-select" style="padding:7px 10px;font-size:13px" onchange="qeExpPayMethod=this.value">
            <option value="Cash" ${qeExpPayMethod==='Cash'?'selected':''}>Cash</option>
            <option value="Credit Card" ${qeExpPayMethod==='Credit Card'?'selected':''}>Credit Card</option>
          </select>
        </div>
      </div>
    </div>
    <div class="qe-spreadsheet-wrapper">
      <table class="qe-spreadsheet" id="qeExpSpreadsheet">
        <thead><tr>
          <th class="qe-th-day">Day</th>
          <th style="text-align:left;padding-left:10px;font-size:11px;color:var(--text-muted);font-weight:500">
            Category &nbsp;·&nbsp; Amount &nbsp;·&nbsp; Vendor/Note &nbsp;
            <span style="opacity:.45;font-weight:400">(click <i class="fa-solid fa-plus" style="font-size:9px"></i> to add more per day)</span>
          </th>
          <th class="qe-th-total">Day Total</th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr class="qe-sp-tfoot">
          <td class="qe-tf-label">TOTAL</td><td></td>
          <td class="qe-tf-grand qe-td-total" id="qeExpGrandTotal">—</td>
        </tr></tfoot>
      </table>
    </div>
    <button class="qe-save-grid-btn" onclick="saveQEExpenseGrid()"><i class="fa-solid fa-check"></i> Save All Filled Entries</button>`;

  document.querySelectorAll('#qeExpSpreadsheet tbody tr[data-date]').forEach(tr=>updateQEExpDayTotal(tr.dataset.date));
}

function addQEExpSlot(dateStr) {
  const cont = document.getElementById('qe-slots-'+dateStr);
  if (!cont) return;
  // Only add if the last existing slot has at least a category or amount
  const slots = cont.querySelectorAll('.qe-exp-slot');
  if (slots.length > 0) {
    const last = slots[slots.length - 1];
    const lastCat = last.querySelector('[data-type="expcategory"]')?.value || '';
    const lastAmt = last.querySelector('[data-type="expamount"]')?.value || '';
    if (!lastCat && !lastAmt) return; // last slot is still empty, don't add another
  }
  const si = slots.length;
  cont.insertAdjacentHTML('beforeend', renderQEExpSlotHTML(dateStr,{id:'',category:'',amount:'',note:''},si));
}

function removeQEExpSlot(btn) {
  const slotEl = btn.closest('.qe-exp-slot');
  if (!slotEl) return;
  const amtInp = slotEl.querySelector('[data-type="expamount"]');
  const entryId = amtInp?.dataset.entryId;
  const dateStr = slotEl.dataset.date;
  if (entryId) {
    state.expenses = state.expenses.filter(e=>e.id!==entryId);
    if (qeExpenseGridData[dateStr]) qeExpenseGridData[dateStr] = qeExpenseGridData[dateStr].filter(s=>s.id!==entryId);
    saveData(); showToast('Expense removed');
  }
  slotEl.remove();
  updateQEExpDayTotal(dateStr);
}

function updateQEExpDayTotal(dateStr) {
  const cont = document.getElementById('qe-slots-'+dateStr);
  let total = 0;
  cont?.querySelectorAll('[data-type="expamount"]').forEach(inp=>{ total += parseFloat(inp.value)||0; });
  const tc = document.querySelector('.qe-exp-day-total[data-date="'+dateStr+'"]');
  if (tc) { tc.textContent = total>0?fmt(total):'—'; tc.dataset.value=total; }
  updateQEExpGrandTotal();
}

function updateQEExpGrandTotal() {
  let grand=0;
  document.querySelectorAll('.qe-exp-day-total').forEach(c=>{ grand+=parseFloat(c.dataset.value)||0; });
  const g = document.getElementById('qeExpGrandTotal');
  if (g) g.textContent = grand>0?fmt(grand):'—';
}

function saveQEExpenseGrid() {
  const table = document.getElementById('qeExpSpreadsheet');
  if (!table) return;
  let savedCount=0, savedTotal=0;
  table.querySelectorAll('.qe-exp-slot[data-date]').forEach(slotEl=>{
    const dateStr  = slotEl.dataset.date;
    const catSel   = slotEl.querySelector('[data-type="expcategory"]');
    const amtInp   = slotEl.querySelector('[data-type="expamount"]');
    const noteInp  = slotEl.querySelector('[data-type="expnote"]');
    const category = catSel?.value||''; const amount = parseFloat(amtInp?.value)||0;
    const note = noteInp?.value.trim()||''; const entryId = amtInp?.dataset.entryId||'';
    if (amount<=0) return;
    if (entryId) {
      const xi = state.expenses.findIndex(e=>e.id===entryId);
      if (xi>=0) state.expenses[xi] = {...state.expenses[xi], category, amount, vendor:note, description:note};
    } else {
      const entry = {id:genId(), category, vendor:note, description:note, amount, vatAmount:0,
        paymentMethod:qeExpPayMethod, recurring:false, date:dateStr, notes:note, createdAt:Date.now()};
      state.expenses.push(entry); sheetsAdd('expense',entry);
      if (amtInp) amtInp.dataset.entryId = entry.id;
    }
    savedCount++; savedTotal+=amount;
  });
  if (!savedCount) { showToast('No entries to save','error'); return; }
  saveData(); captureQEExpGridData();
  showToast(savedCount+' expenses saved — '+fmt(savedTotal));
}

function flashRow(tr, type) {
  tr.classList.add('qe-flash-'+type);
  setTimeout(()=>tr.classList.remove('qe-flash-'+type), 600);
}

// ── RENDER: Dashboard ──────────────────────────────────────────
function renderDashboard() {
  renderMonthPills();
  const inc = dashMonth==='all' ? state.income   : state.income.filter(e=>monthKey(e.date)===dashMonth);
  const exp = dashMonth==='all' ? state.expenses : state.expenses.filter(e=>monthKey(e.date)===dashMonth);

  // KPIs
  const collected = inc.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const pending   = inc.filter(e=>e.status!=='Paid').reduce((s,e)=>s+e.amount,0);
  const totalExp  = exp.reduce((s,e)=>s+e.amount,0);
  const netProfit = collected-totalExp;
  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card green kpi-clickable" onclick="goToIncome('Paid')" title="Go to Income · Paid"><div class="kpi-icon"><i class="fa-solid fa-circle-check"></i></div><div class="kpi-label">Collected</div><div class="kpi-value">${fmt(collected)}</div></div>
    <div class="kpi-card amber kpi-clickable" onclick="goToIncome('Pending')" title="Go to Income · Pending"><div class="kpi-icon"><i class="fa-solid fa-clock"></i></div><div class="kpi-label">Pending</div><div class="kpi-value">${fmt(pending)}</div></div>
    <div class="kpi-card red kpi-clickable" onclick="navigate('expenses')" title="Go to Expenses"><div class="kpi-icon"><i class="fa-solid fa-arrow-trend-down"></i></div><div class="kpi-label">Expenses</div><div class="kpi-value">${fmt(totalExp)}</div></div>
    <div class="kpi-card blue"><div class="kpi-icon"><i class="fa-solid fa-sack-dollar"></i></div><div class="kpi-label">Net Profit</div><div class="kpi-value" style="color:${netProfit>=0?'var(--green)':'var(--red)'}">${fmt(netProfit)}</div></div>`;

  // Recurring prompt — count missing recurring entries for current month
  const curMonth = todayVal().slice(0,7);
  const recurringIncEntries = state.income.filter(e=>e.recurring);
  const missingInc = recurringIncEntries.filter(e =>
    !state.income.some(x => x.clientId===e.clientId && x.service===e.service && monthKey(x.date)===curMonth)
  );
  const missingIncUnique = [...new Map(missingInc.map(e=>[e.clientId+'|'+e.service, e])).values()];

  const recurringExpEntries = state.expenses.filter(e=>e.recurring);
  const missingExp = recurringExpEntries.filter(e =>
    !state.expenses.some(x => x.category===e.category && x.vendor===e.vendor && monthKey(x.date)===curMonth)
  );
  const missingExpUnique = [...new Map(missingExp.map(e=>[e.category+'|'+e.vendor, e])).values()];

  const totalMissing = missingIncUnique.length + missingExpUnique.length;
  const recurBanner = document.getElementById('recurringBanner');
  if (recurBanner) {
    recurBanner.style.display = totalMissing > 0 ? '' : 'none';
    const ml = document.getElementById('recurBannerMonth');
    if (ml) ml.textContent = monthLabel(curMonth);
    const countEl = document.getElementById('recurBannerCount');
    if (countEl) countEl.textContent = totalMissing;
  }

  // VAT
  const vatCol  = inc.filter(e=>e.paymentType==='invoice').reduce((s,e)=>s+(e.vatAmount||0),0);
  const vatDed  = exp.reduce((s,e)=>s+(e.vatAmount||0),0);
  const netVAT  = vatCol-vatDed;
  document.getElementById('vatSummary').innerHTML = `
    <div class="vat-item green"><div class="vat-item-label">VAT Collected</div><div class="vat-item-value">${fmt(vatCol)}</div></div>
    <div class="vat-item blue"><div class="vat-item-label">VAT Deductible</div><div class="vat-item-value">${fmt(vatDed)}</div></div>
    <div class="vat-item ${netVAT>=0?'red':'green'}"><div class="vat-item-label">Net VAT to Pay</div><div class="vat-item-value">${fmt(netVAT)}</div></div>`;

  // Income by client (left column)
  const byClient = {};
  inc.filter(e=>e.status==='Paid').forEach(e=>{
    const c = clientById(e.clientId);
    const k = c ? c.id : 'unknown';
    if (!byClient[k]) byClient[k]={amount:0,color:c?.color||'#888',name:c?.name||'Unknown'};
    byClient[k].amount += e.amount;
  });
  const sortedClients = Object.values(byClient).sort((a,b)=>b.amount-a.amount);
  const maxInc = sortedClients[0]?.amount||1;
  document.getElementById('incomeByClient').innerHTML = sortedClients.length
    ? sortedClients.map(d=>{
        const pct = Math.round((d.amount/maxInc)*100);
        return `<div class="overview-row">
          <div class="ov-dot" style="background:${d.color}"></div>
          <div class="ov-name">${d.name}</div>
          <div class="ov-bar-wrap"><div class="ov-bar" style="width:${pct}%;background:${d.color}"></div></div>
          <div class="ov-val green">${fmt(d.amount)}</div>
        </div>`;}).join('')
    : '<div class="ov-empty">No income data</div>';

  // Expenses by category (right column)
  const byCat = {};
  exp.forEach(e=>{ byCat[e.category]=(byCat[e.category]||0)+e.amount; });
  const sortedCats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const maxExp = sortedCats[0]?.[1]||1;
  document.getElementById('expensesByCategory').innerHTML = sortedCats.length
    ? sortedCats.map(([cat,amt])=>{
        const pct = Math.round((amt/maxExp)*100);
        return `<div class="overview-row">
          <div class="ov-icon">${CATEGORY_ICONS[cat]||'📦'}</div>
          <div class="ov-name">${cat}</div>
          <div class="ov-bar-wrap"><div class="ov-bar" style="width:${pct}%;background:var(--red)"></div></div>
          <div class="ov-val red">${fmt(amt)}</div>
        </div>`;}).join('')
    : '<div class="ov-empty">No expense data</div>';

  renderStatistics(inc);
}

function renderMonthPills() {
  const months = allMonths();
  const cur    = todayVal().slice(0,7);
  let html = `<button class="month-pill ${dashMonth==='all'?'active':''}" onclick="setDashMonth('all')">All Time</button>`;
  months.forEach(m=>{ html+=`<button class="month-pill ${dashMonth===m?'active':''}" onclick="setDashMonth('${m}')">${monthLabel(m)}</button>`; });
  if (!months.includes(cur)) html+=`<button class="month-pill ${dashMonth===cur?'active':''}" onclick="setDashMonth('${cur}')">${monthLabel(cur)}</button>`;
  document.getElementById('monthPills').innerHTML = html;
}

function goToIncome(status) {
  incStatus = status;
  incClient = 'all';
  incMonth  = todayVal().slice(0,7);
  navigate('income');
}

function setDashMonth(m) { dashMonth=m; saveUIState(); renderDashboard(); }

// ── Statistics ─────────────────────────────────────────────────
function renderStatistics(filteredInc) {
  if (chartByClient) { chartByClient.destroy(); chartByClient=null; }
  if (chartMonthly)  { chartMonthly.destroy();  chartMonthly=null;  }
  if (chartExpCat)   { chartExpCat.destroy();   chartExpCat=null;   }

  if (typeof Chart === 'undefined') return;

  // Revenue by client doughnut
  const byClient = {};
  (filteredInc||state.income).filter(e=>e.status==='Paid').forEach(e=>{
    const c = clientById(e.clientId);
    const n = c?.name||'Unknown';
    byClient[n] = (byClient[n]||0)+e.amount;
  });
  const cEntries = Object.entries(byClient).sort((a,b)=>b[1]-a[1]);

  const pieCtx = document.getElementById('chartByClient');
  if (pieCtx && cEntries.length) {
    chartByClient = new Chart(pieCtx, {
      type:'doughnut',
      data:{
        labels: cEntries.map(([n])=>n),
        datasets:[{ data:cEntries.map(([,v])=>v),
          backgroundColor: cEntries.map(([n])=>state.clients.find(c=>c.name===n)?.color||'#666'),
          borderWidth:2, borderColor:'#13132a' }]
      },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'right', labels:{ color:'#94a3b8',font:{size:11,family:'Inter'},padding:8,boxWidth:12 } },
          tooltip:{ callbacks:{ label:ctx=>` ${ctx.label}: ${fmt(ctx.raw)}` } } } }
    });
  } else if (pieCtx) {
    pieCtx.parentElement.innerHTML='<div class="chart-empty">No paid income data yet</div>';
  }

  // Monthly bar chart
  const months = allMonths().slice(0,12).reverse();
  const barCtx = document.getElementById('chartMonthly');
  if (barCtx && months.length) {
    chartMonthly = new Chart(barCtx, {
      type:'bar',
      data:{
        labels: months.map(m=>{ const[y,mo]=m.split('-'); return MONTH_NAMES[parseInt(mo)-1].slice(0,3)+' \''+y.slice(2); }),
        datasets:[
          { label:'Income',   data:months.map(m=>state.income.filter(e=>monthKey(e.date)===m&&e.status==='Paid').reduce((s,e)=>s+e.amount,0)),  backgroundColor:'rgba(16,185,129,0.8)',borderRadius:4 },
          { label:'Expenses', data:months.map(m=>state.expenses.filter(e=>monthKey(e.date)===m).reduce((s,e)=>s+e.amount,0)), backgroundColor:'rgba(239,68,68,0.7)',borderRadius:4 },
        ]
      },
      options:{ responsive:true, maintainAspectRatio:false,
        scales:{
          x:{ ticks:{color:'#94a3b8',font:{size:10}}, grid:{color:'rgba(255,255,255,0.04)'} },
          y:{ ticks:{color:'#94a3b8',font:{size:10},callback:v=>'€'+(v>=1000?(v/1000).toFixed(1)+'k':v)}, grid:{color:'rgba(255,255,255,0.04)'} }
        },
        plugins:{ legend:{labels:{color:'#94a3b8',font:{size:11,family:'Inter'},boxWidth:12}},
          tooltip:{callbacks:{label:ctx=>` ${ctx.dataset.label}: ${fmt(ctx.raw)}`}} }
      }
    });
  } else if (barCtx) {
    barCtx.parentElement.innerHTML='<div class="chart-empty">No monthly data yet</div>';
  }

  // Expenses by category doughnut
  const byCatExp = {};
  state.expenses.forEach(e => { byCatExp[e.category] = (byCatExp[e.category]||0) + e.amount; });
  const catEntries = Object.entries(byCatExp).sort((a,b) => b[1]-a[1]);
  const expCatCtx = document.getElementById('chartExpCat');
  const catColors = ['#ef4444','#f97316','#f59e0b','#84cc16','#10b981','#06b6d4','#6366f1','#8b5cf6','#ec4899','#64748b'];
  if (expCatCtx && catEntries.length) {
    chartExpCat = new Chart(expCatCtx, {
      type:'doughnut',
      data:{
        labels: catEntries.map(([n])=>n),
        datasets:[{ data: catEntries.map(([,v])=>v),
          backgroundColor: catEntries.map((_,i)=>catColors[i%catColors.length]),
          borderWidth:2, borderColor:'#13132a' }]
      },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'right', labels:{ color:'#94a3b8',font:{size:11,family:'Inter'},padding:8,boxWidth:12 } },
          tooltip:{ callbacks:{ label:ctx=>` ${ctx.label}: ${fmt(ctx.raw)}` } } } }
    });
  } else if (expCatCtx) {
    expCatCtx.parentElement.innerHTML='<div class="chart-empty">No expense data yet</div>';
  }

  // Stats tables
  const topClients = Object.entries(byClient).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const bySvc={};
  (filteredInc||state.income).filter(e=>e.status==='Paid').forEach(e=>{ bySvc[e.service]=(bySvc[e.service]||0)+e.amount; });
  const topSvc = Object.entries(bySvc).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const byMo={};
  state.income.filter(e=>e.status==='Paid').forEach(e=>{ const k=monthKey(e.date); if(k) byMo[k]=(byMo[k]||0)+e.amount; });
  const topMo = Object.entries(byMo).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const maxCl = topClients[0]?.[1]||1;
  const maxSv = topSvc[0]?.[1]||1;
  const maxMo = topMo[0]?.[1]||1;
  document.getElementById('statsTablesRow').innerHTML = `
    <div class="stats-table-card">
      <div class="stats-table-title"><i class="fa-solid fa-trophy"></i> Top Clients</div>
      ${topClients.length?topClients.map(([n,v],i)=>{
        const c=state.clients.find(cl=>cl.name===n);
        const pct=Math.round((v/maxCl)*100);
        return`<div class="stats-row"><span class="stats-rank">${i+1}</span><div class="stats-dot" style="background:${c?.color||'#888'}"></div><span class="stats-name">${n}</span><div class="stats-bar-wrap"><div class="stats-bar" style="width:${pct}%;background:${c?.color||'var(--green)'}"></div></div><span class="stats-val">${fmt(v)}</span></div>`;
      }).join(''):'<div class="chart-empty">No data</div>'}
    </div>
    <div class="stats-table-card">
      <div class="stats-table-title"><i class="fa-solid fa-star"></i> Top Services</div>
      ${topSvc.length?topSvc.map(([n,v],i)=>{
        const pct=Math.round((v/maxSv)*100);
        return`<div class="stats-row"><span class="stats-rank">${i+1}</span><span class="stats-name">${n}</span><div class="stats-bar-wrap"><div class="stats-bar" style="width:${pct}%;background:var(--accent)"></div></div><span class="stats-val">${fmt(v)}</span></div>`;
      }).join(''):'<div class="chart-empty">No data</div>'}
    </div>
    <div class="stats-table-card">
      <div class="stats-table-title"><i class="fa-solid fa-calendar-star"></i> Best Months</div>
      ${topMo.length?topMo.map(([m,v],i)=>{
        const pct=Math.round((v/maxMo)*100);
        return`<div class="stats-row"><span class="stats-rank">${i+1}</span><span class="stats-name">${monthLabel(m)}</span><div class="stats-bar-wrap"><div class="stats-bar" style="width:${pct}%;background:var(--blue)"></div></div><span class="stats-val">${fmt(v)}</span></div>`;
      }).join(''):'<div class="chart-empty">No data</div>'}
    </div>`;
}

// ── Bulk Select — Income ───────────────────────────────────────
function toggleIncBulkMode() {
  incBulkMode = !incBulkMode;
  if (!incBulkMode) incSelectedIds = new Set();
  renderIncome();
  updateIncomeBulkBar();
}
function exitIncBulkMode() {
  incBulkMode = false;
  incSelectedIds = new Set();
  renderIncome();
  updateIncomeBulkBar();
}
function toggleSelectIncome(id, e) {
  if (e) e.stopPropagation();
  if (incSelectedIds.has(id)) incSelectedIds.delete(id);
  else incSelectedIds.add(id);
  updateIncomeBulkBar();
  const cb = document.querySelector(`.bulk-cb[data-id="${id}"]`);
  if (cb) cb.checked = incSelectedIds.has(id);
  const row = document.querySelector(`[data-bulk-id="${id}"]`);
  if (row) row.classList.toggle('bulk-selected', incSelectedIds.has(id));
}
function selectAllIncomeVisible() {
  document.querySelectorAll('[data-bulk-id]').forEach(el => incSelectedIds.add(el.dataset.bulkId));
  updateIncomeBulkBar();
  document.querySelectorAll('.bulk-cb').forEach(cb => { cb.checked = true; });
  document.querySelectorAll('[data-bulk-id]').forEach(el => el.classList.add('bulk-selected'));
}
function updateIncomeBulkBar() {
  const bar = document.getElementById('incomeBulkBar');
  if (!bar) return;
  bar.style.display = incBulkMode ? 'flex' : 'none';
  const cnt = document.getElementById('bulkSelCount');
  if (cnt) cnt.textContent = `${incSelectedIds.size} selected`;
}
function selectClientGroup(cid, e) {
  if (e) e.stopPropagation();
  const group = document.querySelector(`.byclient-group[data-cid="${cid}"]`);
  if (!group) return;
  const ids = [...group.querySelectorAll('[data-bulk-id]')].map(el => el.dataset.bulkId);
  const allSelected = ids.every(id => incSelectedIds.has(id));
  ids.forEach(id => allSelected ? incSelectedIds.delete(id) : incSelectedIds.add(id));
  // Update row highlights and checkboxes
  ids.forEach(id => {
    const cb = group.querySelector(`.bulk-cb[data-id="${id}"]`);
    if (cb) cb.checked = !allSelected;
    const row = group.querySelector(`[data-bulk-id="${id}"]`);
    if (row) row.classList.toggle('bulk-selected', !allSelected);
  });
  // Update the header checkbox state
  const hdrCb = group.querySelector('.bc-select-all-cb');
  if (hdrCb) { hdrCb.checked = !allSelected; hdrCb.indeterminate = false; }
  updateBulkBar();
}

function bulkMarkIncome(status) {
  if (!incSelectedIds.size) { showToast('Select entries first','error'); return; }
  const count = incSelectedIds.size;
  pushUndo(`Mark ${count} entr${count===1?'y':'ies'} ${status}`);
  const now = Date.now();
  state.income.forEach(e => {
    if (incSelectedIds.has(e.id)) {
      e.status = status;
      if (status === 'Paid') e.paidDate = now;
      else delete e.paidDate;
    }
  });
  saveData();
  showToast(`${count} entries marked ${status}`);
  exitIncBulkMode();
}
function bulkDeleteIncome() {
  if (!incSelectedIds.size) { showToast('Select entries first','error'); return; }
  if (!confirm(`Delete ${incSelectedIds.size} selected entries?`)) return;
  const count = incSelectedIds.size;
  pushUndo(`Delete ${count} entr${count===1?'y':'ies'}`);
  state.income = state.income.filter(e => !incSelectedIds.has(e.id));
  saveData();
  showToast(`${count} entries deleted`);
  exitIncBulkMode();
}

// ── RENDER: Income ─────────────────────────────────────────────
function renderIncome() {
  const cont = document.getElementById('incomeList');
  const months = allMonths();
  const clientOpts = state.clients.map(c=>`<option value="${c.id}" ${incClient===c.id?'selected':''}>${c.name}</option>`).join('');
  const moOpts = months.map(m=>`<option value="${m}" ${incMonth===m?'selected':''}>${monthLabel(m)}</option>`).join('');

  let html = `<div class="filter-bar">
    <div class="filter-row">
      <div class="filter-group"><label class="filter-label">Month</label>
        <select class="filter-select" onchange="setIncFilter('month',this.value)">
          <option value="all" ${incMonth==='all'?'selected':''}>All Months</option>${moOpts}</select></div>
      <div class="filter-group"><label class="filter-label">Client</label>
        <select class="filter-select" onchange="setIncFilter('client',this.value)">
          <option value="all" ${incClient==='all'?'selected':''}>All Clients</option>${clientOpts}</select></div>
    </div>
    <div class="filter-row">
      <div class="filter-pills-label">Status</div>
      <div class="filter-pills">${['all','Paid','Pending'].map(s=>`<button class="filter-pill ${incStatus===s?'active':''}" onclick="setIncFilter('status','${s}')">${s==='all'?'All':s}</button>`).join('')}</div>
      <div class="filter-pills-label">Type</div>
      <div class="filter-pills">${[['all','All'],['invoice','Invoice'],['cash','Cash']].map(([v,l])=>`<button class="filter-pill ${incPayType===v?'active':''}" onclick="setIncFilter('paytype','${v}')">${l}</button>`).join('')}</div>
    </div>
  </div>`;

  const vtInc = (m,icon,label) => `<button class="vtb ${incViewMode===m?'active':''}" title="${label}" onclick="setIncViewMode('${m}')"><i class="fa-solid ${icon}"></i><span class="vtb-label">${label}</span></button>`;
  html += `<div class="view-toggle-bar"><span class="vt-label">View</span><div class="vtb-group">${vtInc('byclient','layer-group','By Client')}${vtInc('detailed','list-ul','Detailed')}${vtInc('cards','grip','Cards')}${vtInc('excel','table','Excel')}</div><button class="vtb ${incBulkMode?'active':''}" onclick="toggleIncBulkMode()" title="Bulk select"><i class="fa-solid fa-check-square"></i><span class="vtb-label">Select</span></button></div>`;

  let entries = [...state.income];
  if (incMonth!=='all')   entries=entries.filter(e=>monthKey(e.date)===incMonth);
  if (incClient!=='all')  entries=entries.filter(e=>e.clientId===incClient);
  if (incStatus!=='all')  entries=entries.filter(e=>e.status===incStatus);
  if (incPayType!=='all') entries=entries.filter(e=>e.paymentType===incPayType);
  entries.sort((a,b)=>b.date.localeCompare(a.date));

  if (!entries.length) {
    html += '<div class="empty-state"><i class="fa-solid fa-arrow-trend-up"></i><p>No entries match filters</p><small>Tap + to add income</small></div>';
    cont.innerHTML = html; return;
  }

  html += '<p class="delete-hint"><i class="fa-solid fa-hand-pointer"></i> Tap entry for details · Use buttons to copy, edit, delete</p>';
  const eaInc = (id) => `<div class="entry-actions" onclick="event.stopPropagation()">
    <button class="ea-btn ea-copy" title="Copy" onclick="openCopyDialog('income','${id}')"><i class="fa-solid fa-copy"></i></button>
    <button class="ea-btn ea-edit" title="Edit" onclick="openEditEntry('income','${id}')"><i class="fa-solid fa-pen"></i></button>
    <button class="ea-btn ea-del"  title="Delete" onclick="confirmDelete('income','${id}')"><i class="fa-solid fa-trash"></i></button>
  </div>`;

  // ── By Client view — collapsed summaries, click to expand ─────
  if (incViewMode==='byclient') {
    const byClient = {};
    entries.forEach(e=>{ if(!byClient[e.clientId])byClient[e.clientId]=[]; byClient[e.clientId].push(e); });
    Object.entries(byClient)
      .sort(([,a],[,b])=>{
        const at=a.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
        const bt=b.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
        return bt-at;
      })
      .forEach(([cid,grp])=>{
        const c=clientById(cid);
        const paid=grp.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
        const pend=grp.filter(e=>e.status!=='Paid').reduce((s,e)=>s+e.amount,0);
        const subs=[...new Set(grp.map(e=>e.subClient).filter(Boolean))];
        const dates=grp.map(e=>e.date).sort();
        const span=dates[0]===dates[dates.length-1]?toDateStr(dates[0]):toDateStr(dates[0])+' – '+toDateStr(dates[dates.length-1]);
        const av = c?.image
          ? `<img src="${c.image}" style="width:30px;height:30px;object-fit:cover;border-radius:50%;flex-shrink:0">`
          : `<span class="entry-client-dot" style="background:${c?.color||'#888'};width:30px;height:30px;border-radius:50%;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff">${initials(c?.name||'?')}</span>`;
        const entriesHtml = grp.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(e=>{
          const sl=e.status.toLowerCase();
          return `<div class="entry-compact ${sl} ${incBulkMode&&incSelectedIds.has(e.id)?'bulk-selected':''}" data-bulk-id="${e.id}" onclick="${incBulkMode?`toggleSelectIncome('${e.id}',event)`:`openEntryDetail('income','${e.id}')`}">
            ${incBulkMode?`<input type="checkbox" class="bulk-cb" data-id="${e.id}" ${incSelectedIds.has(e.id)?'checked':''} onclick="toggleSelectIncome('${e.id}',event)">`:'' }
            <span class="ec-date">${toDateStr(e.date)}</span>
            <span class="ec-sep">·</span>
            <span class="ec-service">${e.service}${e.subClient?` <em style="opacity:.6">· ${e.subClient}</em>`:''}</span>
            <span class="ec-amount">${fmt(e.amount)}</span>
            <span class="badge ${e.paymentType} mini">${e.paymentType==='invoice'?'INV':'CASH'}</span>
            <span class="badge ${sl} mini">${e.status.slice(0,3).toUpperCase()}</span>
            ${eaInc(e.id)}
          </div>`;
        }).join('');
        const grpIds = grp.map(e=>e.id);
        const allChecked = grpIds.every(id=>incSelectedIds.has(id));
        const someChecked = !allChecked && grpIds.some(id=>incSelectedIds.has(id));
        html+=`<div class="byclient-group" data-cid="${cid}">
          <div class="byclient-header" style="border-left:3px solid ${c?.color||'#888'}" onclick="${incBulkMode?'':`toggleClientGroup('${cid}')`}">
            ${incBulkMode?`<input type="checkbox" class="bulk-cb bc-select-all-cb" title="Select all for ${c?.name||'client'}" ${allChecked?'checked':''} onclick="selectClientGroup('${cid}',event)" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)">`:'' }
            <div class="byclient-name">${av}<span>${c?.name||'Unknown'}</span></div>
            <div class="bc-meta">
              <span class="bc-count">${grp.length} payment${grp.length>1?'s':''}</span>
              ${subs.length?`<span class="bc-subs">${subs.join(', ')}</span>`:''}
              <span class="bc-dates">${span}</span>
            </div>
            <div class="byclient-totals">
              <span class="byclient-paid">${fmt(paid)}</span>
              ${pend>0?`<span class="byclient-pending">+${fmt(pend)} pend.</span>`:''}
            </div>
            ${incBulkMode?'':`<i class="fa-solid fa-chevron-right bc-chevron"></i>`}
          </div>
          <div class="byclient-entries">${entriesHtml}</div>
        </div>`;
      });
    cont.innerHTML = html;
    // Set indeterminate on partially-selected client headers
    if (incBulkMode) {
      document.querySelectorAll('.byclient-group').forEach(grpEl => {
        const ids = [...grpEl.querySelectorAll('[data-bulk-id]')].map(el=>el.dataset.bulkId);
        const cb  = grpEl.querySelector('.bc-select-all-cb');
        if (cb && ids.length) {
          const n = ids.filter(id=>incSelectedIds.has(id)).length;
          cb.checked       = n === ids.length;
          cb.indeterminate = n > 0 && n < ids.length;
        }
      });
    }
    return;
  }

  // ── Excel view — Income ────────────────────────────────────────
  if (incViewMode==='excel') {
    const totalPaid = entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const totalAll  = entries.reduce((s,e)=>s+e.amount,0);
    const rows = entries.map((e,i)=>{
      const c=clientById(e.clientId); const sl=e.status.toLowerCase();
      return `<tr class="xls-row-${sl} ${incBulkMode&&incSelectedIds.has(e.id)?'bulk-selected':''}" data-bulk-id="${e.id}" onclick="${incBulkMode?`toggleSelectIncome('${e.id}',event)`:''}">
        <td class="xls-idx">${incBulkMode?`<input type="checkbox" class="bulk-cb" data-id="${e.id}" ${incSelectedIds.has(e.id)?'checked':''} onclick="toggleSelectIncome('${e.id}',event)">`:`${i+1}`}</td>
        <td>${toDateStr(e.date)}</td>
        <td style="color:${c?.color||'var(--text)'}"><strong>${c?.name||'?'}</strong></td>
        <td>${e.subClient||'—'}</td>
        <td>${e.service}</td>
        <td class="xls-num">${fmt(e.amount)}</td>
        <td class="xls-num" style="opacity:.7">${e.vatAmount>0?fmt(e.vatAmount):'—'}</td>
        <td><span class="badge ${sl} mini">${e.status}</span></td>
        <td><span class="badge ${e.paymentType} mini">${e.paymentType==='invoice'?'Invoice':'Cash'}</span></td>
        <td class="xls-note">${e.notes||'—'}</td>
        <td><div class="entry-actions" onclick="event.stopPropagation()">${eaInc(e.id).replace('<div class="entry-actions" onclick="event.stopPropagation()">','').replace('</div>','')}</div></td>
      </tr>`;
    }).join('');
    html+=`<div class="excel-wrapper">
      <table class="excel-table" id="incExcelTbl">
        <thead><tr>
          <th style="width:32px">#</th><th>Date</th><th>Client</th><th>Subclient</th>
          <th>Service</th><th>Amount (€)</th><th>VAT (€)</th><th>Status</th><th>Type</th><th>Notes</th><th style="width:90px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="5" class="xls-foot-label">TOTAL PAID / ALL</td>
          <td class="xls-num xls-foot-val">${fmt(totalPaid)} / ${fmt(totalAll)}</td>
          <td colspan="5"></td>
        </tr></tfoot>
      </table>
      <button class="excel-copy-btn" onclick="copyExcelTable('incExcelTbl')"><i class="fa-solid fa-copy"></i> Copy to clipboard (paste in Excel)</button>
    </div>`;
    cont.innerHTML = html; return;
  }

  // ── Month-grouped views (Detailed / Cards) ─────────────────────
  const groups={};
  entries.forEach(e=>{ const k=monthKey(e.date); if(!groups[k])groups[k]=[]; groups[k].push(e); });

  Object.keys(groups).sort((a,b)=>b.localeCompare(a)).forEach(key=>{
    const grp=[...groups[key]].sort((a,b)=>a.date.localeCompare(b.date)); // day 1 first within month
    const total=grp.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    html+=`<div class="month-group"><div class="month-group-header"><span>${monthLabel(key)}</span><span class="month-group-total">${fmt(total)}</span></div>`;

    if (incViewMode==='cards') {
      html+='<div class="entries-cards-grid">';
      grp.forEach(e=>{
        const c=clientById(e.clientId); const sl=e.status.toLowerCase();
        html+=`<div class="entry-card ${sl} ${incBulkMode&&incSelectedIds.has(e.id)?'bulk-selected':''}" data-bulk-id="${e.id}" onclick="${incBulkMode?`toggleSelectIncome('${e.id}',event)`:`openEntryDetail('income','${e.id}')`}">
          ${incBulkMode?`<input type="checkbox" class="bulk-cb" data-id="${e.id}" ${incSelectedIds.has(e.id)?'checked':''} onclick="toggleSelectIncome('${e.id}',event)" style="margin:0 0 6px 0">`:'' }
          <div class="entry-card-top" style="border-left:3px solid ${c?.color||'#888'}">
            <span class="entry-card-client">${c?.name||'?'}</span>
            <span class="entry-card-amount">${fmt(e.amount)}</span>
          </div>
          <div class="entry-card-service">${e.service}</div>
          <div class="entry-card-footer">
            <span class="entry-card-date">${toDateStr(e.date)}</span>
            <span class="badge ${e.paymentType} mini">${e.paymentType==='invoice'?'INV':'CASH'}</span>
            <span class="badge ${sl} mini">${e.status.slice(0,3).toUpperCase()}</span>
          </div>
          ${eaInc(e.id)}
        </div>`;
      });
      html+='</div>';
    } else {
      html += '<div class="simple-list">';
      grp.forEach(e=>{
        const c=clientById(e.clientId); const sl=e.status.toLowerCase();
        html+=`<div class="sl-row ${sl} ${incBulkMode&&incSelectedIds.has(e.id)?'bulk-selected':''}" data-bulk-id="${e.id}" onclick="${incBulkMode?`toggleSelectIncome('${e.id}',event)`:`openEntryDetail('income','${e.id}')`}">
          ${incBulkMode?`<input type="checkbox" class="bulk-cb" data-id="${e.id}" ${incSelectedIds.has(e.id)?'checked':''} onclick="toggleSelectIncome('${e.id}',event)">`:'' }
          <span class="sl-date">${toDateStr(e.date)}</span>
          <span class="sl-client" style="color:${c?.color||'var(--text)'}">${c?.name||'Unknown'}</span>
          <span class="sl-amount ${sl}">${fmt(e.amount)}${e.paidDate?`<span class="sl-paiddate">Paid ${toDateStr(new Date(e.paidDate).toISOString().slice(0,10))}</span>`:''}</span>
          ${eaInc(e.id)}
        </div>`;
      });
      html += '</div>';
    }
    html+='</div>';
  });
  cont.innerHTML = html;
  updateIncomeBulkBar();
}

function setIncFilter(t,v){ if(t==='month')incMonth=v; if(t==='client')incClient=v; if(t==='status')incStatus=v; if(t==='paytype')incPayType=v; renderIncome(); }

// ── RENDER: Expenses ───────────────────────────────────────────
function renderExpenses() {
  const cont = document.getElementById('expensesList');
  const months = allMonths();
  const moOpts  = months.map(m=>`<option value="${m}" ${expMonth===m?'selected':''}>${monthLabel(m)}</option>`).join('');
  const catOpts = Object.keys(CATEGORY_ICONS).map(c=>`<option value="${c}" ${expCategory===c?'selected':''}>${CATEGORY_ICONS[c]} ${c}</option>`).join('');

  let html = `<div class="filter-bar">
    <div class="filter-row">
      <div class="filter-group"><label class="filter-label">Month</label>
        <select class="filter-select" onchange="setExpFilter('month',this.value)">
          <option value="all" ${expMonth==='all'?'selected':''}>All Months</option>${moOpts}</select></div>
      <div class="filter-group"><label class="filter-label">Category</label>
        <select class="filter-select" onchange="setExpFilter('category',this.value)">
          <option value="all" ${expCategory==='all'?'selected':''}>All Categories</option>${catOpts}</select></div>
    </div>
  </div>`;
  const vtExp = (m,icon,label) => `<button class="vtb ${expViewMode===m?'active':''}" title="${label}" onclick="setExpViewMode('${m}')"><i class="fa-solid ${icon}"></i><span class="vtb-label">${label}</span></button>`;
  html += `<div class="view-toggle-bar"><span class="vt-label">View</span><div class="vtb-group">${vtExp('bycategory','layer-group','By Category')}${vtExp('detailed','list-ul','Detailed')}${vtExp('cards','grip','Cards')}${vtExp('excel','table','Excel')}</div></div>`;

  let entries = [...state.expenses];
  if (expMonth!=='all')    entries=entries.filter(e=>monthKey(e.date)===expMonth);
  if (expCategory!=='all') entries=entries.filter(e=>e.category===expCategory);
  entries.sort((a,b)=>b.date.localeCompare(a.date));

  if (!entries.length) {
    html += '<div class="empty-state"><i class="fa-solid fa-arrow-trend-down"></i><p>No entries match filters</p><small>Tap + to add an expense</small></div>';
    cont.innerHTML = html; return;
  }

  html += '<p class="delete-hint"><i class="fa-solid fa-hand-pointer"></i> Tap entry for details · Use buttons to copy, edit, delete</p>';
  const eaExp = (id) => `<div class="entry-actions" onclick="event.stopPropagation()">
    <button class="ea-btn ea-copy" title="Copy" onclick="openCopyDialog('expense','${id}')"><i class="fa-solid fa-copy"></i></button>
    <button class="ea-btn ea-edit" title="Edit" onclick="openEditEntry('expense','${id}')"><i class="fa-solid fa-pen"></i></button>
    <button class="ea-btn ea-del"  title="Delete" onclick="confirmDelete('expense','${id}')"><i class="fa-solid fa-trash"></i></button>
  </div>`;

  // ── By Category view ──────────────────────────────────────────
  if (expViewMode==='bycategory') {
    const bycat = {};
    entries.forEach(e=>{ if(!bycat[e.category])bycat[e.category]=[]; bycat[e.category].push(e); });
    Object.entries(bycat)
      .sort(([,a],[,b])=>b.reduce((s,e)=>s+e.amount,0)-a.reduce((s,e)=>s+e.amount,0))
      .forEach(([cat,grp])=>{
        const icon=CATEGORY_ICONS[cat]||'📦';
        const total=grp.reduce((s,e)=>s+e.amount,0);
        html+=`<div class="byclient-group">
          <div class="byclient-header" style="border-left:3px solid var(--red)">
            <div class="byclient-name"><span style="font-size:20px">${icon}</span><span>${cat}</span></div>
            <div class="byclient-totals"><span class="byclient-paid" style="color:var(--red)">${fmt(total)}</span></div>
          </div>`;
        grp.sort((a,b)=>b.date.localeCompare(a.date)).forEach(e=>{
          html+=`<div class="entry-compact" onclick="openEntryDetail('expense','${e.id}')">
            <span class="ec-date">${toDateStr(e.date)}</span>
            <span class="ec-sep">·</span>
            <span class="ec-service">${e.vendor||e.description||'—'}</span>
            <span class="ec-amount" style="color:var(--red)">${fmt(e.amount)}</span>
            <span class="badge mini">${e.paymentMethod==='Credit Card'?'Card':'Cash'}</span>
            ${eaExp(e.id)}
          </div>`;
        });
        html+='</div>';
      });
    cont.innerHTML = html; return;
  }

  // ── Excel view — Expenses ──────────────────────────────────────
  if (expViewMode==='excel') {
    const totalAll = entries.reduce((s,e)=>s+e.amount,0);
    const rows = entries.map((e,i)=>{
      const icon=CATEGORY_ICONS[e.category]||'📦';
      return `<tr>
        <td class="xls-idx">${i+1}</td>
        <td>${toDateStr(e.date)}</td>
        <td>${icon} ${e.category||'—'}</td>
        <td>${e.vendor||'—'}</td>
        <td class="xls-note">${e.description||'—'}</td>
        <td class="xls-num" style="color:var(--red)">${fmt(e.amount)}</td>
        <td class="xls-num" style="opacity:.7">${e.vatAmount>0?fmt(e.vatAmount):'—'}</td>
        <td>${e.paymentMethod||'—'}</td>
        <td>${e.recurring?'🔄 Yes':'No'}</td>
        <td><div class="entry-actions" onclick="event.stopPropagation()">${eaExp(e.id).replace('<div class="entry-actions" onclick="event.stopPropagation()">','').replace('</div>','')}</div></td>
      </tr>`;
    }).join('');
    html+=`<div class="excel-wrapper">
      <table class="excel-table" id="expExcelTbl">
        <thead><tr>
          <th style="width:32px">#</th><th>Date</th><th>Category</th><th>Type</th>
          <th>Description</th><th>Amount (€)</th><th>VAT (€)</th><th>Payment</th><th>Recurring</th><th style="width:90px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="5" class="xls-foot-label">TOTAL</td>
          <td class="xls-num xls-foot-val" style="color:var(--red)">${fmt(totalAll)}</td>
          <td colspan="4"></td>
        </tr></tfoot>
      </table>
      <button class="excel-copy-btn" onclick="copyExcelTable('expExcelTbl')"><i class="fa-solid fa-copy"></i> Copy to clipboard (paste in Excel)</button>
    </div>`;
    cont.innerHTML = html; return;
  }

  const groups={};
  entries.forEach(e=>{ const k=monthKey(e.date); if(!groups[k])groups[k]=[]; groups[k].push(e); });

  Object.keys(groups).sort((a,b)=>b.localeCompare(a)).forEach(key=>{
    const grp=[...groups[key]].sort((a,b)=>a.date.localeCompare(b.date)); // day 1 first within month
    const total=grp.reduce((s,e)=>s+e.amount,0);
    html+=`<div class="month-group"><div class="month-group-header"><span>${monthLabel(key)}</span><span style="color:var(--red);font-size:13px;font-weight:700">${fmt(total)}</span></div>`;

    if (expViewMode==='cards') {
      html+='<div class="entries-cards-grid">';
      grp.forEach(e=>{
        const icon=CATEGORY_ICONS[e.category]||'📦';
        html+=`<div class="entry-card expense-card" onclick="openEntryDetail('expense','${e.id}')">
          <div class="entry-card-top exp-top">
            <span class="entry-card-icon">${icon}</span>
            <span class="entry-card-client">${e.vendor||e.category}</span>
            <span class="entry-card-amount" style="color:var(--red)">${fmt(e.amount)}</span>
          </div>
          <div class="entry-card-service">${e.category}${e.recurring?' · 🔄':''}</div>
          <div class="entry-card-footer">
            <span class="entry-card-date">${toDateStr(e.date)}</span>
            <span class="badge mini">${e.paymentMethod==='Credit Card'?'Card':'Cash'}</span>
          </div>
          ${eaExp(e.id)}
        </div>`;
      });
      html+='</div>';
    } else {
      html += '<div class="simple-list">';
      grp.forEach(e=>{
        const typeLabel = e.vendor || e.category;
        html+=`<div class="sl-row" onclick="openEntryDetail('expense','${e.id}')">
          <span class="sl-date">${toDateStr(e.date)}</span>
          <span class="sl-client">${typeLabel}</span>
          <span class="sl-amount" style="color:var(--red)">${fmt(e.amount)}</span>
          ${eaExp(e.id)}
        </div>`;
      });
      html += '</div>';
    }
    html+='</div>';
  });
  cont.innerHTML = html;
}

function setExpFilter(t,v){ if(t==='month')expMonth=v; if(t==='category')expCategory=v; renderExpenses(); }

// ── RENDER: Clients ────────────────────────────────────────────
function renderClients() {
  const cont = document.getElementById('clientsGrid');
  cont.innerHTML = '';
  state.clients.forEach(c=>{
    const ci    = state.income.filter(e=>e.clientId===c.id);
    const total = ci.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const card  = document.createElement('div');
    card.className = 'client-card';
    card.onclick = ()=>openClientDetail(c.id);
    const avatarInner = c.image
      ? `<img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : initials(c.name);
    const avatarStyle = c.image ? '' : `background:${c.color}22;color:${c.color};border:2px solid ${c.color}44`;
    card.innerHTML = `
      <div style="position:absolute;top:0;left:0;right:0;height:4px;background:${c.color};border-radius:16px 16px 0 0;"></div>
      <button class="client-card-edit" onclick="event.stopPropagation();openEditClient('${c.id}')">
        <i class="fa-solid fa-pen"></i>
      </button>
      <div class="client-card-avatar" style="${avatarStyle}">${avatarInner}</div>
      <div class="client-card-name">${c.name}</div>
      <div class="client-card-type">${c.type==='Agency'?`Agency · ${c.subclients.length} sub-clients`:'Direct Client'} · <span class="client-pay-badge ${c.paymentType||'invoice'}">${c.paymentType==='cash'?'Cash':'Invoice'}</span></div>
      <div class="client-card-stats">
        <div class="client-stat"><span class="client-stat-label">Total Earned</span><span class="client-stat-val green">${fmt(total)}</span></div>
        <div class="client-stat"><span class="client-stat-label">Jobs</span><span class="client-stat-val">${ci.length}</span></div>
      </div>`;
    cont.appendChild(card);
  });
}

function openClientDetail(clientId) {
  const client = clientById(clientId);
  if (!client) return;
  const ci=state.income.filter(e=>e.clientId===clientId);
  const totalPaid=ci.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const totalPend=ci.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
  document.getElementById('clientDetailTitle').textContent = client.name;
  const editBtn = document.getElementById('clientDetailEditBtn');
  if (editBtn) editBtn.onclick = ()=>{ closeSheet('sheetClientDetail'); openEditClient(clientId); };
  let html=`
    <div class="client-detail-header">
      <div class="client-detail-avatar" style="background:${client.color}22;color:${client.color};border:2px solid ${client.color}44">${initials(client.name)}</div>
      <div><div class="client-detail-name">${client.name}</div><div class="client-detail-type">${client.type} Client</div></div>
    </div>
    <div class="client-detail-stats">
      <div class="cds"><div class="cds-label">Paid</div><div class="cds-val" style="color:var(--green)">${fmt(totalPaid)}</div></div>
      <div class="cds"><div class="cds-label">Pending</div><div class="cds-val" style="color:var(--amber)">${fmt(totalPend)}</div></div>
      <div class="cds"><div class="cds-label">Jobs</div><div class="cds-val">${ci.length}</div></div>
    </div>`;
  if (client.type==='Agency' && client.subclients.length) {
    html+=`<div class="section-title" style="margin-top:4px">Sub-Client Breakdown</div><div class="subclient-section">`;
    client.subclients.forEach(sc=>{
      const scInc=ci.filter(e=>e.subClient===sc);
      const scT=scInc.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
      html+=`<div class="subclient-row"><span>${sc}</span><span><strong>${fmt(scT)}</strong><span style="color:var(--text-faint);font-size:11px;margin-left:8px">${scInc.length} job${scInc.length!==1?'s':''}</span></span></div>`;
    });
    html+='</div>';
  }
  if (ci.length) {
    html+=`<div class="section-title" style="margin-top:20px">Income History</div>`;
    [...ci].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30).forEach(e=>{
      const sl=e.status.toLowerCase();
      html+=`<div class="income-entry ${sl}" style="margin-bottom:8px;cursor:default">
        <div class="entry-info"><div class="entry-service">${e.service}</div><div class="entry-meta">${toDateStr(e.date)}${e.subClient?' · '+e.subClient:''}</div></div>
        <div class="entry-right"><div class="entry-amount">${fmt(e.amount)}</div>
          <div class="entry-badges"><span class="badge ${e.paymentType}">${e.paymentType==='invoice'?'Invoice':'Cash'}</span><span class="badge ${sl}">${e.status}</span></div>
        </div></div>`;
    });
  }
  document.getElementById('clientDetailContent').innerHTML = html;
  _openSheet('sheetClientDetail');
}

// ── RENDER: Reports ────────────────────────────────────────────
function renderReports() {
  const months = allMonths();
  // Agency clients first, then Direct — both are valid for reports
  const agencyClients = state.clients.filter(c=>c.type==='Agency');
  const directClients = state.clients.filter(c=>c.type==='Direct');
  document.getElementById('reportsContainer').innerHTML = `
    <div class="report-controls">
      <select class="form-select" id="reportClient" onchange="renderReportTable()">
        <option value="">Select Client…</option>
        <option value="__all__">📊 All My Income</option>
        ${agencyClients.length ? `<optgroup label="Agency">${agencyClients.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</optgroup>` : ''}
        ${directClients.length ? `<optgroup label="Direct">${directClients.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</optgroup>` : ''}
      </select>
      <select class="form-select" id="reportMonth" onchange="renderReportTable()">
        <option value="">All Months</option>
        ${months.map(m=>`<option value="${m}">${monthLabel(m)}</option>`).join('')}
      </select>
      <button class="btn-print" onclick="printReport()"><i class="fa-solid fa-print"></i> Print / PDF</button>
    </div>
    <div class="report-type-tabs">
      <button class="report-type-tab ${reportPayFilter==='all'?'active':''}" onclick="setReportPayFilter('all')"><i class="fa-solid fa-list"></i> All Jobs</button>
      <button class="report-type-tab cash-tab ${reportPayFilter==='cash'?'active':''}" onclick="setReportPayFilter('cash')"><i class="fa-solid fa-money-bill-wave"></i> Cash Only</button>
      <button class="report-type-tab invoice-tab ${reportPayFilter==='invoice'?'active':''}" onclick="setReportPayFilter('invoice')"><i class="fa-solid fa-file-invoice"></i> Invoice / VAT</button>
      <button class="report-type-tab ${reportSubMode==='combined'?'active':''}" onclick="setReportSubMode('combined')"><i class="fa-solid fa-layer-group"></i> Combined</button>
      <button class="report-type-tab ${reportSubMode==='separated'?'active':''}" onclick="setReportSubMode('separated')"><i class="fa-solid fa-list-ul"></i> Separated</button>
    </div>
    <div id="reportTableArea"><div class="report-empty">Select a client to view their report</div></div>`;
}

function setReportPayFilter(f) {
  reportPayFilter = f;
  document.querySelectorAll('.report-type-tab').forEach(el=>{
    el.classList.remove('active');
  });
  const idx = {all:0,cash:1,invoice:2}[f]||0;
  const tabs = document.querySelectorAll('.report-type-tab');
  if (tabs[idx]) tabs[idx].classList.add('active');
  renderReportTable();
}

function setReportSubMode(m) {
  reportSubMode = m;
  saveUIState();
  renderReportTable();
  // Refresh the tabs so active state updates in the already-rendered controls
  // (the report controls are part of the pre-rendered DOM, re-render them)
  document.querySelectorAll('.report-type-tab').forEach(btn => {
    const txt = btn.textContent.trim();
    if (txt.includes('Combined')) btn.classList.toggle('active', m === 'combined');
    if (txt.includes('Separated')) btn.classList.toggle('active', m === 'separated');
  });
}

function renderReportTable() {
  const clientId = document.getElementById('reportClient').value;
  const month    = document.getElementById('reportMonth').value;
  const area     = document.getElementById('reportTableArea');
  if (!clientId) { area.innerHTML='<div class="report-empty">Select a client to view report</div>'; return; }

  if (clientId==='__all__') {
    let entries = state.income;
    if (month) entries=entries.filter(e=>monthKey(e.date)===month);
    if (reportPayFilter!=='all') entries=entries.filter(e=>e.paymentType===reportPayFilter);
    if (!entries.length) { area.innerHTML='<div class="report-table-wrapper"><div class="report-empty">No entries found</div></div>'; return; }
    const showVAT = reportPayFilter!=='cash';
    const showCashInv = reportPayFilter==='all';
    const cMap={};
    entries.forEach(e=>{
      const c=clientById(e.clientId); const k=c?.name||'Unknown';
      if(!cMap[k])cMap[k]={paid:0,pending:0,jobs:0,vat:0,cashJobs:0,invoiceJobs:0,color:c?.color||'#888'};
      cMap[k].jobs++; cMap[k].vat+=(e.vatAmount||0);
      if(e.paymentType==='cash')cMap[k].cashJobs++; else cMap[k].invoiceJobs++;
      if(e.status==='Paid')cMap[k].paid+=e.amount;
      if(e.status==='Pending')cMap[k].pending+=e.amount;
    });
    const gPaid=entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const gPend=entries.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
    const gVAT=entries.reduce((s,e)=>s+(e.vatAmount||0),0);
    area.innerHTML=`<div class="report-table-wrapper" id="printArea">
      <div style="padding:16px 16px 8px;font-size:13px;color:var(--text-muted)">
        <strong style="color:var(--text)">All Income</strong>${month?` · ${monthLabel(month)}`:''}
      </div>
      <table class="report-table"><thead><tr>
        <th>Client</th><th>Jobs</th>
        ${showCashInv?'<th>Cash</th><th>Invoice</th>':''}
        <th>Paid</th><th>Pending</th>
        ${showVAT?'<th>VAT</th>':''}
      </tr></thead>
      <tbody>${Object.entries(cMap).map(([name,d])=>`<tr>
        <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${d.color};margin-right:6px"></span>${name}</td><td>${d.jobs}</td>
        ${showCashInv?`<td>${d.cashJobs||'—'}</td><td>${d.invoiceJobs||'—'}</td>`:''}
        <td style="color:var(--green)">${fmt(d.paid)}</td>
        <td style="color:var(--amber)">${d.pending>0?fmt(d.pending):'—'}</td>
        ${showVAT?`<td>${fmt(d.vat)}</td>`:''}
      </tr>`).join('')}</tbody>
      <tfoot><tr class="total-row">
        <td>TOTAL</td><td>${entries.length}</td>
        ${showCashInv?`<td>${entries.filter(e=>e.paymentType==='cash').length}</td><td>${entries.filter(e=>e.paymentType==='invoice').length}</td>`:''}
        <td>${fmt(gPaid)}</td><td>${gPend>0?fmt(gPend):'—'}</td>
        ${showVAT?`<td>${fmt(gVAT)}</td>`:''}
      </tr></tfoot>
      </table></div>`;
    return;
  }

  let entries = state.income.filter(e=>e.clientId===clientId);
  if (month) entries=entries.filter(e=>monthKey(e.date)===month);
  if (reportPayFilter!=='all') entries=entries.filter(e=>e.paymentType===reportPayFilter);
  if (!entries.length) { area.innerHTML='<div class="report-table-wrapper"><div class="report-empty">No entries found</div></div>'; return; }

  const filterLabel = reportPayFilter==='cash' ? ' — Cash Jobs' : reportPayFilter==='invoice' ? ' — Invoice (VAT) Jobs' : '';
  const client = clientById(clientId);
  const gPaid=entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const gPend=entries.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
  const gVAT=entries.reduce((s,e)=>s+(e.vatAmount||0),0);
  const showVAT = reportPayFilter!=='cash';
  const gTotal = gPaid + gPend + gVAT;

  // SEPARATED: one row per entry with all details
  if (reportSubMode === 'separated') {
    const sorted = [...entries].sort((a,b)=>b.date.localeCompare(a.date));
    const rows = sorted.map(e => {
      const sl = e.status.toLowerCase();
      const vat = e.vatAmount || 0;
      const total = e.amount + vat;
      return `<tr class="rpt-${sl}">
        <td>${toDateStr(e.date)}</td>
        <td>${e.subClient||'—'}</td>
        <td>${e.service}</td>
        <td style="text-align:right">${fmt(e.amount)}</td>
        ${showVAT?`<td style="text-align:right;color:var(--text-muted)">${vat>0?fmt(vat)+'<span class="rpt-vat-tag">+VAT</span>':'—'}</td>`:''}
        <td style="text-align:right;font-weight:700">${fmt(total)}</td>
        <td><span class="badge ${sl} mini">${e.status}</span></td>
      </tr>`;
    }).join('');
    area.innerHTML = `<div class="report-table-wrapper" id="printArea">
      <div style="padding:16px 16px 8px;font-size:13px;color:var(--text-muted)">
        <strong style="color:var(--text)">${client?.name||''}</strong>${filterLabel}${month?` · ${monthLabel(month)}`:''}
        <span style="margin-left:12px;font-size:11px;opacity:.7">${entries.length} entries</span>
      </div>
      <table class="report-table">
        <thead><tr>
          <th>Date</th><th>Sub-Client</th><th>Service</th><th style="text-align:right">Amount</th>
          ${showVAT?'<th style="text-align:right">VAT</th>':''}
          <th style="text-align:right">Total</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="total-row">
          <td colspan="3">TOTAL</td>
          <td style="text-align:right">${fmt(gPaid+gPend)}</td>
          ${showVAT?`<td style="text-align:right">${fmt(gVAT)}</td>`:''}
          <td style="text-align:right">${fmt(gTotal)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>`;
    return;
  }

  // COMBINED: grouped by subclient, summary rows
  const scMap={};
  entries.forEach(e=>{
    const k=e.subClient||'(General)';
    if(!scMap[k])scMap[k]={paid:0,pending:0,jobs:0,vat:0,total:0};
    scMap[k].jobs++;
    scMap[k].vat += (e.vatAmount||0);
    scMap[k].total += e.amount + (e.vatAmount||0);
    if(e.status==='Paid')    scMap[k].paid+=e.amount;
    if(e.status==='Pending') scMap[k].pending+=e.amount;
  });
  area.innerHTML=`<div class="report-table-wrapper" id="printArea">
    <div style="padding:16px 16px 8px;font-size:13px;color:var(--text-muted)">
      <strong style="color:var(--text)">${client?.name||''}</strong>${filterLabel}
      ${month?` · ${monthLabel(month)}`:''}
    </div>
    <table class="report-table"><thead><tr>
      <th>Sub-Client</th><th>Jobs</th>
      <th style="text-align:right">Paid</th><th style="text-align:right">Pending</th>
      ${showVAT?'<th style="text-align:right">VAT</th>':''}
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${Object.entries(scMap).map(([sc,d])=>`<tr>
      <td>${sc}</td><td>${d.jobs}</td>
      <td style="text-align:right;color:var(--green)">${fmt(d.paid)}</td>
      <td style="text-align:right;color:var(--amber)">${d.pending>0?fmt(d.pending):'—'}</td>
      ${showVAT?`<td style="text-align:right;color:var(--text-muted)">${d.vat>0?fmt(d.vat):'—'}</td>`:''}
      <td style="text-align:right;font-weight:700">${fmt(d.total)}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr class="total-row">
      <td>TOTAL</td><td>${entries.length}</td>
      <td style="text-align:right">${fmt(gPaid)}</td>
      <td style="text-align:right">${gPend>0?fmt(gPend):'—'}</td>
      ${showVAT?`<td style="text-align:right">${fmt(gVAT)}</td>`:''}
      <td style="text-align:right">${fmt(gTotal)}</td>
    </tr></tfoot>
    </table></div>`;
}

// ── Print Options Dialog ────────────────────────────────────────
function printReport() {
  const clientId = document.getElementById('reportClient')?.value;
  const month    = document.getElementById('reportMonth')?.value;
  if (!clientId) { showToast('Select a client first','error'); return; }
  showPrintOptionsDialog(clientId, month);
}

function showPrintOptionsDialog(clientId, month) {
  let dlg = document.getElementById('printOptionsDialog');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'printOptionsDialog';
    dlg.className = 'copy-dialog';
    dlg.innerHTML = `
      <h3><i class="fa-solid fa-print"></i> Print Options</h3>
      <p id="printOptsMeta"></p>
      <div style="margin-bottom:16px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Sub-client Layout</div>
        <div style="display:flex;gap:8px" id="printSubModeToggle">
          <button class="report-type-tab active" data-mode="separated" onclick="setPrintSubMode('separated')"><i class="fa-solid fa-list-ul"></i> Separated</button>
          <button class="report-type-tab" data-mode="combined" onclick="setPrintSubMode('combined')"><i class="fa-solid fa-layer-group"></i> Combined</button>
        </div>
      </div>
      <div style="margin-bottom:20px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Payment Filter</div>
        <div style="display:flex;gap:8px" id="printPayFilterToggle">
          <button class="report-type-tab active" data-pf="all" onclick="setPrintPayFilter('all')">All</button>
          <button class="report-type-tab invoice-tab" data-pf="invoice" onclick="setPrintPayFilter('invoice')"><i class="fa-solid fa-file-invoice"></i> Invoice</button>
          <button class="report-type-tab cash-tab" data-pf="cash" onclick="setPrintPayFilter('cash')"><i class="fa-solid fa-money-bill"></i> Cash</button>
        </div>
      </div>
      <div class="copy-dialog-btns">
        <button class="btn-cancel" onclick="closePrintOptionsDialog()">Cancel</button>
        <button class="btn-save" style="flex:1;padding:10px" onclick="confirmPrintReport()"><i class="fa-solid fa-print"></i> Print</button>
      </div>`;
    document.body.appendChild(dlg);
    document.getElementById('modalOverlay').addEventListener('click', closePrintOptionsDialog);
  }
  dlg.dataset.clientId = clientId;
  dlg.dataset.month = month || '';
  const client = clientById(clientId);
  document.getElementById('printOptsMeta').textContent =
    (clientId==='__all__' ? 'All Clients' : (client?.name||'')) +
    (month ? ' · '+monthLabel(month) : '');
  _printSubMode = 'separated';
  _printPayFilter = reportPayFilter || 'all';
  document.querySelectorAll('#printSubModeToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.mode===_printSubMode));
  document.querySelectorAll('#printPayFilterToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.pf===_printPayFilter));
  document.getElementById('modalOverlay').classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>dlg.classList.add('open')));
}

function setPrintSubMode(m) {
  _printSubMode = m;
  document.querySelectorAll('#printSubModeToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
}

function setPrintPayFilter(pf) {
  _printPayFilter = pf;
  document.querySelectorAll('#printPayFilterToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.pf===pf));
}

function closePrintOptionsDialog() {
  const dlg = document.getElementById('printOptionsDialog');
  if (dlg) dlg.classList.remove('open');
  if (!activeSheet) document.getElementById('modalOverlay').classList.add('hidden');
}

function confirmPrintReport() {
  const dlg = document.getElementById('printOptionsDialog');
  if (!dlg) return;
  const clientId = dlg.dataset.clientId;
  const month    = dlg.dataset.month || '';
  closePrintOptionsDialog();
  executePrintReport(clientId, month, _printSubMode, _printPayFilter);
}

function executePrintReport(clientId, month, subMode, payFilter) {
  let entries = clientId==='__all__' ? [...state.income] : state.income.filter(e=>e.clientId===clientId);
  if (month) entries = entries.filter(e=>monthKey(e.date)===month);
  if (payFilter!=='all') entries = entries.filter(e=>e.paymentType===payFilter);
  if (!entries.length) { showToast('No entries to print','error'); return; }
  entries.sort((a,b)=>a.date.localeCompare(b.date));

  const isAll = clientId==='__all__';
  const client = isAll ? null : clientById(clientId);
  const title = isAll ? 'All Income' : (client?.name||'Report');
  const filterLabel = payFilter==='cash' ? ' — Cash Only' : payFilter==='invoice' ? ' — Invoice / VAT' : '';
  const monthStr = month ? ' · '+monthLabel(month) : '';
  const showVAT = payFilter!=='cash';
  const fd = d => { const [y,mo,dy]=d.split('-'); return `${dy}/${mo}/${y}`; };
  const ef = n => '€'+(Math.round(n*100)/100).toFixed(2);

  let bodyHtml = '';

  if (subMode==='separated') {
    // Group by client (if __all__) or subclient (if specific client)
    const groups={}, keys=[];
    entries.forEach(e=>{
      const key = isAll ? (clientById(e.clientId)?.name||'Unknown') : (e.subClient||'(General)');
      if (!groups[key]) { groups[key]=[]; keys.push(key); }
      groups[key].push(e);
    });
    const colSpanLabel = showVAT ? 2 : 2;
    let tbodyHtml = '';
    keys.forEach(key=>{
      const g = groups[key];
      const tAmt = g.reduce((s,e)=>s+e.amount,0);
      const tVAT = g.reduce((s,e)=>s+(e.vatAmount||0),0);
      tbodyHtml += `<tr><td colspan="99" style="background:#e8e8e8;font-weight:700;padding:10px 12px;font-size:13px;border-top:2px solid #bbb">${key}</td></tr>`;
      g.forEach(e=>{
        const vat=e.vatAmount||0;
        const qty=e.qty||'';
        const unitPrice=e.unitPrice||'';
        tbodyHtml += `<tr>
          <td>${fd(e.date)}</td><td>${e.service}</td>
          <td style="color:#555">${e.notes||'—'}</td>
          <td style="text-align:center;color:#444">${qty||'—'}</td>
          <td style="text-align:right;color:#444">${unitPrice?ef(unitPrice):'—'}</td>
          <td style="text-align:right">${ef(e.amount)}</td>
          ${showVAT?`<td style="text-align:right;color:#888">${vat>0?ef(vat):'—'}</td>`:''}
          <td style="text-align:right;font-weight:700">${ef(e.amount+vat)}</td>
        </tr>`;
      });
      tbodyHtml += `<tr style="background:#f5f5f5">
        <td colspan="5" style="font-weight:700;font-size:12px">TOTAL</td>
        <td style="text-align:right;font-weight:700">${ef(tAmt)}</td>
        ${showVAT?`<td style="text-align:right;font-weight:700">${ef(tVAT)}</td>`:''}
        <td style="text-align:right;font-weight:700">${ef(tAmt+tVAT)}</td>
      </tr>`;
    });
    const gAmt=entries.reduce((s,e)=>s+e.amount,0);
    const gVAT=entries.reduce((s,e)=>s+(e.vatAmount||0),0);
    // Single tbody, no thead/tfoot — only way to guarantee GRAND TOTAL stays at end in PDF
    const colHdr = `<tr style="background:#f0f0f0;border-bottom:2px solid #ccc">
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px">Date</td>
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px">Service</td>
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px">Notes</td>
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;text-align:center">Qty</td>
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;text-align:right">Unit €</td>
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;text-align:right">Amount</td>
      ${showVAT?'<td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;text-align:right">VAT</td>':''}
      <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;text-align:right">Total</td>
    </tr>`;
    const grandTotalRow = `<tr style="background:#e8e8e8;border-top:3px solid #bbb">
      <td colspan="5" style="font-weight:800;font-size:13px;padding:12px">GRAND TOTAL</td>
      <td style="text-align:right;font-weight:800;padding:12px">${ef(gAmt)}</td>
      ${showVAT?`<td style="text-align:right;font-weight:800;padding:12px">${ef(gVAT)}</td>`:''}
      <td style="text-align:right;font-weight:800;font-size:15px;padding:12px">${ef(gAmt+gVAT)}</td>
    </tr>`;
    bodyHtml = `<table><tbody>${colHdr}${tbodyHtml}${grandTotalRow}</tbody></table>`;
  } else {
    // Combined: all entries sorted by date, show sub-client column
    const rows = entries.map(e=>{
      const vat=e.vatAmount||0;
      const cl=isAll?clientById(e.clientId):null;
      const qty=e.qty||'';
      const unitPrice=e.unitPrice||'';
      return `<tr>
        <td>${fd(e.date)}</td>
        ${isAll?`<td>${cl?.name||'?'}</td>`:''}
        <td>${e.subClient||'—'}</td>
        <td>${e.service}</td>
        <td style="color:#555">${e.notes||'—'}</td>
        <td style="text-align:center;color:#444">${qty||'—'}</td>
        <td style="text-align:right;color:#444">${unitPrice?ef(unitPrice):'—'}</td>
        <td style="text-align:right">${ef(e.amount)}</td>
        ${showVAT?`<td style="text-align:right;color:#888">${vat>0?ef(vat):'—'}</td>`:''}
        <td style="text-align:right;font-weight:700">${ef(e.amount+vat)}</td>
      </tr>`;
    }).join('');
    const gAmt=entries.reduce((s,e)=>s+e.amount,0);
    const gVAT=entries.reduce((s,e)=>s+(e.vatAmount||0),0);
    const hdrSpan = 6 + (isAll?1:0);
    const hdrStyle = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px';
    const colHdr2 = `<tr style="background:#f0f0f0;border-bottom:2px solid #ccc">
      <td style="${hdrStyle}">Date</td>
      ${isAll?`<td style="${hdrStyle}">Client</td>`:''}
      <td style="${hdrStyle}">Sub-Client</td>
      <td style="${hdrStyle}">Service</td>
      <td style="${hdrStyle}">Notes</td>
      <td style="${hdrStyle};text-align:center">Qty</td>
      <td style="${hdrStyle};text-align:right">Unit €</td>
      <td style="${hdrStyle};text-align:right">Amount</td>
      ${showVAT?`<td style="${hdrStyle};text-align:right">VAT</td>`:''}
      <td style="${hdrStyle};text-align:right">Total</td>
    </tr>`;
    const grandRow2 = `<tr style="background:#e8e8e8;border-top:3px solid #bbb">
      <td colspan="${hdrSpan}" style="font-weight:800;font-size:13px;padding:12px">GRAND TOTAL</td>
      <td style="text-align:right;font-weight:800;padding:12px">${ef(gAmt)}</td>
      ${showVAT?`<td style="text-align:right;font-weight:800;padding:12px">${ef(gVAT)}</td>`:''}
      <td style="text-align:right;font-weight:800;font-size:15px;padding:12px">${ef(gAmt+gVAT)}</td>
    </tr>`;
    bodyHtml = `<table><tbody>${colHdr2}${rows}${grandRow2}</tbody></table>`;
  }

  // Build client avatar — use uploaded photo if available, else coloured circle
  const avatarHtml = (() => {
    if (!isAll && client?.image) {
      return `<img src="${client.image}" style="width:52px;height:52px;border-radius:50%;object-fit:cover;display:inline-block;vertical-align:middle;margin-right:14px;flex-shrink:0" />`;
    }
    const avatarColor = client?.color || '#6366f1';
    const avatarText  = isAll ? 'ALL' : initials(client?.name||title);
    return `<svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:14px;flex-shrink:0">
      <circle cx="26" cy="26" r="26" fill="${avatarColor}"/>
      <text x="26" y="32" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="white">${avatarText}</text>
    </svg>`;
  })();
  const exportedDate = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
  const reportMonth  = month ? monthLabel(month) : '';

  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>${title} — ${reportMonth}</title>
    <style>
      @page{margin:0}
      body{font-family:Arial,sans-serif;margin:1.5cm;color:#000;max-width:960px}
      .rpt-header{display:flex;align-items:center;margin-bottom:28px}
      .rpt-info{display:flex;flex-direction:column;justify-content:center}
      .rpt-client-name{font-size:22px;font-weight:800;color:#0f0f1a;line-height:1.2}
      .rpt-meta{font-size:13px;color:#555;margin-top:4px}
      table{width:100%;border-collapse:collapse}
      th{background:#f0f0f0;padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #ccc}
      td{padding:9px 12px;border-bottom:1px solid #e0e0e0;font-size:13px}
    </style></head><body>
    <div class="rpt-header">
      ${avatarHtml}
      <div class="rpt-info">
        <div class="rpt-client-name">${title}${filterLabel}</div>
        <div class="rpt-meta">${[reportMonth, 'Exported '+exportedDate].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
    ${bodyHtml}
    <script>window.onload=()=>{window.print();}<\/script>
  </body></html>`;

  const w=window.open('','_blank');
  if (!w) { showToast('Popup blocked — allow popups for printing','error'); return; }
  w.document.write(html);
  w.document.close();
}

// ── Copy Entry to Another Month ─────────────────────────────────
let _copyType='', _copyId='';

function openCopyDialog(type, id) {
  _copyType=type; _copyId=id;
  const entry = type==='income'
    ? state.income.find(e=>e.id===id)
    : state.expenses.find(e=>e.id===id);
  if (!entry) return;

  let cd = document.getElementById('copyDialog');
  if (!cd) {
    cd = document.createElement('div');
    cd.id = 'copyDialog'; cd.className = 'copy-dialog';
    cd.innerHTML = `
      <h3><i class="fa-solid fa-copy"></i> Copy Entry</h3>
      <p id="copyDialogDesc"></p>
      <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px">Target Month</label>
      <input type="month" id="copyTargetMonth" class="form-input" style="margin-bottom:0" />
      <div class="copy-dialog-btns">
        <button class="btn-cancel" onclick="closeCopyDialog()">Cancel</button>
        <button class="btn-save" style="flex:1;padding:10px" onclick="confirmCopyEntry()"><i class="fa-solid fa-check"></i> Copy</button>
      </div>`;
    document.body.appendChild(cd);
    document.getElementById('modalOverlay').addEventListener('click', closeCopyDialog);
  }

  const label = type==='income'
    ? `${clientById(entry.clientId)?.name||'?'} — ${entry.service} (${fmt(entry.amount)})`
    : `${entry.vendor} — ${entry.category} (${fmt(entry.amount)})`;
  document.getElementById('copyDialogDesc').textContent = label;
  document.getElementById('copyTargetMonth').value = monthKey(entry.date);
  document.getElementById('modalOverlay').classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>cd.classList.add('open')));
}

function closeCopyDialog() {
  const cd = document.getElementById('copyDialog');
  if (cd) { cd.classList.remove('open'); }
  if (!activeSheet) document.getElementById('modalOverlay').classList.add('hidden');
}

function confirmCopyEntry() {
  const targetMonth = document.getElementById('copyTargetMonth').value;
  if (!targetMonth) { showToast('Select a target month','error'); return; }

  if (_copyType==='income') {
    const src = state.income.find(e=>e.id===_copyId);
    if (!src) return;
    const newDate = targetMonth+'-'+src.date.slice(8);
    const copy = { ...src, id:genId(), date:newDate, createdAt:Date.now() };
    state.income.push(copy);
    sheetsAdd('income', copy);
  } else {
    const src = state.expenses.find(e=>e.id===_copyId);
    if (!src) return;
    const newDate = targetMonth+'-'+src.date.slice(8);
    const copy = { ...src, id:genId(), date:newDate, createdAt:Date.now() };
    state.expenses.push(copy);
    sheetsAdd('expense', copy);
  }
  saveData();
  closeCopyDialog();
  showToast(`Entry copied to ${monthLabel(targetMonth)}`);
  renderView(currentView);
}

// ── One-time accident recovery ─────────────────────────────────
// Reverts income entries whose paidDate was set today (the accident)
// back to Pending. Entries already paid on a previous day are left alone.
// Called manually if user accidentally bulk-marks a month as Paid.
function revertTodayPaidToMonth(month) {
  const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
  const todayTs = startOfToday.getTime();
  let reverted = 0;
  pushUndo(`Revert accidental Paid → Pending (${month||'all'})`);
  state.income.forEach(e => {
    if (e.status === 'Paid' && e.paidDate >= todayTs) {
      if (!month || monthKey(e.date) === month) {
        e.status = 'Pending';
        delete e.paidDate;
        reverted++;
      }
    }
  });
  if (reverted > 0) {
    saveData();
    renderView(currentView);
    showToast(`↩ Reverted ${reverted} entries back to Pending`);
  } else {
    showToast('No entries were changed today to revert', 'error');
  }
}

// ── Recurring Auto-Generate ────────────────────────────────────
function generateRecurring(silent=false) {
  const currentMonth = todayVal().slice(0,7);
  let generated = 0;

  // Income: key = clientId + service
  const incTemplates = new Map();
  state.income.filter(e=>e.recurring).forEach(e=>{
    const k = e.clientId + '\x00' + e.service;
    if (!incTemplates.has(k) || e.date > incTemplates.get(k).date) incTemplates.set(k, e);
  });
  incTemplates.forEach((tmpl, k)=>{
    const [clientId, service] = k.split('\x00');
    const exists = state.income.some(e=>
      e.recurring && e.clientId===clientId && e.service===service && monthKey(e.date)===currentMonth
    );
    if (!exists) {
      const entry = { ...tmpl, id:genId(), date:currentMonth+'-01', status:'Pending', createdAt:Date.now() };
      state.income.push(entry);
      sheetsAdd('income', entry);
      generated++;
    }
  });

  // Expenses: key = category + vendor
  const expTemplates = new Map();
  state.expenses.filter(e=>e.recurring).forEach(e=>{
    const k = e.category + '\x00' + e.vendor;
    if (!expTemplates.has(k) || e.date > expTemplates.get(k).date) expTemplates.set(k, e);
  });
  expTemplates.forEach((tmpl, k)=>{
    const [category, vendor] = k.split('\x00');
    const exists = state.expenses.some(e=>
      e.recurring && e.category===category && e.vendor===vendor && monthKey(e.date)===currentMonth
    );
    if (!exists) {
      const entry = { ...tmpl, id:genId(), date:currentMonth+'-01', createdAt:Date.now() };
      state.expenses.push(entry);
      sheetsAdd('expense', entry);
      generated++;
    }
  });

  if (generated > 0) {
    saveData();
    renderView(currentView);
    showToast(`${generated} recurring entr${generated===1?'y':'ies'} added for ${monthLabel(currentMonth)}`);
  } else if (!silent) {
    showToast(`All recurring entries already exist for ${monthLabel(currentMonth)}`);
  }
}

// ── Cloud Sync — Firebase Realtime Database ────────────────────
// Works directly from browser, no proxy needed, completely free.
const BLOB_KEY     = 'bm_sync_blob_id';
const FB_URL_KEY   = 'bm_firebase_url';
let syncBlobId  = localStorage.getItem(BLOB_KEY)   || '';
let fbUrl       = localStorage.getItem(FB_URL_KEY) || '';
let _autoPushTimer = null;
let _isSyncing  = false;

function fbEndpoint(id) {
  return fbUrl.replace(/\/+$/, '') + '/bmsync/' + id + '.json';
}

// Encode Firebase URL + sync ID into one portable string
function encodeSyncCode(url, id) {
  try { return btoa(unescape(encodeURIComponent(url + '||' + id))); }
  catch { return btoa(url + '||' + id); }
}
function decodeSyncCode(code) {
  try {
    const s = decodeURIComponent(escape(atob(code.trim())));
    const i = s.indexOf('||');
    if (i < 0) return null;
    return { url: s.slice(0, i), id: s.slice(i + 2) };
  } catch { return null; }
}

function setSyncIndicator(state_) {
  const el = document.getElementById('cloudSyncDot');
  if (el) el.className = 'cloud-sync-dot cs-' + state_;
  const label = document.getElementById('cloudSyncLabel');
  if (label) {
    const map = { idle:'Sync ready', pushing:'Saving…', pulling:'Loading…', ok:'Synced ✓', error:'Sync error !' };
    label.textContent = map[state_] || '';
  }
  const topDot = document.getElementById('topbarSyncDot');
  if (topDot) topDot.className = 'topbar-sync-dot cs-' + (syncBlobId ? state_ : 'idle');
}

function updateSyncModalStatus(msg) {
  const el = document.getElementById('cloudSyncStatus');
  if (el) el.textContent = msg;
}

function updateSyncModalUI() {
  const fbSection = document.getElementById('syncFirebaseSection');
  const codeSection = document.getElementById('syncCodeSection');
  if (!fbSection || !codeSection) return;
  if (!fbUrl) {
    fbSection.style.display = 'block';
    codeSection.style.display = 'none';
  } else {
    fbSection.style.display = 'none';
    codeSection.style.display = 'block';
    if (syncBlobId) {
      document.getElementById('cloudCodeInput').value = encodeSyncCode(fbUrl, syncBlobId);
    }
  }
}

function saveFbUrl() {
  const val = (document.getElementById('fbUrlInput').value || '').trim();
  if (!val || (!val.includes('firebaseio.com') && !val.includes('firebasedatabase.app'))) {
    showToast('Enter a valid Firebase Database URL', 'error'); return;
  }
  fbUrl = val;
  localStorage.setItem(FB_URL_KEY, fbUrl);
  updateSyncModalUI();
  showToast('✓ Firebase URL saved');
}

let _pendingPush = false; // true if unsaved changes haven't reached Firebase yet

function scheduleAutoPush() {
  if (!syncBlobId || !fbUrl) return;
  _pendingPush = true;
  clearTimeout(_autoPushTimer);
  // Push immediately — no delay. emergencyPush is the fallback if app closes first.
  _autoPushTimer = setTimeout(() => autoPush(true), 0);
}

async function autoPush(silent, keepalive = false) {
  if (!syncBlobId || !fbUrl) return;
  if (_isSyncing && !keepalive) {
    // Another sync is running — retry once it finishes
    setTimeout(() => { if (_pendingPush) autoPush(true); }, 1500);
    return;
  }
  _isSyncing = true;
  setSyncIndicator('pushing');
  try {
    const body = JSON.stringify(state);
    const res = await fetch(fbEndpoint(syncBlobId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(keepalive ? { keepalive: true } : {})
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _pendingPush = false;
    setSyncIndicator('ok');
    updateSyncModalStatus('Last push: ' + new Date().toLocaleTimeString());
    if (!silent) showToast('☁ Synced to cloud');
    setTimeout(() => setSyncIndicator('idle'), 3000);
  } catch(e) {
    setSyncIndicator('error');
    console.warn('Auto-push failed:', e.message);
    // Retry once after 3 seconds if it failed
    setTimeout(() => { if (_pendingPush) autoPush(true); }, 3000);
    setTimeout(() => setSyncIndicator('idle'), 5000);
  } finally { _isSyncing = false; }
}

// Push immediately when user leaves the page (covers refresh, tab close, navigation)
function emergencyPush() {
  if (!_pendingPush || !syncBlobId || !fbUrl) return;
  // Use keepalive so the browser completes the request even after page unloads
  try {
    const body = JSON.stringify(state);
    fetch(fbEndpoint(syncBlobId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    });
  } catch(e) { /* best-effort */ }
}

async function autoPull(silent) {
  if (!syncBlobId || !fbUrl || _isSyncing) return;
  // If we have local changes not yet pushed, push first — never let a pull
  // overwrite a pending local delete/edit
  if (_pendingPush) { autoPush(true); return; }
  _isSyncing = true;
  setSyncIndicator('pulling');
  try {
    const res = await fetch(fbEndpoint(syncBlobId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    const cloudTs      = p.lastModified || 0;
    const localTs      = state.lastModified || 0;
    const cloudIncome   = p.income   || [];
    const cloudExpenses = p.expenses || [];

    // NEVER skip a pull entirely — the other device may have NEW entries
    // even if its overall timestamp is older (e.g. phone added entries while
    // desktop was also modified). Always merge by ID.

    // Snapshot IDs before merge so we can detect real changes
    const prevIncomeIds = new Set((state.income || []).map(e => e.id));
    const prevExpIds    = new Set((state.expenses || []).map(e => e.id));

    // Build local maps for conflict resolution
    const localIncMap = new Map((state.income   || []).map(e => [e.id, e]));
    const localExpMap = new Map((state.expenses || []).map(e => [e.id, e]));

    const cloudIncomeIds  = new Set(cloudIncome.map(e => e.id));
    const cloudExpenseIds = new Set(cloudExpenses.map(e => e.id));

    // For entries that exist on BOTH sides: prefer local if local is strictly
    // newer (localTs > cloudTs), otherwise trust the cloud version.
    const mergedIncome   = cloudIncome.map(ce => {
      const le = localIncMap.get(ce.id);
      return (le && localTs > cloudTs) ? le : ce;
    });
    const mergedExpenses = cloudExpenses.map(ce => {
      const le = localExpMap.get(ce.id);
      return (le && localTs > cloudTs) ? le : ce;
    });

    // Entries only in local (new additions not yet pushed to cloud)
    const localOnlyIncome  = (state.income   || []).filter(e => !cloudIncomeIds.has(e.id));
    const localOnlyExpense = (state.expenses || []).filter(e => !cloudExpenseIds.has(e.id));

    state.clients  = p.clients;
    state.income   = [...mergedIncome,   ...localOnlyIncome];
    state.expenses = [...mergedExpenses, ...localOnlyExpense];
    state.services = p.services || [...DEFAULT_SERVICES];
    // Use the newer timestamp
    state.lastModified = Math.max(cloudTs, localTs);
    idbSet(STORAGE_KEY, state);
    // Remove any duplicate recurring entries that crept in via multi-device race
    deduplicateIncome();
    deduplicateExpenses();
    // If we had local-only entries, push the merged result back to Firebase
    if (localOnlyIncome.length || localOnlyExpense.length) {
      scheduleAutoPush();
    }
    // Only re-render if entry IDs or statuses actually changed
    const incChanged = state.income.some(e => !prevIncomeIds.has(e.id)) ||
                       [...prevIncomeIds].some(id => !cloudIncomeIds.has(id) && !localOnlyIncome.find(e=>e.id===id));
    const expChanged = state.expenses.some(e => !prevExpIds.has(e.id)) ||
                       [...prevExpIds].some(id => !cloudExpenseIds.has(id) && !localOnlyExpense.find(e=>e.id===id));
    // Also check if any entry statuses/amounts changed
    const statusChanged = mergedIncome.some(e => {
      const prev = localIncMap.get(e.id);
      return prev && (prev.status !== e.status || prev.amount !== e.amount);
    });
    if (incChanged || expChanged || statusChanged || !silent) {
      navigate(currentView);
    }
    setSyncIndicator('ok');
    updateSyncModalStatus('Last pull: ' + new Date().toLocaleTimeString());
    if (!silent) showToast('☁ Updated from cloud');
    setTimeout(() => setSyncIndicator('idle'), 3000);
  } catch(e) {
    setSyncIndicator('error');
    console.warn('Auto-pull failed:', e.message);
    setTimeout(() => setSyncIndicator('idle'), 5000);
  } finally { _isSyncing = false; }
}

async function cloudPush() {
  if (!syncBlobId || !fbUrl) { showToast('Set up Cloud Sync first','error'); return; }
  const btn = document.getElementById('cloudPushBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Pushing…'; }
  try {
    state.lastModified = Date.now();
    idbSet(STORAGE_KEY, state);
    const res = await fetch(fbEndpoint(syncBlobId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    showToast('✓ Pushed to cloud');
    updateSyncModalStatus('Last push: ' + new Date().toLocaleTimeString());
    setSyncIndicator('ok'); setTimeout(() => setSyncIndicator('idle'), 3000);
  } catch(e) { showToast('Push failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Force Push'; } }
}

async function cloudPull() {
  if (!syncBlobId || !fbUrl) { showToast('Set up Cloud Sync first','error'); return; }
  const btn = document.getElementById('cloudPullBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Pulling…'; }
  try {
    const res = await fetch(fbEndpoint(syncBlobId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    state.clients  = p.clients;
    state.income   = p.income   || [];
    state.expenses = p.expenses || [];
    state.services = p.services || [...DEFAULT_SERVICES];
    state.lastModified = p.lastModified || Date.now();
    idbSet(STORAGE_KEY, state);
    navigate(currentView);
    showToast('✓ Pulled from cloud');
    updateSyncModalStatus('Last pull: ' + new Date().toLocaleTimeString());
  } catch(e) { showToast('Pull failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Force Pull'; } }
}

async function cloudCreate() {
  if (!fbUrl) { showToast('Enter your Firebase URL first','error'); return; }
  const btn = document.getElementById('cloudCreateBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…'; }
  try {
    state.lastModified = Date.now();
    idbSet(STORAGE_KEY, state);
    const id = (crypto.randomUUID ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36));
    const res = await fetch(fbEndpoint(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    syncBlobId = id;
    localStorage.setItem(BLOB_KEY, id);
    const code = encodeSyncCode(fbUrl, id);
    document.getElementById('cloudCodeInput').value = code;
    updateSyncModalStatus('✓ Auto-sync active — copy the code to other devices');
    setSyncIndicator('ok'); setTimeout(() => setSyncIndicator('idle'), 3000);
    showToast('✓ Cloud created! Copy the sync code to your phone.');
  } catch(e) {
    showToast('Create failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-plus"></i> Create New'; }
  }
}

async function cloudSaveCode() {
  const val = (document.getElementById('cloudCodeInput').value || '').trim();
  if (!val) { showToast('Enter a sync code first','error'); return; }
  const decoded = decodeSyncCode(val);
  if (!decoded) { showToast('Invalid sync code','error'); return; }
  fbUrl      = decoded.url;
  syncBlobId = decoded.id;
  localStorage.setItem(FB_URL_KEY, fbUrl);
  localStorage.setItem(BLOB_KEY,   syncBlobId);
  updateSyncModalStatus('Connecting — pulling latest data…');
  await autoPull();
  updateSyncModalStatus('✓ Auto-sync active — syncs automatically');
  showToast('✓ Connected — auto-sync is on');
}

function openSyncModal() {
  updateSyncModalUI();
  if (syncBlobId && fbUrl) {
    updateSyncModalStatus('✓ Auto-sync active');
  } else if (fbUrl) {
    updateSyncModalStatus('Firebase URL saved — create or connect a sync slot');
  } else {
    updateSyncModalStatus('Follow the steps below to set up sync');
  }
  document.getElementById('syncModal').classList.add('open');
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function closeSyncModal() {
  document.getElementById('syncModal').classList.remove('open');
  document.getElementById('modalOverlay').classList.add('hidden');
}

function startAutoSync() {
  if (!syncBlobId) return;
  // Pull when window regains focus
  window.addEventListener('focus', () => autoPull(true));
  // Poll every 30 seconds
  setInterval(() => autoPull(true), 15000); // check every 15s
  // On initial load: if local state is empty (new device / first visit),
  // do a forced pull that always re-renders after completion
  if (!state.income.length && !state.expenses.length) {
    autoPullForced();
  } else {
    autoPull(true);
  }
  setSyncIndicator('idle');
}

async function autoPullForced() {
  if (!syncBlobId || !fbUrl || _isSyncing) return;
  _isSyncing = true;
  setSyncIndicator('pulling');
  try {
    const res = await fetch(fbEndpoint(syncBlobId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    // ALWAYS merge — never blindly overwrite local data
    const cloudIncome   = p.income   || [];
    const cloudExpenses = p.expenses || [];
    const cloudIncomeIds  = new Set(cloudIncome.map(e => e.id));
    const cloudExpenseIds = new Set(cloudExpenses.map(e => e.id));
    const localOnlyIncome  = (state.income   || []).filter(e => !cloudIncomeIds.has(e.id));
    const localOnlyExpense = (state.expenses || []).filter(e => !cloudExpenseIds.has(e.id));
    state.clients  = p.clients;
    state.income   = [...cloudIncome,   ...localOnlyIncome];
    state.expenses = [...cloudExpenses, ...localOnlyExpense];
    state.services = p.services || [...DEFAULT_SERVICES];
    state.lastModified = Math.max(p.lastModified || 0, state.lastModified || 0);
    idbSet(STORAGE_KEY, state);
    // Remove any duplicate recurring entries from multi-device race
    deduplicateIncome();
    deduplicateExpenses();
    // Push merged result back if we had local-only entries
    if (localOnlyIncome.length || localOnlyExpense.length) scheduleAutoPush();
    navigate(currentView);
    setSyncIndicator('ok');
    updateSyncModalStatus('Last pull: ' + new Date().toLocaleTimeString());
    setTimeout(() => setSyncIndicator('idle'), 3000);
  } catch(e) {
    setSyncIndicator('error');
    console.warn('Initial pull failed:', e.message);
    setTimeout(() => setSyncIndicator('idle'), 5000);
  } finally { _isSyncing = false; }
}

// ── Export / Import ────────────────────────────────────────────
function exportAllToExcel() {
  if (typeof XLSX === 'undefined') { showToast('Excel library not loaded','error'); return; }
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Income ────────────────────────────────────────────
  const incRows = [['Date','Client','Sub-Client','Service','Amount (€)','VAT (€)','Total (€)','Status','Payment Type']];
  [...state.income].sort((a,b)=>b.date.localeCompare(a.date)).forEach(e=>{
    const c = clientById(e.clientId);
    const vat = e.vatAmount||0;
    incRows.push([e.date, c?.name||'?', e.subClient||'', e.service,
      e.amount, vat, e.amount+vat, e.status, e.paymentType==='invoice'?'Invoice':'Cash']);
  });
  const wsInc = XLSX.utils.aoa_to_sheet(incRows);
  wsInc['!cols'] = [{wch:12},{wch:20},{wch:18},{wch:24},{wch:12},{wch:10},{wch:12},{wch:10},{wch:12}];
  XLSX.utils.book_append_sheet(wb, wsInc, 'Income');

  // ── Sheet 2: Expenses ──────────────────────────────────────────
  const expRows = [['Date','Category','Type','Amount (€)','VAT (€)','Payment Method','Recurring']];
  [...state.expenses].sort((a,b)=>b.date.localeCompare(a.date)).forEach(e=>{
    expRows.push([e.date, e.category, e.vendor||'', e.amount, e.vatAmount||0, e.paymentMethod||'', e.recurring?'Yes':'No']);
  });
  const wsExp = XLSX.utils.aoa_to_sheet(expRows);
  wsExp['!cols'] = [{wch:12},{wch:22},{wch:20},{wch:12},{wch:10},{wch:16},{wch:10}];
  XLSX.utils.book_append_sheet(wb, wsExp, 'Expenses');

  // ── Sheet 3: Income by Client ──────────────────────────────────
  const cRows = [['Client','Total Paid (€)','Total Pending (€)','VAT (€)','Net Total (€)','Jobs']];
  state.clients.forEach(c=>{
    const ci = state.income.filter(e=>e.clientId===c.id);
    if (!ci.length) return;
    const paid = ci.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const pend = ci.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
    const vat  = ci.reduce((s,e)=>s+(e.vatAmount||0),0);
    cRows.push([c.name, paid, pend, vat, paid+pend+vat, ci.length]);
  });
  const wsCli = XLSX.utils.aoa_to_sheet(cRows);
  wsCli['!cols'] = [{wch:22},{wch:16},{wch:16},{wch:12},{wch:14},{wch:8}];
  XLSX.utils.book_append_sheet(wb, wsCli, 'By Client');

  // ── Sheet 4: Expenses by Category ─────────────────────────────
  const catMap = {};
  state.expenses.forEach(e=>{ catMap[e.category]=(catMap[e.category]||0)+e.amount; });
  const catRows = [['Category','Total (€)']];
  Object.entries(catMap).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>catRows.push([k,v]));
  const wsCat = XLSX.utils.aoa_to_sheet(catRows);
  wsCat['!cols'] = [{wch:28},{wch:14}];
  XLSX.utils.book_append_sheet(wb, wsCat, 'By Category');

  // ── Sheet 5: Monthly Summary ───────────────────────────────────
  const allMonthsSet = new Set([...state.income.map(e=>monthKey(e.date)), ...state.expenses.map(e=>monthKey(e.date))]);
  const monthsSorted = [...allMonthsSet].sort((a,b)=>b.localeCompare(a));
  const sumRows = [['Month','Income Paid (€)','Income Pending (€)','Expenses (€)','Net Profit (€)','VAT Due (€)']];
  monthsSorted.forEach(m=>{
    const mInc = state.income.filter(e=>monthKey(e.date)===m);
    const mExp = state.expenses.filter(e=>monthKey(e.date)===m);
    const paid = mInc.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const pend = mInc.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
    const exp  = mExp.reduce((s,e)=>s+e.amount,0);
    const vat  = mInc.filter(e=>e.status==='Paid'&&e.paymentType==='invoice').reduce((s,e)=>s+(e.vatAmount||0),0)
               - mExp.reduce((s,e)=>s+(e.vatAmount||0),0);
    sumRows.push([m, paid, pend, exp, paid-exp, vat]);
  });
  const wsSum = XLSX.utils.aoa_to_sheet(sumRows);
  wsSum['!cols'] = [{wch:10},{wch:16},{wch:16},{wch:14},{wch:14},{wch:12}];
  XLSX.utils.book_append_sheet(wb, wsSum, 'Monthly Summary');

  XLSX.writeFile(wb, 'BusinessMastermind_'+new Date().toISOString().slice(0,10)+'.xlsx');
  showToast('Excel file downloaded');
}

function exportData() {
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`business-mastermind-${todayVal()}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported');
}

function importData(ev) {
  const file=ev.target.files[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{ try {
    const p=JSON.parse(e.target.result);
    if(p.clients&&Array.isArray(p.clients)){
      state.clients=p.clients; state.income=p.income||[]; state.expenses=p.expenses||[];
      saveData(); showToast('Data imported'); navigate(currentView);
    } else showToast('Invalid format','error');
  } catch{ showToast('Could not parse file','error'); } };
  reader.readAsText(file);
  ev.target.value='';
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  await loadData();
  // Always start income/expense tabs on current month (override UIState)
  incMonth  = todayVal().slice(0,7);
  expMonth  = todayVal().slice(0,7);
  generateRecurring(true); // auto-generate on load, silent if nothing new
  updateServicesDatalist();
  document.getElementById('incomeDate').value  = todayVal();
  document.getElementById('expenseDate').value = todayVal();

  document.getElementById('modalOverlay').addEventListener('click', ()=>{
    const cd  = document.getElementById('confirmDialog');
    const edd = document.getElementById('entryDetailDialog');
    const sm  = document.getElementById('syncModal');
    if (cd&&cd.classList.contains('open'))   cancelDelete();
    else if (edd&&edd.classList.contains('open')) closeEntryDetail();
    else if (sm&&sm.classList.contains('open')) closeSyncModal();
    else closeAllModals();
  });

  // Close client dropdown on outside click
  document.addEventListener('click', e=>{
    if (!e.target.closest('.client-combo-wrapper')) {
      document.getElementById('clientDropdown').classList.add('hidden');
    }
  });

  // Close search panel on outside click
  document.addEventListener('click', e=>{
    if (!e.target.closest('.search-wrapper') && !e.target.closest('.search-results-panel')) {
      document.getElementById('searchResultsPanel').classList.add('hidden');
    }
  });

  // Cmd/Ctrl+Z → undo
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      const ae = document.activeElement;
      // Don't intercept undo inside text inputs/textareas
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      performUndo();
    }
  });

  // Push data before page closes/refreshes so other devices always get latest
  window.addEventListener('pagehide',       emergencyPush);
  window.addEventListener('beforeunload',   emergencyPush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') emergencyPush();
    if (document.visibilityState === 'visible') autoPull(true);
  });

  // Ensure QE month is set if not restored
  if (!qeGridMonth) qeGridMonth = todayVal().slice(0, 7);

  // iOS layout fixes: pin bottom nav + keep open sheet inside visual viewport
  if (window.visualViewport) {
    const adjustViewport = () => {
      const vv     = window.visualViewport;
      const vvH    = Math.floor(vv.height);
      // Pin bottom nav above keyboard
      const nav = document.querySelector('.bottom-nav');
      if (nav && nav.style.display !== 'none') {
        const offset = window.innerHeight - vvH - vv.offsetTop;
        nav.style.transform = offset > 10 ? `translateY(-${offset}px)` : '';
      }
      // Constrain any open sheet so its footer is never behind the keyboard
      const openSheet = document.querySelector('.sheet.open');
      if (openSheet) {
        openSheet.style.maxHeight = (vvH * 0.97) + 'px';
      }
    };
    window.visualViewport.addEventListener('resize',  adjustViewport);
    window.visualViewport.addEventListener('scroll',  adjustViewport);
  }

  // The save buttons use onclick which is reliable on desktop.
  // On mobile, the TOP save buttons (sheet-top-save) are always visible
  // above the keyboard so no special touch handling needed.

  // Navigate to last-used view (restored by loadUIState inside loadData)
  navigate(currentView);
  // Start auto-sync (will pull from cloud and re-render only if cloud data is newer)
  startAutoSync();
  // Safety net: re-render after 300ms in case any async op clobbered the first render
  setTimeout(() => renderView(currentView), 300);
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    console.error('App init failed:', err);
    // Recover: render dashboard with whatever state loaded so far
    try { navigate('dashboard'); } catch(_) {}
  });
});
