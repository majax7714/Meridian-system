const trades = require('./data/trades.json');
const today = trades.filter(t => {
  const d = new Date(t.created_at || t.timestamp);
  return d.toDateString() === new Date().toDateString();
});

console.log('=== OVERVIEW ===');
console.log('Total trades:', today.length);
const wins = today.filter(t => t.outcome === 'win').length;
const losses = today.filter(t => t.outcome === 'loss').length;
const totalPnL = today.reduce((s, t) => s + (t.profit_loss || 0), 0);
console.log('Wins:', wins, '| Losses:', losses, '| Win rate:', (wins/today.length*100).toFixed(1)+'%');
console.log('Total P&L: $' + totalPnL.toFixed(2));
console.log('Avg P&L per trade: $' + (totalPnL/today.length).toFixed(2));
console.log('Avg confidence:', (today.reduce((s,t)=>s+parseFloat(t.confidence||0),0)/today.length).toFixed(1));

console.log('\n=== BY PATH ===');
const byPath = {};
for (const t of today) {
  const p = t.path || 'UNK';
  if (!byPath[p]) byPath[p] = {wins:0,losses:0,pnl:0};
  if (t.outcome==='win') byPath[p].wins++;
  if (t.outcome==='loss') byPath[p].losses++;
  byPath[p].pnl += (t.profit_loss||0);
}
for (const [p,s] of Object.entries(byPath)) {
  const tot = s.wins+s.losses;
  console.log(`Path ${p}: ${tot} trades | ${s.wins}W/${s.losses}L | ${tot>0?(s.wins/tot*100).toFixed(1)+'%':'N/A'} | $${s.pnl.toFixed(2)}`);
}

console.log('\n=== BY SESSION ===');
const bySess = {};
for (const t of today) {
  const s = t.session || 'UNK';
  if (!bySess[s]) bySess[s] = {wins:0,losses:0,pnl:0};
  if (t.outcome==='win') bySess[s].wins++;
  if (t.outcome==='loss') bySess[s].losses++;
  bySess[s].pnl += (t.profit_loss||0);
}
for (const [s,v] of Object.entries(bySess)) {
  const tot = v.wins+v.losses;
  console.log(`${s}: ${tot} trades | ${v.wins}W/${v.losses}L | ${tot>0?(v.wins/tot*100).toFixed(1)+'%':'N/A'} | $${v.pnl.toFixed(2)}`);
}

console.log('\n=== BY EXIT REASON ===');
const byExit = {};
for (const t of today) {
  const e = t.exit_reason || 'UNK';
  if (!byExit[e]) byExit[e] = {wins:0,losses:0,pnl:0,count:0};
  byExit[e].count++;
  if (t.outcome==='win') byExit[e].wins++;
  if (t.outcome==='loss') byExit[e].losses++;
  byExit[e].pnl += (t.profit_loss||0);
}
for (const [e,v] of Object.entries(byExit)) {
  console.log(`${e}: ${v.count} | ${v.wins}W/${v.losses}L | $${v.pnl.toFixed(2)}`);
}

console.log('\n=== BY RVIV REGIME ===');
const byReg = {};
for (const t of today) {
  const r = t.rviv_regime || 'UNK';
  if (!byReg[r]) byReg[r] = {wins:0,losses:0,pnl:0};
  if (t.outcome==='win') byReg[r].wins++;
  if (t.outcome==='loss') byReg[r].losses++;
  byReg[r].pnl += (t.profit_loss||0);
}
for (const [r,v] of Object.entries(byReg)) {
  const tot = v.wins+v.losses;
  console.log(`${r}: ${tot} | ${v.wins}W/${v.losses}L | ${(v.wins/tot*100).toFixed(1)}% | $${v.pnl.toFixed(2)}`);
}

console.log('\n=== CONFIDENCE DISTRIBUTION ===');
const buckets = {'<50':0,'50-55':0,'55-60':0,'60-70':0,'70-80':0,'80+':0};
const bucketPnL = {'<50':0,'50-55':0,'55-60':0,'60-70':0,'70-80':0,'80+':0};
const bucketW = {'<50':0,'50-55':0,'55-60':0,'60-70':0,'70-80':0,'80+':0};
for (const t of today) {
  const c = parseFloat(t.confidence)||0;
  const b = c<50?'<50':c<55?'50-55':c<60?'55-60':c<70?'60-70':c<80?'70-80':'80+';
  buckets[b]++;
  bucketPnL[b]+=(t.profit_loss||0);
  if (t.outcome==='win') bucketW[b]++;
}
for (const [b] of Object.entries(buckets)) {
  const tot=buckets[b];
  if(tot>0) console.log(`${b}: ${tot} trades | ${bucketW[b]}W | ${(bucketW[b]/tot*100).toFixed(0)}% WR | $${bucketPnL[b].toFixed(2)}`);
}

console.log('\n=== DIRECTION BREAKDOWN ===');
const byDir = {};
for (const t of today) {
  const d = t.direction || 'UNK';
  if (!byDir[d]) byDir[d] = {wins:0,losses:0,pnl:0};
  if (t.outcome==='win') byDir[d].wins++;
  if (t.outcome==='loss') byDir[d].losses++;
  byDir[d].pnl += (t.profit_loss||0);
}
for (const [d,v] of Object.entries(byDir)) {
  const tot=v.wins+v.losses;
  console.log(`${d}: ${tot} | ${v.wins}W/${v.losses}L | ${(v.wins/tot*100).toFixed(1)}% | $${v.pnl.toFixed(2)}`);
}

