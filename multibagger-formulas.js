// multibagger-formulas.js — "Multibagger Blueprint": an early-stage multibagger score (0-100) built from the
// published rules of well-known investors. Pure functions, no I/O.
//
//   Pillar (points)               Rules it borrows from
//   1 Size & runway        (15)   Kedia SMILE (Small, Extra-large market), Mayer SQGLP (Small size), Phelps/Lynch (small = room)
//   2 Quality & reinvest   (20)   Mayer (high ROIC, gross margin 50%+), Jhunjhunwala (ROE, low debt), O'Neil (ROE 17%+), Fisher (margins)
//   3 Growth engine        (25)   O'Neil CAN SLIM (C and A: 25%+ earnings growth), Lynch (15-30% growers), Mayer (earnings engine)
//   4 Price discipline     (12)   Lynch PEG (<=1 great, >2 expensive), Mayer (don't overpay), Jhunjhunwala (sell when P/E unsustainable)
//   5 Skin & stealth       (10)   Kedia/Maheshwari (promoter skin in game), Value Research (promoter 40%+, institutions still low)
//   6 Trend / Stage 2      (18)   Minervini Trend Template (8 rules), O'Neil (buy new highs, leaders), Weinstein stage analysis
//
// Entry / exit: buy only inside "stage 2" and below a value cap; stop under the 200-day average;
// trim at +50% and +100%, then ride the rest while the 200-day holds (Jhunjhunwala / Mayer: be a reluctant seller),
// and trim anyway if the price runs past the PEG-2 value cap (the "P/E is unsustainable" exit).
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;
const sma = (a, n, end) => { end = end == null ? a.length : end; if (end < n) return null; let s = 0; for (let i = end - n; i < end; i++) s += a[i]; return s / n; };

function trendTemplate(t) {
  // t: { closes, highs, lows, bench6m }
  const c = t.closes, n = c.length;
  if (n < 200) return null;
  const price = c[n - 1];
  const s50 = sma(c, 50), s150 = n >= 150 ? sma(c, 150) : null, s200 = sma(c, 200);
  const s200Prev = n >= 221 ? sma(c, 200, n - 21) : null;
  const win = c.slice(Math.max(0, n - 252));
  const hi = Math.max.apply(null, win), lo = Math.min.apply(null, win);
  const ret6 = n > 126 ? (price / c[n - 127] - 1) * 100 : null;
  const items = [
    { k: 'Price above 150 & 200-day average', ok: price > s150 && price > s200 },
    { k: '150-day above 200-day', ok: s150 > s200 },
    { k: '200-day average rising (1 month)', ok: s200Prev != null ? s200 > s200Prev : false },
    { k: '50-day above 150 & 200-day', ok: s50 > s150 && s50 > s200 },
    { k: 'Price above 50-day average', ok: price > s50 },
    { k: 'At least 30% above 52-week low', ok: price >= lo * 1.3 },
    { k: 'Within 25% of 52-week high', ok: price >= hi * 0.75 },
    { k: 'Outperforming the Nifty (6 months)', ok: ret6 != null && t.bench6m != null ? ret6 > t.bench6m : false }
  ];
  const recent = t.highs.slice(-15), recentL = t.lows.slice(-15);
  const tight = (Math.max.apply(null, recent) - Math.min.apply(null, recentL)) / price * 100;
  const pivot = Math.max.apply(null, c.slice(-60));
  return { price, sma50: s50, sma150: s150, sma200: s200, hi52: hi, lo52: lo, ret6, items, passed: items.filter(x => x.ok).length, tight15: tight, pivot,
    pctFromHigh: (1 - price / hi) * 100, pctAboveLow: (price / lo - 1) * 100 };
}

