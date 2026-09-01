// Serverless price-history fetcher, used for the stock detail chart
// (1D/1W/1M/3M/6M/1Y/5Y/All) so a stock flagged Strong Buy by the
// technical scanner can be monitored over time.
//
// GET /api/stock-history?symbol=<yahoo symbol, e.g. RELIANCE.NS>&range=1d|1w|1mo|3mo|6mo|1y|5y|max

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Yahoo needs both a range and a compatible interval — too fine an
// interval for a long range gets rejected or truncated.
const RANGE_MAP = {
  '1d':  { range: '1d',  interval: '5m' },
  '1w':  { range: '5d',  interval: '15m' },
  '1mo': { range: '1mo', interval: '1d' },
  '3mo': { range: '3mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1y':  { range: '1y',  interval: '1d' },
  '5y':  { range: '5y',  interval: '1wk' },
  'max': { range: 'max', interval: '1mo' }
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function fetchJson(url) {
  const res = await withTimeout(fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }), 8000);
  if (!res.ok) throw new Error('Upstream request failed: ' + res.status);
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const { symbol, range } = req.query || {};
  if (!symbol || !String(symbol).trim()) {
    res.status(400).json({ error: 'Missing query parameter "symbol".' });
    return;
  }
  const cfg = RANGE_MAP[range] || RANGE_MAP['3mo'];

  let data;
  try {
    data = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${cfg.interval}&range=${cfg.range}`);
  } catch (e) {
    res.status(502).json({ error: 'Live data source is unavailable right now.' });
    return;
  }

  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const timestamps = result && result.timestamp;
  const closesRaw = result && result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
  const meta = result && result.meta;
  if (!timestamps || !closesRaw) {
    res.status(404).json({ error: `No price history found for ${symbol}.` });
    return;
  }

  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (typeof closesRaw[i] === 'number') {
      points.push({ t: timestamps[i] * 1000, c: closesRaw[i] });
    }
  }
  if (!points.length) {
    res.status(404).json({ error: `No price history found for ${symbol}.` });
    return;
  }

  const first = points[0].c;
  const last = points[points.length - 1].c;
  const changePct = first ? ((last - first) / first) * 100 : null;

  res.status(200).json({
    symbol: (meta && meta.symbol) || symbol,
    currency: (meta && meta.currency) || 'INR',
    range: range || '3mo',
    price: (meta && meta.regularMarketPrice) != null ? meta.regularMarketPrice : last,
    previousClose: meta ? (meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose) : null,
    changePct,
    points
  });
};
