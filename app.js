// Main app: state, rendering, and all event wiring. Depends on billing.js,
// offline.js, pdf.js, and supabase.js all being loaded first (see index.html).

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove('show'), 2600);
}

let DATA = { purchases: [], readings: [], flats: [] };
let CURRENT_USER = null;
let TAB = 'dashboard';
let EXPANDED_PURCHASE = null;
let REPORT_METHOD = {};
let HISTORY_FLAT = null;
let ACTIVE_BATCH_ID = null;
let SHOW_BATCH_SWITCH = false;
let EDIT_PURCHASE_ID = null;
let EDIT_CYLINDERS = [];
let EDIT_READING_ID = null;
let SET_RATE_FOR = null;
let GRAPH_RANGE = '6'; // 6 | 12 | all
let AUTH_STATUS = 'checking'; // checking | nobackend | signedout | pending | ready
let AUTH_MODE = 'login'; // login | signup
let PROFILES = [];

const ROLE_LABEL = { admin:'Admin', resident:'Resident', pending:'Pending', purchase_manager:'Purchase manager', meter_reader:'Meter reader' };

const TABS = [
  { id:'dashboard', label:'Dashboard', visible: function(u){ return u.role==='admin' || hasPermission(u,'dashboard'); } },
  { id:'purchase', label:'New purchase', visible: function(u){ return u.role==='admin' || hasPermission(u,'purchase'); } },
  { id:'reading', label:'Log reading', visible: function(u){ return u.role==='admin' || hasPermission(u,'meter_reading'); } },
  { id:'history', label:'Flat Dashboard', visible: function(u){ return u.role==='admin' || hasPermission(u,'my_flat'); } },
  { id:'admin', label:'Admin', visible: function(u){ return u.role==='admin' || hasPermission(u,'people_access') || hasPermission(u,'settings'); } },
];

function renderShell(){
  const roleTag = document.getElementById('roleTag');
  const logoutBtn = document.getElementById('logoutBtn');
  const tabsEl = document.getElementById('tabs');
  if(AUTH_STATUS !== 'ready'){
    roleTag.style.display = 'none';
    logoutBtn.style.display = 'none';
    tabsEl.innerHTML = '';
    return;
  }
  roleTag.style.display = '';
  logoutBtn.style.display = '';
  roleTag.textContent = ROLE_LABEL[CURRENT_USER.role].toUpperCase();
  logoutBtn.onclick = async function(){ await sb.auth.signOut(); AUTH_STATUS='signedout'; CURRENT_USER=null; renderAll(); };
  const visibleTabs = TABS.filter(function(t){ return t.visible(CURRENT_USER); });
  if(!visibleTabs.find(function(t){return t.id===TAB;})) TAB = 'dashboard';
  tabsEl.innerHTML = visibleTabs.map(function(t){
    return '<button data-tab="'+t.id+'" class="'+(TAB===t.id?'active':'')+'">'+t.label+'</button>';
  }).join('');
  document.querySelectorAll('#tabs button').forEach(function(b){
    b.onclick = function(){ TAB = b.dataset.tab; renderAll(); if(TAB==='admin') loadProfiles(); };
  });
}

function renderMain(){
  const m = document.getElementById('main');
  if(AUTH_STATUS === 'checking'){ m.innerHTML = '<div class="card"><div class="empty">Loading\u2026</div></div>'; return; }
  if(AUTH_STATUS === 'nobackend'){ m.innerHTML = '<div class="card"><div class="empty">Supabase is not connected yet \u2014 add your project URL &amp; key in the code.</div></div>'; return; }
  if(AUTH_STATUS === 'signedout'){ m.innerHTML = viewAuth(); bindAuthEvents(); return; }
  if(AUTH_STATUS === 'pending'){ m.innerHTML = viewPending(); bindAuthEvents(); return; }
  if(TAB==='dashboard') m.innerHTML = viewDashboard();
  else if(TAB==='purchase') m.innerHTML = viewPurchaseForm();
  else if(TAB==='reading') m.innerHTML = viewReadingForm();
  else if(TAB==='history') m.innerHTML = viewHistory();
  else if(TAB==='admin') m.innerHTML = viewAdmin();
  bindMainEvents();
}

function renderAll(){ renderShell(); renderMain(); }

function viewAuth(){
  const signup = AUTH_MODE === 'signup';
  return '<div class="card authcard"><h2>'+(signup?'Request access':'Sign in')+'</h2>'
    + '<p class="sub">'+(signup?'Create an account, then an admin approves it and assigns your role before you can use anything.':'Sign in to LPG Ledger.')+'</p>'
    + '<form id="authForm">'
    + (signup ? '<label>Your name</label><input type="text" name="name" required>' : '')
    + '<label>Email</label><input type="email" name="email" required>'
    + '<label>Password</label><input type="password" name="password" required minlength="6">'
    + '<button class="btn" type="submit" style="width:100%;justify-content:center;">'+(signup?'Create account':'Sign in')+'</button>'
    + '</form>'
    + '<p class="hint" style="margin-top:14px;text-align:center;">'+(signup?'Already have an account? ':"Don't have access yet? ")+'<a id="authToggle">'+(signup?'Sign in':'Request access')+'</a></p>'
    + '<div id="authMsg" class="hint" style="margin-top:8px;text-align:center;"></div></div>';
}

function viewPending(){
  return '<div class="card authcard" style="text-align:center;"><h2>Waiting for approval</h2>'
    + '<p class="sub">Your account is created. An admin needs to approve it and assign your role before you can use the app.</p>'
    + '<button class="btn secondary" id="signOutBtn">Sign out</button></div>';
}

function bindAuthEvents(){
  const t = document.getElementById('authToggle');
  if(t) t.onclick = function(){ AUTH_MODE = AUTH_MODE==='signup' ? 'login' : 'signup'; renderMain(); };
  const f = document.getElementById('authForm');
  if(f) f.onsubmit = async function(e){
    e.preventDefault();
    const fd = new FormData(f);
    const email = fd.get('email'), password = fd.get('password');
    const msg = document.getElementById('authMsg');
    msg.textContent = 'Please wait\u2026';
    try{
      if(AUTH_MODE==='signup'){
        const name = fd.get('name');
        const res = await sb.auth.signUp({ email:email, password:password, options:{ data:{ name:name } } });
        if(res.error){ msg.textContent = res.error.message; return; }
        if(res.data.user && !res.data.session){ msg.textContent = 'Check your email to confirm, then sign in.'; AUTH_MODE='login'; renderMain(); return; }
        if(res.data.user){ await sb.from('profiles').insert({ id:res.data.user.id, name:name, email:email }); }
        await checkSession();
      } else {
        const res = await sb.auth.signInWithPassword({ email:email, password:password });
        if(res.error){ msg.textContent = res.error.message; return; }
        await checkSession();
      }
    }catch(err){ msg.textContent = 'Something went wrong. Try again.'; }
  };
  const so = document.getElementById('signOutBtn');
  if(so) so.onclick = async function(){ await sb.auth.signOut(); AUTH_STATUS='signedout'; CURRENT_USER=null; renderAll(); };
}

