'use strict';

// ── Google Sheets Config ───────────────────────────────────────
let SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwpnWWC_FLbbSj5WU5pVOT5-62VRt0YNjzlNhTwGgDu9JmNdHLD9o5gYX8Zvje1fY3X/exec';

const STORAGE_KEY = 'biz_mastermind_data';
const VAT_RATE    = 0.24;

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

// Quick entry tab
let qeTab = 'income';

// QE Grid / Spreadsheet state
let qeGridMonth = '';
let qeGridSelectedClients = [];
let qeGridService = 'Video Editing';
let qeGridStatus = 'Paid';
let qeGridPayType = 'cash';
let qeGridData = {}; // persistent grid state: key = "type|clientId|date|sub", value = string
let qeExpenseGridData = {}; // expense QE: { date: [{id,category,amount,note}] }
let qeExpPayMethod = 'Cash';

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

// ── Persistence ────────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      state.clients  = p.clients  || DEFAULT_CLIENTS;
      state.income   = p.income   || [];
      state.expenses = p.expenses || [];
      state.services = p.services || [...DEFAULT_SERVICES];
    } else {
      state.clients  = DEFAULT_CLIENTS;
      state.services = [...DEFAULT_SERVICES];
    }
  } catch(e) { state.clients = DEFAULT_CLIENTS; state.services = [...DEFAULT_SERVICES]; }
}

function saveData() {
  state.lastModified = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
function toDateStr(s) { if(!s)return''; const[y,m,d]=s.split('-'); return`${d}/${m}/${y}`; }
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
}

