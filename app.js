'use strict';

// ── Google Sheets Config ───────────────────────────────────────
// Legacy Google Sheets sync — disabled. Firebase is the sole sync now.
// The Sheets pull was destructive (overwrote local data with stale rows and
// stripped the income "recurring" flag), so it is turned off entirely.
let SCRIPT_URL = '';

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
// profile.sources controls which income sections show: { clients, mainJob, sideHustles }
// profile.onboarded gates the first-run wizard. Income/clients carry kind:
// 'client' (default) | 'sidehustle' | 'mainjob'.
let state = { clients:[], income:[], expenses:[], services:[], deletedIds:[], deletedAt:{}, deletedClientIds:[], monthlyStopped:{}, profile:null };

const MAINJOB_CLIENT_ID = '__mainjob__'; // the single pseudo-client that holds salary income
function defaultProfile() { return { onboarded:false, sources:{ clients:true, mainJob:false, sideHustles:false }, hiddenTabs:[] }; }
// Left-nav items the user can show/hide from Settings (dashboard is always on)
const TOGGLEABLE_TABS = [
  { view:'income',     label:'Income' },
  { view:'expenses',   label:'Expenses' },
  { view:'calendar',   label:'Calendar' },
  { view:'quickentry', label:'Quick Entry' },
  { view:'monthly',    label:'Monthly' },
  { view:'services',   label:'Services' },
  { view:'reports',    label:'Reports' },
];
function profileHiddenTabs() { return (state.profile && Array.isArray(state.profile.hiddenTabs)) ? state.profile.hiddenTabs : []; }
function clientKind(c) { return (c && c.kind) ? c.kind : 'client'; }
function profileHas(src) { return !!(state.profile && state.profile.sources && state.profile.sources[src]); }
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
let incViewMode = 'byclient'; // 'byclient' | 'detailed' | 'excel'

// Expense filters
let expMonth='all', expCategory='all';
let expViewMode = 'bycategory'; // 'bycategory' | 'detailed' | 'excel'

// Split payment
let incSplitMode = false;
let splitInvStatus  = 'Paid'; // independent status for the invoice half
let splitCashStatus = 'Paid'; // independent status for the cash half

// Qty × Price mode in income form
let incQtyMode = false;

// Report filter
let reportPayFilter = 'all';
let reportSubMode   = 'separated'; // 'combined' | 'separated'

// Print options dialog
let _printSubMode    = 'separated';
let _printPayFilter  = 'all';
let _printStatusFilter = 'all'; // 'all' | 'Paid' | 'Pending' — print both / only paid / only pending
let _printMonths     = null;  // null = all months, array = specific months
let _printSubClients = null;  // null = all subclients, array = specific ones

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
  // Clear tombstones for any entry the undo brings back, otherwise the next
  // sync would treat the restored entry as deleted and remove it again.
  const restoredIds = new Set([...snap.income, ...snap.expenses].map(e => e.id));
  if (state.deletedIds) state.deletedIds = state.deletedIds.filter(id => !restoredIds.has(id));
  if (state.deletedAt) restoredIds.forEach(id => delete state.deletedAt[id]);
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

// Trim + dedupe every subclient name and trim entry subClients. A stray trailing
// space (e.g. "Other projects ") breaks Quick Entry column↔entry matching and makes
// real entries look "erased". Run on load AND after every cloud merge (a sync could
// otherwise re-introduce the space from another device's blob).
function normalizeSubclients() {
  const definedBy = {}; // clientId → its defined subclient names (for case-normalising entries)
  (state.clients||[]).forEach(c => {
    if (!Array.isArray(c.subclients)) return;
    const seen = new Set(); const out = [];
    c.subclients.forEach(s => {
      const t = (typeof s === 'string') ? s.trim() : s;
      if (t === '') return;
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    });
    c.subclients = out;
    definedBy[c.id] = out;
  });
  (state.income||[]).forEach(e => {
    if (typeof e.subClient !== 'string') return;
    e.subClient = e.subClient.trim();
    // Case-normalise to the client's defined subclient casing — an entry saved as
    // "citymed" must match the "Citymed" column (otherwise it's invisible in Quick
    // Entry but still counted in Income, so the totals disagree).
    const defs = definedBy[e.clientId];
    if (e.subClient && defs) {
      const m = defs.find(d => d.toLowerCase() === e.subClient.toLowerCase());
      if (m && m !== e.subClient) e.subClient = m;
    }
  });
}