function buildingOverview(){
  const sortedAll = DATA.purchases.slice().sort(function(a,b){ return batchSeq(a.id)-batchSeq(b.id); });
  if(sortedAll.length===0) return '';
  const current = sortedAll[sortedAll.length-1];
  const t = cylinderTotals(current);
  const b = computeBilling(current, DATA.readings, REPORT_METHOD[current.id]||'actual');
  const activeFlats = DATA.flats.filter(function(f){return f.active;});
  const flatsWithReadings = b.rows.length;
  const flatsPending = Math.max(0, activeFlats.length - flatsWithReadings);
  const consumedKg = b.rows.reduce(function(s,r){return s+r.units*b.rate;},0);
  const avgPerFlat = flatsWithReadings>0 ? consumedKg/flatsWithReadings : 0;

  let html = '<div class="card"><h2>Building overview</h2><p class="sub">Current cycle: '+current.id+(current.status==='open'?' (still open)':'')+'</p>';
  html += '<div class="stat-grid-3">'
    + '<div class="stat"><div class="v">'+fmtQty(t.kg)+' kg</div><div class="l">Purchased</div></div>'
    + '<div class="stat"><div class="v">'+fmtQty(consumedKg)+' kg</div><div class="l">Consumed</div></div>'
    + '<div class="stat"><div class="v">Tk '+fmtTk(b.totalBill)+'</div><div class="l">Total billed</div></div>'
    + '<div class="stat"><div class="v">'+flatsWithReadings+' / '+activeFlats.length+'</div><div class="l">Flats read</div></div>'
    + '<div class="stat"><div class="v">'+flatsPending+'</div><div class="l">Pending</div></div>'
    + '<div class="stat"><div class="v">'+fmtQty(avgPerFlat)+' kg</div><div class="l">Avg / flat</div></div>'
    + '</div>';

  const chartCycles = sortedAll.slice(-8);
  if(chartCycles.length>1){
    const values = chartCycles.map(function(p){ const bb = computeBilling(p, DATA.readings, 'actual'); return bb.rows.reduce(function(s,r){return s+r.units*bb.rate;},0); });
    const labels = chartCycles.map(function(p){ return 'C'+(sortedAll.indexOf(p)+1); });
    html += '<div class="hint" style="margin-top:12px;">Building-wide consumption by cycle (actual method):</div>';
    html += barChart(values, labels, 'var(--teal)');
    html += '<div class="chart-legend">'+chartCycles.map(function(p){ const period=billingPeriod(p,DATA.readings); return 'C'+(sortedAll.indexOf(p)+1)+' = '+p.id+(period?' ('+period.start+' to '+period.end+')':''); }).join(' \u00b7 ')+'</div>';
  }
  html += '</div>';
  return html;
}

function viewDashboard(){
  if(DATA.purchases.length === 0){
    return '<div class="card"><div class="empty">No gas purchases logged yet. '+(can('addPurchase') ? 'Start with "New purchase."' : 'Ask your purchase manager to log the first batch.')+'</div></div>';
  }
  const sorted = DATA.purchases.slice().sort(function(a,b){
    const na = parseInt((/^P-(\d+)/.exec(a.id)||[0,'0'])[1],10);
    const nb = parseInt((/^P-(\d+)/.exec(b.id)||[0,'0'])[1],10);
    return nb-na;
  });
  let html = buildingOverview();
  html += '<div class="card"><h2>Purchases</h2><p class="sub">Tap a batch to see every flat\u2019s bill and how it was calculated.</p>';
  sorted.forEach(function(p){
    const t = cylinderTotals(p);
    const period = billingPeriod(p, DATA.readings);
    html += '<div class="purchase-row" data-purchase="'+p.id+'">'
      + '<div class="pr-top"><strong>'+p.id+'</strong><span class="status '+p.status+'">'+p.status+'</span></div>'
      + '<div class="pr-meta">'+(p.cylinders||[]).length+' cylinder(s) \u00b7 '+fmtQty(t.kg)+' kg \u00b7 Tk '+fmtTk(t.cost)+(period?' \u00b7 '+period.days+' days so far':'')+' \u00b7 '+DATA.readings.filter(function(r){return r.purchaseId===p.id;}).length+' readings logged</div>'
      + '</div>';
    if(EXPANDED_PURCHASE === p.id) html += renderPurchaseDetail(p);
  });
  html += '</div>';
  return html;
}

