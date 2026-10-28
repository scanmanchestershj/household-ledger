// Multi-year fundamentals for the Investment > Screener "Fundamentals" form.
//   GET /api/stock-fundamentals?symbol=WIPRO.NS
// Returns the fields stock-quote.js can't: 3-yr avg ROCE, 3-yr sales/profit growth, EPS growth,
// 3/5-yr cash-flow totals (₹ Cr), shares (Cr) and an approximate industry P/E (median of Yahoo's
// "similar stocks"). Uses Yahoo's UNOFFICIAL endpoints; any field Yahoo doesn't have comes back null
// (never guessed) and `notes` says what was approximated.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const wt = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]);
async function getJson(url, cookie) {
  const r = await wt(fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, cookie ? { Cookie: cookie } : {}) }), 8000);
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
    return crumb && !crumb.includes('<') ? { cookie, crumb } : { cookie: '', crumb: '' };
  } catch (e) { return { cookie: '', crumb: '' }; }
}
const TYPES = ['annualTotalRevenue', 'annualNetIncome', 'annualDilutedEPS', 'annualEBIT', 'annualStockholdersEquity', 'annualTotalDebt', 'annualFreeCashFlow', 'annualOperatingCashFlow', 'annualOrdinarySharesNumber'];
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// CAGR over up to `years` years using the newest points; needs positive endpoints.
function cagr(arr, years) {
  const v = arr.map(x => x.v);
  if (v.length < 2) return null;
  const span = Math.min(years, v.length - 1);
  const a = v[v.length - 1 - span], b = v[v.length - 1];
  if (!(a > 0) || !(b > 0)) return null;
  return { pct: (Math.pow(b / a, 1 / span) - 1) * 100, years: span };
}
const cr = x => x / 1e7;                                  // INR -> ₹ Crore
const sumLast = (arr, n) => arr.length >= n ? arr.slice(-n).reduce((s, x) => s + x.v, 0) : null;
async function peerPe(sym) {
  try {
    const d = await getJson(`https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(sym)}`);
    const peers = (d?.finance?.result?.[0]?.recommendedSymbols || []).map(x => x.symbol).filter(s => /\.(NS|BO)$/.test(s) && s !== sym).slice(0, 10);
    if (peers.length < 3) return null;
    const q = await getJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(peers.join(','))}`);
    const pes = (q?.quoteResponse?.result || []).map(x => x.trailingPE).filter(x => typeof x === 'number' && x > 0 && x < 150);
    return pes.length >= 3 ? { pe: median(pes), n: pes.length } : null;
  } catch (e) { return null; }
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  const sym = String((req.query || {}).symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9&.\-]{1,20}$/.test(sym)) { res.status(400).json({ error: 'Pass ?symbol=WIPRO.NS' }); return; }
  try {
    const { cookie, crumb } = await session();
    const now = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${TYPES.join(',')}&period1=${now - 8 * 365 * 86400}&period2=${now}` + (crumb ? '&crumb=' + encodeURIComponent(crumb) : '');
    const [ts, pe] = await Promise.all([getJson(url, cookie), peerPe(sym)]);
    const s = {};
    (ts?.timeseries?.result || []).forEach(o => {
      const t = o.meta?.type?.[0]; if (!t || !o[t]) return;
      s[t] = o[t].filter(x => x && x.reportedValue && typeof x.reportedValue.raw === 'number').map(x => ({ d: x.asOfDate, v: x.reportedValue.raw }));
    });
    const g = k => s[k] || [];
    if (!g('annualNetIncome').length && !g('annualTotalRevenue').length) { res.status(404).json({ error: 'No annual financials found for ' + sym }); return; }
    const notes = [];
    // ROCE (pre-tax proxy) = EBIT / (equity + debt), averaged over up to 3 years, aligned by report date
    const eq = Object.fromEntries(g('annualStockholdersEquity').map(x => [x.d, x.v]));
    const debt = Object.fromEntries(g('annualTotalDebt').map(x => [x.d, x.v]));
    const roces = g('annualEBIT').map(x => eq[x.d] != null && (eq[x.d] + (debt[x.d] || 0)) > 0 ? x.v / (eq[x.d] + (debt[x.d] || 0)) * 100 : null).filter(x => x != null).slice(-3);
    const roce3yr = roces.length ? roces.reduce((a, b) => a + b, 0) / roces.length : null;
    if (roce3yr != null) notes.push(`ROCE = EBIT ÷ (equity + debt), pre-tax, avg of ${roces.length} yr`);
    const sales = cagr(g('annualTotalRevenue'), 3), profit = cagr(g('annualNetIncome'), 3), eps = cagr(g('annualDilutedEPS'), 5);
    if (eps && eps.years < 5) notes.push(`EPS growth uses ${eps.years} yr (Yahoo has no more history)`);
    if (sales && sales.years < 3) notes.push(`Sales growth uses ${sales.years} yr`);
    if (profit && profit.years < 3) notes.push(`Profit growth uses ${profit.years} yr`);
    const fcf = g('annualFreeCashFlow'), ocf = g('annualOperatingCashFlow'), sh = g('annualOrdinarySharesNumber');
    const f3 = sumLast(fcf, 3), o3 = sumLast(ocf, 3), f5 = sumLast(fcf, 5);
    if (f3 == null && fcf.length) notes.push(`Only ${fcf.length} yr of free cash flow available — 3-yr total left blank`);
    if (f5 == null && fcf.length) notes.push('5-yr free cash flow needs 5 reported years — left blank');
    res.status(200).json({
      symbol: sym,
      roce3yr, salesGrowth3yr: sales ? sales.pct : null, profitGrowth3yr: profit ? profit.pct : null,
      epsGrowth5yr: eps ? eps.pct : null, epsGrowthYears: eps ? eps.years : null,
      fcf3yr: f3 != null ? cr(f3) : null, ocf3yr: o3 != null ? cr(o3) : null, fcf5yr: f5 != null ? cr(f5) : null,
      fcfPrecYear: fcf.length ? cr(fcf[fcf.length - 1].v) : null,
      shares: sh.length ? cr(sh[sh.length - 1].v) : null,
      industryPe: pe ? pe.pe : null, industryPeNote: pe ? `median P/E of ${pe.n} similar listed stocks` : null,
      notes
    });
  } catch (e) {
    res.status(502).json({ error: 'Financials source unavailable: ' + (e.message || 'unknown') });
  }
};
