// Next results (earnings) date for a few stocks.
//   GET /api/earnings-calendar?symbols=A.NS,B.NS   (max 8)
// -> { results: [{ symbol, date: 'YYYY-MM-DD' | null, estimate: bool, daysAway }] }
// Source: Yahoo Finance quoteSummary "calendarEvents" (UNOFFICIAL). Coverage of Indian stocks is
// incomplete — a missing date comes back as null, never guessed.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const wt = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]);
async function session() {
  try {
    const r1 = await wt(fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }), 5000);
    const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [];
    const cookie = raw.map(c => c.split(';')[0]).join('; ');
    const r2 = await wt(fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } }), 5000);
    const crumb = (await r2.text()).trim();
    return crumb && !crumb.includes('<') ? { cookie, crumb } : null;
  } catch (e) { return null; }
}
async function one(sym, sess) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents&crumb=${encodeURIComponent(sess.crumb)}`;
  const r = await wt(fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: sess.cookie } }), 8000);
  if (!r.ok) throw new Error('upstream ' + r.status);
  const d = await r.json();
  const e = d?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
  const raw = e?.earningsDate?.[0]?.raw;
  if (typeof raw !== 'number') return { symbol: sym, date: null, estimate: false, daysAway: null };
  const date = new Date(raw * 1000).toISOString().slice(0, 10);
  const daysAway = Math.round((new Date(date + 'T00:00:00Z') - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86400000);
  return { symbol: sym, date, estimate: !!e.isEarningsDateEstimate, daysAway };
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  const syms = String((req.query || {}).symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9&.\-]{1,20}$/.test(s)).slice(0, 8);
  if (!syms.length) { res.status(400).json({ error: 'Pass ?symbols=A.NS,B.NS (max 8)' }); return; }
  const sess = await session();
  if (!sess) { console.error('earnings-calendar: no Yahoo session'); res.status(502).json({ error: 'Data source unavailable (no session)' }); return; }
  const results = await Promise.all(syms.map(s => one(s, sess).catch(e => ({ symbol: s, date: null, estimate: false, daysAway: null, error: e.message }))));
  res.status(200).json({ results });
};