function renderPurchaseDetail(p){
  const method = REPORT_METHOD[p.id] || 'actual';
  const b = computeBilling(p, DATA.readings, method);
  const isAdmin = CURRENT_USER.role === 'admin';
  const manualSet = p.manualRate != null && p.manualRate !== '';

  let html = '<div class="card" style="background:var(--paper);border-style:dashed;">';

  if(isAdmin){
    html += '<button class="btn secondary small" data-edit-purchase="'+p.id+'">Edit batch</button>';
  }

  if(EDIT_PURCHASE_ID === p.id){
    html += '<div class="inline-edit"><div class="hint" style="margin-bottom:8px;">Cylinder purchases in this batch \u2014 edit any of them or add more:</div>';
    EDIT_CYLINDERS.forEach(function(c){
      html += '<div class="row3" style="margin-bottom:6px;">'
        + '<div><label>Date</label><input type="date" class="cylDate" data-cyl="'+c.id+'" value="'+c.date+'"></div>'
        + '<div><label>KG</label><input type="number" step="0.01" class="cylKg" data-cyl="'+c.id+'" value="'+c.kg+'"></div>'
        + '<div><label>Cost (Tk)</label><input type="number" step="0.01" class="cylCost" data-cyl="'+c.id+'" value="'+c.cost+'"></div>'
        + '</div><button class="btn danger small" data-del-cyl="'+c.id+'" style="margin-bottom:10px;">Remove this cylinder</button>';
    });
    html += '<button class="btn secondary small" data-add-cyl="1">+ Add another cylinder purchase</button>'
      + '<label style="margin-top:14px;">Status</label><select id="epStatus"><option value="open" '+(p.status==='open'?'selected':'')+'>Open</option><option value="closed" '+(p.status==='closed'?'selected':'')+'>Closed</option></select>'
      + '<div class="rowbtns" style="margin-top:12px;"><button class="btn small" data-save-purchase="'+p.id+'">Save</button><button class="btn secondary small" data-cancel-edit-purchase="1">Cancel</button></div>'
      + '</div>';
  }

  html += '<div class="toggle-group">'
    + '<button data-method="actual" data-purchase="'+p.id+'" class="'+(method==='actual'?'on':'')+'">Actual</button>'
    + '<button data-method="manual" data-purchase="'+p.id+'" class="'+(method==='manual'?'on':'')+'">Manual'+(manualSet?'':' (not set)')+'</button>'
    + '</div>';

  if(method === 'manual'){
    if(!manualSet && !isAdmin){
      html += '<div class="method-note">No manual conversion rate has been set for this batch yet. Ask an admin to set one.</div></div>';
      return html;
    }
    if(isAdmin && SET_RATE_FOR === p.id){
      html += '<div class="inline-edit"><label>Manual conversion rate (kg per meter unit)</label>'
        + '<input type="number" step="0.01" id="manualRateInput" value="'+(p.manualRate||'')+'" placeholder="e.g. 2.60">'
        + '<div class="rowbtns" style="margin-top:12px;"><button class="btn small" data-save-rate="'+p.id+'">Save rate</button><button class="btn secondary small" data-cancel-rate="1">Cancel</button></div></div>';
    } else {
      html += '<div class="method-note">Manual method \u2014 fixed conversion rate: <b>'+(manualSet?p.manualRate:'not set')+' kg/unit</b>'
        + (isAdmin ? ' <a data-edit-rate="'+p.id+'" style="cursor:pointer;text-decoration:underline;">'+(manualSet?'edit':'set now')+'</a>' : '')
        + '. This stays fixed until an admin updates it, so bills can be revised on request.</div>';
    }
    if(!manualSet){ html += '</div>'; return html; }
  } else {
    html += '<div class="method-note">Actual method \u2014 conversion ratio calculated automatically from this batch: <b>'+b.conversionRatio.toFixed(3)+' kg/unit</b>. This spreads any line leakage fairly across every flat based on their real metered share.</div>';
  }

  html += '<div class="stat-grid">'
    + '<div class="stat"><div class="v">Tk '+fmtTk(b.pricePerKg)+'</div><div class="l">Price / kg (blended)</div></div>'
    + '<div class="stat"><div class="v">'+b.rate.toFixed(3)+'</div><div class="l">kg / unit used</div></div>'
    + '</div>';
  const period = billingPeriod(p, DATA.readings);
  html += '<div class="hint" style="margin-top:8px;">'+(p.cylinders||[]).length+' cylinder(s) \u00b7 '+fmtQty(b.totalKg)+' kg total \u00b7 Tk '+fmtTk(b.totalCost)+' total'+(period?' \u00b7 billing period: '+period.days+' days ('+period.start+' to '+period.end+')':'')+'</div>';

  html += '<div class="hint" style="margin:14px 0 4px;">Cylinder purchases in this batch:</div>';
  html += '<div class="tablewrap"><table><thead><tr><th>Date</th><th class="num">KG</th><th class="num">Cost (Tk)</th><th></th></tr></thead><tbody>';
  (p.cylinders||[]).slice().sort(function(a,c){return a.date.localeCompare(c.date);}).forEach(function(c){
    html += '<tr><td>'+c.date+'</td><td class="num">'+fmtQty(c.kg)+'</td><td class="num">'+fmtTk(c.cost)+'</td>'
      + '<td class="num">'+(c.hasPhoto ? '<button class="btn small secondary" data-view-cyl-photo="'+c.id+'">Receipt</button>' : '\u2014')+'</td></tr>';
  });
  html += '</tbody></table></div>';

  html += '<div class="tablewrap"><table><thead><tr><th>Flat</th><th class="num">Prev</th><th class="num">Curr</th><th class="num">Units</th><th class="num">Bill (Tk)</th><th></th></tr></thead><tbody>';
  b.rows.sort(function(a,c){return naturalFlatCompare(a.flatId,c.flatId);}).forEach(function(r){
    const f = flatById(r.flatId);
    const phone = f && f.phone;
    html += '<tr><td class="flat">'+r.flatId+(f&&f.name?' <span style="color:var(--ink-soft);font-weight:400;">'+f.name+'</span>':'')+'</td>'
      + '<td class="num">'+fmtQty(r.previous)+'</td><td class="num">'+fmtQty(r.current)+'</td><td class="num">'+fmtQty(r.units)+'</td><td class="num">'+fmtTk(r.bill)+'</td>'
      + '<td class="num">';
    if(phone) html += '<button class="btn small secondary" data-wa="'+r.id+'" data-purchase="'+p.id+'">WA</button> ';
    if(isAdmin) html += '<button class="btn small secondary" data-edit-reading="'+r.id+'">Edit</button>';
    html += '</td></tr>';
    if(EDIT_READING_ID === r.id){
      html += '<tr><td colspan="6"><div class="inline-edit">'
        + '<div class="row3"><div><label>Flat</label><select id="erFlat">'+sortedFlats().map(function(fl){return '<option value="'+fl.id+'" '+(fl.id===r.flatId?'selected':'')+'>'+fl.id+'</option>';}).join('')+'</select></div>'
        + '<div><label>Previous</label><input type="number" step="0.01" id="erPrev" value="'+r.previous+'"></div>'
        + '<div><label>Current</label><input type="number" step="0.01" id="erCurr" value="'+r.current+'"></div></div>'
        + '<label>Purchase batch</label><select id="erBatch">'+DATA.purchases.map(function(pp){return '<option value="'+pp.id+'" '+(pp.id===r.purchaseId?'selected':'')+'>'+pp.id+'</option>';}).join('')+'</select>'
        + '<div class="hint">Moving this reading to a different batch fixes a mis-logged entry.</div>'
        + '<div class="rowbtns" style="margin-top:12px;"><button class="btn small" data-save-reading="'+r.id+'">Save</button><button class="btn secondary small" data-cancel-edit-reading="1">Cancel</button><button class="btn danger small" data-delete-reading="'+r.id+'">Delete</button></div>'
        + '</div></td></tr>';
    }
  });
  html += '</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">'+fmtQty(b.totalUnits)+'</td><td class="num">'+fmtTk(b.totalBill)+'</td><td></td></tr></tfoot></table></div>';

  const rec = computeReconciliation(p, DATA.readings);
  html += '<div class="hint" style="margin:16px 0 6px;">Purchase vs. consumption reconciliation:</div>';
  html += '<div class="subcard"><b style="font-size:13px;">Actual method</b>'
    + '<div class="hint" style="margin:4px 0 8px;">This ratio is derived FROM the purchased KG and metered units, so it will always land close to 100% \u2014 that\u2019s expected by construction, not proof there\u2019s no leakage.</div>'
    + '<div class="tablewrap"><table style="margin-top:0;"><tbody>'
    + '<tr><td>Purchased KG</td><td class="num">'+fmtQty(rec.purchasedKg)+'</td></tr>'
    + '<tr><td>Total metered units</td><td class="num">'+fmtQty(rec.totalUnits)+'</td></tr>'
    + '<tr><td>Actual KG conversion</td><td class="num">'+rec.actual.conversionRatio.toFixed(3)+' kg/unit</td></tr>'
    + '<tr><td>Calculated KG consumed</td><td class="num">'+fmtQty(rec.actual.calculatedKg)+'</td></tr>'
    + '<tr><td>Reconciliation</td><td class="num">'+rec.actual.reconciliationPct.toFixed(1)+'%</td></tr>'
    + '</tbody></table></div></div>';
  if(rec.manual){
    html += '<div class="subcard"><b style="font-size:13px;">Manual method</b>'
      + '<div class="hint" style="margin:4px 0 8px;">This compares purchased gas against what the fixed manual rate implies was consumed \u2014 the meaningful number for spotting leakage or unrecovered cost.</div>'
      + '<div class="tablewrap"><table style="margin-top:0;"><tbody>'
      + '<tr><td>Purchased KG</td><td class="num">'+fmtQty(rec.purchasedKg)+'</td></tr>'
      + '<tr><td>Manual conversion rate</td><td class="num">'+rec.manual.rate+' kg/unit</td></tr>'
      + '<tr><td>Implied KG consumed</td><td class="num">'+fmtQty(rec.manual.impliedKg)+'</td></tr>'
      + '<tr><td>Difference / unaccounted KG</td><td class="num">'+fmtQty(rec.manual.diffKg)+'</td></tr>'
      + '<tr><td>Recovery</td><td class="num">'+rec.manual.recoveryPct.toFixed(1)+'%</td></tr>'
      + '<tr><td>Variance</td><td class="num">Tk '+fmtTk(rec.manual.varianceTk)+'</td></tr>'
      + '</tbody></table></div></div>';
  } else {
    html += '<div class="method-note">Set a manual conversion rate on this batch (via the Manual toggle above) to see the leakage/recovery comparison here.</div>';
  }

  if(hasPermission(CURRENT_USER,'reports')){
    html += '<button class="btn secondary small" style="margin-top:12px;" data-print="'+p.id+'">Download PDF ('+ (method==='actual'?'Actual':'Manual') +')</button>';
  }
  html += '</div>';
  return html;
}

function viewPurchaseForm(){
  if(!can('addPurchase')) return '<div class="card"><div class="locked">Only the purchase manager or admin can log a gas purchase.</div></div>';
  const open = DATA.purchases.find(function(p){return p.status==='open';});
  let html = '<div class="card">';
  if(open){
    const t = cylinderTotals(open);
    const period = billingPeriod(open, DATA.readings);
    html += '<h2>Add a cylinder purchase</h2><p class="sub">Adding to the currently open batch <b>'+open.id+'</b>. Log every cylinder as you buy it \u2014 they all bill together, blended by cost, once you close this batch.</p>';
    html += '<div class="stat-grid"><div class="stat"><div class="v">'+(open.cylinders||[]).length+'</div><div class="l">Cylinders so far</div></div>'
      + '<div class="stat"><div class="v">'+fmtQty(t.kg)+' kg</div><div class="l">Total KG so far</div></div></div>';
    html += '<div class="hint" style="margin-top:8px;">Running cost: Tk '+fmtTk(t.cost)+(period?' \u00b7 cycle running '+period.days+' days so far':'')+'</div>';
    html += '<form id="cylForm" style="margin-top:16px;">'
      + '<label>Purchase date</label><input type="date" name="date" required value="'+new Date().toISOString().slice(0,10)+'">'
      + '<div class="row2"><div><label>KG in this cylinder</label><input type="number" step="0.01" name="kg" required></div>'
      + '<div><label>Cost (Tk)</label><input type="number" step="0.01" name="cost" required></div></div>'
      + '<label>Receipt photo (optional)</label><input type="file" accept="image/*" capture="environment" name="photo">'
      + '<button class="btn" type="submit">Add cylinder to '+open.id+'</button></form>';
    html += '<button class="btn secondary small" style="margin-top:18px;" data-close-batch="'+open.id+'">Close this batch & start a new cycle</button>'
      + '<div class="hint" style="margin-top:6px;">Close it once the last cylinder in this cycle runs out and meter readings are logged \u2014 typically 30\u201335 days. You can still add or fix cylinders afterward from Admin.</div>';
  } else {
    html += '<h2>Start a new purchase cycle</h2><p class="sub">Log the first cylinder of a fresh billing cycle. You\u2019ll be able to add more cylinders to this same batch over the coming weeks as you buy them.</p>'
      + '<form id="cylForm">'
      + '<label>Purchase date</label><input type="date" name="date" required value="'+new Date().toISOString().slice(0,10)+'">'
      + '<div class="row2"><div><label>KG in this cylinder</label><input type="number" step="0.01" name="kg" required></div>'
      + '<div><label>Cost (Tk)</label><input type="number" step="0.01" name="cost" required></div></div>'
      + '<label>Receipt photo (optional)</label><input type="file" accept="image/*" capture="environment" name="photo">'
      + '<button class="btn" type="submit">Start batch</button></form>';
  }
  html += '</div>';
  return html;
}

