// Pure billing/consumption math — no DOM, no Supabase calls.
// This is the single source of truth for every calculation in the app.
// Do not duplicate this logic elsewhere (PDF export and the Flat Dashboard both call into these functions).

function uid(prefix){ return prefix + '-' + Math.random().toString(36).slice(2,8); }

function seedFlats(){
  const out = [];
  for(let floor=1; floor<=11; floor++){
    for(const w of ['A','B','C']) out.push({ id: floor+w, name:'', phone:'', active:true });
  }
  return out;
}

function flatSortKey(id){
  const m = /^(\d+)([A-Za-z]*)$/.exec(id||'');
  return m ? [parseInt(m[1],10), m[2]] : [999999, id||''];
}

function naturalFlatCompare(idA, idB){
  const ka = flatSortKey(idA), kb = flatSortKey(idB);
  if(ka[0]!==kb[0]) return ka[0]-kb[0];
  return ka[1].localeCompare(kb[1]);
}

function sortedFlats(){ return DATA.flats.slice().sort(function(a,b){ return naturalFlatCompare(a.id,b.id); }); }

function flatById(id){ return DATA.flats.find(function(f){ return f.id===id; }); }

const PERMISSION_LABELS = { dashboard:'Dashboard', purchase:'Purchase', meter_reading:'Meter Reading', my_flat:'My Flat', people_access:'People & Access', reports:'Reports', settings:'Settings' };

function hasPermission(user, perm){
  if(!user) return false;
  if(user.role === 'admin') return true;
  return Array.isArray(user.permissions) && user.permissions.indexOf(perm) !== -1;
}
function can(action){
  const map = { addPurchase:'purchase', addReading:'meter_reading' };
  return hasPermission(CURRENT_USER, map[action] || action);
}

function nextPurchaseId(){
  let max = 0;
  DATA.purchases.forEach(function(p){
    const m = /^P-(\d+)/.exec(p.id);
    if(m) max = Math.max(max, parseInt(m[1],10));
  });
  return 'P-' + String(max+1).padStart(3,'0');
}

function cylinderTotals(p){
  const cyls = p.cylinders || [];
  return { kg: cyls.reduce(function(s,c){return s+c.kg;},0), cost: cyls.reduce(function(s,c){return s+c.cost;},0) };
}

function billingPeriod(p, readings){
  const cylDates = (p.cylinders||[]).map(function(c){return c.date;}).filter(Boolean);
  if(cylDates.length===0) return null;
  const start = cylDates.slice().sort()[0];
  const readingDates = readings.filter(function(r){return r.purchaseId===p.id;}).map(function(r){return r.dateLogged;});
  const end = (readingDates.length ? readingDates : cylDates).slice().sort().slice(-1)[0];
  const days = Math.max(0, Math.round((new Date(end) - new Date(start)) / 86400000));
  return { start: start, end: end, days: days };
}

function computeBilling(purchase, readings, method){
  const totals = cylinderTotals(purchase);
  const rows = readings.filter(r => r.purchaseId === purchase.id).map(r => Object.assign({}, r, { units: r.current - r.previous }));
  const totalUnits = rows.reduce((s,r)=>s+r.units, 0);
  const pricePerKg = totals.kg > 0 ? totals.cost / totals.kg : 0;
  const conversionRatio = totalUnits > 0 ? totals.kg / totalUnits : 0;
  const rate = method === 'manual' ? (purchase.manualRate || 0) : conversionRatio;
  rows.forEach(r=>{ r.bill = r.units * rate * pricePerKg; });
  const totalBill = rows.reduce((s,r)=>s+r.bill,0);
  return { rows: rows, totalUnits: totalUnits, pricePerKg: pricePerKg, conversionRatio: conversionRatio, rate: rate, totalBill: totalBill, totalKg: totals.kg, totalCost: totals.cost };
}

function batchSeq(id){ const m = /^P-(\d+)/.exec(id); return m ? parseInt(m[1],10) : 0; }

function shortDate(d){
  if(!d) return '';
  const parts = d.split('-');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parts[2]+' '+months[parseInt(parts[1],10)-1];
}

function cycleLabel(period, index, full){
  const n = String(index+1).padStart(2,'0');
  if(!period) return 'Cycle '+n;
  return 'Cycle '+n+' \u2014 '+(full? period.start+' to '+period.end : shortDate(period.start)+'\u2013'+shortDate(period.end));
}

function cycleShortRange(period){ return period ? shortDate(period.start)+'\u2013'+shortDate(period.end) : ''; }

function flatCycles(flatId, method){
  const cycles = [];
  DATA.purchases.forEach(function(p){
    const b = computeBilling(p, DATA.readings, method||'actual');
    const row = b.rows.find(function(r){return r.flatId===flatId;});
    if(!row) return;
    cycles.push({
      purchaseId: p.id, seq: batchSeq(p.id), period: billingPeriod(p, DATA.readings),
      previous: row.previous, current: row.current, units: row.units,
      kg: row.units * b.rate, rate: b.rate, pricePerKg: b.pricePerKg, bill: row.bill
    });
  });
  cycles.sort(function(a,b){ return a.seq - b.seq; });
  return cycles;
}

function avg(arr){ return arr.length ? arr.reduce(function(s,v){return s+v;},0)/arr.length : 0; }

function computeReconciliation(p, readings){
  const totals = cylinderTotals(p);
  const actual = computeBilling(p, readings, 'actual');
  const manualSet = p.manualRate != null && p.manualRate !== '' && p.manualRate > 0;
  const result = {
    purchasedKg: totals.kg, totalUnits: actual.totalUnits,
    actual: {
      conversionRatio: actual.conversionRatio,
      calculatedKg: actual.totalUnits * actual.conversionRatio,
      reconciliationPct: totals.kg>0 ? (actual.totalUnits*actual.conversionRatio/totals.kg*100) : 0
    },
    manual: null
  };
  if(manualSet){
    const impliedKg = actual.totalUnits * p.manualRate;
    const diffKg = totals.kg - impliedKg;
    result.manual = { rate: p.manualRate, impliedKg: impliedKg, diffKg: diffKg,
      recoveryPct: totals.kg>0 ? (impliedKg/totals.kg*100) : 0, varianceTk: diffKg * actual.pricePerKg };
  }
  return result;
}

function fmtTk(n){ return (isFinite(n)?n:0).toLocaleString('en-BD', {maximumFractionDigits:2}); }

function fmtQty(n){ return (isFinite(n)?n:0).toLocaleString('en-BD', {maximumFractionDigits:2}); }

function cycleNumberFor(purchaseId){
  const sortedAll = DATA.purchases.slice().sort(function(a,b){ return batchSeq(a.id)-batchSeq(b.id); });
  return sortedAll.findIndex(function(p){ return p.id===purchaseId; }) + 1;
}
