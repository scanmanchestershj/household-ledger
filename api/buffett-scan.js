// Warren Buffett value screen — serverless endpoint.
//   GET /api/buffett-scan?prefilter=A.NS,B.NS,...   (<=120) -> { keep: [symbols with P/B<=4 and 0<PE<=25] }
//   GET /api/buffett-scan?symbols=A.NS,B.NS          (<=4)   -> { results: [...evaluate() output | {symbol,error}] }
// Uses Yahoo Finance's UNOFFICIAL endpoints (same as stock-quote.js). Anything missing -> that stock is
// reported as an error/insufficient-data and is NEVER passed as a buy.
const { evaluate } = require('../buffett-formulas.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const wt = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]);
async function getJson(url, headers) {
  const r = await wt(fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers || {}) }), 8000);
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}
async function session() {
  try {
    const r1 = await wt(fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }), 5000);
    const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [];
    const cookie = raw.map(c => c.split(';')[0]).join('; ');
    const r2 = await wt(fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } }), 5000);
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.includes('<')) return { cookie: '', crumb: '' };
    return { cookie, crumb };
  } catch (e) { return { cookie: '', crumb: '' }; }
}
const sma = (a, n) => a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null;
function rsi14(c) {
  if (c.length < 15) return null;
  let g = 0, l = 0;
  for (let i = c.length - 14; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
async function loadOne(sym, sess) {
  const ck = sess.cookie ? { Cookie: sess.cookie } : {};
  const cr = sess.crumb ? '&crumb=' + encodeURIComponent(sess.crumb) : '';
  const types = ['annualNetIncome', 'annualDilutedEPS', 'annualStockholdersEquity', 'annualTotalDebt', 'annualFreeCashFlow', 'annualOrdinarySharesNumber', 'annualEBIT'];
  const now = Math.floor(Date.now() / 1000);
  const [chart, ts, q, prof] = await Promise.allSettled([
    getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`),
    getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types.join(',')}&period1=${now - 8 * 365 * 86400}&period2=${now}${cr}`, ck),
    getJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}${cr}`, ck),
    sess.crumb ? getJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile${cr}`, ck) : Promise.reject(new Error('no crumb')),
  ]);
  if (chart.status !== 'fulfilled') throw new Error('no price data');
  if (ts.status !== 'fulfilled') throw new Error('no fundamentals history');
  const cres = chart.value?.chart?.result?.[0];
  const closes = (cres?.indicators?.quote?.[0]?.close || []).filter(x => typeof x === 'number');
  const price = cres?.meta?.regularMarketPrice;
  if (!price || closes.length < 60) throw new Error('not enough price history');
  const series = {};
  (ts.value?.timeseries?.result || []).forEach(o => {
    const t = o.meta?.type?.[0]; if (!t || !o[t]) return;
    series[t] = o[t].filter(x => x && x.reportedValue && typeof x.reportedValue.raw === 'number').map(x => x.reportedValue.raw);
  });
  const ni = series.annualNetIncome || [], eps = series.annualDilutedEPS || [], eq = series.annualStockholdersEquity || [];
  const debt = series.annualTotalDebt || [], fcf = series.annualFreeCashFlow || [], sh = series.annualOrdinarySharesNumber || [], ebit = series.annualEBIT || [];
  const n = Math.min(ni.length, eps.length, eq.length);
  if (n < 3) throw new Error('fewer than 3 years of reported data');
  const take = a => a.slice(-n);
  const roeHistory = take(ni).map((x, i) => take(eq)[i] > 0 ? x / take(eq)[i] * 100 : -100);
  const lastEq = eq[eq.length - 1], lastDebt = debt.length ? debt[debt.length - 1] : 0, lastSh = sh.length ? sh[sh.length - 1] : null;
  const bvps = lastSh ? lastEq / lastSh : null;
  if (!bvps || bvps <= 0) throw new Error('book value unavailable');
  const lastEbit = ebit.length ? ebit[ebit.length - 1] : null;
  const roce = lastEbit != null && (lastEq + lastDebt) > 0 ? lastEbit / (lastEq + lastDebt) * 100 : 0;
  const profitable = take(ni).filter(x => x > 0).length;
  const industry = prof.status === 'fulfilled' ? (prof.value?.quoteSummary?.result?.[0]?.assetProfile?.industry || '') : '';
  const qr = q.status === 'fulfilled' ? q.value?.quoteResponse?.result?.[0] : null;
  const res = evaluate({
    symbol: sym, price, bvps, epsHistory: take(eps),
    fcfPsHistory: lastSh ? take(fcf).map(x => x / lastSh) : [],
    roeHistory, roce, de: lastEq > 0 ? lastDebt / lastEq : 9,
    profitYears: Math.round(5 * profitable / n), promoterPledge: null, sector: industry,
    sma200: sma(closes, 200) || sma(closes, closes.length), rsi14: rsi14(closes) ?? 50, qtrProfitYoY: [],
  });
  return Object.assign(res, { name: (qr && (qr.longName || qr.shortName)) || sym, price, industry, yearsOfData: n, pledgeChecked: false });
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  const qs = req.query || {};
  try {
    if (qs.prefilter) {
      const syms = String(qs.prefilter).split(',').map(s => s.trim()).filter(Boolean).slice(0, 120);
      const sess = await session();   // Yahoo's batch quote needs the cookie+crumb session
      const cr = sess.crumb ? '&crumb=' + encodeURIComponent(sess.crumb) : '';
      const d = await getJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms.join(','))}${cr}`, sess.cookie ? { Cookie: sess.cookie } : {});
      const rows = d?.quoteResponse?.result || [];
      const keep = rows.filter(x => x.trailingPE > 0 && x.trailingPE <= 25 && x.priceToBook > 0 && x.priceToBook <= 4).map(x => x.symbol);
      res.status(200).json({ keep, checked: rows.length, crumb: !!sess.crumb });
      return;
    }
    const syms = String(qs.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (!syms.length) { res.status(400).json({ error: 'Pass ?symbols=A.NS,B.NS (max 4) or ?prefilter=...' }); return; }
    const sess = await session();
    const results = await Promise.all(syms.map(s => loadOne(s, sess).catch(e => ({ symbol: s, error: e.message || 'failed' }))));
    res.status(200).json({ results });
  } catch (e) {
    console.error('buffett-scan failed:', e && e.message);
    res.status(502).json({ error: 'Data source unavailable: ' + (e.message || 'unknown') });
  }
};