function openAddPicker()  { closeAllModals(); _openSheet('sheetPicker'); }
function openAddIncome()  { _closeSheetSync('sheetPicker'); resetIncomeForm(); _openSheet('sheetIncome'); }
function openAddExpense() { _closeSheetSync('sheetPicker'); resetExpenseForm(); _openSheet('sheetExpense'); }
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
  clearSearch();
  // Close mobile sidebar if open
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  if (sidebar) { sidebar.setAttribute('data-open','0'); sidebar.style.cssText='display:none'; }
  if (overlay) overlay.style.display='none';
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
  document.getElementById('editSubclientList').innerHTML = editClientSubclients.map((sc,i)=>`
    <div class="subclient-edit-row">
      <input type="text" class="form-input sc-edit-input" value="${sc}"
        onchange="editClientSubclients[${i}]=this.value" style="flex:1;padding:8px 12px;font-size:14px" />
      <button class="btn-remove-sub" onclick="removeSubclientEdit(${i})"><i class="fa-solid fa-times"></i></button>
    </div>`).join('');
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
    <div class="service-card">
      <div class="service-icon"><i class="fa-solid fa-briefcase"></i></div>
      <div class="service-name">${s}</div>
      <button class="service-del-btn" onclick="deleteService(${i})" title="Remove"><i class="fa-solid fa-times"></i></button>
    </div>`).join('');
  document.getElementById('servicesGrid').innerHTML = html || '<div class="ov-empty">No services yet</div>';
  updateServicesDatalist();
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
      return `<div class="client-dd-item" onmousedown="selectClient('${c.id}')">${av}<span>${c.name}</span></div>`;
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
  document.getElementById('statusOverdue').classList.remove('active');

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

function setIncViewMode(m) { incViewMode = m; renderIncome(); }
function setExpViewMode(m) { expViewMode = m; renderExpenses(); }
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
  document.getElementById('statusOverdue').classList.toggle('active', s==='Overdue');
}

function updateVATPreview() {
  const amt = parseFloat(document.getElementById('incomeAmount').value)||0;
  const vat = incomePaymentType==='invoice' ? amt*VAT_RATE : 0;
  document.getElementById('vatPreviewText').textContent = `VAT: ${fmt(vat)}`;
  document.getElementById('vatGrossText').textContent   = `Client pays: ${fmt(amt+vat)}`;
}

function saveIncome() {
  const clientId = document.getElementById('incomeClientId').value;
  const service  = document.getElementById('incomeService').value.trim();
  const amount   = parseFloat(document.getElementById('incomeAmount').value);
  const date     = document.getElementById('incomeDate').value;

  if (!clientId) { showToast('Please select a client','error'); return; }
  if (!service)  { showToast('Please enter a service','error'); return; }
  if (!date)     { showToast('Please select a date','error'); return; }

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

  if (!amount||amount<=0){ showToast('Please enter a valid amount','error'); return; }
  const vatAmount = incomePaymentType==='invoice' ? amount*VAT_RATE : 0;

  // qty meta (optional)
  const qty       = incQtyMode ? (parseFloat(document.getElementById('incQty').value)||null) : null;
  const unitPrice = incQtyMode ? (parseFloat(document.getElementById('incUnitPrice').value)||null) : null;

  if (editingEntryId) {
    const idx = state.income.findIndex(e=>e.id===editingEntryId);
    if (idx>=0) state.income[idx] = { ...state.income[idx], clientId, subClient, service, amount, vatAmount, paymentType:incomePaymentType, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, qty, unitPrice };
    editingEntryId = null; editingEntryType = null;
    saveData();
    closeAllModals();
    showToast('Income entry updated');
  } else {
    const entry = { id:genId(), clientId, subClient, service, amount, vatAmount, paymentType:incomePaymentType, date:rawDate, status:incomeStatus, notes, recurring:incRecurring, qty, unitPrice, createdAt:Date.now() };
    state.income.push(entry);
    saveData();
    sheetsAdd('income', entry);
    closeAllModals();
    showToast(`Income saved — ${fmt(amount)}`);
  }
  renderView(currentView);
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
  const category = document.getElementById('expenseCategory').value;
  const vendor   = document.getElementById('expenseVendor').value.trim();
  const amount   = parseFloat(document.getElementById('expenseAmount').value);
  const date     = document.getElementById('expenseDate').value;

  if (!category)       { showToast('Please select a category','error'); return; }
  if (!vendor)         { showToast('Please enter a vendor name','error'); return; }
  if (!amount||amount<=0){ showToast('Please enter a valid amount','error'); return; }
  if (!date)           { showToast('Please select a date','error'); return; }

  const rawDate     = expDateMode==='month' ? date+'-01' : date;
  const description = document.getElementById('expenseDescription').value.trim();
  const vatAmount   = parseFloat(document.getElementById('expenseVAT').value)||0;

  if (editingEntryId) {
    const idx = state.expenses.findIndex(e=>e.id===editingEntryId);
    if (idx>=0) state.expenses[idx] = { ...state.expenses[idx], category, vendor, description, amount, vatAmount, paymentMethod:expPaymentMethod, recurring:expRecurring, date:rawDate };
    editingEntryId = null; editingEntryType = null;
    saveData();
    closeAllModals();
    showToast('Expense entry updated');
  } else {
    const entry = { id:genId(), category, vendor, description, amount, vatAmount, paymentMethod:expPaymentMethod, recurring:expRecurring, date:rawDate, createdAt:Date.now() };
    state.expenses.push(entry);
    saveData();
    sheetsAdd('expense', entry);
    closeAllModals();
    showToast(`Expense saved — ${fmt(amount)}`, 'error');
  }
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
      <div class="ed-row"><span>Type</span><strong>${e.paymentType==='invoice'?'Invoice':'Cash'}</strong></div>
      ${e.recurring?'<div class="ed-row"><span>Recurring</span><strong>Yes</strong></div>':''}
      ${e.notes?`<div class="ed-row"><span>Notes</span><strong>${e.notes}</strong></div>`:''}`;
  } else {
    const e = state.expenses.find(x=>x.id===id); if (!e) return;
    title = 'Expense Details';
    html = `
      <div class="ed-row"><span>Category</span><strong>${e.category}</strong></div>
      <div class="ed-row"><span>Vendor</span><strong>${e.vendor}</strong></div>
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
  if (pendingDeleteType==='income')  { state.income=state.income.filter(e=>e.id!==pendingDeleteId); showToast('Income entry deleted'); }
  else if (pendingDeleteType==='expense'){ state.expenses=state.expenses.filter(e=>e.id!==pendingDeleteId); showToast('Expense entry deleted'); }
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
    qeGridData[key] = inp.value;
    if (inp.dataset.type === 'subnote') {
      qeGridData['notevis|'+(inp.dataset.client||'')+'|'+(inp.dataset.date||'')+'|'+(inp.dataset.sub||'')] =
        (inp.style.display !== 'none' && inp.style.display !== '') ? '1' : '';
    }
  });
}

/* Load permanent income entries for the current month+service into the grid */
function loadQEFromState(table) {
  if (!table) return;
  const service = (qeGridService||'').trim();
  // Get entries for this month (filter by service if set, else show all)
  const monthEntries = state.income.filter(e =>
    e.date && e.date.startsWith(qeGridMonth) && (!service || e.service === service)
  );
  if (!monthEntries.length) return;

  table.querySelectorAll('tbody tr[data-date]').forEach(tr => {
    const dateStr = tr.dataset.date;
    const dayEntries = monthEntries.filter(e => e.date === dateStr);
    if (!dayEntries.length) return;

    // Group by clientId
    const byClient = {};
    dayEntries.forEach(e => { (byClient[e.clientId] = byClient[e.clientId]||[]).push(e); });

    Object.entries(byClient).forEach(([cid, entries]) => {
      const hasSubclients = entries.some(e => e.subClient);

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
        if (entry.qty != null) {
          const qi = tr.querySelector('[data-client="'+cid+'"][data-type="qty"]');
          if (qi) qi.value = entry.qty;
        }
        if (entry.unitPrice != null) {
          const pi = tr.querySelector('[data-client="'+cid+'"][data-type="price"]');
          if (pi) pi.value = entry.unitPrice;
        }
        // If no qty/unitPrice stored, put amount directly in the total cell
        if (entry.qty == null && entry.amount) {
          const tc = tr.querySelector('.qe-client-total[data-client="'+cid+'"]');
          if (tc) { tc.textContent = fmt(entry.amount); tc.dataset.value = entry.amount; }
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
  table.querySelectorAll('input[data-client][data-date]').forEach(inp => {
    const key = (inp.dataset.type||'')+'|'+(inp.dataset.client||'')+'|'+(inp.dataset.date||'')+'|'+(inp.dataset.sub||'');
    if (key in qeGridData) {
      inp.value = qeGridData[key];
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

  // Header row 1: Day | Note | [ClientName spanning N cols] | Day Total
  const hRow1 = selCols.map(c=>{
    const bg = hexToRgba(c.color, 0.09);
    return '<th colspan="'+clientColCount(c)+'" class="qe-th-client" style="border-top:3px solid '+c.color+';border-left:2px solid '+c.color+';background:'+bg+';text-align:center">'+c.name+'</th>';
  }).join('');

  // Header row 2: per client sub-headers
  const hRow2 = selCols.map(c=>{
    const subs = c.subclients||[];
    const bg = hexToRgba(c.color, 0.06);
    if (subs.length > 0) {
      return subs.map((s,si)=>'<th class="qe-sh" style="'+(si===0?'border-left:2px solid '+c.color+';':'')+' background:'+bg+'">'+s+'</th>').join('')
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
          +'<td class="qe-client-total" style="background:'+bg+'" data-client="'+c.id+'" data-date="'+ds+'" data-value="0">—</td>';
      } else {
        // Direct: qty (with note) + price + total
        return '<td class="qe-td-n" style="border-left:2px solid '+c.color+';background:'+bg+';text-align:center;vertical-align:middle">'
          +'<div class="qe-sub-cell">'
          +'<input class="qe-sp-inp qe-sp-qty" type="number" placeholder="—" min="0" step="1" data-client="'+c.id+'" data-date="'+ds+'" data-type="qty" oninput="updateQEClientTotal(this)" />'
          +'<button class="qe-note-pen" onclick="toggleSubNote(this)" title="Add note"><i class="fa-solid fa-pencil"></i></button>'
          +'<input class="qe-sp-inp qe-sp-subnote" type="text" placeholder="note…" data-client="'+c.id+'" data-date="'+ds+'" data-type="subnote" style="display:none" onblur="qeSubNoteBlur(this)" />'
          +'</div></td>'
          +'<td class="qe-td-n" style="background:'+bg+';text-align:center;vertical-align:middle"><input class="qe-sp-inp qe-sp-price" type="number" placeholder="—" min="0" step="0.01" data-client="'+c.id+'" data-date="'+ds+'" data-type="price" oninput="updateQEClientTotal(this)" onkeydown="qeSpreadsheetNav(event,this)" /></td>'
          +'<td class="qe-client-total" style="background:'+bg+'" data-client="'+c.id+'" data-date="'+ds+'" data-value="0">—</td>';
      }
    }).join('');
    return '<tr class="qe-sp-row'+(isToday?' qe-today-row':'')+'" data-date="'+ds+'">'
      +'<td class="qe-td-day'+(isToday?' qe-today-day':'')+'">'+day+'</td>'
      +clientCells
      +'<td class="qe-td-total" data-date="'+ds+'">—</td></tr>';
  }).join('');

  // Footer
  const footCells = selCols.map(c=>'<td colspan="'+clientColCount(c)+'" class="qe-tf-coltotal" data-client="'+c.id+'">—</td>').join('');

  cont.innerHTML = `
    <div class="qe-grid-controls">
      <div class="qe-ctrl-row">
        <div class="qe-ctrl-field">
          <label class="qe-ctrl-label">Month</label>
          <select class="form-select" style="padding:7px 10px;font-size:13px" onchange="qeGridMonth=this.value;renderQEIncome(document.getElementById('qeContent'))">${moOpts}</select>
        </div>
        <div class="qe-ctrl-field" style="flex:2">
          <label class="qe-ctrl-label">Service</label>
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

function updateQEClientTotal(inp) {
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
  const ct = tr.querySelector('.qe-client-total[data-client="'+cid+'"]');
  if (ct) { ct.textContent = clientTotal > 0 ? fmt(clientTotal) : '—'; ct.dataset.value = clientTotal; }
  // Day total
  let dayTotal = 0;
  tr.querySelectorAll('.qe-client-total').forEach(c=>{ dayTotal += parseFloat(c.dataset.value)||0; });
  const dt = tr.querySelector('.qe-td-total');
  if (dt) dt.textContent = dayTotal > 0 ? fmt(dayTotal) : '—';
  updateQEColTotals();
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
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  if (window.innerWidth <= 768) {
    const isOpen = sidebar.getAttribute('data-open') === '1';
    if (isOpen) {
      sidebar.setAttribute('data-open','0');
      sidebar.style.cssText = 'display:none';
      if (overlay) overlay.style.display = 'none';
    } else {
      sidebar.setAttribute('data-open','1');
      sidebar.style.cssText = 'display:flex;position:fixed;top:0;left:0;bottom:0;z-index:200;width:240px;flex-direction:column;box-shadow:4px 0 32px rgba(0,0,0,0.6)';
      if (overlay) overlay.style.display = 'block';
    }
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
      const service = (qeGridService||'Video Editing').trim();
      const subqtys = tr.querySelectorAll('[data-client="'+cid+'"][data-type="subqty"]');
      if (subqtys.length > 0) {
        subqtys.forEach(sq=>{
          const qty = parseFloat(sq.value) || 0;
          if (qty <= 0) return;
          const sub = sq.dataset.sub;
          const subPriceEl = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subprice"]');
          const subNoteEl  = tr.querySelector('[data-client="'+cid+'"][data-sub="'+sub+'"][data-type="subnote"]');
          const effectivePrice = parseFloat(subPriceEl?.value) || price;
          if (effectivePrice <= 0) return;
          const subNote = subNoteEl?.value.trim() || '';
          const amount = Math.round(qty * effectivePrice * 100) / 100;
          // Upsert: update existing entry or create new
          const xi = state.income.findIndex(e=>e.clientId===cid && e.date===dateStr && (e.subClient||'')===(sub||'') && e.service===service);
          if (xi >= 0) {
            state.income[xi] = { ...state.income[xi], amount, qty, unitPrice:effectivePrice, sharedPrice:price, notes:subNote, vatAmount:qeGridPayType==='invoice'?amount*VAT_RATE:0, status:qeGridStatus };
          } else {
            const entry = { id:genId(), clientId:cid, subClient:sub||'', service, amount, qty, unitPrice:effectivePrice, sharedPrice:price,
              vatAmount:qeGridPayType==='invoice'?amount*VAT_RATE:0,
              paymentType:qeGridPayType, date:dateStr, status:qeGridStatus, notes:subNote, createdAt:Date.now() };
            state.income.push(entry); sheetsAdd('income',entry);
          }
          savedCount++; savedTotal += amount;
        });
      } else {
        const qty = parseFloat(tr.querySelector('[data-client="'+cid+'"][data-type="qty"]')?.value) || 0;
        if (qty <= 0) return;
        const subNoteEl = tr.querySelector('[data-client="'+cid+'"][data-type="subnote"]');
        const subNote = subNoteEl?.value.trim() || '';
        const amount = Math.round(qty * price * 100) / 100;
        if (amount <= 0) return;
        const xi = state.income.findIndex(e=>e.clientId===cid && e.date===dateStr && (e.subClient||'')=== '' && e.service===service);
        if (xi >= 0) {
          state.income[xi] = { ...state.income[xi], amount, qty, unitPrice:price, notes:subNote, vatAmount:qeGridPayType==='invoice'?amount*VAT_RATE:0, status:qeGridStatus };
        } else {
          const entry = { id:genId(), clientId:cid, subClient:'', service, amount, qty, unitPrice:price,
            vatAmount:qeGridPayType==='invoice'?amount*VAT_RATE:0,
            paymentType:qeGridPayType, date:dateStr, status:qeGridStatus, notes:subNote, createdAt:Date.now() };
          state.income.push(entry); sheetsAdd('income',entry);
        }
        savedCount++; savedTotal += amount;
      }
    });
  });
  if (!savedCount) { showToast('No entries to save','error'); return; }
  saveData();
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
    if (!qeExpenseGridData[ds]) qeExpenseGridData[ds]=[];
    qeExpenseGridData[ds].push({ id:amt?.dataset.entryId||'', category:cat, amount:amt?.value||'', note });
  });
  // Drop fully-empty date buckets so they reload fresh from state next time
  Object.keys(qeExpenseGridData).forEach(ds=>{
    if ((qeExpenseGridData[ds]||[]).every(s=>!s.category&&!s.amount&&!s.note)) delete qeExpenseGridData[ds];
  });
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
  const si = cont.querySelectorAll('.qe-exp-slot').length;
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
    <div class="kpi-card green"><div class="kpi-icon"><i class="fa-solid fa-circle-check"></i></div><div class="kpi-label">Collected</div><div class="kpi-value">${fmt(collected)}</div></div>
    <div class="kpi-card amber"><div class="kpi-icon"><i class="fa-solid fa-clock"></i></div><div class="kpi-label">Pending</div><div class="kpi-value">${fmt(pending)}</div></div>
    <div class="kpi-card red"><div class="kpi-icon"><i class="fa-solid fa-arrow-trend-down"></i></div><div class="kpi-label">Expenses</div><div class="kpi-value">${fmt(totalExp)}</div></div>
    <div class="kpi-card blue"><div class="kpi-icon"><i class="fa-solid fa-sack-dollar"></i></div><div class="kpi-label">Net Profit</div><div class="kpi-value" style="color:${netProfit>=0?'var(--green)':'var(--red)'}">${fmt(netProfit)}</div></div>`;

  // Recurring prompt — show button if any recurring entries haven't been generated yet for current month
  const curMonth = todayVal().slice(0,7);
  const missingInc = state.income.filter(e=>e.recurring).some(e=>{
    return !state.income.some(x=>x.recurring&&x.clientId===e.clientId&&x.service===e.service&&monthKey(x.date)===curMonth);
  });
  const missingExp = state.expenses.filter(e=>e.recurring).some(e=>{
    return !state.expenses.some(x=>x.recurring&&x.category===e.category&&x.vendor===e.vendor&&monthKey(x.date)===curMonth);
  });
  const recurBanner = document.getElementById('recurringBanner');
  if (recurBanner) {
    recurBanner.style.display = (missingInc||missingExp) ? '' : 'none';
    const ml = document.getElementById('recurBannerMonth');
    if (ml) ml.textContent = monthLabel(curMonth);
  }

  // VAT
  const vatCol  = inc.filter(e=>e.status==='Paid'&&e.paymentType==='invoice').reduce((s,e)=>s+(e.vatAmount||0),0);
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

function setDashMonth(m) { dashMonth=m; renderDashboard(); }

// ── Statistics ─────────────────────────────────────────────────
function renderStatistics(filteredInc) {
  if (chartByClient) { chartByClient.destroy(); chartByClient=null; }
  if (chartMonthly)  { chartMonthly.destroy();  chartMonthly=null;  }

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
      <div class="filter-pills">${['all','Paid','Pending','Overdue'].map(s=>`<button class="filter-pill ${incStatus===s?'active':''}" onclick="setIncFilter('status','${s}')">${s==='all'?'All':s}</button>`).join('')}</div>
      <div class="filter-pills-label">Type</div>
      <div class="filter-pills">${[['all','All'],['invoice','Invoice'],['cash','Cash']].map(([v,l])=>`<button class="filter-pill ${incPayType===v?'active':''}" onclick="setIncFilter('paytype','${v}')">${l}</button>`).join('')}</div>
    </div>
  </div>`;

  const vtInc = (m,icon,label) => `<button class="vtb ${incViewMode===m?'active':''}" title="${label}" onclick="setIncViewMode('${m}')"><i class="fa-solid ${icon}"></i><span class="vtb-label">${label}</span></button>`;
  html += `<div class="view-toggle-bar"><span class="vt-label">View</span><div class="vtb-group">${vtInc('byclient','layer-group','By Client')}${vtInc('detailed','list-ul','Detailed')}${vtInc('cards','grip','Cards')}${vtInc('excel','table','Excel')}</div></div>`;

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
          return `<div class="entry-compact ${sl}" onclick="openEntryDetail('income','${e.id}')">
            <span class="ec-date">${toDateStr(e.date)}</span>
            <span class="ec-sep">·</span>
            <span class="ec-service">${e.service}${e.subClient?` <em style="opacity:.6">· ${e.subClient}</em>`:''}</span>
            <span class="ec-amount">${fmt(e.amount)}</span>
            <span class="badge ${e.paymentType} mini">${e.paymentType==='invoice'?'INV':'CASH'}</span>
            <span class="badge ${sl} mini">${e.status.slice(0,3).toUpperCase()}</span>
            ${eaInc(e.id)}
          </div>`;
        }).join('');
        html+=`<div class="byclient-group" data-cid="${cid}">
          <div class="byclient-header" style="border-left:3px solid ${c?.color||'#888'}" onclick="toggleClientGroup('${cid}')">
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
    cont.innerHTML = html; return;
  }

  // ── Excel view — Income ────────────────────────────────────────
  if (incViewMode==='excel') {
    const totalPaid = entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    const totalAll  = entries.reduce((s,e)=>s+e.amount,0);
    const rows = entries.map((e,i)=>{
      const c=clientById(e.clientId); const sl=e.status.toLowerCase();
      return `<tr class="xls-row-${sl}">
        <td class="xls-idx">${i+1}</td>
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
    const grp=groups[key];
    const total=grp.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
    html+=`<div class="month-group"><div class="month-group-header"><span>${monthLabel(key)}</span><span class="month-group-total">${fmt(total)}</span></div>`;

    if (incViewMode==='cards') {
      html+='<div class="entries-cards-grid">';
      grp.forEach(e=>{
        const c=clientById(e.clientId); const sl=e.status.toLowerCase();
        html+=`<div class="entry-card ${sl}" onclick="openEntryDetail('income','${e.id}')">
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
      grp.forEach(e=>{
        const c=clientById(e.clientId); const sl=e.status.toLowerCase();
        const av=c?.image?`<img src="${c.image}" style="width:28px;height:28px;object-fit:cover;border-radius:50%">`:null;
        html+=`<div class="income-entry ${sl}" onclick="openEntryDetail('income','${e.id}')">
          <div class="entry-client-badge">${av?av:`<span class="entry-client-dot" style="background:${c?.color||'#888'}"></span>`}${c?.name||'Unknown'}</div>
          <div class="entry-info"><div class="entry-service">${e.service}</div><div class="entry-meta">${toDateStr(e.date)}${e.subClient?' · '+e.subClient:''}</div></div>
          <div class="entry-right"><div class="entry-amount">${fmt(e.amount)}</div>
            <div class="entry-badges"><span class="badge ${e.paymentType}">${e.paymentType==='invoice'?'Invoice':'Cash'}</span><span class="badge ${sl}">${e.status}</span>${e.recurring?'<span class="badge recurring"><i class="fa-solid fa-rotate"></i></span>':''}</div>
          </div>
          ${eaInc(e.id)}
        </div>`;
      });
    }
    html+='</div>';
  });
  cont.innerHTML = html;
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
            <span class="ec-service">${e.vendor}${e.description?' — '+e.description:''}</span>
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
          <th style="width:32px">#</th><th>Date</th><th>Category</th><th>Vendor</th>
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
    const grp=groups[key];
    const total=grp.reduce((s,e)=>s+e.amount,0);
    html+=`<div class="month-group"><div class="month-group-header"><span>${monthLabel(key)}</span><span style="color:var(--red);font-size:13px;font-weight:700">${fmt(total)}</span></div>`;

    if (expViewMode==='cards') {
      html+='<div class="entries-cards-grid">';
      grp.forEach(e=>{
        const icon=CATEGORY_ICONS[e.category]||'📦';
        html+=`<div class="entry-card expense-card" onclick="openEntryDetail('expense','${e.id}')">
          <div class="entry-card-top exp-top">
            <span class="entry-card-icon">${icon}</span>
            <span class="entry-card-client">${e.vendor}</span>
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
      grp.forEach(e=>{
        const icon=CATEGORY_ICONS[e.category]||'📦';
        html+=`<div class="expense-entry" onclick="openEntryDetail('expense','${e.id}')">
          <div class="expense-cat-icon">${icon}</div>
          <div class="expense-info"><div class="expense-vendor">${e.vendor}</div>
            <div class="expense-cat">${e.category} · ${e.paymentMethod}${e.recurring?' · 🔄':''}</div>
            ${e.description?`<div class="expense-desc">${e.description}</div>`:''}
          </div>
          <div class="expense-right"><div class="expense-amount">${fmt(e.amount)}</div>
            <div class="expense-vat">${toDateStr(e.date)}</div>
            ${e.vatAmount>0?`<div class="expense-vat">VAT: ${fmt(e.vatAmount)}</div>`:''}
          </div>
          ${eaExp(e.id)}
        </div>`;
      });
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
      <div class="client-card-type">${c.type==='Agency'?`Agency · ${c.subclients.length} sub-clients`:'Direct Client'}</div>
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
  const agency = state.clients.filter(c=>c.type==='Agency');
  const months = allMonths();
  document.getElementById('reportsContainer').innerHTML = `
    <div class="report-controls">
      <select class="form-select" id="reportClient" onchange="renderReportTable()">
        <option value="">Select Client…</option>
        <option value="__all__">📊 All My Income</option>
        ${agency.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
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
    </div>
    <div id="reportTableArea"><div class="report-empty">Select an agency client to view sub-client breakdown</div></div>`;
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

  const scMap={};
  entries.forEach(e=>{
    const k=e.subClient||'(General)';
    if(!scMap[k])scMap[k]={paid:0,pending:0,jobs:0,vat:0,cashJobs:0,invoiceJobs:0};
    scMap[k].jobs++; scMap[k].vat+=(e.vatAmount||0);
    if(e.paymentType==='cash') scMap[k].cashJobs++; else scMap[k].invoiceJobs++;
    if(e.status==='Paid')    scMap[k].paid+=e.amount;
    if(e.status==='Pending') scMap[k].pending+=e.amount;
  });
  const gPaid=entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const gPend=entries.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
  const gVAT=entries.reduce((s,e)=>s+(e.vatAmount||0),0);
  const showVAT = reportPayFilter!=='cash';

  area.innerHTML=`<div class="report-table-wrapper" id="printArea">
    <div style="padding:16px 16px 8px;font-size:13px;color:var(--text-muted)">
      <strong style="color:var(--text)">${client?.name||''}</strong>${filterLabel}
      ${month?` · ${monthLabel(month)}`:''}
    </div>
    <table class="report-table"><thead><tr>
      <th>Sub-Client</th><th>Jobs</th>
      ${reportPayFilter==='all'?'<th>Cash</th><th>Invoice</th>':''}
      <th>Paid</th><th>Pending</th>
      ${showVAT?'<th>VAT</th>':''}
    </tr></thead>
    <tbody>${Object.entries(scMap).map(([sc,d])=>`<tr>
      <td>${sc}</td><td>${d.jobs}</td>
      ${reportPayFilter==='all'?`<td>${d.cashJobs||'—'}</td><td>${d.invoiceJobs||'—'}</td>`:''}
      <td style="color:var(--green)">${fmt(d.paid)}</td>
      <td style="color:var(--amber)">${d.pending>0?fmt(d.pending):'—'}</td>
      ${showVAT?`<td>${fmt(d.vat)}</td>`:''}
    </tr>`).join('')}</tbody>
    <tfoot><tr class="total-row">
      <td>TOTAL</td><td>${entries.length}</td>
      ${reportPayFilter==='all'?`<td>${entries.filter(e=>e.paymentType==='cash').length}</td><td>${entries.filter(e=>e.paymentType==='invoice').length}</td>`:''}
      <td>${fmt(gPaid)}</td><td>${gPend>0?fmt(gPend):'—'}</td>
      ${showVAT?`<td>${fmt(gVAT)}</td>`:''}
    </tr></tfoot>
    </table></div>`;
}

// ── Print Report ───────────────────────────────────────────────
function printReport() {
  const clientId = document.getElementById('reportClient')?.value;
  const month    = document.getElementById('reportMonth')?.value;
  if (!clientId) { showToast('Select a client first','error'); return; }

  // ── All My Income ──────────────────────────────────────────────
  if (clientId==='__all__') {
    let entries = [...state.income];
    if (month) entries=entries.filter(e=>monthKey(e.date)===month);
    if (reportPayFilter!=='all') entries=entries.filter(e=>e.paymentType===reportPayFilter);
    if (!entries.length) { showToast('No entries to print','error'); return; }
    const showVAT=reportPayFilter!=='cash', showCI=reportPayFilter==='all';
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
    const filterLabel=reportPayFilter==='cash'?' — Cash Only':reportPayFilter==='invoice'?' — Invoice / VAT':'';
    const rows=Object.entries(cMap).map(([name,d])=>`<tr>
      <td>${name}</td><td>${d.jobs}</td>
      ${showCI?`<td>${d.cashJobs||'—'}</td><td>${d.invoiceJobs||'—'}</td>`:''}
      <td>${fmt(d.paid)}</td><td>${d.pending>0?fmt(d.pending):'—'}</td>
      ${showVAT?`<td>${fmt(d.vat)}</td>`:''}</tr>`).join('');
    const gExp   = state.expenses.filter(e=>!month||monthKey(e.date)===month).reduce((s,e)=>s+e.amount,0);
    const gNet   = gPaid - gExp;
    const kpiHtml = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px">
      <div style="border-radius:8px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;text-align:center">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#16a34a;margin-bottom:4px">Collected</div>
        <div style="font-size:20px;font-weight:800;color:#16a34a">${fmt(gPaid)}</div>
      </div>
      <div style="border-radius:8px;padding:16px;background:#fffbeb;border:1px solid #fde68a;text-align:center">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#d97706;margin-bottom:4px">Pending</div>
        <div style="font-size:20px;font-weight:800;color:#d97706">${fmt(gPend)}</div>
      </div>
      <div style="border-radius:8px;padding:16px;background:#fef2f2;border:1px solid #fecaca;text-align:center">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#dc2626;margin-bottom:4px">Expenses</div>
        <div style="font-size:20px;font-weight:800;color:#dc2626">${fmt(gExp)}</div>
      </div>
      <div style="border-radius:8px;padding:16px;background:${gNet>=0?'#eff6ff':'#fef2f2'};border:1px solid ${gNet>=0?'#bfdbfe':'#fecaca'};text-align:center">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:${gNet>=0?'#1d4ed8':'#dc2626'};margin-bottom:4px">Net Profit</div>
        <div style="font-size:20px;font-weight:800;color:${gNet>=0?'#1d4ed8':'#dc2626'}">${fmt(gNet)}</div>
      </div>
    </div>`;
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>All Income${filterLabel}${month?' · '+monthLabel(month):''}</title>
      <style>body{font-family:Arial,sans-serif;padding:32px;color:#000;max-width:860px;margin:0 auto}
      h1{font-size:22px;margin-bottom:4px}.meta{color:#555;font-size:12px;margin-bottom:20px}
      table{width:100%;border-collapse:collapse}th{background:#f0f0f0;padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #ccc}
      td{padding:10px 12px;border-bottom:1px solid #e0e0e0;font-size:13px}tfoot td{font-weight:bold;background:#f8f8f8;border-top:2px solid #ccc}</style></head><body>
      <h1>All Income${filterLabel}</h1>
      <div class="meta">Generated: ${new Date().toLocaleDateString('en-GB')}${month?' · '+monthLabel(month):''}</div>
      ${kpiHtml}
      <table><thead><tr><th>Client</th><th>Jobs</th>${showCI?'<th>Cash</th><th>Invoice</th>':''}<th>Paid</th><th>Pending</th>${showVAT?'<th>VAT</th>':''}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>TOTAL</td><td>${entries.length}</td>
        ${showCI?`<td>${entries.filter(e=>e.paymentType==='cash').length}</td><td>${entries.filter(e=>e.paymentType==='invoice').length}</td>`:''}
        <td>${fmt(gPaid)}</td><td>${gPend>0?fmt(gPend):'—'}</td>${showVAT?`<td>${fmt(gVAT)}</td>`:''}</tr></tfoot>
      </table><script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const w=window.open('','_blank'); w.document.write(html); w.document.close();
    return;
  }

  // ── Agency client (sub-client breakdown) ──────────────────────
  const client = clientById(clientId);
  let entries = state.income.filter(e=>e.clientId===clientId);
  if (month) entries=entries.filter(e=>monthKey(e.date)===month);
  if (reportPayFilter!=='all') entries=entries.filter(e=>e.paymentType===reportPayFilter);
  if (!entries.length) { showToast('No entries to print','error'); return; }

  const filterLabel = reportPayFilter==='cash' ? ' — Cash Jobs' : reportPayFilter==='invoice' ? ' — Invoice / VAT Jobs' : '';
  const monthLabel2 = month ? ' · '+monthLabel(month) : '';
  const showVAT = reportPayFilter!=='cash';
  const showCashInv = reportPayFilter==='all';

  const scMap={};
  entries.forEach(e=>{
    const k=e.subClient||'(General)';
    if(!scMap[k])scMap[k]={paid:0,pending:0,jobs:0,vat:0,cashJobs:0,invoiceJobs:0};
    scMap[k].jobs++; scMap[k].vat+=(e.vatAmount||0);
    if(e.paymentType==='cash') scMap[k].cashJobs++; else scMap[k].invoiceJobs++;
    if(e.status==='Paid')    scMap[k].paid+=e.amount;
    if(e.status==='Pending') scMap[k].pending+=e.amount;
  });
  const gPaid=entries.filter(e=>e.status==='Paid').reduce((s,e)=>s+e.amount,0);
  const gPend=entries.filter(e=>e.status==='Pending').reduce((s,e)=>s+e.amount,0);
  const gVAT=entries.reduce((s,e)=>s+(e.vatAmount||0),0);

  const rows = Object.entries(scMap).map(([sc,d])=>`<tr>
    <td>${sc}</td><td>${d.jobs}</td>
    ${showCashInv?`<td>${d.cashJobs||'—'}</td><td>${d.invoiceJobs||'—'}</td>`:''}
    <td>${fmt(d.paid)}</td>
    <td>${d.pending>0?fmt(d.pending):'—'}</td>
    ${showVAT?`<td>${fmt(d.vat)}</td>`:''}
  </tr>`).join('');

  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>${client?.name||'Report'}${filterLabel}${monthLabel2}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:32px;color:#000;max-width:800px;margin:0 auto}
      h1{font-size:22px;margin-bottom:4px}
      .meta{color:#555;font-size:12px;margin-bottom:24px}
      table{width:100%;border-collapse:collapse}
      th{background:#f0f0f0;padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #ccc}
      td{padding:10px 12px;border-bottom:1px solid #e0e0e0;font-size:13px}
      tfoot td{font-weight:bold;background:#f8f8f8;border-top:2px solid #ccc}
    </style></head><body>
    <h1>${client?.name||''}${filterLabel}</h1>
    <div class="meta">Generated: ${new Date().toLocaleDateString('en-GB')}${monthLabel2}</div>
    <table>
      <thead><tr>
        <th>Sub-Client</th><th>Jobs</th>
        ${showCashInv?'<th>Cash</th><th>Invoice</th>':''}
        <th>Paid</th><th>Pending</th>
        ${showVAT?'<th>VAT</th>':''}
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td>TOTAL</td><td>${entries.length}</td>
        ${showCashInv?`<td>${entries.filter(e=>e.paymentType==='cash').length}</td><td>${entries.filter(e=>e.paymentType==='invoice').length}</td>`:''}
        <td>${fmt(gPaid)}</td><td>${gPend>0?fmt(gPend):'—'}</td>
        ${showVAT?`<td>${fmt(gVAT)}</td>`:''}
      </tr></tfoot>
    </table>
    <script>window.onload=()=>{window.print();}<\/script>
  </body></html>`;

  const w=window.open('','_blank');
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
  if (!el) return;
  el.className = 'cloud-sync-dot cs-' + state_;
  const label = document.getElementById('cloudSyncLabel');
  if (!label) return;
  const map = { idle:'Sync ready', pushing:'Pushing…', pulling:'Pulling…', ok:'Synced', error:'Sync error' };
  label.textContent = map[state_] || '';
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

function scheduleAutoPush() {
  if (!syncBlobId || !fbUrl) return;
  clearTimeout(_autoPushTimer);
  _autoPushTimer = setTimeout(() => autoPush(true), 1500);
}

async function autoPush(silent) {
  if (!syncBlobId || !fbUrl || _isSyncing) return;
  _isSyncing = true;
  setSyncIndicator('pushing');
  try {
    const res = await fetch(fbEndpoint(syncBlobId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setSyncIndicator('ok');
    updateSyncModalStatus('Last push: ' + new Date().toLocaleTimeString());
    if (!silent) showToast('☁ Synced to cloud');
    setTimeout(() => setSyncIndicator('idle'), 3000);
  } catch(e) {
    setSyncIndicator('error');
    console.warn('Auto-push failed:', e.message);
    setTimeout(() => setSyncIndicator('idle'), 5000);
  } finally { _isSyncing = false; }
}

async function autoPull(silent) {
  if (!syncBlobId || !fbUrl || _isSyncing) return;
  _isSyncing = true;
  setSyncIndicator('pulling');
  try {
    const res = await fetch(fbEndpoint(syncBlobId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !p.clients || !Array.isArray(p.clients)) throw new Error('Invalid data');
    const cloudTs = p.lastModified || 0;
    const localTs = state.lastModified  || 0;
    if (cloudTs <= localTs) {
      setSyncIndicator('ok');
      setTimeout(() => setSyncIndicator('idle'), 2000);
      return;
    }
    state.clients  = p.clients;
    state.income   = p.income   || [];
    state.expenses = p.expenses || [];
    state.services = p.services || [...DEFAULT_SERVICES];
    state.lastModified = cloudTs;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    navigate(currentView);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  // Pull on page-focus (switching back to app from another tab/app)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') autoPull(true);
  });
  window.addEventListener('focus', () => autoPull(true));
  // Poll every 60 seconds
  setInterval(() => autoPull(true), 60000);
  // Pull immediately on start
  autoPull(true);
  setSyncIndicator('idle');
}

// ── Export / Import ────────────────────────────────────────────
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
function init() {
  loadData();
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

  startAutoSync();
  navigate('dashboard');
}

document.addEventListener('DOMContentLoaded', init);