function viewReadingForm(){
  if(!can('addReading')) return '<div class="card"><div class="locked">Only the meter reader or admin can log meter readings.</div></div>';
  const openPurchases = DATA.purchases.filter(function(p){return p.status==='open';});
  if(openPurchases.length===0) return '<div class="card"><div class="empty">No open purchase batch. Ask the purchase manager to open one first.</div></div>';
  if(!ACTIVE_BATCH_ID || !openPurchases.find(function(p){return p.id===ACTIVE_BATCH_ID;})) ACTIVE_BATCH_ID = openPurchases[0].id;
  const activeBatch = openPurchases.find(function(p){return p.id===ACTIVE_BATCH_ID;});
  const activeFlats = sortedFlats().filter(function(f){return f.active;});

  let html = '<div class="card">';
  html += '<div class="batch-banner">Logging against batch <b>'+activeBatch.id+'</b>'
    + (openPurchases.length>1 ? ' &nbsp;<a data-switch-batch="1">switch</a>' : '')
    + '</div>';
  if(SHOW_BATCH_SWITCH && openPurchases.length>1){
    html += '<label>Switch active batch</label><select id="batchSwitchSelect">'
      + openPurchases.map(function(p){return '<option value="'+p.id+'" '+(p.id===ACTIVE_BATCH_ID?'selected':'')+'>'+p.id+'</option>';}).join('')
      + '</select>';
  }
  html += '<h2 style="margin-top:14px;">Log a meter reading</h2><p class="sub">The batch is fixed above \u2014 pick the flat, enter the reading, submit, repeat. No per-entry batch picking.</p>'
    + '<form id="readingForm">'
    + '<label>Flat</label><select name="flatId" id="flatSelect">'+activeFlats.map(function(f){return '<option value="'+f.id+'">'+f.id+(f.name?' \u2014 '+f.name:'')+'</option>';}).join('')+'</select>'
    + '<div class="row2"><div><label>Previous reading</label><input type="number" step="0.01" name="previous" id="prevInput" required></div>'
    + '<div><label>Current reading</label><input type="number" step="0.01" name="current" required></div></div>'
    + '<label>Meter photo (optional but recommended)</label><input type="file" accept="image/*" capture="environment" name="photo">'
    + '<button class="btn" type="submit">Save reading</button></form></div>';
  return html;
}

function autofillPrevious(){
  const flatSelect = document.getElementById('flatSelect');
  if(!flatSelect) return;
  const flatId = flatSelect.value;
  const last = DATA.readings.filter(function(r){return r.flatId===flatId;}).sort(function(a,b){return b.dateLogged.localeCompare(a.dateLogged);})[0];
  document.getElementById('prevInput').value = last ? last.current : 0;
}

function viewHistory(){
  const isResident = CURRENT_USER.role === 'resident';
  if(isResident && !CURRENT_USER.flat_id){
    return '<div class="card"><div class="empty">Your account isn\u2019t linked to a flat yet. Ask an admin to assign your flat in Admin \u2192 People & access.</div></div>';
  }
  if(isResident) HISTORY_FLAT = CURRENT_USER.flat_id;
  if(!HISTORY_FLAT) HISTORY_FLAT = DATA.flats[0] ? DATA.flats[0].id : null;
  if(!HISTORY_FLAT) return '<div class="card"><div class="empty">No flats set up yet.</div></div>';

  const cycles = flatCycles(HISTORY_FLAT, 'actual');
  const f = flatById(HISTORY_FLAT);

  let html = '<div class="card"><h2>Flat Dashboard</h2><p class="sub">Consumption, bills, and the full calculation chain for one flat.</p>';
  if(!isResident){
    html += '<select id="historyFlat">'+sortedFlats().map(function(fl){return '<option value="'+fl.id+'" '+(HISTORY_FLAT===fl.id?'selected':'')+'>'+fl.id+(fl.name?' \u2014 '+fl.name:'')+(fl.active?'':' (inactive)')+'</option>';}).join('')+'</select>';
  }
  html += '</div>';

  if(cycles.length===0){
    html += '<div class="card"><div class="empty">No billing cycles with a reading for '+HISTORY_FLAT+' yet.</div></div>';
    return html + photoHistorySection(HISTORY_FLAT);
  }

  const latest = cycles[cycles.length-1];
  const prevCycle = cycles.length>1 ? cycles[cycles.length-2] : null;

  html += '<div class="card"><h2>'+HISTORY_FLAT+(f&&f.name?' \u2014 '+f.name:'')+'</h2><p class="sub">'+cycleLabel(latest.period, cycles.length-1)+'</p>';
  html += '<div class="row2">'
    + '<div class="subcard" style="text-align:center;"><div class="bignum">'+fmtQty(latest.kg)+' kg</div><div class="bignum-l">This cycle consumed</div></div>'
    + '<div class="subcard" style="text-align:center;"><div class="bignum">Tk '+fmtTk(latest.bill)+'</div><div class="bignum-l">This cycle bill</div></div>'
    + '</div>';
  if(prevCycle){
    const pctChange = prevCycle.kg>0 ? ((latest.kg-prevCycle.kg)/prevCycle.kg*100) : 0;
    const dir = pctChange>0.05 ? 'increased' : (pctChange<-0.05 ? 'decreased' : 'stayed about the same as');
    html += '<div class="hint" style="margin-top:10px;">Consumption '+dir+(Math.abs(pctChange)>=0.05?' by '+Math.abs(pctChange).toFixed(1)+'%':'')+' compared with last cycle ('+fmtQty(prevCycle.kg)+' kg).</div>';
  }

  html += '<div class="hint" style="margin:14px 0 6px;">Calculation chain for this cycle:</div>';
  html += '<div class="subcard"><div class="tablewrap"><table style="margin-top:0;"><tbody>'
    + '<tr><td>Previous Reading</td><td class="num">'+fmtQty(latest.previous)+'</td></tr>'
    + '<tr><td>Current Reading</td><td class="num">'+fmtQty(latest.current)+'</td></tr>'
    + '<tr><td>Units Consumed</td><td class="num">'+fmtQty(latest.units)+'</td></tr>'
    + '<tr><td>KG Consumed</td><td class="num">'+fmtQty(latest.kg)+' kg</td></tr>'
    + '<tr><td>Rate</td><td class="num">Tk '+fmtTk(latest.pricePerKg)+'/kg</td></tr>'
    + '<tr><td>Total Bill</td><td class="num">Tk '+fmtTk(latest.bill)+'</td></tr>'
    + '</tbody></table></div>'
    + (hasPermission(CURRENT_USER,'reports') ? '<button class="btn secondary small" data-flat-pdf="'+HISTORY_FLAT+'" data-cycle-num="'+cycles.length+'" style="margin-top:10px;">Download this cycle (PDF)</button>' : '')
    + '</div>';

  const kgs = cycles.map(function(c){return c.kg;});
  const bills = cycles.map(function(c){return c.bill;});
  html += '<div class="hint" style="margin:14px 0 6px;">Consumption summary:</div>';
  html += '<div class="stat-grid-3">'
    + '<div class="stat"><div class="v">'+fmtQty(latest.kg)+'</div><div class="l">This cycle kg</div></div>'
    + '<div class="stat"><div class="v">'+(prevCycle?fmtQty(prevCycle.kg):'\u2014')+'</div><div class="l">Previous cycle kg</div></div>'
    + '<div class="stat"><div class="v">'+fmtQty(avg(kgs.slice(-3)))+'</div><div class="l">Avg last 3</div></div>'
    + '<div class="stat"><div class="v">'+fmtQty(avg(kgs.slice(-6)))+'</div><div class="l">Avg last 6</div></div>'
    + '<div class="stat"><div class="v">'+fmtQty(kgs.slice(-12).reduce(function(s,v){return s+v;},0))+'</div><div class="l">Total last 12</div></div>'
    + '<div class="stat"><div class="v">'+cycles.length+'</div><div class="l">Cycles on record</div></div>'
    + '</div>';
  html += '<div class="hint" style="margin:14px 0 6px;">Billing summary:</div>';
  html += '<div class="stat-grid-3">'
    + '<div class="stat"><div class="v">Tk '+fmtTk(latest.bill)+'</div><div class="l">This cycle</div></div>'
    + '<div class="stat"><div class="v">'+(prevCycle?'Tk '+fmtTk(prevCycle.bill):'\u2014')+'</div><div class="l">Previous cycle</div></div>'
    + '<div class="stat"><div class="v">Tk '+fmtTk(avg(bills.slice(-3)))+'</div><div class="l">Avg last 3</div></div>'
    + '<div class="stat"><div class="v">Tk '+fmtTk(avg(bills.slice(-6)))+'</div><div class="l">Avg last 6</div></div>'
    + '<div class="stat"><div class="v">Tk '+fmtTk(bills.reduce(function(s,v){return s+v;},0))+'</div><div class="l">Total, all cycles</div></div>'
    + '<div class="stat"><div class="v">Tk '+fmtTk(avg(bills))+'</div><div class="l">Avg / cycle</div></div>'
    + '</div>';

  if(cycles.length>=3){
    const priorAvg = avg(kgs.slice(0,-1));
    const threshold = (DATA.settings && DATA.settings.abnormalThresholdPct!=null) ? DATA.settings.abnormalThresholdPct : 25;
    if(priorAvg>0){
      const changePct = (latest.kg-priorAvg)/priorAvg*100;
      if(changePct >= threshold){
        html += '<div class="warn-box">\u26a0\ufe0f Higher than usual \u2014 '+HISTORY_FLAT+' consumed '+fmtQty(latest.kg)+' kg this cycle. Average previous consumption: '+fmtQty(priorAvg)+' kg. Increase: '+changePct.toFixed(1)+'%.</div>';
      } else if(changePct <= -threshold){
        html += '<div class="warn-box">\u26a0\ufe0f Lower than usual \u2014 '+HISTORY_FLAT+' consumed '+fmtQty(latest.kg)+' kg this cycle, '+Math.abs(changePct).toFixed(1)+'% below its usual average of '+fmtQty(priorAvg)+' kg. Worth checking a reading wasn\u2019t missed.</div>';
      }
    }
  }
  html += '</div>';

  const rangeN = GRAPH_RANGE==='all' ? cycles.length : Math.min(parseInt(GRAPH_RANGE,10), cycles.length);
  const shown = cycles.slice(-rangeN);
  const shownLabels = shown.map(function(c){ return 'C'+(cycles.indexOf(c)+1); });
  const legend = shown.map(function(c){ return 'C'+(cycles.indexOf(c)+1)+' = '+cycleShortRange(c.period); }).join(' \u00b7 ');

  html += '<div class="card"><h2>Monthly LPG consumption</h2><p class="sub">'+HISTORY_FLAT+' \u2014 by billing cycle, not calendar month</p>'
    + '<div class="range-toggle">'
      + '<button data-range="6" class="'+(GRAPH_RANGE==='6'?'on':'')+'">6 cycles</button>'
      + '<button data-range="12" class="'+(GRAPH_RANGE==='12'?'on':'')+'">12 cycles</button>'
      + '<button data-range="all" class="'+(GRAPH_RANGE==='all'?'on':'')+'">All</button>'
    + '</div>'
    + barChart(shown.map(function(c){return c.kg;}), shownLabels, 'var(--flame)')
    + '<div class="chart-legend">'+legend+'</div></div>';

  html += '<div class="card"><h2>Monthly LPG bill</h2><p class="sub">Same cycles, billed amount (Tk)</p>'
    + barChart(shown.map(function(c){return c.bill;}), shownLabels, 'var(--teal)')
    + '<div class="chart-legend">'+legend+'</div></div>';

  html += '<div class="card"><h2>Billing history</h2><p class="sub">Complete calculation chain for every cycle.</p>'
    + '<div class="tablewrap"><table><thead><tr><th>Cycle</th><th class="num">Prev</th><th class="num">Curr</th><th class="num">Units</th><th class="num">KG</th><th class="num">Rate/kg</th><th class="num">Bill</th></tr></thead><tbody>'
    + cycles.slice().reverse().map(function(c){
        const idx = cycles.indexOf(c);
        return '<tr><td>'+cycleLabel(c.period, idx)+'</td><td class="num">'+fmtQty(c.previous)+'</td><td class="num">'+fmtQty(c.current)+'</td><td class="num">'+fmtQty(c.units)+'</td><td class="num">'+fmtQty(c.kg)+'</td><td class="num">Tk '+fmtTk(c.pricePerKg)+'</td><td class="num">Tk '+fmtTk(c.bill)+'</td></tr>';
      }).join('')
    + '</tbody></table></div></div>';

  return html + photoHistorySection(HISTORY_FLAT);
}

