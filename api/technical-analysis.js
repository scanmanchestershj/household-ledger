// Serverless technical-analysis summary — computes the same kind of
// "Technical Overview" that Groww shows on its stock product pages
// (moving averages, RSI, MACD, overall Buy/Sell/Neutral gauge), but from
// our own math over real historical prices rather than Groww's app, since
// Groww's official API requires a paid trading-account key we don't want
// to put in this app (see conversation), and there's no public "just give
// me their technical summary" endpoint. The formulas here (SMA/EMA, RSI-14,
// MACD 12/26/9) are the standard, publicly documented ones every broker/
// terminal (Groww, TradingView, Investing.com) uses, so the output should
// land close to what you'd see in Groww's Technical Overview tab.
//
// GET /api/technical-analysis?q=<company name or ticker>&market=IN|AE

const { calculateTechnicalScore } = require('../investment-verdict-formulas.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

const STOCK_SUFFIXES = {
  IN: ['.NS', '.BO'],
  AE: ['.AE'],
  GB: ['.L'],
  SA: ['.SR'],
  US: []
};

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
  const suffixes = STOCK_SUFFIXES[market] || STOCK_SUFFIXES.IN;
  const trimmed = query.trim();
  if (suffixes.some(s => trimmed.toUpperCase().endsWith(s)) || (market === 'US' && /^[A-Z.]{1,6}$/.test(trimmed) && trimmed === trimmed.toUpperCase() && trimmed.length <= 5)) {
    return { symbol: trimmed.toUpperCase(), name: trimmed.toUpperCase() };
  }
  const data = await fetchJson(`${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const quotes = (data.quotes || []).filter(q => q.symbol);
  if (!quotes.length) return null;
  if (market === 'US') {
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

// ~1.5 years of daily closes — enough history for a 200-day SMA plus
// warm-up room for RSI/MACD to stabilize.
async function getDailyCloses(symbol) {
  const data = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=2y`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const result = data?.chart?.result?.[0];
  const closesRaw = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;
  if (!closesRaw || !timestamps) return null;
  const closes = [];
  for (let i = 0; i < closesRaw.length; i++) {
    if (typeof closesRaw[i] === 'number') closes.push(closesRaw[i]);
  }
  return closes;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const series = new Array(period - 1).fill(null).concat([emaVal]);
  for (let i = period; i < closes.length; i++) {
    emaVal = closes[i] * k + emaVal * (1 - k);
    series.push(emaVal);
  }
  return series; // series[series.length-1] is the latest EMA
}

function ema(closes, period) {
  const s = emaSeries(closes, period);
  return s ? s[s.length - 1] : null;
}

// Wilder's RSI-14 — the standard formula used industry-wide.
function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  if (!ema12 || !ema26) return null;
  const len = Math.min(ema12.length, ema26.length);
  const macdLine = [];
  for (let i = 0; i < len; i++) {
    const a = ema12[ema12.length - len + i];
    const b = ema26[ema26.length - len + i];
    if (a == null || b == null) { macdLine.push(null); continue; }
    macdLine.push(a - b);
  }
  const cleanMacd = macdLine.filter(v => v != null);
  const signalSeries = emaSeries(cleanMacd, 9);
  if (!signalSeries) return null;
  const macdVal = cleanMacd[cleanMacd.length - 1];
  const signalVal = signalSeries[signalSeries.length - 1];
  return { macd: macdVal, signal: signalVal, histogram: macdVal - signalVal };
}

function verdictFromCounts(buy, sell, total) {
  if (total === 0) return 'Neutral';
  const buyPct = buy / total;
  const sellPct = sell / total;
  if (buyPct >= 0.8) return 'Strong Buy';
  if (buyPct > sellPct) return 'Buy';
  if (sellPct >= 0.8) return 'Strong Sell';
  if (sellPct > buyPct) return 'Sell';
  return 'Neutral';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  const { q, market } = req.query || {};
  if (!q || !String(q).trim()) {
    res.status(400).json({ error: 'Missing query parameter "q" (company name or ticker).' });
    return;
  }
  const marketCode = ['IN', 'AE', 'US', 'GB', 'SA'].includes(market) ? market : 'IN';

  let resolved;
  try {
    resolved = await resolveSymbol(String(q), marketCode);
  } catch (e) {
    res.status(502).json({ error: 'Live data source is unavailable right now.' });
    return;
  }
  if (!resolved) {
    res.status(404).json({ error: `Couldn't find a matching stock for "${q}".` });
    return;
  }

  let closes;
  try {
    closes = await getDailyCloses(resolved.symbol);
  } catch (e) {
    res.status(502).json({ error: 'Could not fetch historical price data right now.' });
    return;
  }
  if (!closes || closes.length < 30) {
    res.status(404).json({ error: `Not enough price history for ${resolved.symbol} to compute a technical summary.` });
    return;
  }

  const price = closes[closes.length - 1];
  const maPeriods = [5, 10, 20, 50, 100, 200];
  const movingAverages = maPeriods.map(period => {
    const val = sma(closes, period);
    if (val == null) return { period, value: null, signal: 'n/a' };
    return { period, value: val, signal: price > val ? 'Buy' : (price < val ? 'Sell' : 'Neutral') };
  }).filter(m => m.value != null);

  const maBuy = movingAverages.filter(m => m.signal === 'Buy').length;
  const maSell = movingAverages.filter(m => m.signal === 'Sell').length;
  const movingAverageVerdict = verdictFromCounts(maBuy, maSell, movingAverages.length);

  const rsi14 = rsi(closes, 14);
  const macdResult = macd(closes);

  const oscillators = [];
  if (rsi14 != null) {
    oscillators.push({
      name: 'RSI (14)',
      value: rsi14,
      signal: rsi14 < 30 ? 'Buy' : (rsi14 > 70 ? 'Sell' : 'Neutral')
    });
  }
  if (macdResult) {
    oscillators.push({
      name: 'MACD (12,26,9)',
      value: macdResult.histogram,
      signal: macdResult.macd > macdResult.signal ? 'Buy' : (macdResult.macd < macdResult.signal ? 'Sell' : 'Neutral')
    });
  }
  const oscBuy = oscillators.filter(o => o.signal === 'Buy').length;
  const oscSell = oscillators.filter(o => o.signal === 'Sell').length;
  const oscillatorVerdict = verdictFromCounts(oscBuy, oscSell, oscillators.length);

  const totalBuy = maBuy + oscBuy;
  const totalSell = maSell + oscSell;
  const totalSignals = movingAverages.length + oscillators.length;
  const overallVerdict = verdictFromCounts(totalBuy, totalSell, totalSignals);
  const technicalScore = calculateTechnicalScore({ movingAverages, oscillators });

  res.status(200).json({
    symbol: resolved.symbol,
    name: resolved.name,
    price,
    movingAverages,
    movingAverageVerdict,
    oscillators,
    oscillatorVerdict,
    overallVerdict,
    technicalScore,
    buySignals: totalBuy,
    sellSignals: totalSell,
    totalSignals,
    disclaimer: 'A formula-based technical summary, not a recommendation. Technical signals reflect past price action only — they don\'t know about news, fundamentals, or upcoming events.'
  });
};