function evaluate(m) {
  const T = m.trend; // result of trendTemplate (may be null)
  const why = [];
  const pil = { size: 0, quality: 0, growth: 0, price: 0, skin: 0, trend: 0 };

  // 1. Size & runway (15)
  const mc = m.mcapCr;
  pil.size = mc == null ? 5 : mc <= 2000 ? 15 : mc <= 5000 ? 13 : mc <= 10000 ? 10 : mc <= 25000 ? 6 : mc <= 60000 ? 3 : 1;
  why.push({ who: 'Kedia · Mayer', ok: pil.size >= 10, txt: mc == null ? 'Market cap unknown' : (pil.size >= 10 ? 'Small enough to compound (' : 'Already large, less room (') + 'market cap about ₹' + Math.round(mc).toLocaleString('en-IN') + ' cr)' });

  // 2. Quality & reinvestment (20)
  let q = 0;
  if (m.roce != null) q += m.roce >= 25 ? 10 : m.roce >= 18 ? 7 : m.roce >= 15 ? 4 : 0;
  if (m.de != null) q += m.de <= 0.3 ? 5 : m.de <= 1 ? 3 : 0;
  if (m.fcfPositive) q += 2;
  if (m.grossMargin != null) q += m.grossMargin >= 50 ? 3 : m.grossMargin >= 30 ? 2 : m.grossMargin >= 20 ? 1 : 0;
  pil.quality = Math.min(20, q);
  why.push({ who: 'Mayer · Jhunjhunwala', ok: m.roce != null && m.roce >= 15 && m.de != null && m.de <= 1, txt: 'Return on capital ' + (m.roce != null ? m.roce.toFixed(0) + '%' : 'n/a') + ' (3-yr avg), debt/equity ' + (m.de != null ? m.de.toFixed(2) : 'n/a') + (m.fcfPositive ? ', free cash flow positive' : '') });

  // 3. Growth engine (25)
  let g = 0;
  if (m.salesG != null) g += m.salesG >= 20 ? 8 : m.salesG >= 15 ? 6 : m.salesG >= 10 ? 3 : 0;
  if (m.profitG != null) g += m.profitG >= 25 ? 9 : m.profitG >= 18 ? 6 : m.profitG >= 12 ? 3 : 0;
  if (m.qEarn != null) g += m.qEarn >= 25 ? 5 : m.qEarn >= 15 ? 3 : 0;
  if (m.salesG != null && m.profitG != null && m.profitG > m.salesG + 3) g += 3;
  pil.growth = Math.min(25, g);
  why.push({ who: "O'Neil · Lynch", ok: m.profitG != null && m.profitG >= 18, txt: '3-yr sales growth ' + (m.salesG != null ? m.salesG.toFixed(0) + '%' : 'n/a') + ', profit growth ' + (m.profitG != null ? m.profitG.toFixed(0) + '%' : 'n/a') + (m.qEarn != null ? ', latest quarter profit ' + (m.qEarn >= 0 ? '+' : '') + m.qEarn.toFixed(0) + '% YoY' : '') });

  // 4. Price discipline (12) — Lynch PEG
  const gUse = m.profitG != null ? m.profitG : m.salesG;
  let peg = null;
  if (m.pe > 0 && gUse != null && gUse > 0) peg = m.pe / clamp(gUse, 5, 40);
  pil.price = peg == null ? 0 : peg <= 1 ? 12 : peg <= 1.5 ? 9 : peg <= 2 ? 5 : peg <= 3 ? 2 : 0;
  why.push({ who: 'Lynch · Mayer', ok: peg != null && peg <= 1.5, txt: peg == null ? 'P/E or growth not available, price discipline cannot be checked' : 'P/E ' + m.pe.toFixed(1) + ' against growth gives PEG ' + peg.toFixed(2) + (peg <= 1 ? ' (cheap for its growth)' : peg <= 2 ? ' (fair)' : ' (expensive)') });

  // 5. Skin in the game & still under-researched (10)
  let s = 0;
  if (m.ins != null) s += m.ins >= 55 ? 6 : m.ins >= 40 ? 5 : m.ins >= 30 ? 3 : m.ins >= 20 ? 1 : 0;
  if (m.inst != null) s += (m.inst >= 2 && m.inst <= 25) ? 4 : m.inst < 2 ? 2 : m.inst <= 40 ? 1 : 0;
  pil.skin = Math.min(10, s);
  why.push({ who: 'Kedia · Value Research', ok: m.ins != null && m.ins >= 40, txt: 'Promoter/insider holding ' + (m.ins != null ? m.ins.toFixed(0) + '%' : 'n/a') + ', institutions ' + (m.inst != null ? m.inst.toFixed(0) + '%' : 'n/a') + ' (early but not unknown is the sweet spot). Pledge is not checked, verify it on the exchange site' });

  // 6. Trend / Stage 2 (18)
  if (T) {
    pil.trend = Math.min(18, T.passed * 2 + (T.tight15 <= 8 ? 2 : 0));
    why.push({ who: 'Minervini · Weinstein', ok: T.passed >= 7, txt: T.passed + ' of 8 trend-template rules pass; ' + T.pctFromHigh.toFixed(0) + '% below the 52-week high, ' + T.pctAboveLow.toFixed(0) + '% above the low' });
  } else why.push({ who: 'Minervini · Weinstein', ok: false, txt: 'Not enough price history for the trend template' });

  const score = Math.round(pil.size + pil.quality + pil.growth + pil.price + pil.skin + pil.trend);
  const gatesPass = m.roce != null && m.roce >= 15 && m.de != null && m.de <= 1 && m.profitG != null && m.profitG >= 12 && m.salesG != null && m.salesG >= 10;
  const stage2 = !!T && T.passed >= 7 && T.price > T.sma200;
  const above200 = !!T && T.price > T.sma200;
  let verdict;
  if (score >= 75 && gatesPass && stage2) verdict = 'Strong Buy';
  else if (score >= 62 && gatesPass && above200) verdict = 'Buy';
  else if (score >= 48) verdict = 'Hold';
  else verdict = 'Avoid';

  // Levels
  let lv = null;
  if (T) {
    const eps = m.pe > 0 ? T.price / m.pe : null;
    const gg = gUse != null ? clamp(gUse, 8, 40) : null;
    const fair = eps && gg ? eps * clamp(gg, 12, 35) : null;                 // PEG = 1 value
    const valueCap = eps && gg ? eps * clamp(gg * 2, 25, 70) : null;         // PEG = 2, the "too expensive" line
    let entryHigh = T.sma50 * 1.08;
    if (fair) entryHigh = Math.min(entryHigh, fair * 1.10);
    const entryLow = Math.max(T.sma200 * 1.02, T.sma50 * 0.95);
    let mode = 'now';
    if (!above200) mode = 'avoid';
    else if (T.price > entryHigh) mode = 'wait';
    const ref = Math.min(T.price, entryHigh);
    let stop = Math.max(ref * 0.90, T.sma200 * 0.97);
    if (stop >= ref) stop = ref * 0.90;
    const lowBand = Math.min(Math.max(entryLow, stop * 1.03), entryHigh);
    lv = { mode, limit: r2(entryHigh), entryLow: r2(lowBand), stop: r2(stop), trim1: r2(ref * 1.5), trim2: r2(ref * 2), valueCap: r2(valueCap), fair: r2(fair),
      reclaim: above200 ? null : r2(T.sma200 * 1.03) };
  }
  return { score, pillars: pil, verdict, gatesPass, stage2, peg: r2(peg), why, levels: lv };
}
module.exports = { evaluate, trendTemplate };