function photoHistorySection(flatId){
  const items = DATA.readings.filter(function(r){return r.flatId===flatId;}).sort(function(a,b){return b.dateLogged.localeCompare(a.dateLogged);});
  let html = '<div class="card"><h2>Meter reading photos</h2><p class="sub">Proof photo for every reading logged.</p>';
  if(items.length===0) html += '<div class="empty">No readings logged for this flat yet.</div>';
  items.forEach(function(r){
    html += '<div class="flat-history">'
      + (r.hasPhoto ? '<div>'
          + '<img src="" data-reading="'+r.id+'" class="hist-photo">'
          + (CURRENT_USER.role==='admin' ? '<div style="text-align:center;margin-top:3px;"><a data-del-photo="'+r.id+'" style="font-size:10px;color:var(--red);cursor:pointer;text-decoration:underline;">delete photo</a></div>' : '')
          + '</div>'
        : '<div class="ph-none">no photo</div>')
      + '<div class="fh-body"><b>'+r.previous+' \u2192 '+r.current+' ('+(r.current-r.previous)+' units)</b>'
      + '<div class="fh-meta">'+r.dateLogged+' \u00b7 batch '+r.purchaseId+' \u00b7 logged by '+r.loggedBy+'</div></div></div>';
  });
  html += '</div>';
  return html;
}

function loadPhotosForHistory(){
  document.querySelectorAll('.hist-photo').forEach(function(img){
    const url = photoUrl(img.dataset.reading);
    if(url){ img.src = url; img.onclick = function(){ showPhotoModal(url); }; }
  });
}

function showPhotoModal(src){
  if(!src) return;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = '<img src="'+src+'">';
  bg.onclick = function(){ bg.remove(); };
  document.body.appendChild(bg);
}

function renderPeopleRow(u, isAdminEditor){
  const isSelf = u.id === CURRENT_USER.id;
  const targetIsAdmin = u.role === 'admin';
  const canEditThisRow = isAdminEditor || (!targetIsAdmin && !isSelf);

  let html = '<div class="user-row" style="flex-wrap:wrap;align-items:flex-start;">';
  html += '<div class="ui"><b>'+u.name+'</b><span>'+u.email
    + (u.role==='pending' ? ' \u00b7 awaiting approval' : ' \u00b7 '+ROLE_LABEL[u.role])
    + (u.role==='resident' && u.flat_id ? ' \u00b7 flat '+u.flat_id : '')
    + '</span></div>';

  if(!canEditThisRow){
    html += '<div class="hint">'+(targetIsAdmin ? 'Admin account \u2014 not editable here.' : 'Your own account.')+'</div></div>';
    return html;
  }
  if(targetIsAdmin){
    html += '<div class="hint">Admin \u2014 full access, nothing to configure.</div></div>';
    return html;
  }

  if(isAdminEditor){
    html += '<select data-profile="'+u.id+'" class="roleSelect">'
      + '<option value="pending" '+(u.role==='pending'?'selected':'')+'>Pending</option>'
      + '<option value="resident" '+(u.role==='resident'?'selected':'')+'>Resident</option>'
      + '<option value="admin" '+(u.role==='admin'?'selected':'')+'>Admin</option>'
      + '</select>';
  } else if(u.role==='pending'){
    html += '<button class="btn small" data-approve-resident="'+u.id+'">Approve as resident</button>';
  }

  if(u.role==='resident'){
    html += '<select data-profile-flat="'+u.id+'"><option value="">No flat</option>'+sortedFlats().map(function(fl){return '<option value="'+fl.id+'" '+(u.flat_id===fl.id?'selected':'')+'>'+fl.id+'</option>';}).join('')+'</select>';
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    const hasFlat = !!u.flat_id;
    html += '<div class="perm-grid" data-perm-owner="'+u.id+'">';
    Object.keys(PERMISSION_LABELS).forEach(function(key){
      if(key==='my_flat'){
        html += '<label class="permchk"><input type="checkbox" checked disabled> My Flat'+(hasFlat?'':' (no flat assigned yet)')+'</label>';
        return;
      }
      const locked = !isAdminEditor && (key==='people_access' || key==='settings');
      html += '<label class="permchk"><input type="checkbox" class="permInput" data-perm="'+key+'" '+(perms.indexOf(key)!==-1?'checked':'')+' '+(locked?'disabled':'')+'> '+PERMISSION_LABELS[key]+(locked?' (admin only)':'')+'</label>';
    });
    html += '</div><button class="btn small secondary" data-save-perms="'+u.id+'" style="margin-top:8px;">Save permissions</button>';
  }

  if(isAdminEditor && !isSelf) html += '<button class="btn danger small" data-remove-profile="'+u.id+'">Remove</button>';
  html += '</div>';
  return html;
}