// ── Persistence ────────────────────────────────────────────────
async function loadData() {
  try {
    const p = await idbGet(STORAGE_KEY);
    if (p) {
      state.clients      = p.clients    || [];
      state.income       = p.income     || [];
      state.expenses     = p.expenses   || [];
      state.services     = p.services   || [...DEFAULT_SERVICES];
      state.deletedIds   = p.deletedIds || [];
      state.deletedAt    = p.deletedAt || {};
      state.deletedClientIds = p.deletedClientIds || [];
      state.monthlyStopped = p.monthlyStopped || {};
      state.profile      = p.profile || null;
      state.lastModified = p.lastModified || 0;
    } else {
      // Brand-new on this device → clean slate; the onboarding wizard sets things up
      state.clients  = [];
      state.services = [...DEFAULT_SERVICES];
      state.profile  = null;
    }
  } catch(e) { state.clients = []; state.services = [...DEFAULT_SERVICES]; }
  state.clients.forEach(c => {
    if (!c.paymentType) c.paymentType = 'invoice';
    if (!c.subclientPaymentTypes) c.subclientPaymentTypes = {};
    if (!Array.isArray(c.subclients)) c.subclients = []; // backfill so edit never crashes
    if (!c.kind) c.kind = 'client'; // backfill source kind
  });
  normalizeSubclients(); migrateMonthlyStopped();
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
    // Skip split-payment entries — they intentionally share clientId+date+subClient
    // but differ by paymentType (invoice vs cash). Deduping them would delete the cash half.
    if (e.splitGroupId) return;
    // Key on the FULL content, not just client+date+sub — otherwise two legitimately
    // different gigs for the same client on the same day (e.g. a €100 morning shoot and
    // a €200 evening shoot) would be treated as duplicates and one silently deleted.
    // Only entries identical in every meaningful field are a true (recurring/race) dupe.
    const key = [e.clientId||'', e.date||'', e.subClient||'', e.amount||0,
      e.qty??'', e.unitPrice??'', e.service||'', e.paymentType||'', (e.notes||'').trim()].join('|');
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
    const key = (e.category||'') + '|' + (e.vendor||'') + '|' + monthKey(e.date||'') + '|' + (e.amount||0);
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
    // 'cards' and 'detailed' views were removed — migrate any saved preference
    if (incViewMode==='cards' || incViewMode==='detailed') incViewMode = 'byclient';
    if (expViewMode==='cards' || expViewMode==='detailed') expViewMode = 'bycategory';
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

// Record a deletion so it propagates to every device and the entry can never
// be resurrected by a stale copy on another device. Tombstones are timestamped
// and kept for a full year — far longer than any realistic offline period.
function addTombstone(id) {
  if (!id) return;
  if (!state.deletedIds) state.deletedIds = [];
  if (!state.deletedAt)  state.deletedAt  = {};
  if (!state.deletedIds.includes(id)) state.deletedIds.push(id);
  state.deletedAt[id] = Date.now();
}

const TOMBSTONE_TTL = 365 * 24 * 60 * 60 * 1000; // 1 year

// Merge two versions of the SAME income entry (local le + cloud ce) with
// field-level resolution for `status`. Whole-object last-write-wins would lose
// a Paid/Pending change made on one device when the other device edited the
// amount; here status is resolved by its own timestamp so neither is lost.
function mergeIncomeEntry(le, ce) {
  const leTs = le.updatedAt || le.createdAt || 0;
  const ceTs = ce.updatedAt || ce.createdAt || 0;
  const winner = leTs >= ceTs ? le : ce; // newer object wins for non-status fields
  // Resolve status independently using its own timestamp.
  // Fall back to createdAt (NOT updatedAt) so a QE amount save that bumps
  // updatedAt cannot accidentally override a Paid/Pending toggle on the other device.
  const leSt = le.statusUpdatedAt || le.createdAt || 0;
  const ceSt = ce.statusUpdatedAt || ce.createdAt || 0;
  const statusSrc = leSt >= ceSt ? le : ce;
  if (statusSrc.status === winner.status) return winner;
  const merged = { ...winner, status: statusSrc.status, statusUpdatedAt: Math.max(leSt, ceSt) };
  if (statusSrc.status === 'Paid') { if (statusSrc.paidDate) merged.paidDate = statusSrc.paidDate; }
  else delete merged.paidDate;
  return merged;
}

function saveData() {
  state.lastModified = Date.now();
  // Prune tombstones only when they are older than a full year. Pruning by
  // count (the old behaviour) could drop a recent deletion that an offline
  // device still needed, which is exactly how deleted entries came back.
  if (state.deletedIds && state.deletedIds.length) {
    if (!state.deletedAt) state.deletedAt = {};
    const cutoff = Date.now() - TOMBSTONE_TTL;
    state.deletedIds = state.deletedIds.filter(id => {
      const ts = state.deletedAt[id];
      if (ts === undefined) return true;     // legacy tombstone, no ts — keep
      return ts >= cutoff;                   // keep if deleted within the year
    });
    // Drop timestamp records for ids no longer tracked
    Object.keys(state.deletedAt).forEach(id => {
      if (!state.deletedIds.includes(id)) delete state.deletedAt[id];
    });
  }
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
  const out = {
    id: String(e.id||genId()), clientId: String(e.clientId||''),
    subClient: String(e.subClient||''), service: String(e.service||''),
    amount: parseFloat(e.amount)||0, vatAmount: parseFloat(e.vatAmount)||0,
    paymentType: String(e.paymentType||'cash'), date: String(e.date||''),
    status: String(e.status||'Paid'), notes: String(e.notes||''),
    recurring: e.recurring===true||e.recurring==='TRUE'||e.recurring==='true',
    createdAt: Number(e.createdAt)||Date.now(),
  };
  // Preserve optional fields so sync/import never silently drops them
  if (e.qty!=null) out.qty = parseFloat(e.qty)||0;
  if (e.unitPrice!=null) out.unitPrice = parseFloat(e.unitPrice)||0;
  if (e.updatedAt!=null) out.updatedAt = Number(e.updatedAt)||0;
  if (e.splitGroupId) out.splitGroupId = String(e.splitGroupId);
  if (e.paidDate!=null) out.paidDate = Number(e.paidDate)||0;
  if (e.statusUpdatedAt!=null) out.statusUpdatedAt = Number(e.statusUpdatedAt)||0;
  if (e.oneOff) out.oneOff = true;
  return out;
}

function normalizeExpense(e) {
  const out = {
    id: String(e.id||genId()), category: String(e.category||''),
    vendor: String(e.vendor||''), description: String(e.description||''),
    amount: parseFloat(e.amount)||0, vatAmount: parseFloat(e.vatAmount)||0,
    paymentMethod: String(e.paymentMethod||'Cash'),
    recurring: e.recurring===true||e.recurring==='TRUE'||e.recurring==='true',
    date: String(e.date||''), createdAt: Number(e.createdAt)||Date.now(),
  };
  if (e.updatedAt!=null) out.updatedAt = Number(e.updatedAt)||0;
  if (e.oneOff) out.oneOff = true;
  return out;
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
function fmt(n)  {
  const v = Number(n||0);
  const s = '€'+Math.abs(v).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
  return v < 0 ? '-'+s : s;
}
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
  // Force a reflow then add 'open' — reliable trigger for the CSS transition.
  // (double-rAF could silently skip if the frame loop was paused, leaving the
  // sheet stuck off-screen — that was the "edit button does nothing" bug.)
  void el.offsetWidth;
  el.classList.add('open');
  // Hide the mobile bottom nav while a sheet is open (so it never blocks the save
  // button). Class-driven on <body> so it can NEVER get stuck hidden — that was the
  // "Add Entry does nothing on mobile" bug (closeSheet left an inline display:none).
  document.body.classList.add('sheet-open');
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
  document.body.classList.remove('sheet-open'); // restore the mobile bottom nav
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
  if (!anyOpen) {
    document.getElementById('modalOverlay').classList.add('hidden');
    document.body.classList.remove('sheet-open'); // restore the mobile bottom nav
  }
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
    [e.vendor, e.category, e.description||'', e.notes||'', String(e.amount)].some(s=>s.toLowerCase().includes(q))
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
  // Flush any pending Quick Entry auto-saves before leaving it (income + expenses)
  if (currentView === 'quickentry' && typeof qeFlushSave === 'function') qeFlushSave();
  if (currentView === 'quickentry' && typeof qeExpFlushSave === 'function') qeExpFlushSave();
  currentView = view;
  saveUIState();
  clearSearch();
  closeMobileSidebar();
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  document.querySelectorAll('.bottom-nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  document.querySelectorAll('.view').forEach(el=>el.classList.add('hidden'));
  document.getElementById('view-'+view).classList.remove('hidden');
  const titles={dashboard:'Dashboard',income:'Income',expenses:'Expenses',clients:'Clients',sidehustles:'Side Hustles',quickentry:'Quick Entry',reports:'Reports',services:'Services',monthly:'Monthly',calendar:'Calendar',settings:'Settings'};
  document.getElementById('topbarTitle').textContent = titles[view]||'';
  renderView(view);
}

function renderView(v) {
  if      (v==='dashboard') renderDashboard();
  else if (v==='income')    renderIncome();
  else if (v==='expenses')  renderExpenses();
  else if (v==='clients')   renderClients();
  else if (v==='sidehustles') renderSideHustles();
  else if (v==='quickentry')renderQuickEntry();
  else if (v==='reports')   renderReports();
  else if (v==='services')  renderServices();
  else if (v==='monthly')   renderMonthly();
  else if (v==='calendar')  renderCalendar();
  else if (v==='settings')  renderSettings();
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

let addClientKind = 'client'; // 'client' | 'sidehustle'
function openAddSideHustle() { openAddClient('sidehustle'); }
function openAddClient(kind) {
  addClientKind  = kind || 'client';
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
  // Side hustles are simple named sources — hide the Agency/sub-client machinery
  const isSH = addClientKind === 'sidehustle';
  const titleEl = document.querySelector('#sheetAddClient .sheet-title');
  if (titleEl) titleEl.textContent = isSH ? 'Add Side Hustle' : 'Add New Client';
  const nameInp = document.getElementById('addClientName');
  if (nameInp) nameInp.placeholder = isSH ? 'Side hustle name… (e.g. Etsy shop)' : 'Client name…';
  const typeGroup = document.getElementById('addTypeDirect')?.closest('.form-group');
  if (typeGroup) typeGroup.style.display = isSH ? 'none' : '';
  const saveBtn = document.querySelector('#sheetAddClient .btn-save');
  if (saveBtn) saveBtn.innerHTML = isSH ? '<i class="fa-solid fa-check"></i> Add Side Hustle' : '<i class="fa-solid fa-check"></i> Add Client';
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
  const isSH  = addClientKind === 'sidehustle';
  const label = isSH ? 'side hustle' : 'client';
  const name = document.getElementById('addClientName').value.trim();
  if (!name) { showToast(`Please enter a ${label} name`,'error'); return; }
  if (state.clients.find(c=>c.name.toLowerCase()===name.toLowerCase())) {
    showToast(`A ${label} with this name already exists`,'error'); return;
  }
  const nc = { id:'C'+Date.now(), name, type:isSH?'Direct':addClientType, color:addClientColor, subclients:[], kind:addClientKind || 'client', paymentType: isSH?'cash':'invoice', updatedAt: Date.now() };
  const imgData = document.getElementById('addClientImgData')?.value;
  if (imgData) nc.image = imgData;
  state.clients.push(nc);
  saveData();
  closeAllModals();
  showToast(`${isSH?'Side hustle':'Client'} "${name}" added`);
  navigate(isSH ? 'sidehustles' : 'clients');
}

function openEditClient(clientId) {
  const c = clientById(clientId);
  if (!c) return;
  document.getElementById('editClientId').value    = clientId;
  document.getElementById('editClientName').value  = c.name;
  editClientType       = c.type;
  editClientColor      = c.color;
  editClientSubclients = [...(c.subclients || [])]; // guard: old/direct clients may lack the array
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
  const typeChanged = c.type !== editClientType;
  c.name       = name;
  c.type       = editClientType;
  c.color      = editClientColor;
  c.subclients = editClientType==='Agency'
    ? [...new Set(editClientSubclients.map(s=>(s||'').trim()).filter(Boolean))] // trim + dedupe on save
    : [];
  c.updatedAt = Date.now(); // stamp so cross-device merge keeps this edit (incl. new subclients)
  // Direct↔Agency restructures the QE columns — drop stale QE drafts for this client
  if (typeChanged) clearQEDraftForClient(id);
  const editPTInv  = document.getElementById('editPayTypeInvoice');
  const editPTCash = document.getElementById('editPayTypeCash');
  if (editPTInv && editPTCash) {
    c.paymentType = editPTCash.classList.contains('active') ? 'cash' : 'invoice';
  }
  const imgData = document.getElementById('editClientImgData')?.value;
  if (imgData) c.image = imgData;
  saveData();
  closeSheet('sheetEditClient');
  showToast(`${clientKind(c)==='sidehustle'?'Side hustle':'Client'} "${name}" updated`);
  renderView(currentView);
}

function deleteClientFromEdit() {
  const id = document.getElementById('editClientId').value;
  const c  = clientById(id);
  if (!c) return;
  if (state.income.some(e=>e.clientId===id)) {
    showToast('Cannot delete client with existing income entries','error'); return;
  }
  state.clients = state.clients.filter(cl=>cl.id!==id);
  if (!state.deletedClientIds) state.deletedClientIds = [];
  if (!state.deletedClientIds.includes(id)) state.deletedClientIds.push(id); // propagate the deletion cross-device
  saveData();
  closeSheet('sheetEditClient');
  showToast(`"${c.name}" deleted`);
  renderView(currentView);
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
  // Exclude the Main Job pseudo-client (salary is managed in its own tab)
  const hits = state.clients.filter(c=>clientKind(c)!=='mainjob' && c.name.toLowerCase().includes(q));
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
  // Reset per-half split statuses + re-show the single Status toggle
  splitInvStatus = 'Paid'; splitCashStatus = 'Paid';
  setSplitStatus('inv', 'Paid'); setSplitStatus('cash', 'Paid');
  const _sg = document.getElementById('incStatusGroup');
  if (_sg) _sg.classList.remove('hidden');

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

  document.getElementById('incomeDate').value = todayVal(); // fresh add defaults to today
  setIncomeDateMode('exact');
  updateVATPreview();
  editingEntryId = null; editingEntryType = null;
  const titleEl = document.querySelector('#sheetIncome .sheet-title');
  const saveEl  = document.querySelector('#sheetIncome .btn-save');
  if (titleEl) titleEl.textContent = 'Add Income';
  if (saveEl)  saveEl.innerHTML = '<i class="fa-solid fa-check"></i> Save Income Entry';
}

// Reformat a stored date value for a given mode:
//   exact → 'YYYY-MM-DD' (append -01 if only a month was stored)
//   month → 'YYYY-MM'
function reformatDateVal(v, mode) {
  if (!v) v = todayVal();
  if (mode === 'month') return v.slice(0, 7);
  return v.length === 7 ? v + '-01' : v.slice(0, 10);
}

function setIncomeDateMode(mode) {
  incomeDateMode = mode;
  document.getElementById('incDateModeExact').classList.toggle('active', mode==='exact');
  document.getElementById('incDateModeMonth').classList.toggle('active', mode==='month');
  const inp = document.getElementById('incomeDate');
  inp.value = reformatDateVal(inp.value, mode);
  updateIncomeDateDisplay();
}

function setExpDateMode(mode) {
  expDateMode = mode;
  document.getElementById('expDateModeExact').classList.toggle('active', mode==='exact');
  document.getElementById('expDateModeMonth').classList.toggle('active', mode==='month');
  const inp = document.getElementById('expenseDate');
  inp.value = reformatDateVal(inp.value, mode);
  updateExpDateDisplay();
}

// ── Date display fields + iOS-style wheel picker ───────────────
function fmtDateDisplay(val, mode) {
  if (!val) return mode === 'month' ? 'Pick a month' : 'Pick a date';
  const p = val.split('-').map(Number);
  if (mode === 'month') return MONTH_NAMES[(p[1]||1)-1] + ' ' + p[0];
  return (p[2]||1) + ' ' + MONTH_NAMES[(p[1]||1)-1] + ' ' + p[0];
}
function updateIncomeDateDisplay() {
  const el = document.getElementById('incomeDateDisplay');
  if (el) el.querySelector('.dd-text').textContent = fmtDateDisplay(document.getElementById('incomeDate').value, incomeDateMode);
}
function updateExpDateDisplay() {
  const el = document.getElementById('expenseDateDisplay');
  if (el) el.querySelector('.dd-text').textContent = fmtDateDisplay(document.getElementById('expenseDate').value, expDateMode);
}
function openIncomeDateWheel() {
  openDateWheel(incomeDateMode, document.getElementById('incomeDate').value, val => {
    document.getElementById('incomeDate').value = val;
    updateIncomeDateDisplay();
  });
}
function openExpenseDateWheel() {
  openDateWheel(expDateMode, document.getElementById('expenseDate').value, val => {
    document.getElementById('expenseDate').value = val;
    updateExpDateDisplay();
  });
}

const WHEEL_ITEM_H = 40;
let _dateWheel = null; // { mode, y, m(0-11), d, onPick }

function _pad2(n){ return String(n).padStart(2,'0'); }
function _daysInMon(y,m){ return new Date(y, m+1, 0).getDate(); }
function _wheelYears(){
  const w = _dateWheel;
  const lo = Math.min(2018, w.y);
  const hi = Math.max(new Date().getFullYear()+2, w.y);
  const a = []; for (let y=lo; y<=hi; y++) a.push(y);
  return a;
}

function openDateWheel(mode, value, onPick) {
  const t = new Date();
  let y, m, d;
  if (value) { const p = value.split('-').map(Number); y=p[0]; m=(p[1]||1)-1; d=p[2]||1; }
  else { y=t.getFullYear(); m=t.getMonth(); d=t.getDate(); }
  _dateWheel = { mode, y, m, d, onPick };
  const ov = document.getElementById('dateWheelOverlay');
  ov.classList.remove('hidden');
  renderDateWheel();
  requestAnimationFrame(()=>ov.classList.add('open'));
}

function _wheelColHTML(key, items, selIdx) {
  return `<div class="wheel-col" data-key="${key}">`
    + `<div class="wheel-pad"></div>`
    + items.map((it,i)=>`<div class="wheel-item${i===selIdx?' sel':''}" data-idx="${i}">${it}</div>`).join('')
    + `<div class="wheel-pad"></div></div>`;
}

function renderDateWheel() {
  const w = _dateWheel; if (!w) return;
  const years  = _wheelYears();
  const months = MONTH_NAMES.map(n=>n.slice(0,3));
  const dim = _daysInMon(w.y, w.m);
  if (w.d > dim) w.d = dim;

  let cols = '';
  if (w.mode === 'exact') {
    const days = Array.from({length:dim},(_,i)=>i+1);
    cols += _wheelColHTML('d', days, w.d-1);
  }
  cols += _wheelColHTML('m', months, w.m);
  cols += _wheelColHTML('y', years, years.indexOf(w.y));

  document.getElementById('dateWheelSheet').innerHTML =
    `<div class="wheel-title">${w.mode==='month'?'Pick a month':'Pick a date'}</div>`
    + `<div class="wheel-cols">${cols}<div class="wheel-band"></div></div>`
    + `<div class="wheel-actions">`
    +   `<button class="wheel-btn wheel-cancel" onclick="closeDateWheel()">Cancel</button>`
    +   `<button class="wheel-btn wheel-done" onclick="confirmDateWheel()">Done</button>`
    + `</div>`;

  document.querySelectorAll('#dateWheelSheet .wheel-col').forEach(col => _wireWheelCol(col));
}

function _wireWheelCol(col) {
  const sel = col.querySelector('.wheel-item.sel');
  const selIdx = sel ? parseInt(sel.dataset.idx) : 0;
  requestAnimationFrame(()=>{ col.scrollTop = selIdx * WHEEL_ITEM_H; });
  let tmr = null;
  col.addEventListener('scroll', () => {
    _markWheelSel(col);
    clearTimeout(tmr);
    tmr = setTimeout(()=>_onWheelSettle(col), 100);
  });
  col.querySelectorAll('.wheel-item').forEach(it => {
    it.addEventListener('click', ()=> col.scrollTo({ top: parseInt(it.dataset.idx)*WHEEL_ITEM_H, behavior:'smooth' }));
  });
}

function _markWheelSel(col) {
  const idx = Math.round(col.scrollTop / WHEEL_ITEM_H);
  col.querySelectorAll('.wheel-item').forEach(it => it.classList.toggle('sel', parseInt(it.dataset.idx)===idx));
}

function _onWheelSettle(col) {
  const w = _dateWheel; if (!w) return;
  const idx = Math.max(0, Math.round(col.scrollTop / WHEEL_ITEM_H));
  const snapped = idx * WHEEL_ITEM_H;
  if (Math.abs(col.scrollTop - snapped) > 1) col.scrollTop = snapped;
  const key = col.dataset.key;
  if (key === 'y')      { w.y = _wheelYears()[idx]; _rebuildWheelDays(); }
  else if (key === 'm') { w.m = idx;                _rebuildWheelDays(); }
  else if (key === 'd') { w.d = idx + 1; }
}

function _rebuildWheelDays() {
  const w = _dateWheel; if (!w || w.mode !== 'exact') return;
  const dim = _daysInMon(w.y, w.m);
  const col = document.querySelector('#dateWheelSheet .wheel-col[data-key="d"]');
  if (!col) return;
  if (col.querySelectorAll('.wheel-item').length === dim) return; // no change
  if (w.d > dim) w.d = dim;
  const days = Array.from({length:dim},(_,i)=>i+1);
  col.innerHTML = `<div class="wheel-pad"></div>`
    + days.map((it,i)=>`<div class="wheel-item${i===w.d-1?' sel':''}" data-idx="${i}">${it}</div>`).join('')
    + `<div class="wheel-pad"></div>`;
  col.querySelectorAll('.wheel-item').forEach(it => {
    it.addEventListener('click', ()=> col.scrollTo({ top: parseInt(it.dataset.idx)*WHEEL_ITEM_H, behavior:'smooth' }));
  });
  col.scrollTop = (w.d-1) * WHEEL_ITEM_H;
}

function confirmDateWheel() {
  const w = _dateWheel; if (!w) return;
  const val = w.mode === 'month'
    ? `${w.y}-${_pad2(w.m+1)}`
    : `${w.y}-${_pad2(w.m+1)}-${_pad2(w.d)}`;
  const cb = w.onPick;
  closeDateWheel();
  if (cb) cb(val);
}

function closeDateWheel() {
  const ov = document.getElementById('dateWheelOverlay');
  if (ov) { ov.classList.remove('open'); setTimeout(()=>ov.classList.add('hidden'), 200); }
  _dateWheel = null;
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
  // In split mode each half carries its OWN status, so hide the single Status toggle
  const sg = document.getElementById('incStatusGroup');
  if (sg) sg.classList.toggle('hidden', v);
  if (v) {
    // Seed both halves from the current single status the first time split turns on
    setSplitStatus('inv',  splitInvStatus  || incomeStatus);
    setSplitStatus('cash', splitCashStatus || incomeStatus);
    updateSplitPreview();
  } else {
    updateVATPreview();
  }
}

// Per-half status for split payments — invoice and cash are independent
function setSplitStatus(which, s) {
  if (which === 'inv') {
    splitInvStatus = s;
    document.getElementById('splitInvPaid').classList.toggle('active',    s==='Paid');
    document.getElementById('splitInvPending').classList.toggle('active', s==='Pending');
  } else {
    splitCashStatus = s;
    document.getElementById('splitCashPaid').classList.toggle('active',    s==='Paid');
    document.getElementById('splitCashPending').classList.toggle('active', s==='Pending');
  }
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

// Drop the Quick Entry draft cache for a cell (client+date, any sub/type) so an
// edit/status-change made OUTSIDE QE is never overwritten by a stale draft when QE
// re-opens. This is what was corrupting entries after editing them in the Income tab.
function clearQEDraftForCell(clientId, date) {
  if (!clientId || !date) return;
  let changed = false;
  Object.keys(qeGridData).forEach(k => {
    const p = k.split('|'); // type|clientId|date|sub
    if (p[1] === clientId && p[2] === date) { delete qeGridData[k]; changed = true; }
  });
  // Also blank any LIVE grid inputs for this cell — the QE table DOM persists while
  // hidden, and captureQEGridData would otherwise re-capture the stale displayed
  // value back into the draft on the next visit (that was the real corruption).
  try {
    document.querySelectorAll(`#qeSpreadsheet input[data-client="${clientId}"][data-date="${date}"]`)
      .forEach(inp => { inp.value = ''; });
  } catch(_) {}
  if (changed) idbSet(QE_GRID_KEY, qeGridData);
}
// Make sure a client shows as a Quick Entry column (called when income is added
// for it), so + Add Entry items appear without forcing EVERY active client.
function ensureQEClientSelected(clientId) {
  const c = clientById(clientId);
  if (!c || clientKind(c) === 'mainjob') return;
  if (!qeGridSelectedClients.includes(clientId)) { qeGridSelectedClients.push(clientId); saveUIState(); }
}
function clearQEDraftForClient(clientId) {
  if (!clientId) return;
  let changed = false;
  Object.keys(qeGridData).forEach(k => { if (k.split('|')[1] === clientId) { delete qeGridData[k]; changed = true; } });
  try {
    document.querySelectorAll(`#qeSpreadsheet input[data-client="${clientId}"]`).forEach(inp => { inp.value = ''; });
  } catch(_) {}
  if (changed) idbSet(QE_GRID_KEY, qeGridData);
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

    // If editing, remove the old entry and its split companion before re-creating
    if (editingEntryId) {
      pushUndo('Edit split payment');
      const oldEntry = state.income.find(e => e.id === editingEntryId);
      if (oldEntry) {
        // Remove both entries that belong to this split group
        const grpId = oldEntry.splitGroupId;
        if (grpId) {
          state.income = state.income.filter(e => e.splitGroupId !== grpId);
        } else {
          // Fallback: remove by id + companion (same client+date+sub, different paymentType)
          const companionId = state.income.find(x =>
            x.id !== editingEntryId &&
            x.clientId === oldEntry.clientId &&
            x.date === oldEntry.date &&
            (x.subClient||'') === (oldEntry.subClient||'') &&
            x.paymentType !== oldEntry.paymentType
          )?.id;
          state.income = state.income.filter(e => e.id !== editingEntryId && e.id !== companionId);
        }
        clearQEDraftForCell(oldEntry.clientId, oldEntry.date);
      }
      editingEntryId = null; editingEntryType = null;
    } else {
      pushUndo('Add split payment');
    }

    const sgId = genId(); // shared group id links the two halves (for amount edits only)
    const now  = Date.now();
    // The two halves keep INDEPENDENT statuses — changing one never flips the other
    const base = { clientId, subClient, service, date:rawDate, notes,
                   recurring:incRecurring, splitGroupId:sgId, createdAt:now };
    const mkHalf = (extra, st) => {
      const e = { ...base, id:genId(), status:st, statusUpdatedAt:now, ...extra };
      if (st === 'Paid') e.paidDate = now;
      return e;
    };
    const entries = [];
    if (invAmt>0)  entries.push(mkHalf({ amount:invAmt,  vatAmount:invAmt*VAT_RATE, paymentType:'invoice' }, splitInvStatus));
    if (cashAmt>0) entries.push(mkHalf({ amount:cashAmt, vatAmount:0,               paymentType:'cash'    }, splitCashStatus));
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
      const updated = { ...prev, clientId, subClient, service, amount, vatAmount, paymentType:incomePaymentType, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, qty, unitPrice, updatedAt:Date.now() };
      if (paidDate) updated.paidDate = paidDate; else delete updated.paidDate;
      if (prev.status !== incomeStatus) updated.statusUpdatedAt = Date.now();
      // Editing a single month of a monthly series is a per-month override —
      // mark it so it doesn't become the template for future auto-generation
      if (incRecurring && prev.recurring && (prev.amount !== amount)) updated.oneOff = true;
      state.income[idx] = updated;
      // Invalidate any stale Quick Entry draft for this cell (old + new location)
      clearQEDraftForCell(prev.clientId, prev.date);
      if (clientId !== prev.clientId || rawDate !== prev.date) clearQEDraftForCell(clientId, rawDate);
    }
    editingEntryId = null; editingEntryType = null;
    saveData();
    closeAllModals();
    showToast('Income entry updated');
    renderView(currentView);
  } else {
    const entry = { id:genId(), clientId, subClient, service, amount, vatAmount, paymentType:incomePaymentType, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, qty, unitPrice, createdAt:Date.now(), statusUpdatedAt:Date.now() };
    if (incomeStatus === 'Paid') entry.paidDate = Date.now();
    // Manually adding a monthly entry revives a previously stopped series
    if (incRecurring && state.monthlyStopped) delete state.monthlyStopped[incSeriesKey(entry)];
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
    ensureQEClientSelected(clientId); // so it shows in Quick Entry
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
      const prevExp = state.expenses[idx];
      state.expenses[idx] = { ...prevExp, category, vendor, description, amount, vatAmount, paymentMethod:expPaymentMethod, recurring:expRecurring, date:rawDate, updatedAt:Date.now() };
      if (expRecurring && prevExp.recurring && (prevExp.amount !== amount)) state.expenses[idx].oneOff = true;
    }
    editingEntryId = null; editingEntryType = null;
    saveData();
    closeAllModals();
    showToast('Expense entry updated');
    renderView(currentView);
    return;
  } else {
    const entry = { id:genId(), category, vendor, description, amount, vatAmount, paymentMethod:expPaymentMethod, recurring:expRecurring, date:rawDate, createdAt:Date.now() };
    if (expRecurring && state.monthlyStopped) delete state.monthlyStopped[expSeriesKey(entry)];
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
  }
}

// ── Entry Detail / Edit ────────────────────────────────────────
function openEntryDetail(type, id) {
  let html, title;
  if (type==='income') {
    const e = state.income.find(x=>x.id===id); if (!e) return;
    const c = clientById(e.clientId);
    title = 'Income Details';
    // Detect split companion
    const splitComp = e.splitGroupId
      ? state.income.find(x => x.splitGroupId === e.splitGroupId && x.id !== id)
      : state.income.find(x =>
          x.id !== id && x.clientId === e.clientId && x.date === e.date &&
          (x.subClient||'') === (e.subClient||'') && x.paymentType !== e.paymentType &&
          ['invoice','cash'].includes(x.paymentType)
        );
    const isSplit = !!splitComp;
    const invE  = isSplit ? (e.paymentType==='invoice' ? e : splitComp) : null;
    const cashE = isSplit ? (e.paymentType==='cash'    ? e : splitComp) : null;
    html = `
      <div class="ed-row"><span>Client</span><strong>${c?.name||'?'}</strong></div>
      ${e.subClient?`<div class="ed-row"><span>Sub-Client</span><strong>${e.subClient}</strong></div>`:''}
      <div class="ed-row"><span>Service</span><strong>${e.service}</strong></div>
      ${isSplit
        ? `<div class="ed-row"><span>Invoice</span><strong style="color:var(--green)">${fmt(invE.amount)} <span style="opacity:.6;font-size:11px">+ VAT ${fmt(invE.vatAmount)}</span> <span style="font-size:11px;color:${invE.status==='Paid'?'var(--green)':'var(--amber)'}">· ${invE.status}</span></strong></div>
           <div class="ed-row"><span>Cash</span><strong style="color:var(--green)">${fmt(cashE.amount)} <span style="font-size:11px;color:${cashE.status==='Paid'?'var(--green)':'var(--amber)'}">· ${cashE.status}</span></strong></div>
           <div class="ed-row"><span>Total</span><strong style="color:var(--green)">${fmt(invE.amount+cashE.amount)}</strong></div>
           <div class="ed-row"><span>Type</span><strong>Split (Invoice + Cash)</strong></div>`
        : `<div class="ed-row"><span>Amount</span><strong style="color:var(--green)">${fmt(e.amount)}</strong></div>
           ${e.vatAmount>0?`<div class="ed-row"><span>VAT</span><strong>${fmt(e.vatAmount)}</strong></div>`:''}
           <div class="ed-row"><span>Type</span><strong>${e.paymentType==='invoice'?'Invoice':'Cash'}</strong></div>`}
      <div class="ed-row"><span>Date</span><strong>${toDateStr(e.date)}</strong></div>
      ${isSplit?'':`<div class="ed-row"><span>Status</span><strong>${e.status}</strong></div>`}
      ${!isSplit && e.paidDate?`<div class="ed-row"><span>Paid on</span><strong style="color:var(--green)">${toDateStr(new Date(e.paidDate).toISOString().slice(0,10))}</strong></div>`:''}
      ${e.recurring?'<div class="ed-row"><span>Monthly</span><strong>Yes</strong></div>':''}
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
      ${e.recurring?'<div class="ed-row"><span>Monthly</span><strong>Yes</strong></div>':''}`;
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
    document.getElementById('incomeNotes').value     = e.notes||'';
    setStatus(e.status);
    setIncRecurring(e.recurring||false);
    setIncomeDateMode('exact');
    document.getElementById('incomeDate').value = e.date.slice(0,10);
    updateIncomeDateDisplay();

    // Detect split pair — by splitGroupId (new) or by companion entry (legacy)
    const companion = e.splitGroupId
      ? state.income.find(x => x.splitGroupId === e.splitGroupId && x.id !== id)
      : state.income.find(x =>
          x.id !== id &&
          x.clientId === e.clientId &&
          x.date === e.date &&
          (x.subClient||'') === (e.subClient||'') &&
          x.paymentType !== e.paymentType &&
          ['invoice','cash'].includes(x.paymentType)
        );

    if (companion) {
      // Open in split mode with both amounts pre-filled
      setIncSplit(true);
      const invEntry  = e.paymentType === 'invoice' ? e : companion;
      const cashEntry = e.paymentType === 'cash'    ? e : companion;
      document.getElementById('splitInvoiceAmt').value = invEntry.amount;
      document.getElementById('splitCashAmt').value    = cashEntry.amount;
      // Pre-fill each half's OWN status so they stay independent
      setSplitStatus('inv',  invEntry.status  || 'Paid');
      setSplitStatus('cash', cashEntry.status || 'Paid');
      updateSplitPreview();
    } else {
      // Normal single entry
      setIncSplit(false);
      document.getElementById('incomeAmount').value = e.amount;
      setPaymentType(e.paymentType);
      updateVATPreview();
    }

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
    updateExpDateDisplay();
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
      // Split payment: tombstone both halves
      if (entry.splitGroupId) {
        state.income.filter(e=>e.splitGroupId===entry.splitGroupId).forEach(e=>addTombstone(e.id));
        state.income = state.income.filter(e=>e.splitGroupId!==entry.splitGroupId);
      } else {
        addTombstone(pendingDeleteId);
        state.income = state.income.filter(e => e.id !== pendingDeleteId);
      }
    } else {
      state.income = state.income.filter(e => e.id !== pendingDeleteId);
    }
    showToast('Income entry deleted');
  } else if (pendingDeleteType === 'expense') {
    const expEntry = state.expenses.find(e => e.id === pendingDeleteId);
    pushUndo(`Delete expense: ${expEntry ? (expEntry.vendor||expEntry.category) : 'entry'}`);
    addTombstone(pendingDeleteId);
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
  saveUIState();
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

// Incrementally record a single input into the draft (cheap — O(1)). Used on every
// keystroke instead of scanning the whole grid.
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
      // Agency vs direct is decided by the CLIENT (does it have sub-client columns),
      // not by whether the entries happen to carry a subclient — otherwise a day with
      // only no-subclient entries on an agency would wrongly use the direct layout.
      const hasSubclients = (clientById(cid)?.subclients||[]).length > 0;
      // No service filter: show whatever is stored for this client+date+sub
      const entries = allClientEntries;

      if (hasSubclients) {
        // Agency: find shared price from saved entries, set it; then per-subclient qty + override
        const withShared = entries.filter(e => e.sharedPrice != null);
        const sharedPrice = withShared.length ? withShared[withShared.length-1].sharedPrice : 0;
        const sharedInp = tr.querySelector('[data-client="'+cid+'"][data-type="price"]');
        if (sharedInp) sharedInp.value = sharedPrice || '';

        entries.forEach(entry => {
          const sub = entry.subClient || ''; // '' → the "no sub-client" column
          // Resolve effective qty (q) + unit price (u), covering Add-Entry items
          // saved with ONLY an amount (no qty/unitPrice) — show them as 1 × amount.
          let q = entry.qty, u = entry.unitPrice;
          if (q == null && u == null && entry.amount > 0) { q = 1; u = entry.amount; }
          else if (q == null && u && entry.amount) { q = Math.round(entry.amount / u * 100) / 100; }
          else if (q != null && u == null && q > 0)  { u = Math.round(entry.amount / q * 100) / 100; }
          const subqtyInp = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subqty"]');
          if (subqtyInp && q != null) subqtyInp.value = q;
          // Subprice override: only when it differs from the shared price
          if (u != null && u !== sharedPrice) {
            const subpriceInp = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subprice"]');
            if (subpriceInp) subpriceInp.value = u;
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

// SINGLE SOURCE OF TRUTH: the grid is filled straight from saved income entries.
// There is NO draft cache to drift out of sync — edits auto-save (qeAutoSaveCell).
function restoreQEGridData() {
  const table = document.getElementById('qeSpreadsheet');
  if (!table) return;
  loadQEFromState(table);
  // Recompute totals once (skipCol=true → no per-cell autosave/colTotals during load)
  const seen = new Set();
  table.querySelectorAll('[data-type="subqty"],[data-type="qty"]').forEach(inp => {
    const k = inp.dataset.client+'|'+inp.dataset.date;
    if (!seen.has(k)) { seen.add(k); updateQEClientTotal(inp, true); }
  });
  qeRecolorAll(); // day totals + per-client cells + column footers, all from state
}

function reloadQEFromData() {
  renderQEIncome(document.getElementById('qeContent'));
  showToast('✓ Grid reloaded from saved data');
}

// ── Quick Entry AUTO-SAVE engine (no draft, no Save button) ───────
// Each cell edit writes directly to state.income (debounced): create/update when
// qty>0 & price>0, delete (+tombstone) when cleared. This eliminates the whole
// class of draft-drift bugs (ghost cells, notes-without-prices, Add-Entry mismatch).
let _qeSaveTimer = null;
const _qeDirty = new Set(); // "cid|date|sub" cells pending a save
function qeSaveDebounced() {
  clearTimeout(_qeSaveTimer);
  _qeSaveTimer = setTimeout(qeFlushSave, 500);
}
function qeFlushSave() {
  clearTimeout(_qeSaveTimer); _qeSaveTimer = null;
  if (!_qeDirty.size) return;
  _qeDirty.forEach(key => {
    const [cid, ds, sub] = key.split(' ');
    qeWriteCell(cid, ds, sub);
  });
  _qeDirty.clear();
  saveData(); // persists to IndexedDB + schedules cloud push (with tombstones)
}
// Mark a cell (or, for a shared-price change on an agency, all its subclient cells) dirty
function qeScheduleAutoSave(inp) {
  const cid = inp.dataset.client, ds = inp.dataset.date, type = inp.dataset.type;
  const c = clientById(cid);
  const hasSubs = c && (c.subclients||[]).length > 0;
  if (type === 'price' && hasSubs) {
    qeColSubs(c).forEach(s => _qeDirty.add(cid+' '+ds+' '+(s||'').trim()));
  } else {
    _qeDirty.add(cid+' '+ds+' '+(inp.dataset.sub||''));
  }
  qeSaveDebounced();
}
// Read a single cell's inputs from the DOM and upsert/delete its entry in state.income
function qeWriteCell(cid, ds, sub) {
  const tr = document.querySelector('#qeSpreadsheet tr[data-date="'+ds+'"]');
  const c  = clientById(cid);
  if (!tr || !c) return;
  const payType = c.paymentType || qeGridPayType || 'invoice';
  const now = Date.now();
  const hasSubs = (c.subclients||[]).length > 0;
  let qty, effectivePrice, sharedPrice = null, note;
  if (hasSubs) { // agency — `sub` may be '' (the no-subclient column)
    const sq = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subqty"]');
    if (!sq) return; // no such cell rendered for this subclient
    const sp = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subprice"]');
    const sn = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subnote"]');
    const shared = tr.querySelector('[data-client="'+cid+'"][data-type="price"]');
    qty = parseFloat(sq?.value) || 0;
    sharedPrice = parseFloat(shared?.value) || 0;
    effectivePrice = parseFloat(sp?.value) || sharedPrice;
    note = (sn?.value || '').trim();
  } else {
    const qi = tr.querySelector('[data-client="'+cid+'"][data-type="qty"]');
    const pi = tr.querySelector('[data-client="'+cid+'"][data-type="price"]');
    const ni = tr.querySelector('[data-client="'+cid+'"][data-type="subnote"]');
    qty = parseFloat(qi?.value) || 0;
    effectivePrice = parseFloat(pi?.value) || 0;
    note = (ni?.value || '').trim();
    sub = '';
  }
  const xi = state.income.findIndex(e => e.clientId===cid && e.date===ds && (e.subClient||'')===(sub||'') && !e.splitGroupId);
  // A split payment occupies this cell (invoice + cash halves). QE must NOT stack a
  // plain entry on top of it (that inflates income with a phantom) nor delete a half —
  // splits are edited in the Income form.
  const hasSplitHere = state.income.some(e => e.clientId===cid && e.date===ds && (e.subClient||'')===(sub||'') && e.splitGroupId);
  const amount = Math.round(qty * effectivePrice * 100) / 100;
  if (qty > 0 && effectivePrice > 0) {
    const service   = getClientService(cid, sub);
    const vatAmount = payType==='invoice' ? amount*VAT_RATE : 0;
    if (xi >= 0) {
      const prev = state.income[xi];
      const upd = { ...prev, service, amount, qty, unitPrice:effectivePrice, notes:note, vatAmount, paymentType:payType, updatedAt:now };
      if (sharedPrice != null) upd.sharedPrice = sharedPrice; // status preserved
      // Editing a recurring entry's amount makes it a one-off override so it doesn't
      // silently reshape every future month's auto-generated value.
      if (prev.recurring && prev.amount !== amount) upd.oneOff = true;
      state.income[xi] = upd;
    } else {
      if (hasSplitHere) return; // don't create a plain entry over a split payment
      const e = { id:genId(), clientId:cid, subClient:sub||'', service, amount, qty, unitPrice:effectivePrice,
        vatAmount, paymentType:payType, date:ds, status:qeGridStatus, notes:note,
        createdAt:now, updatedAt:now, statusUpdatedAt:now };
      if (sharedPrice != null) e.sharedPrice = sharedPrice;
      state.income.push(e);
      ensureQEClientSelected(cid);
    }
  } else if (xi >= 0 && !state.income[xi].recurring) {
    // qty/price cleared → delete + tombstone. Recurring entries are NOT removed via a
    // QE cell-clear (they would just regenerate next load) — manage them in Monthly.
    addTombstone(state.income[xi].id);
    state.income.splice(xi, 1);
  }
}

// Columns for an agency in Quick Entry = its defined subclients PLUS any subclient
// value that actually appears in its entries this month (so a stray/legacy subclient
// is still shown), PLUS a "no subclient" bucket ('') if any entry has an empty sub.
// This guarantees EVERY entry is visible, so the QE total matches the Income total.
function qeColSubs(c) {
  const defined = (c.subclients||[]).map(s=>(s||'').trim()).filter(Boolean);
  if (!defined.length) return []; // direct client → no subclient columns
  const seen = new Set(defined.map(s=>s.toLowerCase()));
  const extras = []; let hasEmpty = false;
  (state.income||[]).forEach(e=>{
    if (e.clientId!==c.id || !(e.date||'').startsWith(qeGridMonth)) return;
    const sc = (e.subClient||'').trim();
    if (!sc) { hasEmpty = true; return; }
    if (!seen.has(sc.toLowerCase())) { seen.add(sc.toLowerCase()); extras.push(sc); }
  });
  const cols = [...defined, ...extras];
  if (hasEmpty) cols.push(''); // entries with no subclient get their own column
  return cols;
}

function renderQEIncome(cont) {
  // No draft capture — the grid is rebuilt from saved income and edits auto-save.
  if (!qeGridMonth) qeGridMonth = todayVal().slice(0,7);
  const [yr, mo] = qeGridMonth.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const today = todayVal();

  // QE shows clients only (never the Main Job salary pseudo-client)
  const qeEligible = state.clients.filter(c => clientKind(c) !== 'mainjob');
  if (!qeGridSelectedClients.length && qeEligible.length)
    qeGridSelectedClients = qeEligible.slice(0, 6).map(c=>c.id);

  // Seed each shown column's service from existing entries (so titles aren't blank).
  // Columns are controlled ONLY by the user's toggles — adding income for a client
  // auto-selects it (see ensureQEClientSelected), so + Add Entry items still appear,
  // but the user can freely add/remove columns and the grid stays small & fast.
  let _qeSvcChanged = false;
  state.income.forEach(e => {
    if (!e.date || !e.date.startsWith(qeGridMonth)) return;
    const c = clientById(e.clientId);
    if (!c || clientKind(c) === 'mainjob' || !qeGridSelectedClients.includes(c.id)) return;
    if (e.service) {
      const key = e.subClient ? (c.id + '|' + e.subClient) : c.id;
      if (!qeClientServices[key]) { qeClientServices[key] = e.service; _qeSvcChanged = true; }
    }
  });
  if (_qeSvcChanged) saveUIState();

  const selCols = qeEligible.filter(c => qeGridSelectedClients.includes(c.id));

  const moOpts = (()=>{
    const ms = allMonths();
    if (!ms.includes(qeGridMonth)) ms.unshift(qeGridMonth);
    return ms.map(m=>`<option value="${m}" ${m===qeGridMonth?'selected':''}>${monthLabel(m)}</option>`).join('');
  })();

  const clientToggles = qeEligible.map(c=>`
    <label class="qe-client-toggle ${qeGridSelectedClients.includes(c.id)?'active':''}">
      <input type="checkbox" style="display:none" ${qeGridSelectedClients.includes(c.id)?'checked':''}
        onchange="toggleQEGridClient('${c.id}',this.checked)" />
      <span class="qe-ct-dot" style="background:${c.color}"></span>
      <span>${c.name}</span>
    </label>`).join('');

  // For each client: agency gets one column per subclient (qty+subprice) + SharedPrice + Total
  //                  direct gets Qty + Price + Total
  // Augmented subclient columns per agency (defined + any in-use + empty bucket) so
  // every entry is visible and the QE total reconciles with the Income total.
  const colSubsMap = {};
  selCols.forEach(c => { colSubsMap[c.id] = qeColSubs(c); });
  const clientColCount = c => (colSubsMap[c.id]||[]).length > 0 ? (colSubsMap[c.id].length + 2) : 3;

  // Header row 1: client name + service (direct) or client name + default service (agency)
  const hRow1 = selCols.map(c=>{
    const bg = hexToRgba(c.color, 0.09);
    const subs = colSubsMap[c.id]||[];
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
    const subs = colSubsMap[c.id]||[];
    const bg = hexToRgba(c.color, 0.06);
    if (subs.length > 0) {
      return subs.map((s,si)=>{
        const subSvcVal = getClientService(c.id, s).replace(/'/g,'&#39;');
        const bl = si===0 ? 'border-left:2px solid '+c.color+';' : '';
        return '<th class="qe-sh" style="'+bl+' background:'+bg+';vertical-align:top">'
          +'<div>'+(s || '<span style="opacity:.6">— no sub-client</span>')+'</div>'
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
      const subs = colSubsMap[c.id]||[];
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
    <div class="qe-autosave-note"><i class="fa-solid fa-cloud-arrow-up"></i> Everything saves automatically as you type</div>
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
  const now = Date.now();
  entries.forEach(e => { e.status = newStatus; e.updatedAt = now; e.statusUpdatedAt = now; if (newStatus==='Paid') e.paidDate = now; else delete e.paidDate; });
  saveData();
  qeRecolorAll(); // recolour the WHOLE grid from state (day's client cells included)
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
  const nowD = Date.now();
  entries.forEach(e => { e.status = newStatus; e.updatedAt = nowD; e.statusUpdatedAt = nowD; if (newStatus==='Paid') e.paidDate = nowD; else delete e.paidDate; });
  saveData();
  qeRecolorAll(); // recolour the WHOLE grid from state — no partial/stale patching
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
  const nowC = Date.now();
  entries.forEach(e => { e.status = newStatus; e.updatedAt = nowC; e.statusUpdatedAt = nowC; if (newStatus==='Paid') e.paidDate = nowC; else delete e.paidDate; });
  saveData();
  qeRecolorAll(); // recolour the WHOLE grid — every day cell for this client included
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

// THE authoritative QE colourer — recomputes EVERY status colour straight from
// state.income (day totals, per-client-day cells, column footers). Called on
// render AND after every status toggle, so a colour can never go stale / diverge
// from the real status ("orange but actually Paid"). Single source of truth.
function qeRecolorAll() {
  document.querySelectorAll('.qe-td-total[data-date]').forEach(cell => {
    applyQETotalColor(cell, getQERowStatus(cell.dataset.date));
  });
  document.querySelectorAll('.qe-client-total[data-client][data-date]').forEach(ct => {
    const entries = state.income.filter(e => e.clientId===ct.dataset.client && e.date===ct.dataset.date);
    if (!entries.length) { ct.style.color=''; ct.style.fontWeight=''; ct.title=''; return; }
    const isOrange = entries.some(e => e.status === 'Pending');
    ct.style.color      = isOrange ? '#f59e0b' : 'var(--green)';
    ct.style.fontWeight = '700';
    ct.title = isOrange ? 'Pending — tap to mark Paid' : 'Paid — tap to mark Pending';
  });
  updateQEColTotals(); // column footers
}

function updateQEClientTotal(inp, skipCol) {
  // Live total recompute is synchronous; the actual data write is debounced.
  // skipCol = bulk recompute during render → don't trigger a save.
  if (!skipCol) qeScheduleAutoSave(inp);
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
  if (!skipCol) updateQEColTotals();
}

function updateQEColTotals() {
  const table = document.getElementById('qeSpreadsheet');
  if (!table) return;
  let grand = 0;
  table.querySelectorAll('.qe-tf-coltotal').forEach(foot=>{
    const cid = foot.dataset.client;
    let col = 0;
    table.querySelectorAll('.qe-client-total[data-client="'+cid+'"]').forEach(c=>{ col += parseFloat(c.dataset.value)||0; });
    foot.textContent = col > 0 ? fmt(col) : '—';
    grand += col;
    // Colour by saved payment status (single source of truth — no draft)
    const clientStatus = getQEClientStatus(cid);
    if (clientStatus === 'Paid') {
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
  // Persist the note onto its entry (if the cell already has qty+price → entry exists)
  qeScheduleAutoSave(inp);
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
  saveUIState(); // persist the user's column choice
  renderQEIncome(document.getElementById('qeContent'));
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

// ── Expense Quick Entry AUTO-SAVE (no draft, no Save button) ──────
// Each slot edit writes straight to state.expenses (debounced): create when amount>0,
// update in place, delete (+tombstone) when cleared. Recurring expenses are protected.
let _qeExpSaveTimer = null;
const _qeExpDirtySlots = new Set();
function qeExpCellEdit(el) {
  const slotEl = el.closest && el.closest('.qe-exp-slot');
  if (!slotEl) return;
  if (el.dataset.type === 'expnote' && !el.value.trim()) { // hide the empty note input again
    el.style.display = 'none';
    const pen = el.previousElementSibling;
    if (pen && pen.classList.contains('qe-note-pen')) pen.style.display = '';
  }
  updateQEExpDayTotal(slotEl.dataset.date);
  _qeExpDirtySlots.add(slotEl);
  clearTimeout(_qeExpSaveTimer);
  _qeExpSaveTimer = setTimeout(qeExpFlushSave, 500);
}
function qeExpFlushSave() {
  clearTimeout(_qeExpSaveTimer); _qeExpSaveTimer = null;
  if (!_qeExpDirtySlots.size) return;
  let changed = false;
  _qeExpDirtySlots.forEach(slotEl => { if (slotEl.isConnected && qeExpWriteSlot(slotEl)) changed = true; });
  _qeExpDirtySlots.clear();
  if (changed) saveData();
}
function qeExpWriteSlot(slotEl) {
  const ds = slotEl.dataset.date;
  const catSel  = slotEl.querySelector('[data-type="expcategory"]');
  const amtInp  = slotEl.querySelector('[data-type="expamount"]');
  const noteInp = slotEl.querySelector('[data-type="expnote"]');
  const category = catSel ? catSel.value : '';
  const amount   = parseFloat(amtInp && amtInp.value) || 0;
  const note     = ((noteInp && noteInp.value) || '').trim();
  const entryId  = (amtInp && amtInp.dataset.entryId) || '';
  const now = Date.now();
  if (amount > 0) {
    if (entryId) {
      const xi = state.expenses.findIndex(e => e.id === entryId);
      if (xi < 0) return false;
      const prev = state.expenses[xi];
      const upd = { ...prev, category, amount, vendor:note, description:note, notes:note, paymentMethod:qeExpPayMethod, updatedAt:now };
      if (prev.recurring && prev.amount !== amount) upd.oneOff = true; // amount override — keep series intact
      state.expenses[xi] = upd;
      return true;
    }
    const entry = { id:genId(), category, vendor:note, description:note, amount, vatAmount:0,
      paymentMethod:qeExpPayMethod, recurring:false, date:ds, notes:note, createdAt:now, updatedAt:now };
    state.expenses.push(entry);
    sheetsAdd('expense', entry);
    if (amtInp) amtInp.dataset.entryId = entry.id;
    // keep one empty trailing slot available for the next entry
    const cont = slotEl.parentElement;
    if (cont && slotEl === cont.lastElementChild) {
      const si = cont.querySelectorAll('.qe-exp-slot').length;
      cont.insertAdjacentHTML('beforeend', renderQEExpSlotHTML(ds, {id:'',category:'',amount:'',note:''}, si));
    }
    return true;
  } else if (entryId) {
    const ex = state.expenses.find(e => e.id === entryId);
    if (ex && ex.recurring) return false; // don't delete a recurring expense via cell-clear
    addTombstone(entryId);
    state.expenses = state.expenses.filter(e => e.id !== entryId);
    if (amtInp) amtInp.dataset.entryId = '';
    return true;
  }
  return false;
}

function renderQEExpSlotHTML(ds, slot, si) {
  const catOpts = Object.keys(CATEGORY_ICONS).map(cat=>
    '<option value="'+cat+'" '+(slot.category===cat?'selected':'')+'>'+CATEGORY_ICONS[cat]+' '+cat+'</option>'
  ).join('');
  const hasNote = !!slot.note;
  return '<div class="qe-exp-slot" data-date="'+ds+'" data-slot="'+si+'">'
    +'<select class="qe-sp-inp qe-exp-cat" data-type="expcategory" onchange="qeExpCellEdit(this)">'
      +'<option value="">Cat…</option>'+catOpts+'</select>'
    +'<input class="qe-sp-inp qe-exp-amt" type="number" placeholder="—" min="0" step="0.01"'
      +' value="'+(slot.amount||'')+'" data-type="expamount" data-entry-id="'+(slot.id||'')+'"'
      +' oninput="qeExpCellEdit(this)" />'
    +'<button class="qe-note-pen" onclick="toggleSubNote(this)" title="Vendor/Note"'
      +' style="'+(hasNote?'display:none':'')+'"><i class="fa-solid fa-pencil"></i></button>'
    +'<input class="qe-sp-inp qe-sp-subnote" type="text" placeholder="vendor / note…"'
      +' value="'+(slot.note||'')+'" data-type="expnote"'
      +' style="display:'+(hasNote?'block':'none')+'" onblur="qeExpCellEdit(this)" />'
    +'<button class="qe-exp-remove" onclick="removeQEExpSlot(this)" title="Remove"><i class="fa-solid fa-xmark"></i></button>'
  +'</div>';
}

function renderQEExpense(cont) {
  // No draft cache — render straight from saved expenses; each cell edit auto-saves.
  if (!qeGridMonth) qeGridMonth = todayVal().slice(0,7);
  const [yr,mo] = qeGridMonth.split('-').map(Number);
  const daysInMonth = new Date(yr,mo,0).getDate();
  const today = todayVal();
  _qeExpDirtySlots.clear(); // dropping the old DOM — clear stale dirty-slot references

  const moOpts = (()=>{
    const ms = allMonths(); if (!ms.includes(qeGridMonth)) ms.unshift(qeGridMonth);
    return ms.map(m=>`<option value="${m}" ${m===qeGridMonth?'selected':''}>${monthLabel(m)}</option>`).join('');
  })();

  const bodyRows = Array.from({length:daysInMonth},(_,i)=>{
    const day=i+1, ds=qeGridMonth+'-'+String(day).padStart(2,'0'), isToday=ds===today;
    const saved = state.expenses.filter(e=>e.date===ds).map(e=>({
      id:e.id, category:e.category||'', amount:e.amount?String(e.amount):'', note:e.vendor||e.description||e.notes||''
    }));
    const slots = [...saved, {id:'',category:'',amount:'',note:''}];
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
    <div class="qe-autosave-note"><i class="fa-solid fa-cloud-arrow-up"></i> Everything saves automatically as you type</div>`;

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
    const ex = state.expenses.find(e=>e.id===entryId);
    if (ex && ex.recurring) { showToast('Manage recurring expenses in the Monthly tab','error'); return; }
    addTombstone(entryId); // so the deletion propagates and can't resurrect via sync
    state.expenses = state.expenses.filter(e=>e.id!==entryId);
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

function flashRow(tr, type) {
  tr.classList.add('qe-flash-'+type);
  setTimeout(()=>tr.classList.remove('qe-flash-'+type), 600);
}

// Count-up animation when a KPI value changes (e.g. switching month filter).
// Skipped entirely when the user prefers reduced motion.
let _lastKpis = null;
function animateKpiValues(next) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const prev = _lastKpis;
  _lastKpis = next;
  if (reduced || !prev) return;
  const DURATION = 400;
  Object.keys(next).forEach(key => {
    const from = prev[key], to = next[key];
    if (from === to || from === undefined) return;
    const el = document.querySelector(`.kpi-value[data-kpi="${key}"]`);
    if (!el) return;
    const start = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - p, 4); // ease-out-quart
      el.textContent = fmt(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ── RENDER: Dashboard ──────────────────────────────────────────
// dashMonth can be 'all', a year 'YYYY', or a month 'YYYY-MM'
function isDashYear()  { return /^\d{4}$/.test(dashMonth); }
function dashMatch(dateStr) {
  if (dashMonth === 'all') return true;
  if (isDashYear()) return (dateStr||'').slice(0,4) === dashMonth;
  return monthKey(dateStr) === dashMonth;
}
function dashPeriodLabel() {
  if (dashMonth === 'all') return 'All Time';
  if (isDashYear()) return dashMonth;
  return monthLabel(dashMonth);
}

function renderDashboard() {
  renderMonthPills();
  const inc = state.income.filter(e=>dashMatch(e.date));
  const exp = state.expenses.filter(e=>dashMatch(e.date));

  // KPIs
  const collected = inc.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const pending   = inc.filter(e=>e.status!=='Paid').reduce((s,e)=>s+e.amount,0);
  const totalExp  = exp.reduce((s,e)=>s+e.amount,0);
  const netProfit = collected-totalExp;
  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card green kpi-clickable" onclick="goToIncome('Paid')" title="Go to Income · Paid"><div class="kpi-icon"><i class="fa-solid fa-circle-check"></i></div><div class="kpi-label">Collected</div><div class="kpi-value" data-kpi="collected">${fmt(collected)}</div></div>
    <div class="kpi-card amber kpi-clickable" onclick="goToIncome('Pending')" title="Go to Income · Pending"><div class="kpi-icon"><i class="fa-solid fa-clock"></i></div><div class="kpi-label">Pending</div><div class="kpi-value" data-kpi="pending">${fmt(pending)}</div></div>
    <div class="kpi-card red kpi-clickable" onclick="navigate('expenses')" title="Go to Expenses"><div class="kpi-icon"><i class="fa-solid fa-arrow-trend-down"></i></div><div class="kpi-label">Expenses</div><div class="kpi-value" data-kpi="expenses">${fmt(totalExp)}</div></div>
    <div class="kpi-card blue"><div class="kpi-icon"><i class="fa-solid fa-sack-dollar"></i></div><div class="kpi-label">Net Profit</div><div class="kpi-value" data-kpi="profit" style="color:${netProfit>=0?'var(--green)':'var(--red)'}">${fmt(netProfit)}</div></div>`;
  animateKpiValues({ collected, pending, expenses: totalExp, profit: netProfit });

  // Small caption: total income = collected + pending (everything invoiced for the period)
  const totalIncome = collected + pending;
  const ktl = document.getElementById('kpiTotalLine');
  if (ktl) ktl.innerHTML = `<i class="fa-solid fa-coins"></i> <span>Total income for ${dashPeriodLabel()} (collected + pending):</span> <strong>${fmt(totalIncome)}</strong>`;

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

  // ── "Owed to you" — ALL outstanding (Pending) income, NOT period-filtered.
  // Old unpaid invoices matter most, so this deliberately ignores the dashboard scope.
  const owedPanel = document.getElementById('owedPanel');
  if (owedPanel) {
    const pendingAll = state.income.filter(e => e.status !== 'Paid' && e.clientId !== MAINJOB_CLIENT_ID);
    if (!pendingAll.length) {
      owedPanel.style.display = 'none';
    } else {
      const todayD = new Date(todayVal());
      const byCl = {};
      pendingAll.forEach(e => {
        const c = clientById(e.clientId);
        const k = c ? c.id : 'unknown';
        if (!byCl[k]) byCl[k] = { name:c?.name||'Unknown', color:c?.color||'#888', amount:0, count:0, oldest:e.date };
        byCl[k].amount += e.amount; byCl[k].count++;
        if ((e.date||'') < byCl[k].oldest) byCl[k].oldest = e.date;
      });
      const rows = Object.entries(byCl).sort((a,b)=>b[1].amount-a[1].amount);
      const totalOwed = pendingAll.reduce((s,e)=>s+e.amount,0);
      const daysAgo = ds => Math.max(0, Math.round((todayD - new Date(ds)) / 86400000));
      owedPanel.style.display = '';
      owedPanel.className = 'owed-panel' + (owedExpanded ? ' expanded' : ''); // collapsed by default
      owedPanel.innerHTML = `
        <div class="owed-head" onclick="toggleOwedPanel()" title="Tap to ${owedExpanded?'collapse':'expand'}">
          <div class="owed-head-l"><i class="fa-solid fa-hand-holding-dollar"></i><span>Owed to you</span><span class="owed-sub">${pendingAll.length} unpaid · ${rows.length} client${rows.length>1?'s':''}</span></div>
          <div class="owed-head-r"><div class="owed-total">${fmt(totalOwed)}</div><i class="fa-solid fa-chevron-down owed-chevron"></i></div>
        </div>
        <div class="owed-list">${rows.map(([cid,d])=>{
          const age = daysAgo(d.oldest);
          const ageCls = age>=45 ? 'owed-old' : age>=21 ? 'owed-mid' : '';
          return `<div class="owed-row" onclick="goToClientPending('${cid}')" title="See ${esc(d.name)}'s unpaid entries">
            <div class="ov-dot" style="background:${d.color}"></div>
            <div class="owed-name">${esc(d.name)}</div>
            <div class="owed-rmeta"><span class="owed-jobs">${d.count} job${d.count>1?'s':''}</span><span class="owed-age ${ageCls}">oldest ${age}d</span></div>
            <div class="owed-amt">${fmt(d.amount)}</div>
          </div>`;
        }).join('')}</div>`;
    }
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
  if (!months.includes(cur)) months.unshift(cur);
  months.sort((a,b)=>b.localeCompare(a));
  const years = [...new Set(months.map(m=>m.slice(0,4)))].sort((a,b)=>b.localeCompare(a));
  let html = `<button class="month-pill ${dashMonth==='all'?'active':''}" onclick="setDashMonth('all')">All Time</button>`;
  // Year pills — pick a whole year for a yearly summary
  years.forEach(y=>{ html+=`<button class="month-pill month-pill-year ${dashMonth===y?'active':''}" onclick="setDashMonth('${y}')"><i class="fa-solid fa-calendar"></i> ${y}</button>`; });
  // Month pills — only the months of the selected year (keeps the row short);
  // when 'all' or a single month is selected, show every month.
  const monthsToShow = isDashYear() ? months.filter(m=>m.slice(0,4)===dashMonth) : months;
  monthsToShow.forEach(m=>{ html+=`<button class="month-pill ${dashMonth===m?'active':''}" onclick="setDashMonth('${m}')">${monthLabel(m)}</button>`; });
  document.getElementById('monthPills').innerHTML = html;
}

function goToIncome(status) {
  incStatus = status;
  incClient = 'all';
  incMonth  = todayVal().slice(0,7);
  navigate('income');
}
// "Owed to you" dashboard panel — collapsed by default, tap the header to expand.
let owedExpanded = false;
function toggleOwedPanel() {
  owedExpanded = !owedExpanded;
  const p = document.getElementById('owedPanel');
  if (p) {
    p.classList.toggle('expanded', owedExpanded);
    const h = p.querySelector('.owed-head');
    if (h) h.title = 'Tap to ' + (owedExpanded ? 'collapse' : 'expand');
  }
}
// Jump to Income filtered to one client's outstanding (Pending) entries, across ALL months.
function goToClientPending(cid) {
  incStatus = 'Pending';
  incClient = cid;
  incMonth  = 'all';
  saveUIState();
  navigate('income');
}

function setDashMonth(m) { dashMonth=m; saveUIState(); renderDashboard(); }

// ── Statistics ─────────────────────────────────────────────────
function renderStatistics(filteredInc) {
  // Theme-aware chart text/grid colours (light theme needs dark, readable text)
  const _light = (typeof currentTheme === 'function') && currentTheme() === 'light';
  const chartTxt  = _light ? '#44424d' : '#94a3b8';
  const chartGrid = _light ? 'rgba(20,20,40,0.08)' : 'rgba(255,255,255,0.04)';
  // Update period badge
  const badge = document.getElementById('statsPeriodBadge');
  if (badge) {
    if (dashMonth === 'all') {
      badge.textContent = 'All Time';
      badge.className = 'stats-period-badge period-all';
    } else if (isDashYear()) {
      badge.textContent = 'Year · ' + dashMonth;
      badge.className = 'stats-period-badge period-month';
    } else {
      const cur = todayVal().slice(0,7);
      badge.textContent = dashMonth === cur ? 'This Month · ' + monthLabel(dashMonth) : monthLabel(dashMonth);
      badge.className = 'stats-period-badge period-month';
    }
  }
  if (chartByClient) { chartByClient.destroy(); chartByClient=null; }
  if (chartMonthly)  { chartMonthly.destroy();  chartMonthly=null;  }
  if (chartExpCat)   { chartExpCat.destroy();   chartExpCat=null;   }

  if (typeof Chart === 'undefined') return;

  // Re-create a canvas if a previous render replaced it with an empty-state
  // message, otherwise the chart can never come back when data appears
  const ensureCanvas = (wrapId, canvasId) => {
    let cv = document.getElementById(canvasId);
    if (!cv) {
      const wrap = document.getElementById(wrapId);
      if (wrap) { wrap.innerHTML = `<canvas id="${canvasId}"></canvas>`; cv = document.getElementById(canvasId); }
    }
    return cv;
  };

  // Revenue by client doughnut
  const byClient = {};
  (filteredInc||state.income).filter(e=>e.status==='Paid').forEach(e=>{
    const c = clientById(e.clientId);
    const n = c?.name||'Unknown';
    byClient[n] = (byClient[n]||0)+e.amount;
  });
  const cEntries = Object.entries(byClient).sort((a,b)=>b[1]-a[1]);

  const pieCtx = ensureCanvas('chartByClientWrap', 'chartByClient');
  if (pieCtx && cEntries.length === 1) {
    // A one-client doughnut is a full ring with zero information — show the
    // figure directly instead
    const [name, val] = cEntries[0];
    const color = state.clients.find(c=>c.name===name)?.color || 'var(--accent)';
    pieCtx.parentElement.innerHTML = `
      <div class="chart-single">
        <div class="chart-single-dot" style="background:${color}"></div>
        <div class="chart-single-name">${name}</div>
        <div class="chart-single-val">${fmt(val)}</div>
        <div class="chart-single-sub">100% of revenue this period</div>
      </div>`;
  } else if (pieCtx && cEntries.length) {
    chartByClient = new Chart(pieCtx, {
      type:'doughnut',
      data:{
        labels: cEntries.map(([n])=>n),
        datasets:[{ data:cEntries.map(([,v])=>v),
          backgroundColor: cEntries.map(([n])=>state.clients.find(c=>c.name===n)?.color||'#666'),
          borderWidth:2, borderColor:'rgba(255,255,255,0.08)' }]
      },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'right', labels:{ color:chartTxt,font:{size:11,family:'Inter'},padding:8,boxWidth:12 } },
          tooltip:{ callbacks:{ label:ctx=>` ${ctx.label}: ${fmt(ctx.raw)}` } } } }
    });
  } else if (pieCtx) {
    pieCtx.parentElement.innerHTML='<div class="chart-empty">No paid income data yet</div>';
  }

  // Monthly bar chart
  const months = allMonths().slice(0,12).reverse();
  const barCtx = ensureCanvas('chartMonthlyWrap', 'chartMonthly');
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
          x:{ ticks:{color:chartTxt,font:{size:10}}, grid:{color:chartGrid} },
          y:{ ticks:{color:chartTxt,font:{size:10},callback:v=>'€'+(v>=1000?(v/1000).toFixed(1)+'k':v)}, grid:{color:chartGrid} }
        },
        plugins:{ legend:{labels:{color:chartTxt,font:{size:11,family:'Inter'},boxWidth:12}},
          tooltip:{callbacks:{label:ctx=>` ${ctx.dataset.label}: ${fmt(ctx.raw)}`}} }
      }
    });
  } else if (barCtx) {
    barCtx.parentElement.innerHTML='<div class="chart-empty">No monthly data yet</div>';
  }

  // Expenses by category doughnut — respects the dashboard month filter
  const periodSubLabel = dashPeriodLabel();
  const cbcp = document.getElementById('chartByClientPeriod');
  const cecp = document.getElementById('chartExpCatPeriod');
  if (cbcp) cbcp.textContent = periodSubLabel;
  if (cecp) cecp.textContent = periodSubLabel;
  const statExpenses = state.expenses.filter(e => dashMatch(e.date));
  const byCatExp = {};
  statExpenses.forEach(e => { byCatExp[e.category] = (byCatExp[e.category]||0) + e.amount; });
  const catEntries = Object.entries(byCatExp).sort((a,b) => b[1]-a[1]);
  const expCatCtx = ensureCanvas('chartExpCatWrap', 'chartExpCat');
  const catColors = ['#ef4444','#f97316','#f59e0b','#84cc16','#10b981','#06b6d4','#6366f1','#8b5cf6','#ec4899','#64748b'];
  if (expCatCtx && catEntries.length) {
    chartExpCat = new Chart(expCatCtx, {
      type:'doughnut',
      data:{
        labels: catEntries.map(([n])=>n),
        datasets:[{ data: catEntries.map(([,v])=>v),
          backgroundColor: catEntries.map((_,i)=>catColors[i%catColors.length]),
          borderWidth:2, borderColor:'rgba(255,255,255,0.08)' }]
      },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'right', labels:{ color:chartTxt,font:{size:11,family:'Inter'},padding:8,boxWidth:12 } },
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
  const periodLabel = dashPeriodLabel();
  document.getElementById('statsTablesRow').innerHTML = `
    <div class="stats-table-card">
      <div class="stats-table-title"><i class="fa-solid fa-trophy"></i> Top Clients <span class="stats-period-sub">${periodLabel}</span></div>
      ${topClients.length?topClients.map(([n,v],i)=>{
        const c=state.clients.find(cl=>cl.name===n);
        const pct=Math.round((v/maxCl)*100);
        return`<div class="stats-row"><span class="stats-rank">${i+1}</span><div class="stats-dot" style="background:${c?.color||'#888'}"></div><span class="stats-name">${n}</span><div class="stats-bar-wrap"><div class="stats-bar" style="width:${pct}%;background:${c?.color||'var(--green)'}"></div></div><span class="stats-val">${fmt(v)}</span></div>`;
      }).join(''):'<div class="chart-empty">No data</div>'}
    </div>
    <div class="stats-table-card">
      <div class="stats-table-title"><i class="fa-solid fa-star"></i> Top Services <span class="stats-period-sub">${periodLabel}</span></div>
      ${topSvc.length?topSvc.map(([n,v],i)=>{
        const pct=Math.round((v/maxSv)*100);
        return`<div class="stats-row"><span class="stats-rank">${i+1}</span><span class="stats-name">${n}</span><div class="stats-bar-wrap"><div class="stats-bar" style="width:${pct}%;background:var(--accent)"></div></div><span class="stats-val">${fmt(v)}</span></div>`;
      }).join(''):'<div class="chart-empty">No data</div>'}
    </div>
    <div class="stats-table-card">
      <div class="stats-table-title"><i class="fa-solid fa-calendar-star"></i> Best Months <span class="stats-period-sub">All Time</span></div>
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
  updateIncomeBulkBar();
}

function bulkMarkIncome(status) {
  if (!incSelectedIds.size) { showToast('Select entries first','error'); return; }
  const count = incSelectedIds.size;
  pushUndo(`Mark ${count} entr${count===1?'y':'ies'} ${status}`);
  const now = Date.now();
  state.income.forEach(e => {
    if (incSelectedIds.has(e.id)) {
      e.status = status;
      e.updatedAt = now;
      e.statusUpdatedAt = now;
      if (status === 'Paid') e.paidDate = now;
      else delete e.paidDate;
      clearQEDraftForCell(e.clientId, e.date); // keep QE in sync with the new status
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
  incSelectedIds.forEach(id => addTombstone(id));
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

  let entries = [...state.income];
  if (incMonth!=='all')   entries=entries.filter(e=>monthKey(e.date)===incMonth);
  if (incClient!=='all')  entries=entries.filter(e=>e.clientId===incClient);
  if (incStatus!=='all')  entries=entries.filter(e=>e.status===incStatus);
  if (incPayType!=='all') entries=entries.filter(e=>e.paymentType===incPayType);
  entries.sort((a,b)=>b.date.localeCompare(a.date));

  // Grand total of the currently-filtered entries — shown top-right of the view bar
  const incPaidSum = entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const incPendSum = entries.filter(e=>e.status!=='Paid').reduce((s,e)=>s+e.amount,0);
  const incGrand   = incPaidSum + incPendSum;
  const incTotalCls = incPendSum > 0 ? 'amber' : 'green'; // orange when anything's pending, green when all paid
  const totalChip = `<div class="inc-grand" title="Total of the entries shown"><span class="inc-grand-label">Total</span><span class="inc-grand-val ${incTotalCls}">${fmt(incGrand)}</span>${incStatus==='all'&&incPendSum>0?`<span class="inc-grand-sub">${fmt(incPaidSum)} paid · ${fmt(incPendSum)} pending</span>`:''}</div>`;

  const vtInc = (m,icon,label) => `<button class="vtb ${incViewMode===m?'active':''}" title="${label}" onclick="setIncViewMode('${m}')"><i class="fa-solid ${icon}"></i><span class="vtb-label">${label}</span></button>`;
  html += `<div class="view-toggle-bar"><span class="vt-label">View</span><div class="vtb-group">${vtInc('byclient','layer-group','By Client')}${vtInc('excel','table','Excel')}</div><button class="vtb-action ${incBulkMode?'active':''}" onclick="toggleIncBulkMode()" title="Select multiple entries to delete"><i class="fa-solid fa-check-square"></i><span class="vtb-label">${incBulkMode?'Done':'Select'}</span></button><div class="vtb-right"><button class="vtb-add vtb-add-income" onclick="openAddIncome()" title="Add an income entry"><i class="fa-solid fa-plus"></i><span class="vtb-label">Income</span></button>${totalChip}</div></div>`;

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
            ${e.notes?`<span class="ec-note" title="${esc(e.notes)}"><i class="fa-solid fa-note-sticky"></i> ${esc(e.notes)}</span>`:'<span class="ec-note-spacer"></span>'}
            <span class="ec-amount">${fmt(e.amount)}</span>
            ${e.recurring?'<span class="badge monthly mini">MONTHLY</span>':''}
            <span class="badge ${e.paymentType} mini">${e.paymentType==='invoice'?'INV':'CASH'}</span>
            <span class="badge ${sl} mini">${e.status.slice(0,3).toUpperCase()}</span>
            ${eaInc(e.id)}
          </div>`;
        }).join('');
        const grpIds = grp.map(e=>e.id);
        const allChecked = grpIds.every(id=>incSelectedIds.has(id));
        const someChecked = !allChecked && grpIds.some(id=>incSelectedIds.has(id));
        html+=`<div class="byclient-group" data-cid="${cid}">
          <div class="byclient-header" style="border-left:3px solid ${c?.color||'#888'}" onclick="toggleClientGroup('${cid}')">
            ${incBulkMode?`<input type="checkbox" class="bulk-cb bc-select-all-cb" title="Select all for ${c?.name||'client'}" ${allChecked?'checked':''} onclick="selectClientGroup('${cid}',event)" style="width:20px;height:20px;flex-shrink:0;accent-color:var(--accent)">`:'' }
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
            <i class="fa-solid fa-chevron-right bc-chevron"></i>
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
      return `<tr class="xls-row-${sl} ${incBulkMode&&incSelectedIds.has(e.id)?'bulk-selected':''}" data-bulk-id="${e.id}" onclick="${incBulkMode?`toggleSelectIncome('${e.id}',event)`:`openEntryDetail('income','${e.id}')`}">
        <td>${incBulkMode?`<input type="checkbox" class="bulk-cb" data-id="${e.id}" ${incSelectedIds.has(e.id)?'checked':''} onclick="toggleSelectIncome('${e.id}',event)">`:toDateStr(e.date)}</td>
        <td style="color:${c?.color||'var(--text)'}"><strong>${c?.name||'?'}</strong>${e.subClient?`<span class="xls-subclient">${e.subClient}</span>`:''}</td>
        <td>${e.service}${e.recurring?' <span class="badge monthly mini">MONTHLY</span>':''}${e.notes?`<span class="xls-note" title="${esc(e.notes)}"><i class="fa-solid fa-note-sticky"></i> ${esc(e.notes)}</span>`:''}</td>
        <td class="xls-num">${fmt(e.amount)}</td>
        <td><span class="badge ${sl} mini">${e.status}</span></td>
        <td class="xls-actions-cell"><div class="entry-actions" onclick="event.stopPropagation()">${eaInc(e.id).replace('<div class="entry-actions" onclick="event.stopPropagation()">','').replace('</div>','')}</div></td>
      </tr>`;
    }).join('');
    html+=`<div class="excel-wrapper">
      <table class="excel-table excel-minimal" id="incExcelTbl">
        <thead><tr>
          <th>Date</th><th>Client</th><th>Service</th><th class="xls-num">Amount</th><th>Status</th><th style="width:70px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="3" class="xls-foot-label">Total paid / all</td>
          <td class="xls-num xls-foot-val">${fmt(totalPaid)} / ${fmt(totalAll)}</td>
          <td colspan="2"></td>
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

    html += '<div class="simple-list">';
    grp.forEach(e=>{
      const c=clientById(e.clientId); const sl=e.status.toLowerCase();
      html+=`<div class="sl-row ${sl} ${incBulkMode&&incSelectedIds.has(e.id)?'bulk-selected':''}" data-bulk-id="${e.id}" onclick="${incBulkMode?`toggleSelectIncome('${e.id}',event)`:`openEntryDetail('income','${e.id}')`}">
        ${incBulkMode?`<input type="checkbox" class="bulk-cb" data-id="${e.id}" ${incSelectedIds.has(e.id)?'checked':''} onclick="toggleSelectIncome('${e.id}',event)">`:'' }
        <span class="sl-date">${toDateStr(e.date)}</span>
        <span class="sl-client" style="color:${c?.color||'var(--text)'}">${c?.name||'Unknown'}</span>
        ${e.recurring?'<span class="badge monthly mini">MONTHLY</span>':''}
        <span class="sl-amount ${sl}">${fmt(e.amount)}${e.paidDate?`<span class="sl-paiddate">Paid ${toDateStr(new Date(e.paidDate).toISOString().slice(0,10))}</span>`:''}</span>
        ${eaInc(e.id)}
      </div>`;
    });
    html += '</div>';
    html+='</div>';
  });
  cont.innerHTML = html;
  updateIncomeBulkBar();
}

function setIncFilter(t,v){ if(t==='month')incMonth=v; if(t==='client')incClient=v; if(t==='status')incStatus=v; if(t==='paytype')incPayType=v; saveUIState(); renderIncome(); }

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
  let entries = [...state.expenses];
  if (expMonth!=='all')    entries=entries.filter(e=>monthKey(e.date)===expMonth);
  if (expCategory!=='all') entries=entries.filter(e=>e.category===expCategory);
  entries.sort((a,b)=>b.date.localeCompare(a.date));

  // Total of the filtered expenses (same layout as Income: right group, red total)
  const expTotal = entries.reduce((s,e)=>s+e.amount,0);
  const expTotalChip = `<div class="inc-grand" title="Total expenses shown"><span class="inc-grand-label">Total</span><span class="inc-grand-val red">${fmt(expTotal)}</span></div>`;
  const vtExp = (m,icon,label) => `<button class="vtb ${expViewMode===m?'active':''}" title="${label}" onclick="setExpViewMode('${m}')"><i class="fa-solid ${icon}"></i><span class="vtb-label">${label}</span></button>`;
  html += `<div class="view-toggle-bar"><span class="vt-label">View</span><div class="vtb-group">${vtExp('bycategory','layer-group','By Category')}${vtExp('excel','table','Excel')}</div><div class="vtb-right"><button class="vtb-add vtb-add-expense" onclick="openAddExpense()" title="Add an expense"><i class="fa-solid fa-plus"></i><span class="vtb-label">Expense</span></button>${expTotalChip}</div></div>`;

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
            ${e.recurring?'<span class="badge monthly mini">MONTHLY</span>':''}
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
      return `<tr onclick="openEntryDetail('expense','${e.id}')">
        <td>${toDateStr(e.date)}</td>
        <td>${icon} ${e.category||'—'}${e.recurring?' <span class="badge monthly mini">MONTHLY</span>':''}</td>
        <td>${e.vendor||'—'}</td>
        <td class="xls-num" style="color:var(--red)">${fmt(e.amount)}</td>
        <td class="xls-actions-cell"><div class="entry-actions" onclick="event.stopPropagation()">${eaExp(e.id).replace('<div class="entry-actions" onclick="event.stopPropagation()">','').replace('</div>','')}</div></td>
      </tr>`;
    }).join('');
    html+=`<div class="excel-wrapper">
      <table class="excel-table excel-minimal" id="expExcelTbl">
        <thead><tr>
          <th>Date</th><th>Category</th><th>Vendor</th><th class="xls-num">Amount</th><th style="width:70px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="3" class="xls-foot-label">Total</td>
          <td class="xls-num xls-foot-val" style="color:var(--red)">${fmt(totalAll)}</td>
          <td></td>
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

    html += '<div class="simple-list">';
    grp.forEach(e=>{
      const icon=CATEGORY_ICONS[e.category]||'📦';
      const typeLabel = e.vendor || e.category;
      html+=`<div class="sl-row" onclick="openEntryDetail('expense','${e.id}')">
        <span class="sl-date">${toDateStr(e.date)}</span>
        <span class="sl-client"><span class="sl-cat-icon">${icon}</span> ${typeLabel}</span>
        ${e.recurring?'<span class="badge monthly mini">MONTHLY</span>':''}
        <span class="sl-amount" style="color:var(--red)">${fmt(e.amount)}</span>
        ${eaExp(e.id)}
      </div>`;
    });
    html += '</div>';
    html+='</div>';
  });
  cont.innerHTML = html;
}

function setExpFilter(t,v){ if(t==='month')expMonth=v; if(t==='category')expCategory=v; saveUIState(); renderExpenses(); }

// ── RENDER: Clients ────────────────────────────────────────────
function renderClients()     { renderClientCards('clientsGrid',    'client'); }
function renderSideHustles()  { renderClientCards('sideHustlesGrid','sidehustle'); }

function renderClientCards(containerId, kind) {
  const cont = document.getElementById(containerId);
  if (!cont) return;
  cont.innerHTML = '';
  const list = state.clients.filter(c => clientKind(c) === kind);
  if (!list.length) {
    cont.innerHTML = `<div class="ov-empty" style="grid-column:1/-1;padding:30px">${kind==='sidehustle'?'No side hustles yet — tap “Add Side Hustle”.':'No clients yet — tap “Add Client”.'}</div>`;
    return;
  }
  const isSH = kind === 'sidehustle';
  list.forEach(c=>{
    const ci    = state.income.filter(e=>e.clientId===c.id);
    const total = ci.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const card  = document.createElement('div');
    card.className = 'client-card';
    card.onclick = ()=>openClientDetail(c.id);
    const avatarInner = c.image
      ? `<img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : initials(c.name);
    const avatarStyle = c.image ? '' : `background:${c.color}22;color:${c.color};border:2px solid ${c.color}44`;
    const subtitle = isSH
      ? 'Side hustle'
      : `${c.type==='Agency'?`Agency · ${(c.subclients||[]).length} sub-clients`:'Direct Client'} · <span class="client-pay-badge ${c.paymentType||'invoice'}">${c.paymentType==='cash'?'Cash':'Invoice'}</span>`;
    card.innerHTML = `
      <div style="position:absolute;top:0;left:0;right:0;height:4px;background:${c.color};border-radius:16px 16px 0 0;"></div>
      <button class="client-card-edit" onclick="event.stopPropagation();openEditClient('${c.id}')">
        <i class="fa-solid fa-pen"></i>
      </button>
      <div class="client-card-avatar" style="${avatarStyle}">${avatarInner}</div>
      <div class="client-card-name">${c.name}</div>
      <div class="client-card-type">${subtitle}</div>
      <div class="client-card-stats">
        <div class="client-stat"><span class="client-stat-label">Total Earned</span><span class="client-stat-val green">${fmt(total)}</span></div>
        <div class="client-stat"><span class="client-stat-label">${isSH?'Entries':'Jobs'}</span><span class="client-stat-val">${ci.length}</span></div>
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
  // Always rebuild fresh — content is dynamic (months/subclients vary by client)
  const old = document.getElementById('printOptionsDialog');
  if (old) old.remove();

  const isAll = clientId === '__all__';
  const client = isAll ? null : clientById(clientId);
  const clientEntries = isAll ? state.income : state.income.filter(e => e.clientId === clientId);

  // Available months for this client (descending)
  const availMonths = [...new Set(clientEntries.map(e => monthKey(e.date)))].sort().reverse();

  // Available subclients (non-empty, sorted) — only for specific client
  const availSubs = isAll ? [] :
    [...new Set(clientEntries.map(e => e.subClient || '').filter(Boolean))].sort();

  // Init print state
  _printSubMode    = 'separated';
  _printPayFilter  = reportPayFilter || 'all';
  _printStatusFilter = 'all';
  _printMonths     = month ? [month] : null; // pre-select current month if one was chosen
  _printSubClients = null; // all subclients by default

  // ── Month checkboxes ──────────────────────────────────────────
  let monthsHtml = '';
  if (availMonths.length > 1) {
    const allChecked = !_printMonths;
    monthsHtml = `
      <div style="margin-bottom:16px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Months</div>
        <div style="display:flex;flex-direction:column;gap:5px;max-height:150px;overflow-y:auto;padding-right:4px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="printMonthAll" ${allChecked?'checked':''} onchange="togglePrintAllMonths(this)" style="accent-color:var(--accent);width:14px;height:14px" />
            <span style="font-weight:600">All Months</span>
          </label>
          ${availMonths.map(m=>`
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding-left:4px">
            <input type="checkbox" class="print-month-cb" value="${m}"
              ${!_printMonths || _printMonths.includes(m)?'checked':''}
              onchange="updatePrintMonthSel()"
              style="accent-color:var(--accent);width:14px;height:14px" />
            <span>${monthLabel(m)}</span>
          </label>`).join('')}
        </div>
      </div>`;
  }

  // ── Subclient checkboxes ──────────────────────────────────────
  let subsHtml = '';
  if (availSubs.length > 0) {
    subsHtml = `
      <div style="margin-bottom:16px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Sub-Clients</div>
        <div style="display:flex;flex-direction:column;gap:5px;max-height:150px;overflow-y:auto;padding-right:4px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="printSubClientAll" checked onchange="togglePrintAllSubClients(this)" style="accent-color:var(--accent);width:14px;height:14px" />
            <span style="font-weight:600">All Sub-Clients</span>
          </label>
          ${availSubs.map(sc=>`
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding-left:4px">
            <input type="checkbox" class="print-sc-cb" value="${sc}" checked
              onchange="updatePrintSubClientSel()"
              style="accent-color:var(--accent);width:14px;height:14px" />
            <span>${sc}</span>
          </label>`).join('')}
        </div>
      </div>`;
  }

  const metaText = (isAll ? 'All Clients' : (client?.name||'')) + (month ? ' · '+monthLabel(month) : '');

  const dlg = document.createElement('div');
  dlg.id = 'printOptionsDialog';
  dlg.className = 'copy-dialog';
  dlg.dataset.clientId = clientId;
  dlg.dataset.month    = month || '';
  dlg.innerHTML = `
    <h3><i class="fa-solid fa-print"></i> Print Options</h3>
    <p style="margin:0 0 16px;font-size:13px;color:var(--text-muted)">${metaText}</p>
    ${monthsHtml}
    ${subsHtml}
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Sub-client Layout</div>
      <div style="display:flex;gap:8px" id="printSubModeToggle">
        <button class="report-type-tab active" data-mode="separated" onclick="setPrintSubMode('separated')"><i class="fa-solid fa-list-ul"></i> Separated</button>
        <button class="report-type-tab" data-mode="combined" onclick="setPrintSubMode('combined')"><i class="fa-solid fa-layer-group"></i> Combined</button>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Status</div>
      <div style="display:flex;gap:8px" id="printStatusFilterToggle">
        <button class="report-type-tab ${_printStatusFilter==='all'?'active':''}" data-sf="all" onclick="setPrintStatusFilter('all')">Both</button>
        <button class="report-type-tab ${_printStatusFilter==='Paid'?'active':''}" data-sf="Paid" onclick="setPrintStatusFilter('Paid')"><i class="fa-solid fa-circle-check"></i> Paid</button>
        <button class="report-type-tab ${_printStatusFilter==='Pending'?'active':''}" data-sf="Pending" onclick="setPrintStatusFilter('Pending')"><i class="fa-solid fa-clock"></i> Pending</button>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">Payment Filter</div>
      <div style="display:flex;gap:8px" id="printPayFilterToggle">
        <button class="report-type-tab ${_printPayFilter==='all'?'active':''}" data-pf="all" onclick="setPrintPayFilter('all')">All</button>
        <button class="report-type-tab invoice-tab ${_printPayFilter==='invoice'?'active':''}" data-pf="invoice" onclick="setPrintPayFilter('invoice')"><i class="fa-solid fa-file-invoice"></i> Invoice</button>
        <button class="report-type-tab cash-tab ${_printPayFilter==='cash'?'active':''}" data-pf="cash" onclick="setPrintPayFilter('cash')"><i class="fa-solid fa-money-bill"></i> Cash</button>
      </div>
    </div>
    <div class="copy-dialog-btns">
      <button class="btn-cancel" onclick="closePrintOptionsDialog()">Cancel</button>
      <button class="btn-save" style="flex:1;padding:10px" onclick="confirmPrintReport()"><i class="fa-solid fa-print"></i> Print</button>
    </div>`;
  document.body.appendChild(dlg);
  document.getElementById('modalOverlay').addEventListener('click', closePrintOptionsDialog);
  document.getElementById('modalOverlay').classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>dlg.classList.add('open')));
}

function togglePrintAllMonths(cb) {
  document.querySelectorAll('.print-month-cb').forEach(c => c.checked = cb.checked);
  _printMonths = cb.checked ? null : [];
}

function updatePrintMonthSel() {
  const all  = document.querySelectorAll('.print-month-cb');
  const sel  = [...document.querySelectorAll('.print-month-cb:checked')].map(c => c.value);
  _printMonths = sel.length === all.length ? null : sel;
  const allCb = document.getElementById('printMonthAll');
  if (allCb) allCb.checked = sel.length === all.length;
}

function togglePrintAllSubClients(cb) {
  document.querySelectorAll('.print-sc-cb').forEach(c => c.checked = cb.checked);
  _printSubClients = cb.checked ? null : [];
}

function updatePrintSubClientSel() {
  const all = document.querySelectorAll('.print-sc-cb');
  const sel = [...document.querySelectorAll('.print-sc-cb:checked')].map(c => c.value);
  _printSubClients = sel.length === all.length ? null : sel;
  const allCb = document.getElementById('printSubClientAll');
  if (allCb) allCb.checked = sel.length === all.length;
}

function setPrintSubMode(m) {
  _printSubMode = m;
  document.querySelectorAll('#printSubModeToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
}

function setPrintPayFilter(pf) {
  _printPayFilter = pf;
  document.querySelectorAll('#printPayFilterToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.pf===pf));
}

function setPrintStatusFilter(sf) {
  _printStatusFilter = sf;
  document.querySelectorAll('#printStatusFilterToggle .report-type-tab').forEach(b=>b.classList.toggle('active',b.dataset.sf===sf));
}

function closePrintOptionsDialog() {
  const dlg = document.getElementById('printOptionsDialog');
  if (dlg) dlg.classList.remove('open');
  if (!activeSheet) document.getElementById('modalOverlay').classList.add('hidden');
}

function confirmPrintReport() {
  const dlg = document.getElementById('printOptionsDialog');
  if (!dlg) return;
  if (_printMonths !== null && _printMonths.length === 0) { showToast('Select at least one month', 'error'); return; }
  if (_printSubClients !== null && _printSubClients.length === 0) { showToast('Select at least one sub-client', 'error'); return; }
  const clientId = dlg.dataset.clientId;
  closePrintOptionsDialog();
  executePrintReport(clientId, _printMonths, _printSubMode, _printPayFilter, _printSubClients, _printStatusFilter);
}

function executePrintReport(clientId, months, subMode, payFilter, subClients, statusFilter) {
  let entries = clientId==='__all__' ? [...state.income] : state.income.filter(e=>e.clientId===clientId);
  // months: null = all, array = specific months
  if (months && months.length) entries = entries.filter(e => months.includes(monthKey(e.date)));
  // subClients: null = all, array = specific subclients (only for single client)
  if (subClients && clientId !== '__all__') entries = entries.filter(e => subClients.includes(e.subClient || ''));
  if (payFilter!=='all') entries = entries.filter(e=>e.paymentType===payFilter);
  if (statusFilter && statusFilter!=='all') entries = entries.filter(e=>e.status===statusFilter); // Paid-only / Pending-only
  if (!entries.length) { showToast('No entries to print','error'); return; }
  entries.sort((a,b)=>a.date.localeCompare(b.date));

  const isAll = clientId==='__all__';
  const client = isAll ? null : clientById(clientId);
  const title = isAll ? 'All Income' : (client?.name||'Report');
  const statusLabel = statusFilter==='Paid' ? ' — Paid only' : statusFilter==='Pending' ? ' — Pending only' : '';
  const filterLabel = (payFilter==='cash' ? ' — Cash Only' : payFilter==='invoice' ? ' — Invoice / VAT' : '') + statusLabel;
  // Build a readable month string for the PDF header
  const monthStr = !months ? '' :
    months.length === 1 ? ' · '+monthLabel(months[0]) :
    ' · '+monthLabel(months[months.length-1])+' – '+monthLabel(months[0]);
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
  const reportMonth = !months ? 'All Months' :
    months.length === 1 ? monthLabel(months[0]) :
    months.map(m=>monthLabel(m)).join(', ');
  const subClientLabel = subClients ? ' · '+subClients.join(', ') : '';

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
        <div class="rpt-meta">${[reportMonth+subClientLabel, 'Exported '+exportedDate].filter(Boolean).join(' · ')}</div>
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
        e.updatedAt = Date.now();
        e.statusUpdatedAt = Date.now();
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
// ── Monthly (recurring) series helpers ─────────────────────────
// A "series" is the recurring template identified by who+what. Each calendar
// month is a separate entry instance sharing the same series key.
// Firebase keys may NOT contain . $ # [ ] / or control chars. These series keys are
// used as `monthlyStopped` object keys; the old \x00 delimiter (and raw service/vendor
// names that can contain a dot) made Firebase reject the whole PUT with HTTP 400 —
// silently breaking ALL cloud sync the moment a recurring series was stopped. Encode
// them base64url so the key is always Firebase-safe.
function _b64urlEnc(s){ try { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); } catch(_){ return String(s).replace(/[^A-Za-z0-9_-]/g,'_'); } }
function incSeriesKey(e) { return 'k_' + _b64urlEnc('inc\x00' + e.clientId + '\x00' + e.service + '\x00' + (e.subClient||'')); }
function expSeriesKey(e) { return 'k_' + _b64urlEnc('exp\x00' + e.category + '\x00' + e.vendor); }
// Convert any legacy/unsafe monthlyStopped keys to the safe form (idempotent) so a
// push can never 400 on a forbidden key again.
function migrateMonthlyStopped(){
  const ms = state.monthlyStopped; if (!ms || typeof ms !== 'object') return;
  let changed = false; const out = {};
  for (const k in ms){ const nk = k.indexOf('k_')===0 ? k : ('k_' + _b64urlEnc(k)); if (nk!==k) changed = true; out[nk] = ms[k]; }
  if (changed) state.monthlyStopped = out;
}
function seriesKeyOf(kind, e) { return kind==='income' ? incSeriesKey(e) : expSeriesKey(e); }
// A series is "stopped" from month M onward when the user deleted "this + future".
function seriesStoppedFrom(key) { return (state.monthlyStopped && state.monthlyStopped[key]) || null; }
function isSeriesStoppedForMonth(key, month) {
  const from = seriesStoppedFrom(key);
  return from !== null && month >= from;
}

function generateRecurring(silent=false) {
  const currentMonth = todayVal().slice(0,7);
  let generated = 0;

  // Income: template = latest recurring instance that is NOT a one-off override
  const incTemplates = new Map();
  state.income.filter(e=>e.recurring && !e.oneOff).forEach(e=>{
    const k = incSeriesKey(e);
    if (!incTemplates.has(k) || e.date > incTemplates.get(k).date) incTemplates.set(k, e);
  });
  incTemplates.forEach((tmpl, k)=>{
    if (isSeriesStoppedForMonth(k, currentMonth)) return; // series stopped — don't regenerate
    const clientId = tmpl.clientId, service = tmpl.service, subClient = tmpl.subClient||''; // from the template (key is now encoded)
    const exists = state.income.some(e=>
      e.recurring && e.clientId===clientId && e.service===service &&
      (e.subClient||'')===(subClient||'') && monthKey(e.date)===currentMonth
    );
    if (!exists) {
      const entry = { ...tmpl, id:genId(), date:currentMonth+'-01', status:'Pending', subClient:subClient||'', oneOff:false, createdAt:Date.now(), updatedAt:Date.now(), statusUpdatedAt:Date.now() };
      state.income.push(entry);
      sheetsAdd('income', entry);
      generated++;
    }
  });

  // Expenses: template = latest recurring instance that is NOT a one-off override
  const expTemplates = new Map();
  state.expenses.filter(e=>e.recurring && !e.oneOff).forEach(e=>{
    const k = expSeriesKey(e);
    if (!expTemplates.has(k) || e.date > expTemplates.get(k).date) expTemplates.set(k, e);
  });
  expTemplates.forEach((tmpl, k)=>{
    if (isSeriesStoppedForMonth(k, currentMonth)) return;
    const category = tmpl.category, vendor = tmpl.vendor; // from the template (key is now encoded)
    const exists = state.expenses.some(e=>
      e.recurring && e.category===category && e.vendor===vendor && monthKey(e.date)===currentMonth
    );
    if (!exists) {
      const entry = { ...tmpl, id:genId(), date:currentMonth+'-01', oneOff:false, createdAt:Date.now(), updatedAt:Date.now() };
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
    showToast(`All monthly entries already exist for ${monthLabel(currentMonth)}`);
  }
}

// ── RENDER: Monthly (recurring series manager) ─────────────────
// Groups every recurring entry into its series so the user can see each
// monthly item once, drill into per-month instances, and edit/delete with
// scope (this month / this + future / whole series).
function buildSeries() {
  const series = new Map(); // key -> { kind, key, label, sub, instances:[], stoppedFrom }
  state.income.filter(e=>e.recurring).forEach(e=>{
    const key = incSeriesKey(e);
    if (!series.has(key)) {
      const c = clientById(e.clientId);
      series.set(key, { kind:'income', key, clientId:e.clientId,
        label:(c?.name||'Unknown'), color:c?.color||'#888',
        sub:[e.service, e.subClient].filter(Boolean).join(' · '),
        instances:[], stoppedFrom:seriesStoppedFrom(key) });
    }
    series.get(key).instances.push(e);
  });
  state.expenses.filter(e=>e.recurring).forEach(e=>{
    const key = expSeriesKey(e);
    if (!series.has(key)) {
      series.set(key, { kind:'expense', key,
        label:(e.category||'—'), color:'var(--red)',
        sub:e.vendor||'', instances:[], stoppedFrom:seriesStoppedFrom(key) });
    }
    series.get(key).instances.push(e);
  });
  series.forEach(s => s.instances.sort((a,b)=>b.date.localeCompare(a.date)));
  return [...series.values()].sort((a,b)=>{
    if (a.kind!==b.kind) return a.kind==='income'?-1:1;
    return a.label.localeCompare(b.label);
  });
}

let _monthlyExpanded = new Set();
let _monthlySeries = []; // cache so onclick handlers reference series by index
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Handlers reference the series by its index in _monthlySeries — the raw series
// key contains NUL separators and user text that break inside HTML onclick.
function toggleMonthlySeries(idx) {
  const s = _monthlySeries[idx]; if (!s) return;
  if (_monthlyExpanded.has(s.key)) _monthlyExpanded.delete(s.key); else _monthlyExpanded.add(s.key);
  renderMonthly();
}

function renderMonthly() {
  const cont = document.getElementById('monthlyList');
  if (!cont) return;
  const all = buildSeries();
  _monthlySeries = all;
  const incomeSeries = all.filter(s=>s.kind==='income');
  const expenseSeries = all.filter(s=>s.kind==='expense');

  if (!all.length) {
    cont.innerHTML = `<div class="empty-state"><i class="fa-solid fa-rotate"></i><p>No monthly items yet</p><small>Mark an income or expense as “Monthly” when you add it, and it will appear here.</small></div>`;
    return;
  }

  const seriesCard = (s) => {
    const idx = all.indexOf(s);
    const latest = s.instances[0];
    const amount = latest ? latest.amount : 0;
    const months = s.instances.length;
    const expanded = _monthlyExpanded.has(s.key);
    const stopped = s.stoppedFrom !== null;
    const rows = s.instances.map(e=>`
      <div class="monthly-inst">
        <span class="mi-month">${monthLabel(monthKey(e.date))}</span>
        ${s.kind==='income'?`<span class="badge ${e.status.toLowerCase()} mini">${e.status.slice(0,3).toUpperCase()}</span>`:''}
        <span class="mi-amount" style="${s.kind==='expense'?'color:var(--red)':''}">${fmt(e.amount)}</span>
        <button class="mi-act" title="Edit this month" onclick="event.stopPropagation();openEditEntry('${s.kind}','${e.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="mi-act" title="Delete" onclick="event.stopPropagation();monthlyDeletePrompt('${s.kind}','${e.id}')"><i class="fa-solid fa-trash"></i></button>
      </div>`).join('');
    return `
      <div class="monthly-card ${expanded?'expanded':''}">
        <div class="monthly-head" onclick="toggleMonthlySeries(${idx})">
          <span class="monthly-dot" style="background:${s.color}"></span>
          <div class="monthly-titles">
            <div class="monthly-name">${esc(s.label)}${stopped?' <span class="badge mini" style="background:var(--red-light);color:var(--red)">STOPPED</span>':''}</div>
            ${s.sub?`<div class="monthly-sub">${esc(s.sub)}</div>`:''}
          </div>
          <div class="monthly-meta">
            <div class="monthly-amount" style="${s.kind==='expense'?'color:var(--red)':''}">${fmt(amount)}</div>
            <div class="monthly-count">${months} month${months>1?'s':''}</div>
          </div>
          <i class="fa-solid fa-chevron-${expanded?'down':'right'} monthly-chev"></i>
        </div>
        ${expanded?`<div class="monthly-body">
          ${rows}
          <div class="monthly-series-actions">
            <button class="ms-btn" onclick="monthlyEditAmountPrompt(${idx})"><i class="fa-solid fa-pen"></i> Change amount</button>
            ${stopped
              ? `<button class="ms-btn" onclick="monthlyResumeSeries(${idx})"><i class="fa-solid fa-play"></i> Resume monthly</button>`
              : `<button class="ms-btn ms-warn" onclick="monthlyStopSeries(${idx})"><i class="fa-solid fa-stop"></i> Stop monthly</button>`}
            <button class="ms-btn ms-danger" onclick="monthlyDeleteSeries(${idx})"><i class="fa-solid fa-trash"></i> Delete series</button>
          </div>
        </div>`:''}
      </div>`;
  };

  let html = '';
  if (incomeSeries.length) {
    html += `<div class="monthly-section-title"><i class="fa-solid fa-arrow-trend-up" style="color:var(--green)"></i> Monthly Income</div>`;
    html += incomeSeries.map(seriesCard).join('');
  }
  if (expenseSeries.length) {
    html += `<div class="monthly-section-title" style="margin-top:24px"><i class="fa-solid fa-arrow-trend-down" style="color:var(--red)"></i> Monthly Expenses</div>`;
    html += expenseSeries.map(seriesCard).join('');
  }
  cont.innerHTML = html;
}

// Helper: all instances of a series, optionally only those in/after a month
function seriesInstances(kind, key, fromMonth) {
  const arr = kind==='income' ? state.income : state.expenses;
  return arr.filter(e => e.recurring && seriesKeyOf(kind, e) === key &&
    (!fromMonth || monthKey(e.date) >= fromMonth));
}

// ── Delete one monthly instance, with scope choice ─────────────
let _monthlyPending = null; // { kind, id, key, month }
function monthlyDeletePrompt(kind, id) {
  const arr = kind==='income' ? state.income : state.expenses;
  const e = arr.find(x=>x.id===id);
  if (!e) return;
  _monthlyPending = { kind, id, key:seriesKeyOf(kind,e), month:monthKey(e.date) };
  openScopeDialog('delete', monthLabel(monthKey(e.date)));
}

function monthlyEditAmountPrompt(idx) {
  const sObj = _monthlySeries[idx]; if (!sObj) return;
  const kind = sObj.kind, key = sObj.key;
  const insts = seriesInstances(kind, key);
  if (!insts.length) return;
  const latest = insts.sort((a,b)=>b.date.localeCompare(a.date))[0];
  _monthlyPending = { kind, id:latest.id, key, month:monthKey(latest.date), editAmount:true };
  const cur = latest.amount;
  const val = prompt('New monthly amount (€):', cur);
  if (val === null) { _monthlyPending=null; return; }
  const num = parseFloat(val);
  if (isNaN(num) || num < 0) { showToast('Invalid amount','error'); _monthlyPending=null; return; }
  _monthlyPending.newAmount = num;
  openScopeDialog('edit', monthLabel(monthKey(latest.date)));
}

// Scope dialog: this month / this + future / whole series
function openScopeDialog(action, monthLabelStr) {
  const verb = action==='delete' ? 'Delete' : 'Apply change';
  document.getElementById('scopeDialogTitle').textContent = `${verb} — choose scope`;
  document.getElementById('scopeDialogMsg').textContent =
    action==='delete'
      ? `Which months should this deletion affect? (selected: ${monthLabelStr})`
      : `Which months should the new amount apply to? (from: ${monthLabelStr})`;
  document.getElementById('scopeDialog').dataset.action = action;
  document.getElementById('scopeDialog').classList.add('open');
  document.getElementById('modalOverlay').classList.remove('hidden');
}
function closeScopeDialog() {
  document.getElementById('scopeDialog').classList.remove('open');
  document.getElementById('modalOverlay').classList.add('hidden');
  _monthlyPending = null;
}

function applyScope(scope) {
  const p = _monthlyPending;
  const action = document.getElementById('scopeDialog').dataset.action;
  if (!p) { closeScopeDialog(); return; }
  const arr = p.kind==='income' ? state.income : state.expenses;

  if (action === 'delete') {
    pushUndo('Delete monthly entry');
    if (scope === 'this') {
      addTombstone(p.id);
      if (p.kind==='income') state.income = state.income.filter(e=>e.id!==p.id);
      else state.expenses = state.expenses.filter(e=>e.id!==p.id);
    } else if (scope === 'future') {
      // Remove this + all future instances and stop the series from this month
      seriesInstances(p.kind, p.key, p.month).forEach(e=>addTombstone(e.id));
      if (p.kind==='income') state.income = state.income.filter(e=>!(seriesKeyOf('income',e)===p.key && monthKey(e.date)>=p.month));
      else state.expenses = state.expenses.filter(e=>!(seriesKeyOf('expense',e)===p.key && monthKey(e.date)>=p.month));
      state.monthlyStopped[p.key] = p.month;
    } else { // whole series
      seriesInstances(p.kind, p.key).forEach(e=>addTombstone(e.id));
      if (p.kind==='income') state.income = state.income.filter(e=>seriesKeyOf('income',e)!==p.key);
      else state.expenses = state.expenses.filter(e=>seriesKeyOf('expense',e)!==p.key);
      state.monthlyStopped[p.key] = '0000-00'; // never regenerate
    }
    showToast('Monthly entry deleted');
  } else { // edit amount
    const newAmt = p.newAmount;
    const apply = (e) => {
      e.amount = newAmt;
      if (e.paymentType === 'invoice') e.vatAmount = newAmt * VAT_RATE;
      e.updatedAt = Date.now();
    };
    pushUndo('Change monthly amount');
    if (scope === 'this') {
      const e = arr.find(x=>x.id===p.id);
      if (e) { apply(e); e.oneOff = true; } // one-off so future generations ignore it
    } else if (scope === 'future') {
      seriesInstances(p.kind, p.key, p.month).forEach(e=>{ apply(e); e.oneOff=false; });
    } else { // whole series
      seriesInstances(p.kind, p.key).forEach(e=>{ apply(e); e.oneOff=false; });
    }
    showToast('Monthly amount updated');
  }
  saveData();
  closeScopeDialog();
  renderMonthly();
}

function monthlyStopSeries(idx) {
  const sObj = _monthlySeries[idx]; if (!sObj) return;
  if (!confirm('Stop generating this monthly item from now on? Past entries stay; no new months will be created.')) return;
  state.monthlyStopped[sObj.key] = todayVal().slice(0,7);
  saveData();
  renderMonthly();
  showToast('Monthly item stopped');
}
function monthlyResumeSeries(idx) {
  const sObj = _monthlySeries[idx]; if (!sObj) return;
  delete state.monthlyStopped[sObj.key];
  saveData();
  renderMonthly();
  showToast('Monthly item resumed');
}
function monthlyDeleteSeries(idx) {
  const sObj = _monthlySeries[idx]; if (!sObj) return;
  const kind = sObj.kind, key = sObj.key;
  const insts = seriesInstances(kind, key);
  if (!confirm(`Delete this entire monthly series and all its ${insts.length} entr${insts.length===1?'y':'ies'} across every month? This cannot be undone from other devices.`)) return;
  pushUndo('Delete monthly series');
  insts.forEach(e=>addTombstone(e.id));
  if (kind==='income') state.income = state.income.filter(e=>seriesKeyOf('income',e)!==key);
  else state.expenses = state.expenses.filter(e=>seriesKeyOf('expense',e)!==key);
  state.monthlyStopped[key] = '0000-00';
  saveData();
  renderMonthly();
  showToast('Monthly series deleted');
}

// ── Cloud Sync — Firebase Realtime Database ────────────────────
// Works directly from browser, no proxy needed, completely free.
const BLOB_KEY     = 'bm_sync_blob_id';
const FB_URL_KEY    = 'bm_firebase_url';
const FB_APIKEY_KEY = 'bm_firebase_apikey';
const AUTH_KEY      = 'bm_auth_token';
const AUTH_REFRESH  = 'bm_auth_refresh';
const AUTH_EMAIL    = 'bm_auth_email';
const AUTH_UID      = 'bm_auth_uid';
const AUTH_EXPIRY   = 'bm_auth_expiry';

let syncBlobId   = localStorage.getItem(BLOB_KEY)      || '';
const FB_URL_DEFAULT    = 'https://business-mastermind-scrollwise-default-rtdb.europe-west1.firebasedatabase.app/';
const FB_APIKEY_DEFAULT = 'AIzaSyAhj1jDLB1qZ5_M9vadJRNkujBaPVpH0qM';

let fbUrl        = localStorage.getItem(FB_URL_KEY)     || FB_URL_DEFAULT;
let fbApiKey     = localStorage.getItem(FB_APIKEY_KEY)  || FB_APIKEY_DEFAULT;
let authToken    = localStorage.getItem(AUTH_KEY)       || '';
let authRefresh  = localStorage.getItem(AUTH_REFRESH)   || '';
let authEmail    = localStorage.getItem(AUTH_EMAIL)     || '';
let authUid      = localStorage.getItem(AUTH_UID)       || '';
let authExpiry   = parseInt(localStorage.getItem(AUTH_EXPIRY)||'0', 10);
let _autoPushTimer = null;
let _isSyncing  = false;
let _loginMode  = 'signin'; // 'signin' | 'signup'

function fbEndpoint(id) {
  const base = fbUrl.replace(/\/+$/, '') + '/bmsync/' + id + '.json';
  return authToken ? base + '?auth=' + authToken : base;
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

// Fetch wrapper for Firebase: on 401/403 (expired token) refresh the auth
// token and retry once. If it still fails, force re-login so sync never
// silently dies in the background.
let _authPromptShown = false;
async function fbFetch(id, opts) {
  let res = await fetch(fbEndpoint(id), opts);
  if ((res.status === 401 || res.status === 403) && fbApiKey) {
    const ok = await refreshAuthToken();
    if (ok) res = await fetch(fbEndpoint(id), opts);
    if (!ok || res.status === 401 || res.status === 403) {
      // Only force re-login when the token is GENUINELY expired. A 401/403 while
      // the token is still valid is almost always a transient RTDB hiccup or auth
      // rules still propagating right after sign-in — signing out here caused the
      // mobile "connect → instantly kicked back to login" loop.
      const tokenExpired = !authExpiry || authExpiry < Date.now();
      if (tokenExpired && !_authPromptShown) {
        _authPromptShown = true;
        showToast('Session expired — please sign in again', 'error');
        doSignOut();
      }
    }
  }
  return res;
}

function scheduleAutoPush() {
  if (!syncBlobId || !fbUrl) return;
  _pendingPush = true;
  clearTimeout(_autoPushTimer);
  // Push immediately — no delay. emergencyPush is the fallback if app closes first.
  _autoPushTimer = setTimeout(() => autoPush(true), 0);
}

// Merge local + cloud client lists so a PULL never drops a freshly-added client or
// subclient before it has been pushed. Keeps every local client, adds cloud-only
// ones, and for clients on both sides unions the subclients (so neither device's
// additions are lost) while newer scalar fields (name/colour/type) win by updatedAt.
function mergeClients(localList, cloudList, deletedClientIds) {
  const del = new Set(deletedClientIds || []);
  const result = new Map();
  (localList || []).forEach(c => { if (!del.has(c.id)) result.set(c.id, c); }); // keep local, drop tombstoned
  (cloudList || []).forEach(cc => {
    if (del.has(cc.id)) { result.delete(cc.id); return; } // deleted on some device → stays deleted
    const lc = result.get(cc.id);
    if (!lc) { result.set(cc.id, cc); return; } // cloud-only → add
    // Newer updatedAt wins the WHOLE client (incl. its subclient list), so BOTH adding
    // and deleting a subclient propagate. A fresh local edit always out-stamps a stale
    // cloud copy, so a just-added client/subclient is never clobbered by the 15s pull.
    result.set(cc.id, (cc.updatedAt || 0) > (lc.updatedAt || 0) ? cc : lc);
  });
  return [...result.values()];
}

// Merge the current cloud blob into local state BEFORE pushing, so a push can
// never overwrite another device's deletes/edits/additions. This is what stops
// deleted entries from resurrecting: the other device's tombstones are unioned
// in (so the deleted id is excluded) and survive into the pushed payload.
function applyCloudBeforePush(p) {
  if (!p || !Array.isArray(p.clients)) return;
  const allDeleted = new Set([...(state.deletedIds||[]), ...(p.deletedIds||[])]);
  const cloudInc = p.income   || [];
  const cloudExp = p.expenses || [];
  const localIncMap = new Map((state.income   || []).map(e => [e.id, e]));
  const localExpMap = new Map((state.expenses || []).map(e => [e.id, e]));
  const cloudIncIds = new Set(cloudInc.map(e => e.id));
  const cloudExpIds = new Set(cloudExp.map(e => e.id));
  const mergedInc = cloudInc.filter(ce => !allDeleted.has(ce.id))
    .map(ce => { const le = localIncMap.get(ce.id); return le ? mergeIncomeEntry(le, ce) : ce; });
  const mergedExp = cloudExp.filter(ce => !allDeleted.has(ce.id))
    .map(ce => { const le = localExpMap.get(ce.id); if (!le) return ce;
      const a = le.updatedAt||le.createdAt||0, b = ce.updatedAt||ce.createdAt||0; return a > b ? le : ce; });
  const localOnlyInc = (state.income   || []).filter(e => !cloudIncIds.has(e.id) && !allDeleted.has(e.id));
  const localOnlyExp = (state.expenses || []).filter(e => !cloudExpIds.has(e.id) && !allDeleted.has(e.id));
  state.income   = [...mergedInc, ...localOnlyInc];
  state.expenses = [...mergedExp, ...localOnlyExp];
  state.deletedIds = [...allDeleted];
  state.deletedAt  = { ...(p.deletedAt||{}), ...(state.deletedAt||{}) };
  state.monthlyStopped = { ...(p.monthlyStopped||{}), ...(state.monthlyStopped||{}) };
  // Clients: merge (newer-wins per client) honouring client tombstones from both sides
  const allDelClients = new Set([...(state.deletedClientIds||[]), ...(p.deletedClientIds||[])]);
  state.clients = mergeClients(state.clients, p.clients, allDelClients);
  state.deletedClientIds = [...allDelClients];
  state.services = [...new Set([...(state.services||[]), ...(p.services||[])])];
  // Profile: we're pushing local intent, so keep local; adopt cloud only if local has none
  if (!state.profile && p.profile) state.profile = p.profile;
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
    // Pull-merge-before-push (skipped on keepalive/unload where we can't await)
    let _mergeChanged = false;
    if (!keepalive) {
      const beforeSig = (state.income||[]).length + '/' + (state.expenses||[]).length;
      try {
        const gres = await fbFetch(syncBlobId);
        if (gres.ok) { const cloud = await gres.json(); applyCloudBeforePush(cloud); }
      } catch(_) { /* GET failed — fall through to a plain push */ }
      const afterSig = (state.income||[]).length + '/' + (state.expenses||[]).length;
      _mergeChanged = beforeSig !== afterSig;
    }
    // If the merge removed/added entries (e.g. another device's delete), reflect it now
    if (_mergeChanged && !activeSheet) renderView(currentView);
    state.lastModified = Date.now();
    if (!keepalive) idbSet(STORAGE_KEY, state); // persist the merge locally
    const body = JSON.stringify(state);
    const res = await fbFetch(syncBlobId, {
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
    const res = await fbFetch(syncBlobId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    const cloudTs      = p.lastModified || 0;
    const localTs      = state.lastModified || 0;
    const cloudIncome   = p.income   || [];
    const cloudExpenses = p.expenses || [];

    // NEVER skip a pull entirely — the other device may have NEW entries
    // even if its overall timestamp is older (e.g. phone added entries while
    // desktop was also modified). Always merge by ID with per-entry timestamps.

    // Snapshot IDs before merge so we can detect real changes
    const prevIncomeIds = new Set((state.income || []).map(e => e.id));
    const prevExpIds    = new Set((state.expenses || []).map(e => e.id));

    // Build local maps for conflict resolution
    const localIncMap = new Map((state.income   || []).map(e => [e.id, e]));
    const localExpMap = new Map((state.expenses || []).map(e => [e.id, e]));

    // Merge tombstones from both sides so deletions propagate everywhere
    const allDeletedIds = new Set([...(state.deletedIds||[]), ...(p.deletedIds||[])]);
    // Merge tombstone timestamps too so the 1-year prune window stays accurate
    const mergedDeletedAt = { ...(p.deletedAt||{}), ...(state.deletedAt||{}) };
    // Merge monthly "stopped" flags so a series stopped on one device stays stopped
    const mergedStopped = { ...(p.monthlyStopped||{}), ...(state.monthlyStopped||{}) };

    const cloudIncomeIds  = new Set(cloudIncome.map(e => e.id));
    const cloudExpenseIds = new Set(cloudExpenses.map(e => e.id));

    // For entries that exist on BOTH sides: use per-entry updatedAt for conflict
    // resolution (whichever device modified it more recently wins).
    // Entries deleted locally (in tombstone) are never re-added from cloud.
    const mergedIncome = cloudIncome
      .filter(ce => !allDeletedIds.has(ce.id))
      .map(ce => {
        const le = localIncMap.get(ce.id);
        if (!le) return ce; // new on cloud, add it
        return mergeIncomeEntry(le, ce);
      });
    const mergedExpenses = cloudExpenses
      .filter(ce => !allDeletedIds.has(ce.id))
      .map(ce => {
        const le = localExpMap.get(ce.id);
        if (!le) return ce;
        const leTs = le.updatedAt || le.createdAt || 0;
        const ceTs = ce.updatedAt || ce.createdAt || 0;
        return leTs > ceTs ? le : ce;
      });

    // Entries only in local (new additions not yet pushed to cloud), excluding tombstones
    const localOnlyIncome  = (state.income   || []).filter(e => !cloudIncomeIds.has(e.id)  && !allDeletedIds.has(e.id));
    const localOnlyExpense = (state.expenses || []).filter(e => !cloudExpenseIds.has(e.id) && !allDeletedIds.has(e.id));

    const allDelClients = new Set([...(state.deletedClientIds||[]), ...(p.deletedClientIds||[])]);
    state.clients    = mergeClients(state.clients, p.clients, allDelClients); // merge — don't clobber a just-added client/subclient
    state.deletedClientIds = [...allDelClients];
    state.income     = [...mergedIncome,   ...localOnlyIncome];
    state.expenses   = [...mergedExpenses, ...localOnlyExpense];
    state.services   = p.services || [...DEFAULT_SERVICES];
    state.deletedIds = [...allDeletedIds];
    state.deletedAt  = mergedDeletedAt;
    state.monthlyStopped = mergedStopped;
    if (p.profile) state.profile = p.profile; // cloud profile wins if present
    normalizeSubclients(); migrateMonthlyStopped(); // a merged-in cloud blob may carry a stray trailing space
    // Use the newer timestamp
    state.lastModified = Math.max(cloudTs, localTs);
    idbSet(STORAGE_KEY, state);
    // Remove any duplicate recurring entries that crept in via multi-device race
    deduplicateIncome();
    deduplicateExpenses();
    // Push the merged result back if we have local-only entries OR the local state is
    // newer than the cloud (a local edit that never reached the cloud — e.g. a push
    // that failed earlier and was stranded — would otherwise sit locally forever).
    if (localOnlyIncome.length || localOnlyExpense.length || localTs > cloudTs) {
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
    afterSyncProfile();
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
    const res = await fbFetch(syncBlobId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    state.clients  = p.clients;
    state.income   = p.income   || [];
    state.expenses = p.expenses || [];
    state.services = p.services || [...DEFAULT_SERVICES];
    state.deletedClientIds = p.deletedClientIds || [];
    if (p.profile) state.profile = p.profile;
    normalizeSubclients(); migrateMonthlyStopped();
    state.lastModified = p.lastModified || Date.now();
    idbSet(STORAGE_KEY, state);
    deduplicateIncome();
    deduplicateExpenses();
    navigate(currentView);
    afterSyncProfile();
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
  // iOS Safari restores from bfcache without firing focus — pull on pageshow too
  window.addEventListener('pageshow', e => { if (e.persisted) autoPull(true); });
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
    const res = await fbFetch(syncBlobId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    // ALWAYS merge — never blindly overwrite local data
    const cloudIncome   = p.income   || [];
    const cloudExpenses = p.expenses || [];
    // Respect tombstones even on first-load forced pull
    const allDeletedIdsF = new Set([...(state.deletedIds||[]), ...(p.deletedIds||[])]);
    const cloudIncomeIds  = new Set(cloudIncome.map(e => e.id));
    const cloudExpenseIds = new Set(cloudExpenses.map(e => e.id));
    const localIncMapF = new Map((state.income||[]).map(e=>[e.id,e]));
    const filteredCloudIncome   = cloudIncome.filter(e => !allDeletedIdsF.has(e.id))
      .map(ce => { const le = localIncMapF.get(ce.id); return le ? mergeIncomeEntry(le, ce) : ce; });
    const filteredCloudExpenses = cloudExpenses.filter(e => !allDeletedIdsF.has(e.id));
    const localOnlyIncome  = (state.income   || []).filter(e => !cloudIncomeIds.has(e.id)  && !allDeletedIdsF.has(e.id));
    const localOnlyExpense = (state.expenses || []).filter(e => !cloudExpenseIds.has(e.id) && !allDeletedIdsF.has(e.id));
    const allDelClientsF = new Set([...(state.deletedClientIds||[]), ...(p.deletedClientIds||[])]);
    state.clients    = mergeClients(state.clients, p.clients, allDelClientsF); // merge — don't clobber a just-added client/subclient
    state.deletedClientIds = [...allDelClientsF];
    state.income     = [...filteredCloudIncome,   ...localOnlyIncome];
    state.expenses   = [...filteredCloudExpenses, ...localOnlyExpense];
    state.services   = p.services || [...DEFAULT_SERVICES];
    if (p.profile) state.profile = p.profile;
    normalizeSubclients(); migrateMonthlyStopped();
    state.deletedIds = [...allDeletedIdsF];
    state.deletedAt  = { ...(p.deletedAt||{}), ...(state.deletedAt||{}) };
    state.monthlyStopped = { ...(p.monthlyStopped||{}), ...(state.monthlyStopped||{}) };
    const _fLocalNewer = (state.lastModified||0) > (p.lastModified||0); // local has unpushed changes
    state.lastModified = Math.max(p.lastModified || 0, state.lastModified || 0);
    idbSet(STORAGE_KEY, state);
    // Remove any duplicate recurring entries from multi-device race
    deduplicateIncome();
    deduplicateExpenses();
    // Push merged result back if we had local-only entries OR local is newer than cloud
    if (localOnlyIncome.length || localOnlyExpense.length || _fLocalNewer) scheduleAutoPush();
    navigate(currentView);
    afterSyncProfile();
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
  const incRows = [['Date','Client','Sub-Client','Service','Amount (€)','VAT (€)','Total (€)','Status','Payment Type','Notes']];
  [...state.income].sort((a,b)=>b.date.localeCompare(a.date)).forEach(e=>{
    const c = clientById(e.clientId);
    const vat = e.vatAmount||0;
    incRows.push([e.date, c?.name||'?', e.subClient||'', e.service,
      e.amount, vat, e.amount+vat, e.status, e.paymentType==='invoice'?'Invoice':'Cash', e.notes||'']);
  });
  const wsInc = XLSX.utils.aoa_to_sheet(incRows);
  wsInc['!cols'] = [{wch:12},{wch:20},{wch:18},{wch:24},{wch:12},{wch:10},{wch:12},{wch:10},{wch:12},{wch:34}];
  XLSX.utils.book_append_sheet(wb, wsInc, 'Income');

  // ── Sheet 2: Expenses ──────────────────────────────────────────
  const expRows = [['Date','Category','Vendor / Note','Amount (€)','VAT (€)','Payment Method','Recurring']];
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
      normalizeSubclients(); migrateMonthlyStopped();
      saveData(); showToast('Data imported'); navigate(currentView);
    } else showToast('Invalid format','error');
  } catch{ showToast('Could not parse file','error'); } };
  reader.readAsText(file);
  ev.target.value='';
}

// ── Init ───────────────────────────────────────────────────────
// ── Theme switcher ─────────────────────────────────────────────
const THEMES = [
  { id:'dark',   name:'Dark',   bg:'#0b0b16', accent:'#6366f1' },
  { id:'light',  name:'Light',  bg:'#f5f3ef', accent:'#4f46e5' },
  { id:'brown',  name:'Brown',  bg:'#140f0b', accent:'#c9784f' },
  { id:'purple', name:'Purple', bg:'#100a1c', accent:'#a855f7' },
  { id:'teal',   name:'Teal',   bg:'#07171a', accent:'#14b8a6' },
  { id:'gold',   name:'Gold',   bg:'#0b0b10', accent:'#d4a857' },
];
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
function applyTheme(id) {
  if (id === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem('biz_theme', id); } catch(e) {}
  const menu = document.getElementById('themeMenu');
  if (menu) menu.classList.add('hidden');
  // Charts bake in colors at creation time — rebuild the dashboard if it's open
  if (currentView === 'dashboard') renderDashboard();
}
function renderThemeMenu() {
  const menu = document.getElementById('themeMenu');
  if (!menu) return;
  const cur = currentTheme();
  menu.innerHTML = `<div class="theme-menu-title">Theme</div>` + THEMES.map(t => `
    <button class="theme-opt ${t.id===cur?'active':''}" onclick="applyTheme('${t.id}')">
      <span class="theme-swatch" style="background:${t.bg}"><span class="theme-swatch-dot" style="background:${t.accent}"></span></span>
      <span class="theme-opt-name">${t.name}</span>
      ${t.id===cur?'<i class="fa-solid fa-check theme-opt-check"></i>':''}
    </button>`).join('');
}
function toggleThemeMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('themeMenu');
  if (!menu) return;
  const willOpen = menu.classList.contains('hidden');
  renderThemeMenu();
  menu.classList.toggle('hidden', !willOpen);
}

// ── Onboarding / Profile / Main Job ────────────────────────────
let _obSources = { mainJob:false, clients:false, sideHustles:false };
let _obIsSetup = false;

// Show or hide nav items per profile: income-source items (Clients / Side Hustles)
// and user-hidden tabs (chosen in Settings). Dashboard & Settings are always reachable.
// Tabs that only make sense when "Freelance clients" is enabled (client-centric)
const CLIENT_DEPENDENT_TABS = ['services', 'quickentry'];
function tabAllowed(v) {
  const src = (state.profile && state.profile.sources) ? state.profile.sources : { clients:true };
  const hidden = profileHiddenTabs();
  if (CLIENT_DEPENDENT_TABS.includes(v) && !src.clients) return false; // needs freelance clients
  if (hidden.includes(v)) return false;                                // user-hidden
  return true;
}
function applyProfileNav() {
  const src = (state.profile && state.profile.sources) ? state.profile.sources : { clients:true };
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    const v = el.dataset.view;
    let show;
    if (el.dataset.src) show = !!src[el.dataset.src];  // source-driven items (Clients / Side Hustles)
    else show = tabAllowed(v);                          // standard tabs (+ client-dependent rule)
    el.style.display = show ? '' : 'none';
  });
  document.querySelectorAll('.bottom-nav-item[data-view]').forEach(el => {
    el.style.display = tabAllowed(el.dataset.view) ? '' : 'none';
  });
  // If the current view just got hidden, fall back to Dashboard
  const map = { clients:'clients', sidehustles:'sideHustles' };
  const srcHidden = map[currentView] && !src[map[currentView]];
  const tabHidden = !tabAllowed(currentView) && !['dashboard','settings','clients','sidehustles'].includes(currentView);
  if ((srcHidden || tabHidden) && currentView !== 'settings') navigate('dashboard');
}

// After a cloud sync: dismiss the wizard if the pulled profile is onboarded, and refresh nav
function afterSyncProfile() {
  if (state.profile && state.profile.onboarded) {
    document.getElementById('onboardingScreen')?.classList.add('hidden');
  }
  applyProfileNav();
}

// Decide whether to show the first-run wizard. Called after load + after sync.
function decideOnboarding() {
  if (state.profile && state.profile.onboarded) { applyProfileNav(); return; }
  const hasData = (state.income && state.income.length) ||
                  (state.clients && state.clients.some(c => clientKind(c) === 'client'));
  if (hasData) {
    // Existing user with data but no profile → keep Clients on, skip the wizard
    state.profile = { onboarded:true, hiddenTabs:[], sources:{
      clients:true,
      mainJob: state.clients.some(c => c.id === MAINJOB_CLIENT_ID),
      sideHustles: state.clients.some(c => clientKind(c) === 'sidehustle')
    }};
    saveData(); applyProfileNav(); return;
  }
  showOnboarding(false); // genuinely new account
}

function showOnboarding(isSetup) {
  _obIsSetup = !!isSetup;
  const src = (state.profile && state.profile.sources) ? state.profile.sources : { clients:false, mainJob:false, sideHustles:false };
  _obSources = { mainJob:!!src.mainJob, clients:!!src.clients, sideHustles:!!src.sideHustles };
  ['mainJob','clients','sideHustles'].forEach(obReflect);
  document.getElementById('obSalaryGroup').classList.toggle('hidden', !_obSources.mainJob);
  document.getElementById('obSalaryAmount').value = isSetup ? (currentSalary() || '') : '';
  document.getElementById('obTitle').textContent = isSetup ? 'Your sections' : "Let's set up Mastermind";
  document.getElementById('obSub').textContent = isSetup
    ? 'Turn sections on or off anytime. Existing data is never deleted.'
    : 'What do you want to track? Pick everything that applies — you can change this anytime.';
  document.getElementById('obFinishBtn').innerHTML = isSetup ? '<i class="fa-solid fa-check"></i> Save' : '<i class="fa-solid fa-check"></i> Get started';
  document.getElementById('onboardingScreen').classList.remove('hidden');
}

function obReflect(k) {
  const id = k==='mainJob'?'obOptMainJob':k==='clients'?'obOptClients':'obOptSideHustles';
  document.getElementById(id)?.classList.toggle('selected', !!_obSources[k]);
}
function obToggleSource(k) {
  _obSources[k] = !_obSources[k];
  obReflect(k);
  if (k === 'mainJob') document.getElementById('obSalaryGroup').classList.toggle('hidden', !_obSources.mainJob);
}

function obFinish() {
  if (!_obSources.mainJob && !_obSources.clients && !_obSources.sideHustles) _obSources.clients = true;
  state.profile = state.profile || defaultProfile();
  state.profile.onboarded = true;
  state.profile.sources = { mainJob:_obSources.mainJob, clients:_obSources.clients, sideHustles:_obSources.sideHustles };
  if (_obSources.mainJob) {
    const amt = parseFloat(document.getElementById('obSalaryAmount').value);
    if (amt && amt > 0) setSalary(amt); else ensureMainJobClient();
  }
  saveData();
  document.getElementById('onboardingScreen').classList.add('hidden');
  applyProfileNav();
  if (_obIsSetup) {
    renderView(currentView);
    showToast('✓ Sections updated');
  } else {
    navigate('dashboard');
    showGuide(); // first-run walkthrough
  }
}
function openSetup() { closeMobileSidebar(); showOnboarding(true); }

// ── First-run quick-start guide ────────────────────────────────
const GUIDE_STEPS = [
  { icon:'fa-plus',          color:'var(--accent)',     title:'Add entries fast',  text:'Tap “+ Add Entry” (top-right) to log income or an expense in seconds.' },
  { icon:'fa-table-cells',   color:'var(--green)',      title:'Quick Entry grid',  text:'A spreadsheet to log lots of days & clients at once — great for busy weeks.' },
  { icon:'fa-calendar-days', color:'var(--blue)',       title:'Calendar',          text:'See every income & expense by day, with monthly totals.' },
  { icon:'fa-circle-check',  color:'var(--amber)',      title:'Paid / Pending',    text:'Tap an entry to mark it Paid or Pending and track what you’re still owed.' },
  { icon:'fa-gear',          color:'var(--text-muted)', title:'Settings',          text:'Turn sections on/off, set your salary, change theme, back up your data.' },
];
function renderGuideSteps() {
  const el = document.getElementById('guideSteps'); if (!el) return;
  el.innerHTML = GUIDE_STEPS.map(s => `
    <div class="guide-step">
      <div class="guide-step-icon" style="color:${s.color}"><i class="fa-solid ${s.icon}"></i></div>
      <div class="guide-step-body"><div class="guide-step-title">${s.title}</div><div class="guide-step-text">${s.text}</div></div>
    </div>`).join('');
}
function showGuide()  { renderGuideSteps(); closeMobileSidebar(); document.getElementById('guideScreen').classList.remove('hidden'); }
function closeGuide() { document.getElementById('guideScreen').classList.add('hidden'); }

// ── Settings view (sources, salary, tab visibility) ────────────
function toggleSource(key) {
  if (!state.profile) state.profile = defaultProfile();
  if (!state.profile.sources) state.profile.sources = { clients:true, mainJob:false, sideHustles:false };
  state.profile.sources[key] = !state.profile.sources[key];
  if (key === 'mainJob' && state.profile.sources.mainJob) ensureMainJobClient();
  saveData();
  applyProfileNav();
  renderSettings();
}
function toggleTabVisible(view) {
  if (!state.profile) state.profile = defaultProfile();
  if (!Array.isArray(state.profile.hiddenTabs)) state.profile.hiddenTabs = [];
  const i = state.profile.hiddenTabs.indexOf(view);
  if (i >= 0) state.profile.hiddenTabs.splice(i, 1); else state.profile.hiddenTabs.push(view);
  saveData();
  applyProfileNav();
  renderSettings();
}
function renderSettings() {
  const cont = document.getElementById('settingsContent');
  if (!cont) return;
  const src = (state.profile && state.profile.sources) ? state.profile.sources : { clients:true, mainJob:false, sideHustles:false };
  const hidden = profileHiddenTabs();
  const sw = (on, fn) => `<span class="set-switch ${on?'on':''}" onclick="${fn}"><span class="set-knob"></span></span>`;
  const srcRow = (key, label, desc, color, icon) => `
    <div class="set-toggle-row">
      <div class="set-row-icon" style="color:${color}"><i class="fa-solid ${icon}"></i></div>
      <div class="set-row-body"><div class="set-row-title">${label}</div><div class="set-row-desc">${desc}</div></div>
      ${sw(!!src[key], `toggleSource('${key}')`)}
    </div>`;
  let html = `<div class="section-title">Income sources</div>
    <div class="set-card">
      ${srcRow('mainJob','Salary / main job','A recurring monthly salary','var(--blue)','fa-id-badge')}
      ${srcRow('clients','Freelance clients','Clients & agencies you invoice','var(--green)','fa-users')}
      ${srcRow('sideHustles','Side hustles','Other income streams','var(--accent-hover)','fa-rocket')}
    </div>`;
  if (src.mainJob) {
    html += `<div class="section-title" style="margin-top:26px">Main job salary</div><div id="mainJobContent"></div>`;
  }
  // Client-centric tabs (Services / Quick Entry) only appear here when freelance clients are on
  const tabsToShow = TOGGLEABLE_TABS.filter(t => !(CLIENT_DEPENDENT_TABS.includes(t.view) && !src.clients));
  html += `<div class="section-title" style="margin-top:26px">Visible tabs</div>
    <p class="monthly-help" style="margin-bottom:12px">Choose what shows in the left menu. Dashboard & Settings are always available.${!src.clients?' Services & Quick Entry appear once you enable Freelance clients.':''}</p>
    <div class="set-card">` +
    tabsToShow.map(t => `
      <div class="set-toggle-row">
        <div class="set-row-body"><div class="set-row-title">${t.label}</div></div>
        ${sw(!hidden.includes(t.view), `toggleTabVisible('${t.view}')`)}
      </div>`).join('') +
    `</div>`;
  // Appearance
  html += `<div class="section-title" style="margin-top:26px">Appearance</div>
    <div class="set-card" style="padding:14px"><div class="set-theme-row">` +
    THEMES.map(t => `<button class="set-theme-swatch ${currentTheme()===t.id?'active':''}" onclick="applyTheme('${t.id}');renderSettings()">
        <span class="sts-chip" style="background:${t.bg}"><span style="background:${t.accent}"></span></span>${t.name}</button>`).join('') +
    `</div></div>`;
  // Data & backup
  html += `<div class="section-title" style="margin-top:26px">Data &amp; backup</div>
    <div class="set-actions">
      <button class="set-action-btn" onclick="openSyncModal()"><i class="fa-solid fa-cloud"></i> Cloud Sync</button>
      <button class="set-action-btn" onclick="exportAllToExcel()"><i class="fa-solid fa-file-excel"></i> Export Excel</button>
      <button class="set-action-btn" onclick="exportData()"><i class="fa-solid fa-download"></i> Backup (JSON)</button>
      <button class="set-action-btn" onclick="document.getElementById('importFile').click()"><i class="fa-solid fa-upload"></i> Restore (JSON)</button>
    </div>`;
  // Help & account
  html += `<div class="section-title" style="margin-top:26px">Help &amp; account</div>
    <div class="set-actions">
      <button class="set-action-btn" onclick="showGuide()"><i class="fa-solid fa-circle-question"></i> Quick-start guide</button>
      <button class="set-action-btn" onclick="openSetup()"><i class="fa-solid fa-wand-magic-sparkles"></i> Re-run setup</button>
    </div>`;
  if (typeof authEmail !== 'undefined' && authEmail) {
    html += `<div class="set-account"><span class="set-account-email"><i class="fa-solid fa-user"></i> ${authEmail}</span>
      <button class="set-action-btn danger" onclick="doSignOut()"><i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out</button></div>`;
  }
  cont.innerHTML = html;
  if (src.mainJob) renderMainJob(); // fills #mainJobContent inside Settings
}

// ── Calendar view (income + expenses by day) ───────────────────
let calMonth = todayVal().slice(0,7);
function calShift(delta) {
  const [y,m] = calMonth.split('-').map(Number);
  const d = new Date(y, m-1+delta, 1);
  calMonth = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  renderCalendar();
}
function renderCalendar() {
  const cont = document.getElementById('calendarContent');
  if (!cont) return;
  const [yr, mo] = calMonth.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const firstDow = (new Date(yr, mo-1, 1).getDay() + 6) % 7; // Mon=0 … Sun=6
  const today = todayVal();
  // aggregate per day
  const inc = {}, exp = {};
  state.income.forEach(e => { const d = (e.date||'').slice(0,10); if (d.startsWith(calMonth)) inc[d] = (inc[d]||0) + (e.amount||0); });
  state.expenses.forEach(e => { const d = (e.date||'').slice(0,10); if (d.startsWith(calMonth)) exp[d] = (exp[d]||0) + (e.amount||0); });
  const monthInc = Object.values(inc).reduce((s,v)=>s+v,0);
  const monthExp = Object.values(exp).reduce((s,v)=>s+v,0);

  const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="cal-dow">${d}</div>`).join('');
  let cells = '';
  for (let i=0;i<firstDow;i++) cells += `<div class="cal-cell cal-empty"></div>`;
  for (let day=1; day<=daysInMonth; day++) {
    const ds = calMonth + '-' + String(day).padStart(2,'0');
    const i = inc[ds]||0, x = exp[ds]||0;
    cells += `<div class="cal-cell${ds===today?' cal-today':''}${(i||x)?' cal-has':''}" onclick="calOpenDay('${ds}')">
      <div class="cal-daynum">${day}</div>
      <div class="cal-amts">
        ${i?`<span class="cal-inc">+${fmtShort(i)}</span>`:''}
        ${x?`<span class="cal-exp">−${fmtShort(x)}</span>`:''}
      </div>
    </div>`;
  }
  cont.innerHTML = `
    <div class="cal-head">
      <button class="cal-nav" onclick="calShift(-1)"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="cal-month">${monthLabel(calMonth)}</div>
      <button class="cal-nav" onclick="calShift(1)"><i class="fa-solid fa-chevron-right"></i></button>
    </div>
    <div class="cal-summary">
      <span class="cal-sum-inc">Income ${fmt(monthInc)}</span>
      <span class="cal-sum-exp">Expenses ${fmt(monthExp)}</span>
      <span class="cal-sum-net">Net ${fmt(monthInc-monthExp)}</span>
    </div>
    <div class="cal-grid cal-dows">${dow}</div>
    <div class="cal-grid cal-days">${cells}</div>
    <div id="calDayPanel"></div>`;
}
function fmtShort(n) {
  const v = Math.abs(Number(n)||0);
  if (v >= 1000) return '€' + (v/1000).toFixed(v%1000===0?0:1) + 'k';
  return '€' + Math.round(v);
}
function calOpenDay(ds) {
  const incE = state.income.filter(e => (e.date||'').slice(0,10) === ds);
  const expE = state.expenses.filter(e => (e.date||'').slice(0,10) === ds);
  const panel = document.getElementById('calDayPanel');
  if (!panel) return;
  if (!incE.length && !expE.length) { panel.innerHTML = `<div class="cal-day-panel"><div class="cal-day-title">${toDateStr(ds)} ${ds.slice(0,4)}</div><div class="ov-empty">Nothing on this day</div></div>`; return; }
  // Rich row: client (+ subclient), then service · note underneath, amount coloured by status
  const incRow = (e) => {
    const c = clientById(e.clientId);
    const stCls = e.status === 'Paid' ? 'green' : 'amber';
    const sub = e.subClient ? ` <em class="cdr-sub">· ${esc(e.subClient)}</em>` : '';
    const meta = [e.service, e.notes].filter(Boolean).map(esc).join('  ·  ');
    return `<div class="cal-day-row cal-day-row-rich" onclick="openEntryDetail('income','${e.id}')">
      <div class="cdr-main"><span class="cal-day-name">${esc(c?.name||'Income')}${sub}</span>${meta?`<span class="cdr-meta">${meta}</span>`:''}</div>
      <span class="cal-day-amt ${stCls}">${fmt(e.amount)}</span></div>`;
  };
  const expRow = (e) => {
    const note = e.vendor || e.notes || e.description || '';
    const meta = [e.category, note].filter(Boolean).map(esc).join('  ·  ');
    return `<div class="cal-day-row cal-day-row-rich" onclick="openEntryDetail('expense','${e.id}')">
      <div class="cdr-main"><span class="cal-day-name">${esc(e.category||'Expense')}</span>${note?`<span class="cdr-meta">${esc(note)}</span>`:''}</div>
      <span class="cal-day-amt red">-${fmt(e.amount)}</span></div>`;
  };
  let html = `<div class="cal-day-panel"><div class="cal-day-title">${toDateStr(ds)} ${ds.slice(0,4)}</div>`;
  incE.forEach(e => { html += incRow(e); });
  expE.forEach(e => { html += expRow(e); });
  html += `</div>`;
  panel.innerHTML = html;
}

// ── Main Job salary ────────────────────────────────────────────
function getMainJobClient() { return state.clients.find(c => c.id === MAINJOB_CLIENT_ID); }
function ensureMainJobClient() {
  let c = getMainJobClient();
  if (!c) {
    c = { id:MAINJOB_CLIENT_ID, name:'Main Job', type:'Direct', color:'#3b82f6', subclients:[], paymentType:'cash', kind:'mainjob' };
    state.clients.push(c);
  }
  return c;
}
function mainJobIncome() { return state.income.filter(e => e.clientId === MAINJOB_CLIENT_ID); }
function currentSalary() {
  const recs = mainJobIncome().filter(e => e.recurring && !e.oneOff).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  return recs.length ? recs[0].amount : (mainJobIncome().slice(-1)[0]?.amount || 0);
}
// Set/update the monthly salary — current month becomes the recurring template;
// generateRecurring then auto-adds future months from it.
function setSalary(amount) {
  amount = parseFloat(amount) || 0;
  if (amount <= 0) return;
  ensureMainJobClient();
  const m = todayVal().slice(0,7);
  const now = Date.now();
  let e = state.income.find(x => x.clientId === MAINJOB_CLIENT_ID && monthKey(x.date) === m);
  if (e) { e.amount = amount; e.recurring = true; e.oneOff = false; e.service = 'Salary'; e.updatedAt = now; }
  else {
    state.income.push({ id:genId(), clientId:MAINJOB_CLIENT_ID, subClient:'', service:'Salary',
      amount, vatAmount:0, paymentType:'cash', date:m+'-01', status:'Pending', recurring:true,
      source:'mainjob', createdAt:now, updatedAt:now, statusUpdatedAt:now });
  }
  saveData();
}
function promptSalary() {
  const cur = currentSalary();
  const v = prompt('Monthly net salary (€):', cur > 0 ? String(cur) : '');
  if (v === null) return;
  const amt = parseFloat(v);
  if (!amt || amt <= 0) { showToast('Enter a valid amount','error'); return; }
  setSalary(amt);
  showToast('✓ Salary updated');
  renderMainJob();
}
// Generic single-entry status flip (used by Main Job months)
function toggleEntryStatus(id) {
  const e = state.income.find(x => x.id === id); if (!e) return;
  const ns = e.status === 'Paid' ? 'Pending' : 'Paid';
  const now = Date.now();
  e.status = ns; e.updatedAt = now; e.statusUpdatedAt = now;
  if (ns === 'Paid') e.paidDate = now; else delete e.paidDate;
  saveData(); renderView(currentView);
  showToast(ns === 'Paid' ? '✓ Marked Paid' : '⏳ Marked Pending');
}

function renderMainJob() {
  const cont = document.getElementById('mainJobContent');
  if (!cont) return;
  const sal = currentSalary();
  const entries = mainJobIncome().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const yr = todayVal().slice(0,4);
  const collected = entries.filter(e=>e.status==='Paid'   && (e.date||'').startsWith(yr)).reduce((s,e)=>s+e.amount,0);
  const pending   = entries.filter(e=>e.status!=='Paid'  && (e.date||'').startsWith(yr)).reduce((s,e)=>s+e.amount,0);
  let html = `<div class="mj-salary-card">
      <div>
        <div class="mj-salary-label">Monthly salary</div>
        <div class="mj-salary-amount">${fmt(sal)}</div>
      </div>
      <button class="btn-add-client" onclick="promptSalary()"><i class="fa-solid fa-pen"></i> ${sal>0?'Change':'Set salary'}</button>
    </div>
    <div class="mj-stats">
      <div class="mj-stat"><span>Collected ${yr}</span><strong class="green">${fmt(collected)}</strong></div>
      <div class="mj-stat"><span>Pending ${yr}</span><strong class="amber">${fmt(pending)}</strong></div>
    </div>
    <div class="section-title" style="margin-top:24px;margin-bottom:12px">Months</div>`;
  if (!entries.length) {
    html += `<div class="ov-empty" style="padding:24px">No salary entries yet — set your monthly salary above and it will repeat automatically each month.</div>`;
  } else {
    html += `<div class="mj-months">` + entries.map(e=>{
      const sl = e.status.toLowerCase();
      return `<div class="mj-month-row">
        <span class="mj-month-name">${monthLabel(monthKey(e.date))}</span>
        <span class="mj-month-amt">${fmt(e.amount)}</span>
        <button class="mj-status-btn ${sl}" onclick="toggleEntryStatus('${e.id}')"><i class="fa-solid fa-${sl==='paid'?'circle-check':'clock'}"></i> ${e.status}</button>
      </div>`;
    }).join('') + `</div>`;
  }
  cont.innerHTML = html;
}

async function init() {
  await loadData();
  // One-time cleanup: an earlier bug kept pushing clients into the Quick Entry
  // column selection every render, bloating both the column list and the draft
  // cache and causing heavy lag (an unresponsive grid). Reset both once so the
  // grid starts small & fast; the user re-picks columns via the toggles.
  if (!localStorage.getItem('biz_qe_reset_v3')) {
    qeGridSelectedClients = [];
    qeGridData = {};
    try { idbSet(QE_GRID_KEY, {}); } catch(_) {}
    try { localStorage.setItem('biz_qe_reset_v3', '1'); } catch(_) {}
    saveUIState();
  }
  // v4: clear ONLY the draft cache (not the column choices). The draft could hold
  // "ghost" values of entries that were deleted (e.g. duplicates removed) and keep
  // showing them in the grid. Rebuilding from saved entries fixes it on every device.
  if (!localStorage.getItem('biz_qe_reset_v4')) {
    qeGridData = {};
    try { idbSet(QE_GRID_KEY, {}); } catch(_) {}
    try { localStorage.setItem('biz_qe_reset_v4', '1'); } catch(_) {}
  }
  // Always start income/expense tabs on current month (override UIState)
  incMonth  = todayVal().slice(0,7);
  expMonth  = todayVal().slice(0,7);
  generateRecurring(true); // auto-generate on load, silent if nothing new
  updateServicesDatalist();
  document.getElementById('incomeDate').value  = todayVal();
  document.getElementById('expenseDate').value = todayVal();
  updateIncomeDateDisplay();
  updateExpDateDisplay();

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

  // Close theme menu on outside click
  document.addEventListener('click', e=>{
    if (!e.target.closest('#themeMenu') && !e.target.closest('.topbar-theme-btn')) {
      const tm = document.getElementById('themeMenu');
      if (tm) tm.classList.add('hidden');
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

  // Power-user shortcuts: N = new entry, / = search, Esc = close sheet
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activeSheet) { closeAllModals(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
    if (activeSheet) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openAddPicker(); }
    else if (e.key === '/') {
      e.preventDefault();
      const s = document.getElementById('globalSearch');
      if (s) s.focus();
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
      // Pin bottom nav above keyboard (skip while a sheet is open — it's hidden then)
      const nav = document.querySelector('.bottom-nav');
      if (nav && !document.body.classList.contains('sheet-open')) {
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
  // First-run wizard / nav visibility per profile
  decideOnboarding();
  // Start auto-sync (will pull from cloud and re-render only if cloud data is newer)
  startAutoSync();
  // Safety net: re-render after 300ms in case any async op clobbered the first render
  setTimeout(() => renderView(currentView), 300);
}

// ── Firebase Authentication ─────────────────────────────────────
const SEEN_LANDING_KEY = 'bm_seen_landing';

function showLoginScreen() {
  // First-time visitor → show the landing page instead of the bare login form
  if (!localStorage.getItem(SEEN_LANDING_KEY)) { showLanding(); return; }
  const ls = document.getElementById('loginScreen');
  if (ls) ls.classList.remove('hidden');
  // Pre-fill config if already set
  const u = document.getElementById('loginFbUrl');
  const k = document.getElementById('loginApiKey');
  if (u && fbUrl) u.value = fbUrl;
  if (k && fbApiKey) k.value = fbApiKey;
}

function showLanding() {
  const l = document.getElementById('landingScreen');
  if (l) l.classList.remove('hidden');
}
function hideLanding() {
  const l = document.getElementById('landingScreen');
  if (l) l.classList.add('hidden');
}
// From the landing, go to the login form in the requested mode (signin/signup)
function enterLoginFromLanding(mode) {
  localStorage.setItem(SEEN_LANDING_KEY, '1');
  hideLanding();
  const ls = document.getElementById('loginScreen');
  if (ls) ls.classList.remove('hidden');
  if (mode === 'signup' && _loginMode !== 'signup') toggleLoginMode();
  if (mode === 'signin' && _loginMode !== 'signin') toggleLoginMode();
  const u = document.getElementById('loginFbUrl');
  const k = document.getElementById('loginApiKey');
  if (u && fbUrl) u.value = fbUrl;
  if (k && fbApiKey) k.value = fbApiKey;
}
// Link on the login form back to the landing
function backToLanding() {
  hideLoginScreen();
  showLanding();
}

function hideLoginScreen() {
  const ls = document.getElementById('loginScreen');
  if (ls) ls.classList.add('hidden');
}

function setLoginError(msg) {
  const el = document.getElementById('loginError');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); }
}

function toggleLoginMode() {
  _loginMode = _loginMode === 'signin' ? 'signup' : 'signin';
  const btn  = document.getElementById('loginBtn');
  const txt  = document.getElementById('loginToggleText');
  const tog  = document.getElementById('loginToggleBtn');
  if (_loginMode === 'signup') {
    if (btn)  btn.innerHTML  = '<i class="fa-solid fa-user-plus"></i> Create Account';
    if (txt)  txt.textContent = 'Already have an account?';
    if (tog)  tog.textContent = 'Sign In';
  } else {
    if (btn)  btn.innerHTML  = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In';
    if (txt)  txt.textContent = "Don't have an account?";
    if (tog)  tog.textContent = 'Sign Up';
  }
  setLoginError('');
}

function saveLoginConfig() {
  const u = (document.getElementById('loginFbUrl')?.value || '').trim();
  const k = (document.getElementById('loginApiKey')?.value || '').trim();
  if (u) { fbUrl = u; localStorage.setItem(FB_URL_KEY, u); }
  if (k) { fbApiKey = k; localStorage.setItem(FB_APIKEY_KEY, k); }
  showToast('Config saved');
}

async function doLogin() {
  const email = (document.getElementById('loginEmail')?.value || '').trim();
  const pass  = document.getElementById('loginPassword')?.value || '';
  if (!email || !pass) { setLoginError('Enter your email and password.'); return; }
  if (!fbApiKey) { setLoginError('Set your Firebase API Key in ⚙ Firebase Setup first.'); return; }

  const btn = document.getElementById('loginBtn');
  if (btn) btn.disabled = true;
  setLoginError('');

  const endpoint = _loginMode === 'signup'
    ? `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${fbApiKey}`
    : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbApiKey}`;

  try {
    const res  = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass, returnSecureToken: true })
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || 'Authentication failed';
      const friendly = msg === 'EMAIL_NOT_FOUND' ? 'No account found for that email.'
        : msg === 'INVALID_PASSWORD' ? 'Incorrect password.'
        : msg === 'INVALID_LOGIN_CREDENTIALS' ? 'Incorrect email or password.'
        : msg === 'EMAIL_EXISTS' ? 'An account with this email already exists.'
        : msg === 'WEAK_PASSWORD : Password should be at least 6 characters' ? 'Password must be at least 6 characters.'
        : msg;
      setLoginError(friendly);
      if (btn) btn.disabled = false;
      return;
    }
    // Store tokens
    authToken   = data.idToken;
    authRefresh = data.refreshToken;
    authEmail   = data.email;
    authUid     = data.localId;
    authExpiry  = Date.now() + (parseInt(data.expiresIn, 10) * 1000);
    localStorage.setItem(AUTH_KEY,     authToken);
    localStorage.setItem(AUTH_REFRESH, authRefresh);
    localStorage.setItem(AUTH_EMAIL,   authEmail);
    localStorage.setItem(AUTH_UID,     authUid);
    localStorage.setItem(AUTH_EXPIRY,  String(authExpiry));
    // Point the sync blob at THIS user before init/startAutoSync runs, otherwise
    // it would read a previous user's blob with the new token → 403 → signout loop
    syncBlobId = authUid;
    localStorage.setItem(BLOB_KEY, authUid);
    _authPromptShown = false;
    hideLoginScreen();
    onAuthReady();
  } catch (e) {
    setLoginError('Network error — check your connection.');
    if (btn) btn.disabled = false;
  }
}

async function refreshAuthToken() {
  if (!authRefresh || !fbApiKey) return false;
  try {
    const res  = await fetch(`https://securetoken.googleapis.com/v1/token?key=${fbApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(authRefresh)}`
    });
    const data = await res.json();
    if (!res.ok) return false;
    authToken  = data.id_token;
    authRefresh = data.refresh_token;
    authExpiry  = Date.now() + (parseInt(data.expires_in, 10) * 1000);
    localStorage.setItem(AUTH_KEY,     authToken);
    localStorage.setItem(AUTH_REFRESH, authRefresh);
    localStorage.setItem(AUTH_EXPIRY,  String(authExpiry));
    return true;
  } catch { return false; }
}

async function checkAuth() {
  // No API key configured = open mode (no auth required)
  if (!fbApiKey) return true;
  // Token present and not expired → OK
  if (authToken && authExpiry > Date.now() + 60000) return true;
  // Try refresh
  if (authRefresh) {
    const ok = await refreshAuthToken();
    if (ok) return true;
  }
  return false;
}

async function finishFirebaseLogin(user) {
  const idToken = await user.getIdToken();
  authToken   = idToken;
  authRefresh = user.refreshToken;
  authEmail   = user.email || '';
  authUid     = user.uid;
  authExpiry  = Date.now() + 3600 * 1000;
  localStorage.setItem(AUTH_KEY,     authToken);
  localStorage.setItem(AUTH_REFRESH, authRefresh);
  localStorage.setItem(AUTH_EMAIL,   authEmail);
  localStorage.setItem(AUTH_UID,     authUid);
  localStorage.setItem(AUTH_EXPIRY,  String(authExpiry));
  // Point the sync blob at THIS user before init/startAutoSync runs, otherwise
  // it would read a previous user's blob with the new token → 403 → signout loop
  syncBlobId = authUid;
  localStorage.setItem(BLOB_KEY, authUid);
  _authPromptShown = false;
  hideLoginScreen();
  scheduleTokenRefresh();
  onAuthReady();
}

// On mobile the Google popup gets blocked / stuck on a blank page (iOS Safari
// third-party storage rules), so we use the full-page redirect flow there.
async function handleGoogleRedirect() {
  if (!sessionStorage.getItem('bm_google_redirect')) return false;
  sessionStorage.removeItem('bm_google_redirect');
  try {
    const result = await firebase.auth().getRedirectResult();
    if (result && result.user) { await finishFirebaseLogin(result.user); return true; }
    // iOS Safari storage-partitioning can make getRedirectResult() return null even
    // though the sign-in succeeded — fall back to the persisted currentUser so the
    // user isn't bounced back to the login screen (the "kicked out" loop).
    const cu = firebase.auth().currentUser;
    if (cu) { await finishFirebaseLogin(cu); return true; }
    // Last resort: wait briefly for auth state to hydrate, then check once more.
    const user = await new Promise(resolve => {
      let done = false;
      const unsub = firebase.auth().onAuthStateChanged(u => { if (!done) { done = true; unsub && unsub(); resolve(u); } });
      setTimeout(() => { if (!done) { done = true; unsub && unsub(); resolve(firebase.auth().currentUser); } }, 2500);
    });
    if (user) { await finishFirebaseLogin(user); return true; }
  } catch(e) {
    showLoginScreen();
    setLoginError(e.message || 'Google sign-in failed');
  }
  return false;
}

async function doGoogleLogin() {
  const btn = document.getElementById('loginGoogleBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  const GOOGLE_BTN_HTML = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Continue with Google';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  try {
    try { await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch(_) {}
    const provider = new firebase.auth.GoogleAuthProvider();
    // Use the POPUP flow on every platform. On iOS Safari the redirect flow loses
    // its session to storage partitioning (auth domain is *.firebaseapp.com) and
    // bounced the user straight back to the login screen — an endless loop with no
    // error. The popup stays in the same browsing context and avoids that.
    const result = await firebase.auth().signInWithPopup(provider);
    await finishFirebaseLogin(result.user);
  } catch(e) {
    const code = e && e.code ? e.code : '';
    const popupFailed = /popup-blocked|popup-closed-by-user|cancelled-popup-request|operation-not-supported|web-storage-unsupported|internal-error/.test(code);
    // Desktop only: fall back to redirect if the popup was blocked. On mobile the
    // redirect loops, so show a clear message instead of bouncing the user.
    if (popupFailed && !isMobile) {
      try {
        sessionStorage.setItem('bm_google_redirect', '1');
        await firebase.auth().signInWithRedirect(provider);
        return;
      } catch(e2) { /* fall through to error display */ }
    }
    setLoginError(
      popupFailed && isMobile
        ? 'Could not open the Google sign-in window — allow pop-ups for this site, or sign up with email below.'
        : ((e && e.message) || 'Google sign-in failed')
    );
    if (btn) { btn.disabled = false; btn.innerHTML = GOOGLE_BTN_HTML; }
  }
}

function doSignOut() {
  try { if (typeof firebase !== 'undefined') firebase.auth().signOut(); } catch(_) {}
  authToken = ''; authRefresh = ''; authEmail = ''; authUid = ''; authExpiry = 0;
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(AUTH_REFRESH);
  localStorage.removeItem(AUTH_EMAIL);
  localStorage.removeItem(AUTH_UID);
  localStorage.removeItem(AUTH_EXPIRY);
  updateSidebarUser();
  showLoginScreen();
}

function updateSidebarUser() {
  const el    = document.getElementById('sidebarUser');
  const av    = document.getElementById('sidebarUserAvatar');
  const email = document.getElementById('sidebarUserEmail');
  if (!el) return;
  if (authEmail) {
    el.classList.remove('hidden');
    if (email) email.textContent = authEmail;
    if (av)    av.textContent   = authEmail.charAt(0).toUpperCase();
  } else {
    el.classList.add('hidden');
  }
}

// Each account gets its own blob keyed by UID. If the blob is empty (first
// login on this account) seed it with the local data so other devices can pull.
const LAST_UID_KEY = 'bm_last_uid';
async function adoptUserBlob() {
  if (!authUid) return;
  if (syncBlobId !== authUid) {
    syncBlobId = authUid;
    localStorage.setItem(BLOB_KEY, syncBlobId);
  }
  try {
    const res = await fetch(fbEndpoint(syncBlobId));
    const p   = res.ok ? await res.json() : null;
    if (p && p.clients && Array.isArray(p.clients)) {
      autoPull(true);
    } else if (state && state.clients && state.clients.length) {
      state.lastModified = Date.now();
      await fetch(fbEndpoint(syncBlobId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
    }
  } catch(_) {}
}

async function onAuthReady() {
  updateSidebarUser();
  // If a DIFFERENT account than last time signed in on this browser, clear the
  // previous user's local data BEFORE init runs — otherwise init's auto-sync /
  // recurring-generation could push their data into this account's blob.
  if (authUid) {
    const lastUid = localStorage.getItem(LAST_UID_KEY) || '';
    if (lastUid && lastUid !== authUid) {
      state = { clients:[], income:[], expenses:[], services:[], deletedIds:[], deletedAt:{}, deletedClientIds:[], monthlyStopped:{} };
      try { await idbSet(STORAGE_KEY, state); } catch(_) {}
    }
    localStorage.setItem(LAST_UID_KEY, authUid);
  }
  init().then(() => adoptUserBlob()).catch(err => {
    console.error('App init failed:', err);
    try { navigate('dashboard'); } catch(_) {}
  });
}

// Schedule token refresh 5 min before expiry
function scheduleTokenRefresh() {
  if (!fbApiKey || !authRefresh || !authExpiry) return;
  const delay = Math.max(60000, authExpiry - Date.now() - 300000);
  setTimeout(async () => {
    await refreshAuthToken();
    scheduleTokenRefresh();
  }, delay);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Returning from a mobile Google sign-in redirect?
  if (await handleGoogleRedirect()) return;
  // Check auth first if API key is configured
  const authed = await checkAuth();
  if (!authed) {
    showLoginScreen();
    return;
  }
  scheduleTokenRefresh();
  onAuthReady();
});
