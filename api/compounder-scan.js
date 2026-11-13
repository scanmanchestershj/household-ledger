// Early Compounder scan for the Investment > Screener.
//   GET /api/compounder-scan?symbols=ABC.NS,XYZ.NS   (max 6 symbols per call)
// For each stock: latest price, 3-yr avg ROCE (pre-tax proxy), debt/equity, 3-yr sales & profit CAGR,
// latest free cash flow sign, and (best effort) insider holding %. Uses Yahoo's UNOFFICIAL endpoints;
// any field Yahoo lacks is null and the stock simply cannot pass that gate. Promoter PLEDGE is NOT
// available from Yahoo, so the app tells the user to verify it manually.
const { evaluate: bpEvaluate, trendTemplate } = require('../multibagger-formulas.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const wt = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]);
async function getJson(url, cookie) {
  const r = await wt(fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, cookie ? { Cookie: cookie } : {}) }), 7000);
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}
async function session() {
  try {
    const r1 = await wt(fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }), 4000);
    const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [];
    const cookie = raw.map(c => c.split(';')[0]).join('; ');
    const r2 = await wt(fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } }), 4000);
    const crumb = (await r2.text()).trim();
    return crumb && !crumb.includes('<') ? { cookie, crumb } : { cookie: '', crumb: '' };
  } catch (e) { return { cookie: '', crumb: '' }; }
}
const TYPES = ['annualTotalRevenue', 'annualNetIncome', 'annualEBIT', 'annualStockholdersEquity', 'annualTotalDebt', 'annualFreeCashFlow'];
function cagr(arr, years) {
  if (arr.length < years + 1) return null;           // need a full window, no shortcuts
  const a = arr[arr.length - 1 - years].v, b = arr[arr.length - 1].v;
  return a > 0 && b > 0 ? (Math.pow(b / a, 1 / years) - 1) * 100 : null;
}
// Gates (all must pass) and ranking score (0-100). Edit here to change the definition of an "early compounder".
const GATES = { roce: 18, de: 0.5, sales: 15, profit: 20 };
function evaluate(m) {
  const pass = m.roce != null && m.roce >= GATES.roce && m.de != null && m.de <= GATES.de
    && m.salesG != null && m.salesG >= GATES.sales && m.profitG != null && m.profitG >= GATES.profit;
  let s = 0;
  if (m.roce != null) s += m.roce >= 25 ? 25 : m.roce >= 18 ? 18 : m.roce >= 15 ? 10 : 0;
  if (m.de != null) s += m.de <= 0.1 ? 20 : m.de <= 0.5 ? 15 : m.de <= 1 ? 5 : 0;
  if (m.salesG != null) s += m.salesG >= 25 ? 20 : m.salesG >= 20 ? 16 : m.salesG >= 15 ? 12 : 0;
  if (m.profitG != null) s += m.profitG >= 30 ? 20 : m.profitG >= 20 ? 15 : m.profitG >= 15 ? 8 : 0;
  if (m.fcfPositive) s += 10;
  if (m.salesG != null && m.profitG != null && m.profitG > m.salesG) s += 5;
  return { pass, score: s };
}
async function one(sym, sess) {
  const now = Math.floor(Date.now() / 1000);
  const cr = sess.crumb ? '&crumb=' + encodeURIComponent(sess.crumb) : '';
  const [chart, ts, hold] = await Promise.allSettled([
    getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`),
    getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${TYPES.join(',')}&period1=${now - 7 * 365 * 86400}&period2=${now}`, sess.cookie),
    sess.crumb ? getJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=majorHoldersBreakdown${cr}`, sess.cookie) : Promise.reject(new Error('no crumb')),
  ]);
  if (chart.status !== 'fulfilled' || ts.status !== 'fulfilled') throw new Error('no data');
  const price = chart.value?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!(price > 0)) throw new Error('no price');
  const s = {};
  (ts.value?.timeseries?.result || []).forEach(o => {
    const t = o.meta?.type?.[0]; if (!t || !o[t]) return;
    s[t] = o[t].filter(x => x && x.reportedValue && typeof x.reportedValue.raw === 'number').map(x => ({ d: x.asOfDate, v: x.reportedValue.raw }));
  });
  const g = k => s[k] || [];
  if (!g('annualTotalRevenue').length) throw new Error('no financials');
  const eq = Object.fromEntries(g('annualStockholdersEquity').map(x => [x.d, x.v]));
  const debt = Object.fromEntries(g('annualTotalDebt').map(x => [x.d, x.v]));
  const roces = g('annualEBIT').map(x => eq[x.d] != null && (eq[x.d] + (debt[x.d] || 0)) > 0 ? x.v / (eq[x.d] + (debt[x.d] || 0)) * 100 : null).filter(x => x != null).slice(-3);
  const eqs = g('annualStockholdersEquity'), lastEq = eqs.length ? eqs[eqs.length - 1].v : null;
  const dts = g('annualTotalDebt'), lastDebt = dts.length ? dts[dts.length - 1].v : 0;
  const fcf = g('annualFreeCashFlow');
  const ins = hold.status === 'fulfilled' ? hold.value?.quoteSummary?.result?.[0]?.majorHoldersBreakdown?.insidersPercentHeld?.raw : null;
  const m = {
    roce: roces.length >= 3 ? roces.reduce((a, b) => a + b, 0) / roces.length : null,
    de: lastEq != null && lastEq > 0 ? lastDebt / lastEq : null,
    salesG: cagr(g('annualTotalRevenue'), 3), profitG: cagr(g('annualNetIncome'), 3),
    fcfPositive: fcf.length ? fcf[fcf.length - 1].v > 0 : false,
  };
  return Object.assign({ symbol: sym, price, insiders: typeof ins === 'number' ? ins * 100 : null }, m, evaluate(m));
}

// ---- Multibagger Blueprint mode: GET /api/compounder-scan?mode=blueprint&symbols=ABC.NS,XYZ.NS (max 4) ----
// Adds a 1-year price history (trend template), market cap / P/E / holdings / industry, then scores with multibagger-formulas.js.
const BP_TYPES = ['annualTotalRevenue', 'annualNetIncome', 'annualEBIT', 'annualStockholdersEquity', 'annualTotalDebt', 'annualFreeCashFlow', 'annualGrossProfit'];
async function benchmark6m() {
  try {
    const j = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1y&interval=1d');
    const c = (j.chart.result[0].indicators.quote[0].close || []).filter(x => typeof x === 'number');
    return c.length > 127 ? (c[c.length - 1] / c[c.length - 127] - 1) * 100 : null;
  } catch (e) { return null; }
}
async function oneBlueprint(sym, sess, bench6m) {
  const now = Math.floor(Date.now() / 1000);
  const cr = sess.crumb ? '&crumb=' + encodeURIComponent(sess.crumb) : '';
  const mods = 'price,summaryDetail,financialData,defaultKeyStatistics,majorHoldersBreakdown,assetProfile';
  const [chart, ts, qs] = await Promise.allSettled([
    getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`),
    getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${BP_TYPES.join(',')}&period1=${now - 7 * 365 * 86400}&period2=${now}`, sess.cookie),
    sess.crumb ? getJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}${cr}`, sess.cookie) : Promise.reject(new Error('no crumb'))
  ]);
  if (chart.status !== 'fulfilled') throw new Error('no price history');
  const res0 = chart.value?.chart?.result?.[0];
  const q = res0?.indicators?.quote?.[0] || {};
  const rows = (res0?.timestamp || []).map((t, i) => ({ c: q.close?.[i], h: q.high?.[i], l: q.low?.[i] })).filter(r => typeof r.c === 'number' && typeof r.h === 'number' && typeof r.l === 'number');
  const price = res0?.meta?.regularMarketPrice || (rows.length ? rows[rows.length - 1].c : null);
  if (!(price > 0)) throw new Error('no price');
  const trend = trendTemplate({ closes: rows.map(r => r.c), highs: rows.map(r => r.h), lows: rows.map(r => r.l), bench6m });
  const s = {};
  if (ts.status === 'fulfilled') (ts.value?.timeseries?.result || []).forEach(o => {
    const t = o.meta?.type?.[0]; if (!t || !o[t]) return;
    s[t] = o[t].filter(x => x && x.reportedValue && typeof x.reportedValue.raw === 'number').map(x => ({ d: x.asOfDate, v: x.reportedValue.raw }));
  });
  const g = k => s[k] || [];
  const eq = Object.fromEntries(g('annualStockholdersEquity').map(x => [x.d, x.v]));
  const debt = Object.fromEntries(g('annualTotalDebt').map(x => [x.d, x.v]));
  const roces = g('annualEBIT').map(x => eq[x.d] != null && (eq[x.d] + (debt[x.d] || 0)) > 0 ? x.v / (eq[x.d] + (debt[x.d] || 0)) * 100 : null).filter(x => x != null).slice(-3);
  const eqs = g('annualStockholdersEquity'), lastEq = eqs.length ? eqs[eqs.length - 1].v : null;
  const dts = g('annualTotalDebt'), lastDebt = dts.length ? dts[dts.length - 1].v : 0;
  const fcf = g('annualFreeCashFlow'), rev = g('annualTotalRevenue'), gp = g('annualGrossProfit');
  const R = qs.status === 'fulfilled' ? (qs.value?.quoteSummary?.result?.[0] || {}) : {};
  const raw = o => (o && typeof o.raw === 'number') ? o.raw : null;
  const mcap = raw(R.price?.marketCap) || raw(R.summaryDetail?.marketCap);
  const pe = raw(R.summaryDetail?.trailingPE) || raw(R.defaultKeyStatistics?.trailingPE);
  const ins = raw(R.majorHoldersBreakdown?.insidersPercentHeld), inst = raw(R.majorHoldersBreakdown?.institutionsPercentHeld);
  const qE = raw(R.defaultKeyStatistics?.earningsQuarterlyGrowth);
  let grossMargin = raw(R.financialData?.grossMargins);
  grossMargin = grossMargin != null ? grossMargin * 100 : (gp.length && rev.length && rev[rev.length - 1].v > 0 ? gp[gp.length - 1].v / rev[rev.length - 1].v * 100 : null);
  const m = {
    trend, mcapCr: mcap ? mcap / 1e7 : null, pe,
    roce: roces.length >= 2 ? roces.reduce((a, b) => a + b, 0) / roces.length : null,
    de: lastEq != null && lastEq > 0 ? lastDebt / lastEq : null,
    salesG: cagr(rev, 3), profitG: cagr(g('annualNetIncome'), 3),
    fcfPositive: fcf.length ? fcf[fcf.length - 1].v > 0 : false,
    grossMargin, qEarn: qE != null ? qE * 100 : null,
    ins: ins != null ? ins * 100 : null, inst: inst != null ? inst * 100 : null
  };
  const ev = bpEvaluate(m);
  // Approximate Shariah screen (AAOIFI-style): excluded industries, debt and cash+investments each under 33% of market cap.
  // Interest income and other impermissible revenue are NOT available here, so this is a first filter only.
  const sharia = (() => {
    const ind = ((R.assetProfile?.industry || '') + ' ' + (R.assetProfile?.sector || '')).toLowerCase();
    if (/bank|insurance|credit|mortgage|capital markets|financial|asset management|brewer|distiller|vintner|wine|alcohol|tobacco|gambl|casino|aerospace|defense|broadcasting|entertainment|publishing|adult/.test(ind)) return { ok: false, why: 'business: ' + (R.assetProfile?.industry || R.assetProfile?.sector) };
    const mc = mcap, td = raw(R.financialData?.totalDebt) != null ? raw(R.financialData?.totalDebt) : lastDebt, tc = raw(R.financialData?.totalCash);
    if (!(mc > 0) || td == null) return { ok: null, why: 'data missing' };
    const debtPct = td / mc * 100, cashPct = tc != null ? tc / mc * 100 : null;
    if (debtPct >= 33) return { ok: false, debtPct, cashPct, why: 'debt ' + debtPct.toFixed(0) + '% of market cap (limit 33%)' };
    if (cashPct != null && cashPct >= 33) return { ok: false, debtPct, cashPct, why: 'cash & deposits ' + cashPct.toFixed(0) + '% of market cap (limit 33%)' };
    return { ok: cashPct != null ? true : null, debtPct, cashPct, why: cashPct != null ? 'passes ratio screen' : 'cash data missing' };
  })();
  return {
    sharia,
    symbol: sym, name: R.price?.longName || R.price?.shortName || sym, price, industry: R.assetProfile?.industry || null, sector: R.assetProfile?.sector || null,
    mcapCr: m.mcapCr, pe, roce: m.roce, de: m.de, salesG: m.salesG, profitG: m.profitG, qEarn: m.qEarn, ins: m.ins, inst: m.inst, grossMargin,
    trend: trend ? { passed: trend.passed, items: trend.items, sma50: trend.sma50, sma150: trend.sma150, sma200: trend.sma200, hi52: trend.hi52, lo52: trend.lo52, pctFromHigh: trend.pctFromHigh, pctAboveLow: trend.pctAboveLow, tight15: trend.tight15 } : null,
    score: ev.score, pillars: ev.pillars, verdict: ev.verdict, gatesPass: ev.gatesPass, stage2: ev.stage2, peg: ev.peg, why: ev.why, levels: ev.levels
  };
}

