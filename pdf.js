// PDF generation via jsPDF — builds the PDF directly from the same computeBilling()
// output the on-screen dashboard uses (no separate/duplicate billing logic), and
// triggers a direct file download. No print dialog, no browser preview.
// Requires the jsPDF CDN script to be loaded before this file (see index.html).

const PDF_FOOTER_ADDRESS = 'House 147, Road 2, Block A, Pallabi, Mirpur 12, Dhaka';
const PAGE_W = 595, PAGE_H = 842, MARGIN = 40;

function addFooter(doc){
  const pageCount = doc.internal.getNumberOfPages();
  for(let i=1;i<=pageCount;i++){
    doc.setPage(i);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(140,140,140);
    doc.text(PDF_FOOTER_ADDRESS, PAGE_W-40, PAGE_H-30, { align:'right' });
  }
}

function generatePdf(purchaseId, method){
  if(!hasPermission(CURRENT_USER,'reports')){ toast('You do not have permission to generate reports'); return; }
  if(!window.jspdf){ toast('PDF library not loaded — check your connection and try again'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const p = DATA.purchases.find(function(x){return x.id===purchaseId;});
  const b = computeBilling(p, DATA.readings, method);
  const period = billingPeriod(p, DATA.readings);
  const rec = computeReconciliation(p, DATA.readings);
  const methodLabel = method==='manual'
    ? ('Manual conversion rate: '+b.rate.toFixed(2)+' kg per meter unit (set by admin)')
    : ('Actual conversion ratio: '+b.rate.toFixed(3)+' kg per meter unit (calculated automatically from this batch)');

  let y = 56;
  doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(27,42,46);
  doc.text('LPG Ledger \u2014 '+p.id, MARGIN, y); y += 20;

  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(90,90,90);
  doc.text((period? period.start+' to '+period.end+' ('+period.days+' days) \u00b7 ' : '')
    + (p.cylinders||[]).length+' cylinder(s) \u00b7 '+fmtQty(b.totalKg)+' kg \u00b7 Tk '+fmtTk(b.totalCost)
    + ' \u00b7 blended price/kg Tk '+fmtTk(b.pricePerKg), MARGIN, y);
  y += 20;

  doc.setFillColor(243,226,210);
  doc.roundedRect(MARGIN, y-12, PAGE_W-MARGIN*2, 22, 3, 3, 'F');
  doc.setTextColor(122,61,15); doc.setFontSize(9.5);
  doc.text('Billing method: '+methodLabel, MARGIN+8, y+3, { maxWidth: PAGE_W-MARGIN*2-16 });
  y += 34;

  doc.setTextColor(0,0,0); doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.text('Flat', MARGIN, y);
  doc.text('Prev', MARGIN+220, y, {align:'right'});
  doc.text('Curr', MARGIN+280, y, {align:'right'});
  doc.text('Units', MARGIN+340, y, {align:'right'});
  doc.text('Bill (Tk)', PAGE_W-MARGIN, y, {align:'right'});
  y += 6; doc.setDrawColor(200,200,200); doc.line(MARGIN, y, PAGE_W-MARGIN, y); y += 14;

  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  b.rows.sort(function(a,c){return naturalFlatCompare(a.flatId,c.flatId);}).forEach(function(r){
    if(y > PAGE_H-70){ doc.addPage(); y = 56; }
    doc.text(String(r.flatId), MARGIN, y);
    doc.text(fmtQty(r.previous), MARGIN+220, y, {align:'right'});
    doc.text(fmtQty(r.current), MARGIN+280, y, {align:'right'});
    doc.text(fmtQty(r.units), MARGIN+340, y, {align:'right'});
    doc.text(fmtTk(r.bill), PAGE_W-MARGIN, y, {align:'right'});
    y += 16;
  });
  y += 6; doc.line(MARGIN, y, PAGE_W-MARGIN, y); y += 14;
  doc.setFont('helvetica','bold');
  doc.text('Total', MARGIN, y);
  doc.text(fmtQty(b.totalUnits), MARGIN+340, y, {align:'right'});
  doc.text(fmtTk(b.totalBill), PAGE_W-MARGIN, y, {align:'right'});
  y += 28;

  if(y > PAGE_H-90){ doc.addPage(); y = 56; }
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(80,80,80);
  let recLine = 'Reconciliation \u2014 Actual: '+rec.actual.reconciliationPct.toFixed(1)+'% (expected near 100% by design, not proof of zero leakage)';
  if(rec.manual) recLine += '. Manual: '+rec.manual.recoveryPct.toFixed(1)+'% recovered, '+fmtQty(rec.manual.diffKg)+' kg / Tk '+fmtTk(rec.manual.varianceTk)+' unaccounted.';
  doc.text(recLine, MARGIN, y, { maxWidth: PAGE_W-MARGIN*2 });

  addFooter(doc);
  const filename = 'LPG_Billing_Report_Cycle_'+String(cycleNumberFor(p.id)).padStart(2,'0')+'.pdf';
  doc.save(filename);
}

function generateFlatPdf(flatId, cycle, cycleNum){
  const isOwnFlat = CURRENT_USER.flat_id === flatId;
  if(!(CURRENT_USER.role==='admin' || (isOwnFlat && hasPermission(CURRENT_USER,'reports')))){
    toast('You are not authorized to generate this flat\u2019s report');
    return;
  }
  if(!window.jspdf){ toast('PDF library not loaded — check your connection and try again'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const f = flatById(flatId);
  let y = 60;
  doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(27,42,46);
  doc.text('LPG Ledger \u2014 Flat '+flatId+(f&&f.name?' ('+f.name+')':''), MARGIN, y); y += 22;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(90,90,90);
  doc.text(cycleLabel(cycle.period, cycleNum-1)+' \u00b7 batch '+cycle.purchaseId, MARGIN, y); y += 28;

  const rows = [
    ['Previous Reading', fmtQty(cycle.previous)],
    ['Current Reading', fmtQty(cycle.current)],
    ['Units Consumed', fmtQty(cycle.units)],
    ['LPG Consumed', fmtQty(cycle.kg)+' KG'],
    ['Rate', 'Tk '+fmtTk(cycle.pricePerKg)+'/KG'],
    ['Total Bill', 'Tk '+fmtTk(cycle.bill)]
  ];
  doc.setFontSize(11.5);
  rows.forEach(function(r,i){
    if(i===rows.length-1){ doc.setDrawColor(200,200,200); doc.line(MARGIN, y-14, PAGE_W-MARGIN, y-14); }
    doc.setFont('helvetica','normal'); doc.setTextColor(60,60,60); doc.text(r[0], MARGIN, y);
    doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0); doc.text(r[1], PAGE_W-MARGIN, y, {align:'right'});
    y += 24;
  });

  addFooter(doc);
  const filename = 'LPG_Billing_Flat_'+flatId+'_Cycle_'+String(cycleNum).padStart(2,'0')+'.pdf';
  doc.save(filename);
}
