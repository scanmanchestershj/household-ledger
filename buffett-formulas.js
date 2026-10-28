// buffett-formulas.js — "Buffett Plus" scorer + entry/exit zones. Pure functions, no I/O.
// Input per stock (all % as numbers, e.g. ROE 18 = 18%):
// { symbol, price, bvps, epsHistory:[5y EPS, oldest→newest], fcfPsHistory:[5y FCF/share],
//   roeHistory:[5y], roce, de, profitYears (0-5), promoterPledge, sector,
//   sma200, rsi14, qtrProfitYoY:[last 2 quarters YoY %] }
const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const scale = (x, lo, hi, pts) => clamp((x - lo) / (hi - lo), 0, 1) * pts;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const CYCLICAL = ['refin', 'oil', 'metal', 'steel', 'cement', 'sugar', 'shipping', 'commodity', 'mining'];

function cagr(h) { const a = h[0], b = h[h.length - 1]; return a > 0 && b > 0 ? (Math.pow(b / a, 1 / (h.length - 1)) - 1) * 100 : 0; }

function intrinsicValue(s) {
  const eps5 = avg(s.epsHistory);                       // NORMALISED earnings, not TTM
  const g = clamp(cagr(s.epsHistory), 0, 15);
  const est = [];
  if (eps5 > 0 && s.bvps > 0) est.push(Math.sqrt(22.5 * eps5 * s.bvps));   // Graham number
  if (eps5 > 0) est.push(eps5 * clamp(8.5 + 2 * g, 8, 25));                // Graham growth multiple
  if (s.fcfPsHistory?.length) { const f = avg(s.fcfPsHistory); if (f > 0) est.push(f * 12); } // owner earnings
  return est.length ? median(est) : 0;
}

function evaluate(s) {
  const iv = intrinsicValue(s);
  const mos = iv > 0 ? (1 - s.price / iv) * 100 : -100;          // margin of safety %
  const roe5 = avg(s.roeHistory);
  const eps5 = avg(s.epsHistory);
  const cv = eps5 > 0 ? Math.sqrt(avg(s.epsHistory.map(x => (x - eps5) ** 2))) / eps5 : 9; // earnings volatility
  const cyclical = CYCLICAL.some(k => (s.sector || '').toLowerCase().includes(k));
  const ttmVsNorm = eps5 > 0 ? s.epsHistory[s.epsHistory.length - 1] / eps5 : 9;           // >1.5 = peak-earnings risk

  // Hard gates (all must pass)
  const gates = {
    roe: roe5 >= 12, debt: s.de <= 0.7, profit: s.profitYears >= 4,
    pledge: (s.promoterPledge ?? 0) < 10, positiveValue: iv > 0 && mos > 0,
    notPeak: !(cyclical && ttmVsNorm > 1.8),   // blocks buying a cyclical at peak EPS (P/E looks "cheap")
  };
  const gatesPass = Object.values(gates).every(Boolean);

  // Score /100: Quality 40 + Durability 20 + Value 30 + Timing 10
  const quality = scale(roe5, 12, 22, 12) + scale(s.roce, 12, 22, 10) + scale(0.7 - s.de, 0, 0.7, 8) + s.profitYears * 2;
  const durability = scale(1.0 - cv, 0, 1, 12) + scale(cagr(s.epsHistory), 0, 15, 8) - (cyclical ? 6 : 0);
  const value = scale(mos, 0, 40, 30);
  const timing = (s.price > s.sma200 ? 6 : 0) + (s.rsi14 >= 35 && s.rsi14 <= 65 ? 4 : s.rsi14 < 35 ? 2 : 0);
  const score = Math.round(clamp(quality + durability + value + timing, 0, 100));

  // Thesis-break (exit regardless of price)
  const broken = roe5 < 10 || s.de > 1 || ((s.qtrProfitYoY || []).length >= 2 && s.qtrProfitYoY.every(x => x < -30)) || (s.price < s.sma200 * 0.9 && score < 50);

  let zone = 'NONE';
  if (broken) zone = 'EXIT_THESIS';
  else if (iv > 0 && s.price >= iv) zone = 'EXIT_FULL';
  else if (iv > 0 && s.price >= iv * 0.9) zone = 'TRIM';
  else if (gatesPass && score >= 70 && mos >= 25 && s.price > s.sma200 * 0.95) zone = 'ENTRY';
  else if (gatesPass && score >= 60 && mos >= 10) zone = 'WATCH';

  return {
    symbol: s.symbol, score, zone, gates, gatesPass, intrinsic: Math.round(iv), mosPct: +mos.toFixed(1),
    entryTranches: [0.75, 0.67, 0.60].map(m => Math.round(iv * m)),  // buy 1/3 at each (25/33/40% discount)
    trimAt: Math.round(iv * 0.9), exitAt: Math.round(iv), reviewStop: Math.round(s.price < s.sma200 ? s.price * 0.8 : s.sma200 * 0.9),
    why: `Score ${score}/100; MoS ${mos.toFixed(0)}% vs normalised value ₹${Math.round(iv)}; ROE5y ${roe5.toFixed(0)}%; ` +
         `failed gates: ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'none'}`,
  };
}

// Daily diff: emit alerts only when a stock's zone CHANGES vs yesterday's stored zone.
function diffAlerts(todayResults, prevZones = {}, held = new Set()) {
  const out = [];
  for (const r of todayResults) {
    const prev = prevZones[r.symbol] || 'NONE';
    const isExit = r.zone === 'TRIM' || r.zone.startsWith('EXIT');
    if (isExit && !held.has(r.symbol)) continue;   // exit/trim alerts only for holdings & watchlist
    if (r.zone !== prev && r.zone !== 'NONE') out.push({ symbol: r.symbol, from: prev, to: r.zone, msg: `${r.symbol}: ${prev} → ${r.zone}. ${r.why}` });
    if (prev.startsWith('ENTRY') && r.zone === 'NONE') out.push({ symbol: r.symbol, from: prev, to: 'LOST_ENTRY', msg: `${r.symbol} left the entry zone. ${r.why}` });
  }
  return out;
}

module.exports = { evaluate, intrinsicValue, diffAlerts };
