// Serverless proxy for live stock data used by the Investment tab's
// "undervalued stock check" calculator. Runs server-side (Vercel Node
// function) because Yahoo Finance's endpoints don't allow direct browser
// (CORS) requests from a static page.
//
// GET /api/stock-quote?q=<company name or ticker>&market=IN|AE
//   market=IN -> tries .NS (NSE) then .BO (BSE) suffixes
//   market=AE -> tries .AE suffix (Dubai Financial Market / ADX)
//
// This calls Yahoo Finance's public but UNOFFICIAL endpoints. They are not
// guaranteed stable long-term. Price comes from the crumb-free "chart"
// endpoint (reliable). Fundamentals (EPS/book value/etc.) need Yahoo's
// newer cookie+crumb session flow — if that fails for any reason, price is
// still returned and the front-end asks for the rest manually rather than
// failing the whole lookup.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_QUOTE_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function fetchJson(url, options) {
  const res = await withTimeout(fetch(url, options), 8000);
  if (!res.ok) throw new Error('Upstream request failed: ' + res.status);
  return res.json();
}

async function resolveSymbol(query, market) {
  if (/\.(NS|BO|AE)$/i.test(query.trim())) {
    return query.trim().toUpperCase();
  }
  const data = await fetchJson(`${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const quotes = (data.quotes || []).filter(q => q.symbol);
  if (!quotes.length) return null;

  const suffixPriority = market === 'AE' ? ['.AE'] : ['.NS', '.BO'];
  for (const suffix of suffixPriority) {
    const match = quotes.find(q => q.symbol.toUpperCase().endsWith(suffix));
    if (match) return { symbol: match.symbol, name: match.longname || match.shortname || match.symbol };
  }
  return { symbol: quotes[0].symbol, name: quotes[0].longname || quotes[0].shortname || quotes[0].symbol };
}

// Price via the "chart" endpoint — this one has stayed crumb-free in
// practice, unlike quoteSummary, so it's the reliable part of this proxy.
async function getChartPrice(symbol) {
  const data = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  return {
    price: typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null
  };
}

// Fundamentals via quoteSummary — needs Yahoo's cookie+crumb session flow
// (added ~2023/2024). Any failure here is caught by the caller so it never
// blocks the price lookup above.
async function getCookieAndCrumb() {
  const res1 = await withTimeout(fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }), 6000);
  const rawCookies = typeof res1.headers.getSetCookie === 'function' ? res1.headers.getSetCookie() : [];
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
  const res2 = await withTimeout(fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookieHeader }
  }), 6000);
  if (!res2.ok) throw new Error('crumb request failed');
  const crumb = (await res2.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('invalid crumb'); // Yahoo sometimes returns an HTML error page
  return { cookieHeader, crumb };
}
async function getFundamentals(symbol) {
  const { cookieHeader, crumb } = await getCookieAndCrumb();
  const modules = 'defaultKeyStatistics,financialData,summaryDetail';
  const data = await fetchJson(`${YAHOO_QUOTE_SUMMARY}/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': cookieHeader }
  });
  const result = data?.quoteSummary?.result?.[0];
  if (!result) return null;
  const keyStats = result.defaultKeyStatistics || {};
  const financialData = result.financialData || {};
  const summaryDetail = result.summaryDetail || {};
  const pick = (obj) => (obj && typeof obj.raw === 'number' ? obj.raw : null);
  return {
    eps: pick(keyStats.trailingEps),
    bookValue: pick(keyStats.bookValue),
    pe: pick(summaryDetail.trailingPE) || pick(keyStats.trailingPE),
    dividendYield: pick(summaryDetail.dividendYield) != null ? pick(summaryDetail.dividendYield) * 100 : null,
    debtToEquity: pick(financialData.debtToEquity) != null ? pick(financialData.debtToEquity) / 100 : null
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const { q, market } = req.query || {};
  if (!q || !String(q).trim()) {
    res.status(400).json({ error: 'Missing query parameter "q" (company name or ticker).' });
    return;
  }
  const marketCode = market === 'AE' ? 'AE' : 'IN';

  let resolved;
  try {
    resolved = await resolveSymbol(String(q), marketCode);
  } catch (e) {
    res.status(502).json({ error: 'Live data source is unavailable right now — please enter values manually.' });
    return;
  }
  if (!resolved) {
    res.status(404).json({ error: `Couldn't find a matching stock for "${q}".` });
    return;
  }

  let priceInfo = null;
  try { priceInfo = await getChartPrice(resolved.symbol); } catch (e) { /* handled below */ }

  let fundamentals = null;
  try { fundamentals = await getFundamentals(resolved.symbol); } catch (e) { /* fundamentals optional — degrade gracefully */ }

  if (!priceInfo || priceInfo.price == null) {
    res.status(404).json({ error: `Found "${resolved.symbol}" but couldn't retrieve a live price for it right now — try again shortly or enter values manually.` });
    return;
  }

  res.status(200).json({
    symbol: resolved.symbol,
    name: resolved.name,
    currency: priceInfo.currency,
    exchange: priceInfo.exchange,
    price: priceInfo.price,
    eps: fundamentals ? fundamentals.eps : null,
    bookValue: fundamentals ? fundamentals.bookValue : null,
    pe: fundamentals ? fundamentals.pe : null,
    dividendYield: fundamentals ? fundamentals.dividendYield : null,
    debtToEquity: fundamentals ? fundamentals.debtToEquity : null
  });
};
