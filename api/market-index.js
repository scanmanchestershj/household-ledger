// Serverless proxy for major stock index levels, shown automatically in the
// Investment tab for whichever country the person is currently viewing.
// GET /api/market-index?market=IN|AE

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

const INDICES = {
  IN: [
    { symbol: '^NSEI', name: 'NIFTY 50', exchange: 'NSE' },
    { symbol: '^BSESN', name: 'SENSEX', exchange: 'BSE' }
  ],
  AE: [
    { symbol: 'DFMGI.AE', name: 'DFM General Index', exchange: 'Dubai (DFM)' },
    { symbol: 'FADGI.FGI', name: 'FTSE ADX General Index', exchange: 'Abu Dhabi (ADX)' }
  ]
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function fetchIndex(def) {
  try {
    const res = await withTimeout(fetch(`${YAHOO_CHART}/${encodeURIComponent(def.symbol)}?interval=1d&range=1d`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    }), 8000);
    if (!res.ok) return { ...def, price: null, changePercent: null };
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return { ...def, price: null, changePercent: null };
    const prevClose = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : meta.previousClose;
    const changePercent = prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : null;
    return { ...def, price: meta.regularMarketPrice, changePercent, currency: meta.currency || null };
  } catch (e) {
    return { ...def, price: null, changePercent: null };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const market = req.query && req.query.market === 'AE' ? 'AE' : 'IN';
  const defs = INDICES[market];
  const results = await Promise.all(defs.map(fetchIndex));
  res.status(200).json({ market, indices: results });
};