console.log('\n=== MACRO REGIME ===');
const byMacro = {};
for (const t of today) {
  const m = t.macro_regime || 'UNK';
  if (!byMacro[m]) byMacro[m] = {wins:0,losses:0,pnl:0};
  if (t.outcome==='win') byMacro[m].wins++;
  if (t.outcome==='loss') byMacro[m].losses++;
  byMacro[m].pnl += (t.profit_loss||0);
}
for (const [m,v] of Object.entries(byMacro)) {
  const tot=v.wins+v.losses;
  console.log(`${m}: ${tot} | ${v.wins}W/${v.losses}L | ${(v.wins/tot*100).toFixed(1)}% | $${v.pnl.toFixed(2)}`);
}

console.log('\n=== P&L TIMELINE (first 10, last 10) ===');
const timeline = today.map((t,i) => `T${t.id}: ${t.outcome==='win'?'+':'-'}$${Math.abs(t.profit_loss||0).toFixed(2)} [${t.exit_reason}] conf=${t.confidence} dir=${t.direction} path=${t.path} sess=${t.session}`);
timeline.slice(0,10).forEach(l=>console.log(l));
if(today.length>20) console.log(`... (${today.length-20} more) ...`);
timeline.slice(-10).forEach(l=>console.log(l));

console.log('\n=== DUPLICATE DETECTION ===');
const dupes = today.filter((t,i,arr) => {
  const prev = arr[i-1];
  return prev && t.entry === prev.entry && t.exit_price === prev.exit_price && t.confidence === prev.confidence;
});
console.log('Potential duplicate trades:', dupes.length);
if(dupes.length>0) {
  dupes.slice(0,5).forEach(t=>console.log(` T${t.id}: entry=${t.entry} exit=${t.exit_price} conf=${t.confidence} ts=${new Date(t.created_at).toISOString()}`));
}

console.log('\n=== RAPID FIRE DETECTION (trades < 60s apart) ===');
let rapid = 0;
for(let i=1;i<today.length;i++){
  const gap = (today[i].created_at - today[i-1].created_at)/1000;
  if(gap<60) { rapid++; console.log(` T${today[i-1].id}→T${today[i].id}: ${gap.toFixed(0)}s apart`); }
}
if(rapid===0) console.log('None found');

console.log('\n=== CLOSE_RUSH DETAIL ===');
const closeRush = today.filter(t => t.session === 'CLOSE_RUSH');
console.log('Trades:', closeRush.length, '| Wins:', closeRush.filter(t=>t.outcome==='win').length);
closeRush.forEach(t => {
  const ts = new Date(t.created_at).toISOString().substring(11,19);
  console.log(`  T${t.id} ${ts} ${t.outcome==='win'?'WIN':'LOSS'} ${t.exit_reason} conf=${t.confidence} dir=${t.direction} pnl=$${(t.profit_loss||0).toFixed(2)}`);
});

console.log('\n=== SL LOSS DETAIL (biggest losses) ===');
const slLosses = today.filter(t=>t.exit_reason==='SL').sort((a,b)=>a.profit_loss-b.profit_loss);
slLosses.slice(0,10).forEach(t=>{
  console.log(`  T${t.id} $${(t.profit_loss||0).toFixed(2)} conf=${t.confidence} dir=${t.direction} sess=${t.session} entry=${t.entry} sl=${t.stop_loss} tp=${t.take_profit}`);
});

console.log('\n=== CONSECUTIVE LOSSES ===');
let streak = 0; let maxStreak = 0; let streakStart = null;
for(let i=0;i<today.length;i++){
  if(today[i].outcome==='loss'){
    streak++;
    if(streak===1) streakStart=today[i].id;
    if(streak>maxStreak) maxStreak=streak;
  } else {
    if(streak>=3) console.log(`  Loss streak of ${streak} starting T${streakStart} ending T${today[i-1].id}`);
    streak=0;
  }
}
if(streak>=3) console.log(`  Loss streak of ${streak} starting T${streakStart}`);
console.log('Max consecutive losses:', maxStreak);

console.log('\n=== SIGNAL VOTE COUNT DISTRIBUTION ===');
const sigCounts = {};
for(const t of today){
  const n = t.total_signals || 0;
  if(!sigCounts[n]) sigCounts[n]={wins:0,losses:0};
  if(t.outcome==='win') sigCounts[n].wins++;
  else sigCounts[n].losses++;
}
for(const [n,v] of Object.entries(sigCounts).sort((a,b)=>a[0]-b[0])){
  const tot=v.wins+v.losses;
  console.log(`  ${n} signals: ${tot} trades | ${v.wins}W/${v.losses}L | ${(v.wins/tot*100).toFixed(0)}%`);
}

console.log('\n=== ASYMMETRIC R:R CHECK ===');
let slSizeSum=0, tpSizeSum=0, count=0;
for(const t of today){
  if(t.entry && t.stop_loss && t.take_profit){
    const slDist = Math.abs(t.entry - t.stop_loss);
    const tpDist = Math.abs(t.entry - t.take_profit);
    slSizeSum += slDist;
    tpSizeSum += tpDist;
    count++;
  }
}
if(count>0){
  console.log(`  Avg SL distance: ${(slSizeSum/count).toFixed(2)} pts | Avg TP distance: ${(tpSizeSum/count).toFixed(2)} pts`);
  console.log(`  Avg R:R ratio: ${(tpSizeSum/slSizeSum).toFixed(2)}:1`);
}
