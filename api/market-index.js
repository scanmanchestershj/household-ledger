// Serverless proxy for major stock index levels, shown automatically in the
// Investment tab for whichever country the person is currently viewing.
// GET /api/market-index?market=IN|AE

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com/v8/finance/chart', 'https://query2.finance.yahoo.com/v8/finance/chart'];

const INDICES = {
  IN: [
    { symbol: '^NSEI', name: 'NIFTY 50', exchange: 'NSE' },
    { symbol: '^BSESN', name: 'SENSEX', exchange: 'BSE' }
  ],
  AE: [
    { symbol: 'DFMGI.AE', name: 'DFM General Index', exchange: 'Dubai (DFM)' },
    { symbol: 'FADGI.FGI', name: 'FTSE ADX General Index', exchange: 'Abu Dhabi (ADX)' }
  ],
  US: [
    { symbol: '^GSPC', name: 'S&P 500', exchange: 'NYSE/Nasdaq' },
    { symbol: '^DJI', name: 'Dow Jones', exchange: 'NYSE' },
    { symbol: '^IXIC', name: 'Nasdaq Composite', exchange: 'Nasdaq' }
  ],
  GB: [
    { symbol: '^FTSE', name: 'FTSE 100', exchange: 'LSE' }
  ],
  SA: [
    { symbol: '^TASI.SR', name: 'Tadawul All Share', exchange: 'Saudi Exchange' }
  ]
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function fetchIndex(def) {
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await withTimeout(fetch(`${host}/${encodeURIComponent(def.symbol)}?interval=1d&range=1d`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }
      }), 8000);
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') continue;
      const prevClose = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : meta.previousClose;
      const changePercent = prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : null;
      return { ...def, price: meta.regularMarketPrice, changePercent, currency: meta.currency || null };
    } catch (e) {
      // try the next host
    }
  }
  return { ...def, price: null, changePercent: null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const market = (req.query && req.query.market) || 'IN';
  const defs = INDICES[market];
  if (!defs) {
    res.status(200).json({ market, indices: [] });
    return;
  }
  const results = await Promise.all(defs.map(fetchIndex));
  res.status(200).json({ market, indices: results });
};
