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
const YAHOO_QUOTE_V7 = 'https://query1.finance.yahoo.com/v7/finance/quote';
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

const STOCK_SUFFIXES = {
  IN: ['.NS', '.BO'],
  AE: ['.AE'],
  GB: ['.L'],
  SA: ['.SR'],
  US: [] // US tickers have no suffix on Yahoo
};

async function resolveSymbol(query, market) {
  const suffixes = STOCK_SUFFIXES[market] || STOCK_SUFFIXES.IN;
  if (suffixes.some(s => query.trim().toUpperCase().endsWith(s)) || (market === 'US' && /^[A-Z.]{1,6}$/.test(query.trim()) && query.trim() === query.trim().toUpperCase() && query.trim().length <= 5)) {
    return { symbol: query.trim().toUpperCase(), name: query.trim().toUpperCase() };
  }
  const data = await fetchJson(`${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const quotes = (data.quotes || []).filter(q => q.symbol);
  if (!quotes.length) return null;

  if (market === 'US') {
    // US tickers have no suffix — prefer results whose symbol has no dot at all.
    const match = quotes.find(q => !q.symbol.includes('.'));
    if (match) return { symbol: match.symbol, name: match.longname || match.shortname || match.symbol };
  } else {
    for (const suffix of suffixes) {
      const match = quotes.find(q => q.symbol.toUpperCase().endsWith(suffix));
      if (match) return { symbol: match.symbol, name: match.longname || match.shortname || match.symbol };
    }
  }
  return { symbol: quotes[0].symbol, name: quotes[0].longname || quotes[0].shortname || quotes[0].symbol };
}

// Lighter-weight batch quote endpoint — historically more permissive than
// quoteSummary (no crumb needed in most reported cases as of writing),
// so it's tried first for the widest field coverage in one call.
async function getQuoteV7(symbol) {
  const data = await fetchJson(`${YAHOO_QUOTE_V7}?symbols=${encodeURIComponent(symbol)}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const q = data?.quoteResponse?.result?.[0];
  if (!q) return null;
  const num = (v) => (typeof v === 'number' ? v : null);
  const priceToBook = num(q.priceToBook);
  const price = num(q.regularMarketPrice);
  return {
    price,
    eps: num(q.epsTrailingTwelveMonths),
    pe: num(q.trailingPE),
    marketCap: num(q.marketCap),
    priceToBook,
    bookValue: (priceToBook && price && priceToBook > 0) ? price / priceToBook : null,
    currency: q.currency || null,
    exchange: q.fullExchangeName || q.exchange || null,
    name: q.longName || q.shortName || null,
    dividendYield: num(q.trailingAnnualDividendYield) != null ? num(q.trailingAnnualDividendYield) * 100 : null
  };
}

// Price via the "chart" endpoint — this one has stayed crumb-free in
// practice, unlike quoteSummary, so it's a reliable fallback for price alone
// if the batch quote above fails entirely.
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
    marketCap: pick(summaryDetail.marketCap) || pick(keyStats.marketCap),
    priceToBook: pick(keyStats.priceToBook),
    dividendYield: pick(summaryDetail.dividendYield) != null ? pick(summaryDetail.dividendYield) * 100 : null,
    debtToEquity: pick(financialData.debtToEquity) != null ? pick(financialData.debtToEquity) / 100 : null,
    returnOnEquity: pick(financialData.returnOnEquity) != null ? pick(financialData.returnOnEquity) * 100 : null,
    currentRatio: pick(financialData.currentRatio),
    operatingCashflow: pick(financialData.operatingCashflow),
    freeCashflow: pick(financialData.freeCashflow)
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const { q, market } = req.query || {};
  if (!q || !String(q).trim()) {
    res.status(400).json({ error: 'Missing query parameter "q" (company name or ticker).' });
    return;
  }
  const marketCode = ['IN','AE','US','GB','SA'].includes(market) ? market : 'IN';

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

  // Try the batch quote first — widest field coverage, and historically the
  // most likely to still work without a crumb.
  let v7 = null;
  try { v7 = await getQuoteV7(resolved.symbol); } catch (e) { /* fall through */ }

  let priceInfo = null;
  if (!v7 || v7.price == null) {
    try { priceInfo = await getChartPrice(resolved.symbol); } catch (e) { /* handled below */ }
  }

  let fundamentals = null;
  // Only worth the extra crumb round-trip if the batch quote didn't already
  // give us EPS/book value.
  if (!v7 || v7.eps == null || v7.bookValue == null) {
    try { fundamentals = await getFundamentals(resolved.symbol); } catch (e) { /* fundamentals optional — degrade gracefully */ }
  }

  const price = (v7 && v7.price != null) ? v7.price : (priceInfo ? priceInfo.price : null);
  if (price == null) {
    res.status(404).json({ error: `Found "${resolved.symbol}" but couldn't retrieve a live price for it right now — try again shortly or enter values manually.` });
    return;
  }

  res.status(200).json({
    symbol: resolved.symbol,
    name: (v7 && v7.name) || resolved.name,
    currency: (v7 && v7.currency) || (priceInfo && priceInfo.currency) || null,
    exchange: (v7 && v7.exchange) || (priceInfo && priceInfo.exchange) || null,
    price,
    eps: (v7 && v7.eps != null) ? v7.eps : (fundamentals ? fundamentals.eps : null),
    bookValue: (v7 && v7.bookValue != null) ? v7.bookValue : (fundamentals ? fundamentals.bookValue : null),
    pe: (v7 && v7.pe != null) ? v7.pe : (fundamentals ? fundamentals.pe : null),
    marketCap: (v7 && v7.marketCap != null) ? v7.marketCap : (fundamentals ? fundamentals.marketCap : null),
    priceToBook: (v7 && v7.priceToBook != null) ? v7.priceToBook : (fundamentals ? fundamentals.priceToBook : null),
    dividendYield: (v7 && v7.dividendYield != null) ? v7.dividendYield : (fundamentals ? fundamentals.dividendYield : null),
    debtToEquity: fundamentals ? fundamentals.debtToEquity : null,
    returnOnEquity: fundamentals ? fundamentals.returnOnEquity : null,
    currentRatio: fundamentals ? fundamentals.currentRatio : null,
    operatingCashflow: fundamentals ? fundamentals.operatingCashflow : null,
    freeCashflow: fundamentals ? fundamentals.freeCashflow : null
  });
};