function viewAdmin(){
  const isAdmin = CURRENT_USER.role === 'admin';
  const canPeople = isAdmin || hasPermission(CURRENT_USER,'people_access');
  const canSettings = isAdmin || hasPermission(CURRENT_USER,'settings');
  if(!canPeople && !canSettings) return '<div class="card"><div class="locked">No Admin sections available to you.</div></div>';

  let html = '';
  if(canPeople){
    html += '<div class="card"><h2>People & access</h2><p class="sub">Share your app link \u2014 anyone can create an account from the sign-in screen, but nothing is granted until approved here.'+(isAdmin?' Only admins can change roles, grant People & Access/Settings, or remove access.':' You can approve new sign-ups and adjust a resident\u2019s flat and permissions, but not roles, People & Access, Settings, or admin accounts.')+'</p>';
    if(PROFILES.length===0) html += '<div class="empty">No accounts yet, or still loading\u2026</div>';
    PROFILES.forEach(function(u){ html += renderPeopleRow(u, isAdmin); });
    html += '</div>';
  }

  if(canSettings){
    html += '<div class="card"><h2>Abnormal consumption alerts</h2><p class="sub">A flat\u2019s consumption is flagged on its dashboard when it swings this much versus its own average (needs at least 3 cycles of history).</p>'
      + '<label>Flag when consumption changes by more than</label><input type="number" id="thresholdInput" value="'+((DATA.settings&&DATA.settings.abnormalThresholdPct!=null)?DATA.settings.abnormalThresholdPct:25)+'" min="5" max="200" step="1"> <span class="hint">%</span>'
      + '<button class="btn small" id="saveThreshold" style="margin-top:12px;">Save</button></div>';

    html += '<div class="card"><h2>Free up photo storage</h2><p class="sub">Deletes old proof photos only \u2014 every reading, cylinder record, and bill stays exactly as it is. Photos are already shrunk automatically when captured; use this if storage space still gets tight.</p>'
      + '<label>Delete photos older than</label><select id="cleanupCutoff"><option value="3">3 months</option><option value="6" selected>6 months</option><option value="12">12 months</option></select>'
      + '<button class="btn danger small" id="cleanupPhotos" style="margin-top:12px;">Delete old photos</button></div>';
  }

  if(canPeople){
    html += '<div class="card"><h2>Flats & residents</h2><p class="sub">Add missing flats (e.g. 8D), rename residents, set phone numbers, and mark a flat inactive when it is not using LPG. Inactive flats are hidden from the reading form but keep their history.</p>';
    sortedFlats().forEach(function(f){
      html += '<div class="flatrow '+(f.active?'':'inactive')+'">'
        + '<div class="fid">'+f.id+'</div>'
        + '<input type="text" class="flatName" data-flat="'+f.id+'" value="'+(f.name||'')+'" placeholder="Resident name">'
        + '<input type="text" class="flatPhone" data-flat="'+f.id+'" value="'+(f.phone||'')+'" placeholder="8801XXXXXXXXX">'
        + '<span class="pill '+(f.active?'active':'inactive')+'" data-toggle-active="'+f.id+'">'+(f.active?'Active':'Inactive')+'</span>'
        + '<button class="btn danger small" data-remove-flat="'+f.id+'">Del</button>'
        + '</div>';
    });
    html += '<button class="btn" id="saveFlats" style="margin-top:14px;">Save flats & residents</button></div>';

    html += '<div class="card"><h2>Add a flat</h2><form id="addFlatForm">'
      + '<div class="row3"><div><label>Flat ID</label><input type="text" name="flatId" placeholder="e.g. 8D" required></div>'
      + '<div><label>Resident name</label><input type="text" name="name"></div>'
      + '<div><label>Phone</label><input type="text" name="phone" placeholder="8801XXXXXXXXX"></div></div>'
      + '<button class="btn" type="submit">Add flat</button></form></div>';
  }
  return html;
}