// ---- Multibagger Early Identifier mode: GET /api/compounder-scan?mode=early&symbols=ABC.NS,XYZ.NS (max 4) ----
// Returns the raw fundamentals the "ChatG Multibagger Early Identifier" module scores in the browser.
// Every field Yahoo does not supply is null (never guessed). Promoter PLEDGE and governance flags are NOT available here.
const EARLY_TYPES = ['annualTotalRevenue', 'annualNetIncome', 'annualEBIT', 'annualStockholdersEquity', 'annualTotalDebt', 'annualFreeCashFlow', 'annualOperatingCashFlow', 'annualInterestExpense', 'quarterlyTotalRevenue', 'quarterlyNetIncome'];
const avgOf = a => { const x = a.filter(v => typeof v === 'number' && isFinite(v)); return x.length >= 3 ? x.reduce((p, q) => p + q, 0) / x.length : null; };
// Growth over the longest window available (up to maxYears, at least minYears). Yahoo usually carries only 4-5 annual points.
function cagrUpTo(arr, maxYears, minYears) {
  for (let y = Math.min(maxYears, arr.length - 1); y >= minYears; y--) { const v = cagr(arr, y); if (v != null) return v; }
  return null;
}
function yoyLatest(arr) { // latest quarter vs the same quarter a year earlier
  if (arr.length < 5) return null;
  const a = arr[arr.length - 5].v, b = arr[arr.length - 1].v;
  return a > 0 ? (b / a - 1) * 100 : null;
}
async function oneEarly(sym, sess) {
  const now = Math.floor(Date.now() / 1000);
  const cr = sess.crumb ? '&crumb=' + encodeURIComponent(sess.crumb) : '';
  const mods = 'price,summaryDetail,financialData,defaultKeyStatistics,majorHoldersBreakdown,assetProfile';
  const [chart, ts, qs] = await Promise.allSettled([
    getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`),
    getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${EARLY_TYPES.join(',')}&period1=${now - 8 * 365 * 86400}&period2=${now + 86400}`),
    sess.crumb ? getJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}${cr}`, sess.cookie) : Promise.reject(new Error('no crumb'))
  ]);
  if (chart.status !== 'fulfilled') throw new Error('no price history');
  const res0 = chart.value?.chart?.result?.[0];
  const q = res0?.indicators?.quote?.[0] || {};
  const stamps = res0?.timestamp || [];
  const rows = stamps.map((t, i) => ({ t, c: q.close?.[i], v: q.volume?.[i] })).filter(r => typeof r.c === 'number');
  const price = res0?.meta?.regularMarketPrice || (rows.length ? rows[rows.length - 1].c : null);
  if (!(price > 0)) throw new Error('no price');
  const closes = rows.map(r => r.c);
  const sma = n => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
  const sma50 = sma(50), sma200 = sma(200);
  const ret6m = closes.length > 127 ? (closes[closes.length - 1] / closes[closes.length - 127] - 1) * 100 : null;
  // Momentum 0-100: above 200-day (35), 50-day above 200-day (20), above 50-day (15), up to 30 for a 6-month gain of 30%+.
  let momentum = null;
  if (sma200 != null && sma50 != null) momentum = Math.round((price > sma200 ? 35 : 0) + (sma50 > sma200 ? 20 : 0) + (price > sma50 ? 15 : 0) + (ret6m != null ? Math.max(0, Math.min(30, ret6m)) : 0));
  const vols = rows.map(r => r.v).filter(v => typeof v === 'number' && v > 0);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const volumeConfirmation = vols.length >= 100 ? avg(vols.slice(-20)) > avg(vols.slice(-100)) * 1.1 : false;
  const history = rows.filter((r, i) => i % 5 === 0 || i === rows.length - 1).map(r => ({ date: new Date(r.t * 1000).toISOString().slice(0, 10), close: Math.round(r.c * 100) / 100 }));

  const s = {};
  if (ts.status === 'fulfilled') (ts.value?.timeseries?.result || []).forEach(o => {
    const t = o.meta?.type?.[0]; if (!t || !o[t]) return;
    s[t] = o[t].filter(x => x && x.reportedValue && typeof x.reportedValue.raw === 'number').map(x => ({ d: x.asOfDate, v: x.reportedValue.raw }));
  });
  const g = k => s[k] || [];
  const eq = Object.fromEntries(g('annualStockholdersEquity').map(x => [x.d, x.v]));
  const debt = Object.fromEntries(g('annualTotalDebt').map(x => [x.d, x.v]));
  const rev = Object.fromEntries(g('annualTotalRevenue').map(x => [x.d, x.v]));
  const ni = Object.fromEntries(g('annualNetIncome').map(x => [x.d, x.v]));
  const ebit = g('annualEBIT');
  const roceSeries = ebit.map(x => eq[x.d] != null && (eq[x.d] + (debt[x.d] || 0)) > 0 ? x.v / (eq[x.d] + (debt[x.d] || 0)) * 100 : null).filter(x => x != null).slice(-5);
  const roeSeries = g('annualNetIncome').map(x => eq[x.d] > 0 ? x.v / eq[x.d] * 100 : null).filter(x => x != null).slice(-5);
  const opmSeries = ebit.map(x => rev[x.d] > 0 ? x.v / rev[x.d] * 100 : null).filter(x => x != null).slice(-5);
  const eqs = g('annualStockholdersEquity'), lastEq = eqs.length ? eqs[eqs.length - 1].v : null;
  const dts = g('annualTotalDebt'), lastDebt = dts.length ? dts[dts.length - 1].v : null;
  const lastOf = a => a.length ? a[a.length - 1].v : null;
  const intExp = g('annualInterestExpense'), lastInt = intExp.length ? Math.abs(intExp[intExp.length - 1].v) : null, lastEbit = lastOf(ebit);
  const R = qs.status === 'fulfilled' ? (qs.value?.quoteSummary?.result?.[0] || {}) : {};
  const raw = o => (o && typeof o.raw === 'number') ? o.raw : null;
  const mcap = raw(R.price?.marketCap) || raw(R.summaryDetail?.marketCap);
  const pe = raw(R.summaryDetail?.trailingPE) || raw(R.defaultKeyStatistics?.trailingPE);
  const roeNow = raw(R.financialData?.returnOnEquity), opmNow = raw(R.financialData?.operatingMargins);
  const ins = raw(R.majorHoldersBreakdown?.insidersPercentHeld);
  const de = lastEq != null && lastEq > 0 && lastDebt != null ? lastDebt / lastEq : (lastDebt === 0 ? 0 : null);
  let interestCoverage = null;
  if (lastEbit != null && lastInt > 0) interestCoverage = lastEbit / lastInt;
  else if (lastDebt === 0 || (de != null && de < 0.02)) interestCoverage = 99; // effectively debt-free
  // Approximate Shariah screen (AAOIFI-style ratio filter): excluded industries, debt and cash each under 33% of market cap.
  const sharia = (() => {
    const ind = ((R.assetProfile?.industry || '') + ' ' + (R.assetProfile?.sector || '')).toLowerCase();
    if (/bank|insurance|credit|mortgage|capital markets|financial|asset management|brewer|distiller|vintner|wine|alcohol|tobacco|gambl|casino|aerospace|defense|broadcasting|entertainment|publishing|adult/.test(ind)) return false;
    const td = raw(R.financialData?.totalDebt) != null ? raw(R.financialData?.totalDebt) : lastDebt, tc = raw(R.financialData?.totalCash);
    if (!(mcap > 0) || td == null || tc == null) return null;
    return td / mcap * 100 < 33 && tc / mcap * 100 < 33;
  })();
  return {
    symbol: sym.replace(/\.(NS|BO)$/i, ''), ysym: sym, name: R.price?.longName || R.price?.shortName || sym,
    exchange: /\.BO$/i.test(sym) ? 'BSE' : 'NSE', industry: R.assetProfile?.industry || null, sector: R.assetProfile?.sector || null,
    price, marketCap: mcap ? mcap / 1e7 : null,
    salesGrowth3Y: cagr(g('annualTotalRevenue'), 3), salesGrowth5Y: cagrUpTo(g('annualTotalRevenue'), 5, 4),
    quarterlySalesGrowth: yoyLatest(g('quarterlyTotalRevenue')),
    profitGrowth3Y: cagr(g('annualNetIncome'), 3), profitGrowth5Y: cagrUpTo(g('annualNetIncome'), 5, 4),
    quarterlyProfitGrowth: yoyLatest(g('quarterlyNetIncome')),
    roce: roceSeries.length ? roceSeries[roceSeries.length - 1] : null, roce5Y: avgOf(roceSeries),
    roe: roeNow != null ? roeNow * 100 : (roeSeries.length ? roeSeries[roeSeries.length - 1] : null), roe5Y: avgOf(roeSeries),
    opm: opmNow != null ? opmNow * 100 : (opmSeries.length ? opmSeries[opmSeries.length - 1] : null), opm5Y: avgOf(opmSeries),
    debtEquity: de, interestCoverage,
    operatingCashFlow: lastOf(g('annualOperatingCashFlow')), freeCashFlow: lastOf(g('annualFreeCashFlow')),
    promoterHolding: ins != null ? ins * 100 : null, pledgedPct: null,
    pe, momentum, volumeConfirmation, governanceFlag: false,
    shariaAAOIFI: sharia, shariaMSCI: sharia, fairValue: null, history
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  const mode = String((req.query || {}).mode || ''), isBp = mode === 'blueprint', isEarly = mode === 'early';
  const syms = String((req.query || {}).symbols || '').split(',').map(x => x.trim().toUpperCase()).filter(x => /^[A-Z0-9&.\-]{1,20}$/.test(x)).slice(0, (isBp || isEarly) ? 4 : 6);
  if (!syms.length) { res.status(400).json({ error: 'Pass ?symbols=ABC.NS,XYZ.NS (max 6)' }); return; }
  try {
    const sess = await session();
    const bench = isBp ? await benchmark6m() : null;
    const out = await Promise.allSettled(syms.map(x => isEarly ? oneEarly(x, sess) : isBp ? oneBlueprint(x, sess, bench) : one(x, sess)));
    const results = [], errors = [];
    out.forEach((o, i) => o.status === 'fulfilled' ? results.push(o.value) : errors.push({ symbol: syms[i], error: String(o.reason && o.reason.message || o.reason) }));
    res.status(200).json({ gates: GATES, results, errors });
  } catch (e) { res.status(502).json({ error: 'Scan source unavailable: ' + (e.message || 'unknown') }); }
};
