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
// guaranteed stable long-term, so every field is optional in the response
// and the front-end always falls back to manual entry if a field is missing.

const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_QUOTE_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Upstream request failed: ' + res.status);
  return res.json();
}

async function resolveSymbol(query, market) {
  // If the query already looks like a ticker with a suffix, use it directly.
  if (/\.(NS|BO|AE)$/i.test(query.trim())) {
    return query.trim().toUpperCase();
  }
  const data = await fetchJson(`${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`);
  const quotes = (data.quotes || []).filter(q => q.symbol);
  if (!quotes.length) return null;

  const suffixPriority = market === 'AE' ? ['.AE'] : ['.NS', '.BO'];
  for (const suffix of suffixPriority) {
    const match = quotes.find(q => q.symbol.toUpperCase().endsWith(suffix));
    if (match) return match.symbol;
  }
  // Fall back to the first result if nothing matched the expected exchange.
  return quotes[0].symbol;
}

async function getQuoteData(symbol) {
  const modules = 'price,defaultKeyStatistics,financialData,summaryDetail';
  const data = await fetchJson(`${YAHOO_QUOTE_SUMMARY}/${encodeURIComponent(symbol)}?modules=${modules}`);
  const result = data?.quoteSummary?.result?.[0];
  if (!result) return null;

  const price = result.price || {};
  const keyStats = result.defaultKeyStatistics || {};
  const financialData = result.financialData || {};
  const summaryDetail = result.summaryDetail || {};

  const pick = (obj) => (obj && typeof obj.raw === 'number' ? obj.raw : null);

  return {
    symbol,
    name: price.longName || price.shortName || symbol,
    currency: price.currency || null,
    exchange: price.exchangeName || null,
    price: pick(price.regularMarketPrice),
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
  try {
    const symbol = await resolveSymbol(String(q), market === 'AE' ? 'AE' : 'IN');
    if (!symbol) {
      res.status(404).json({ error: `Couldn't find a matching stock for "${q}".` });
      return;
    }
    const quote = await getQuoteData(symbol);
    if (!quote || quote.price == null) {
      res.status(404).json({ error: `Found "${symbol}" but couldn't retrieve live data for it right now.` });
      return;
    }
    res.status(200).json(quote);
  } catch (err) {
    res.status(502).json({ error: 'Live data source is unavailable right now — please enter values manually.' });
  }
};