function bindMainEvents(){
  document.querySelectorAll('.purchase-row').forEach(function(row){
    row.onclick = function(){ EXPANDED_PURCHASE = EXPANDED_PURCHASE===row.dataset.purchase ? null : row.dataset.purchase; EDIT_PURCHASE_ID=null; EDIT_READING_ID=null; SET_RATE_FOR=null; renderMain(); };
  });

  document.querySelectorAll('[data-method]').forEach(function(btn){
    btn.onclick = function(e){ e.stopPropagation(); REPORT_METHOD[btn.dataset.purchase] = btn.dataset.method; renderMain(); };
  });
  document.querySelectorAll('[data-edit-rate]').forEach(function(a){
    a.onclick = function(e){ e.stopPropagation(); SET_RATE_FOR = a.dataset.editRate; renderMain(); };
  });
  document.querySelectorAll('[data-cancel-rate]').forEach(function(b){ b.onclick = function(e){ e.stopPropagation(); SET_RATE_FOR=null; renderMain(); }; });
  document.querySelectorAll('[data-save-rate]').forEach(function(b){
    b.onclick = async function(e){
      e.stopPropagation();
      const p = DATA.purchases.find(function(x){return x.id===b.dataset.saveRate;});
      p.manualRate = parseFloat(document.getElementById('manualRateInput').value) || 0;
      SET_RATE_FOR = null;
      await saveStore('lpg-data', true, DATA);
      toast('Manual rate saved \u2014 reports can be re-printed with this value.');
      renderMain();
    };
  });

  document.querySelectorAll('[data-edit-purchase]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); EDIT_PURCHASE_ID = b.dataset.editPurchase; const p = DATA.purchases.find(function(x){return x.id===EDIT_PURCHASE_ID;}); EDIT_CYLINDERS = (p.cylinders||[]).map(function(c){return Object.assign({},c);}); renderMain(); }; });
  document.querySelectorAll('[data-cancel-edit-purchase]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); EDIT_PURCHASE_ID=null; EDIT_CYLINDERS=[]; renderMain(); }; });
  function captureCylinderEdits(){
    document.querySelectorAll('.cylDate').forEach(function(inp){ const c = EDIT_CYLINDERS.find(function(x){return x.id===inp.dataset.cyl;}); if(c) c.date = inp.value; });
    document.querySelectorAll('.cylKg').forEach(function(inp){ const c = EDIT_CYLINDERS.find(function(x){return x.id===inp.dataset.cyl;}); if(c) c.kg = inp.value; });
    document.querySelectorAll('.cylCost').forEach(function(inp){ const c = EDIT_CYLINDERS.find(function(x){return x.id===inp.dataset.cyl;}); if(c) c.cost = inp.value; });
  }
  document.querySelectorAll('[data-add-cyl]').forEach(function(b){
    b.onclick = function(e){ e.stopPropagation(); captureCylinderEdits(); EDIT_CYLINDERS.push({ id: uid('CYL'), date: new Date().toISOString().slice(0,10), kg:'', cost:'' }); renderMain(); };
  });
  document.querySelectorAll('[data-del-cyl]').forEach(function(b){
    b.onclick = function(e){ e.stopPropagation(); captureCylinderEdits(); EDIT_CYLINDERS = EDIT_CYLINDERS.filter(function(c){return c.id!==b.dataset.delCyl;}); renderMain(); };
  });
  document.querySelectorAll('[data-save-purchase]').forEach(function(b){
    b.onclick = async function(e){
      e.stopPropagation();
      captureCylinderEdits();
      const p = DATA.purchases.find(function(x){return x.id===b.dataset.savePurchase;});
      p.cylinders = EDIT_CYLINDERS.map(function(c){ return { id:c.id, date:c.date, kg:parseFloat(c.kg)||0, cost:parseFloat(c.cost)||0, hasPhoto: !!c.hasPhoto }; }).filter(function(c){ return c.kg>0 || c.cost>0; });
      p.status = document.getElementById('epStatus').value;
      EDIT_PURCHASE_ID = null; EDIT_CYLINDERS = [];
      await saveStore('lpg-data', true, DATA);
      toast('Batch updated');
      renderMain();
    };
  });
  document.querySelectorAll('[data-view-cyl-photo]').forEach(function(b){
    b.onclick = function(e){ e.stopPropagation(); showPhotoModal(photoUrl(b.dataset.viewCylPhoto)); };
  });
  document.querySelectorAll('[data-close-batch]').forEach(function(b){
    b.onclick = async function(){
      if(!confirm('Close this batch? Make sure meter readings for this cycle are logged first \u2014 you can still fix cylinder details later from a batch\u2019s Edit button.')) return;
      const p = DATA.purchases.find(function(x){return x.id===b.dataset.closeBatch;});
      p.status = 'closed';
      await saveStore('lpg-data', true, DATA);
      toast('Batch '+p.id+' closed');
      TAB='dashboard'; EXPANDED_PURCHASE=p.id; renderAll();
    };
  });

  document.querySelectorAll('[data-edit-reading]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); EDIT_READING_ID = b.dataset.editReading; renderMain(); }; });
  document.querySelectorAll('[data-cancel-edit-reading]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); EDIT_READING_ID=null; renderMain(); }; });
  document.querySelectorAll('[data-save-reading]').forEach(function(b){
    b.onclick = async function(e){
      e.stopPropagation();
      const r = DATA.readings.find(function(x){return x.id===b.dataset.saveReading;});
      r.flatId = document.getElementById('erFlat').value;
      r.previous = parseFloat(document.getElementById('erPrev').value);
      r.current = parseFloat(document.getElementById('erCurr').value);
      r.purchaseId = document.getElementById('erBatch').value;
      EDIT_READING_ID = null;
      await saveStore('lpg-data', true, DATA);
      toast('Reading updated');
      renderMain();
    };
  });
  document.querySelectorAll('[data-delete-reading]').forEach(function(b){
    b.onclick = async function(e){
      e.stopPropagation();
      if(!confirm('Delete this reading? This cannot be undone.')) return;
      DATA.readings = DATA.readings.filter(function(x){return x.id!==b.dataset.deleteReading;});
      EDIT_READING_ID = null;
      await saveStore('lpg-data', true, DATA);
      toast('Reading deleted');
      renderMain();
    };
  });

  document.querySelectorAll('[data-print]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); generatePdf(b.dataset.print, REPORT_METHOD[b.dataset.print]||'actual'); }; });
  document.querySelectorAll('[data-flat-pdf]').forEach(function(b){
    b.onclick = function(e){
      e.stopPropagation();
      const flatId = b.dataset.flatPdf;
      const cycleNum = parseInt(b.dataset.cycleNum,10);
      const cycles = flatCycles(flatId, 'actual');
      const cycle = cycles[cycleNum-1];
      if(cycle) generateFlatPdf(flatId, cycle, cycleNum);
    };
  });
  document.querySelectorAll('[data-wa]').forEach(function(b){
    b.onclick = function(e){ e.stopPropagation(); const link = waLink(b.dataset.wa, b.dataset.purchase, REPORT_METHOD[b.dataset.purchase]||'actual'); if(link) window.open(link,'_blank'); };
  });

  const cf = document.getElementById('cylForm');
  if(cf) cf.onsubmit = async function(e){
    e.preventDefault();
    const fd = new FormData(cf);
    let open = DATA.purchases.find(function(p){return p.status==='open';});
    const cylId = uid('CYL');
    const file = fd.get('photo');
    let hasPhoto = false;
    if(file && file.size > 0){
      const dataUrl = await compressImage(file);
      await saveStore('photo:'+cylId, true, dataUrl);
      hasPhoto = true;
    }
    const cyl = { id: cylId, date: fd.get('date'), kg: parseFloat(fd.get('kg')), cost: parseFloat(fd.get('cost')), hasPhoto: hasPhoto };
    let isNewBatch = false;
    if(!open){
      open = { id: nextPurchaseId(), status:'open', manualRate:null, cylinders: [] };
      DATA.purchases.push(open);
      ACTIVE_BATCH_ID = open.id;
      isNewBatch = true;
    }
    open.cylinders.push(cyl);
    await saveStore('lpg-data', true, DATA);
    toast(isNewBatch ? 'Batch '+open.id+' started' : 'Cylinder added to '+open.id);
    cf.reset();
    renderMain();
  };

  const fs = document.getElementById('flatSelect');
  if(fs){ fs.onchange = autofillPrevious; autofillPrevious(); }
  const switchLink = document.querySelector('[data-switch-batch]');
  if(switchLink) switchLink.onclick = function(){ SHOW_BATCH_SWITCH = !SHOW_BATCH_SWITCH; renderMain(); };
  const bss = document.getElementById('batchSwitchSelect');
  if(bss) bss.onchange = function(){ ACTIVE_BATCH_ID = bss.value; SHOW_BATCH_SWITCH=false; renderMain(); };

  const rf = document.getElementById('readingForm');
  if(rf) rf.onsubmit = async function(e){
    e.preventDefault();
    const fd = new FormData(rf);
    const readingId = uid('R');
    const file = fd.get('photo');
    let hasPhoto = false;
    if(file && file.size > 0){
      const dataUrl = await compressImage(file);
      await saveStore('photo:'+readingId, true, dataUrl);
      hasPhoto = true;
    }
    const reading = { id: readingId, purchaseId: ACTIVE_BATCH_ID, flatId: fd.get('flatId'), previous: parseFloat(fd.get('previous')), current: parseFloat(fd.get('current')), dateLogged: new Date().toISOString().slice(0,10), loggedBy: CURRENT_USER.name, hasPhoto: hasPhoto };
    DATA.readings.push(reading);
    await saveStore('lpg-data', true, DATA);
    toast('Reading saved for '+reading.flatId);
    rf.reset(); autofillPrevious();
  };

  const hf = document.getElementById('historyFlat');
  if(hf){ hf.onchange = function(){ HISTORY_FLAT = hf.value; renderMain(); }; }
  if(TAB==='history') loadPhotosForHistory();
  document.querySelectorAll('[data-range]').forEach(function(b){
    b.onclick = function(){ GRAPH_RANGE = b.dataset.range; renderMain(); };
  });
  document.querySelectorAll('[data-del-photo]').forEach(function(a){
    a.onclick = async function(){
      if(!confirm('Delete this photo? The reading itself stays \u2014 only the image is removed.')) return;
      try{ await sb.storage.from('meter-photos').remove([a.dataset.delPhoto+'.jpg']); }catch(err){ console.error(err); }
      const r = DATA.readings.find(function(x){return x.id===a.dataset.delPhoto;});
      if(r) r.hasPhoto = false;
      await saveStore('lpg-data', true, DATA);
      toast('Photo deleted');
      renderMain();
    };
  });

  document.querySelectorAll('.roleSelect').forEach(function(sel){
    sel.onchange = async function(){
      const { error } = await sb.from('profiles').update({ role: sel.value }).eq('id', sel.dataset.profile);
      if(error){ toast('Update failed'); return; }
      toast('Role updated'); await loadProfiles();
    };
  });
  document.querySelectorAll('[data-approve-resident]').forEach(function(btn){
    btn.onclick = async function(){
      const { error } = await sb.from('profiles').update({ role: 'resident' }).eq('id', btn.dataset.approveResident);
      if(error){ toast('Approval failed'); return; }
      toast('Approved as resident'); await loadProfiles();
    };
  });
  document.querySelectorAll('[data-save-perms]').forEach(function(btn){
    btn.onclick = async function(){
      const owner = btn.dataset.savePerms;
      const grid = document.querySelector('[data-perm-owner="'+owner+'"]');
      const checked = Array.prototype.slice.call(grid.querySelectorAll('.permInput')).filter(function(i){return i.checked;}).map(function(i){return i.dataset.perm;});
      const { error } = await sb.from('profiles').update({ permissions: checked }).eq('id', owner);
      if(error){ toast('Save failed'); return; }
      toast('Permissions saved'); await loadProfiles();
    };
  });
  document.querySelectorAll('[data-profile-flat]').forEach(function(sel){
    sel.onchange = async function(){
      const { error } = await sb.from('profiles').update({ flat_id: sel.value || null }).eq('id', sel.dataset.profileFlat);
      if(error){ toast('Update failed'); return; }
      toast('Flat assigned'); await loadProfiles();
    };
  });
  document.querySelectorAll('[data-remove-profile]').forEach(function(btn){
    btn.onclick = async function(){
      if(!confirm("Remove this person's access? They can request access again later.")) return;
      const { error } = await sb.from('profiles').delete().eq('id', btn.dataset.removeProfile);
      if(error){ toast('Remove failed'); return; }
      toast('Access removed'); await loadProfiles();
    };
  });
  const saveThresholdBtn = document.getElementById('saveThreshold');
  if(saveThresholdBtn) saveThresholdBtn.onclick = async function(){
    const v = parseFloat(document.getElementById('thresholdInput').value);
    if(!DATA.settings) DATA.settings = {};
    DATA.settings.abnormalThresholdPct = isFinite(v) ? v : 25;
    await saveStore('lpg-data', true, DATA);
    toast('Threshold saved');
  };

  document.querySelectorAll('[data-toggle-active]').forEach(function(p){
    p.onclick = function(){ const f = flatById(p.dataset.toggleActive); f.active = !f.active; renderMain(); };
  });
  document.querySelectorAll('[data-remove-flat]').forEach(function(b){
    b.onclick = function(){
      if(DATA.readings.some(function(r){return r.flatId===b.dataset.removeFlat;})){ toast("Can't delete \u2014 this flat has reading history. Mark it inactive instead."); return; }
      if(!confirm('Remove this flat?')) return;
      DATA.flats = DATA.flats.filter(function(f){return f.id!==b.dataset.removeFlat;});
      renderMain();
    };
  });
  const cleanupBtn = document.getElementById('cleanupPhotos');
  if(cleanupBtn) cleanupBtn.onclick = async function(){
    const months = parseInt(document.getElementById('cleanupCutoff').value,10);
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-months);
    const cutoffStr = cutoff.toISOString().slice(0,10);
    const oldReadings = DATA.readings.filter(function(r){return r.hasPhoto && r.dateLogged < cutoffStr;});
    const oldCyls = [];
    DATA.purchases.forEach(function(p){ (p.cylinders||[]).forEach(function(c){ if(c.hasPhoto && c.date < cutoffStr) oldCyls.push(c); }); });
    const total = oldReadings.length + oldCyls.length;
    if(total===0){ toast('No photos older than that cutoff'); return; }
    if(!confirm('Delete '+total+' photo(s) older than '+cutoffStr+'? Only the images go \u2014 readings and cylinder records stay.')) return;
    const paths = oldReadings.map(function(r){return r.id+'.jpg';}).concat(oldCyls.map(function(c){return c.id+'.jpg';}));
    try{ await sb.storage.from('meter-photos').remove(paths); }catch(err){ console.error(err); }
    oldReadings.forEach(function(r){ r.hasPhoto=false; });
    oldCyls.forEach(function(c){ c.hasPhoto=false; });
    await saveStore('lpg-data', true, DATA);
    toast('Deleted '+total+' old photo(s)');
    renderMain();
  };

  const saveFlatsBtn = document.getElementById('saveFlats');
  if(saveFlatsBtn) saveFlatsBtn.onclick = async function(){
    document.querySelectorAll('.flatName').forEach(function(inp){ flatById(inp.dataset.flat).name = inp.value.trim(); });
    document.querySelectorAll('.flatPhone').forEach(function(inp){ flatById(inp.dataset.flat).phone = inp.value.trim(); });
    await saveStore('lpg-data', true, DATA);
    toast('Flats & residents saved');
  };
  const addFlatForm = document.getElementById('addFlatForm');
  if(addFlatForm) addFlatForm.onsubmit = async function(e){
    e.preventDefault();
    const fd = new FormData(addFlatForm);
    const id = fd.get('flatId').trim();
    if(!id){ return; }
    if(DATA.flats.find(function(f){return f.id===id;})){ toast('That flat ID already exists'); return; }
    DATA.flats.push({ id: id, name: fd.get('name').trim(), phone: fd.get('phone').trim(), active: true });
    await saveStore('lpg-data', true, DATA);
    toast('Flat '+id+' added');
    addFlatForm.reset(); renderMain();
  };
}

function compressImage(file){
  return new Promise(function(resolve){
    const reader = new FileReader();
    reader.onload = function(e){
      const img = new Image();
      img.onload = function(){
        const maxW = 480;
        const scale = Math.min(1, maxW/img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width*scale; canvas.height = img.height*scale;
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.5));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function barChart(values, shortLabels, colorVar){
  const w = 320, h = 150, pad = 26;
  const max = Math.max.apply(null, values.concat([0.01]));
  const gap = (w - pad*2) / Math.max(values.length,1);
  const barW = Math.min(gap*0.6, 34);
  let bars = '';
  values.forEach(function(v,i){
    const bh = max>0 ? (v/max) * (h - pad*2 - 14) : 0;
    const x = pad + i*gap + (gap-barW)/2;
    const y = h - pad - bh;
    bars += '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+bh.toFixed(1)+'" rx="3" fill="'+colorVar+'"></rect>';
    bars += '<text x="'+(x+barW/2).toFixed(1)+'" y="'+(y-4).toFixed(1)+'" font-size="9" text-anchor="middle" fill="var(--ink-soft)">'+fmtQty(v)+'</text>';
    bars += '<text x="'+(x+barW/2).toFixed(1)+'" y="'+(h-8)+'" font-size="8.5" text-anchor="middle" fill="var(--ink-soft)">'+(shortLabels[i]||'')+'</text>';
  });
  return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:150px;" preserveAspectRatio="xMidYMid meet">'+bars+'<line x1="'+pad+'" y1="'+(h-pad)+'" x2="'+(w-pad)+'" y2="'+(h-pad)+'" stroke="var(--line)"></line></svg>';
}

function waLink(readingId, purchaseId, method){
  const p = DATA.purchases.find(function(x){return x.id===purchaseId;});
  const b = computeBilling(p, DATA.readings, method);
  const row = b.rows.find(function(r){return r.id===readingId;});
  const f = flatById(row.flatId);
  const phone = (f.phone||'').replace(/[^0-9]/g,'');
  if(!phone || !row) return null;
  const greeting = f.name ? ('Dear '+f.name+', (Flat '+f.id+')') : ('Dear Flat '+f.id+' User,');
  const rateLine = method==='manual'
    ? ('Manual Conversion Rate: '+b.rate.toFixed(2)+' kg/unit')
    : ('Conversion Ratio (Actual): '+b.rate.toFixed(2)+' kg/unit');
  const msg = greeting+'\nYour LPG bill for '+p.id+' is ready.\n'
    + 'Previous Reading: '+fmtQty(row.previous)+' | Current Reading: '+fmtQty(row.current)+'\n'
    + 'Units Used: '+fmtQty(row.units)+' | '+rateLine+' | Price Per KG: '+fmtTk(b.pricePerKg)+' TK.\n'
    + 'Bill Amount: '+fmtTk(row.bill)+' TK.\n'
    + 'Please pay at your earliest convenience.\nThank you!';
  return 'https://wa.me/'+phone+'?text='+encodeURIComponent(msg);
}

async function boot(){
  if(!sb){ AUTH_STATUS = 'nobackend'; renderAll(); return; }
  sb.auth.onAuthStateChange(function(event){
    if(event === 'SIGNED_OUT'){ AUTH_STATUS='signedout'; CURRENT_USER=null; renderAll(); }
  });
  await checkSession();
}

boot();
if('serviceWorker' in navigator){
  window.addEventListener('load', function(){ navigator.serviceWorker.register('service-worker.js').catch(function(){}); });
}
