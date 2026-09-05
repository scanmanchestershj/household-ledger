// Serverless proxy for a live gold rate, used by the Investment tab's Gold
// holdings tracker ("Sync live rate" button). Runs server-side (Vercel Node
// function) for the same CORS reason as stock-quote.js.
//
// GET /api/gold-rate
//
// Reuses the exact Yahoo Finance "chart" endpoint stock-quote.js already
// relies on (crumb-free, reliable) — no new external API or key needed:
//   GC=F   -> COMEX gold futures, USD per troy ounce
//   INR=X  -> USD/INR
//   AED=X  -> USD/AED
// Converted to price-per-gram at 24K/22K/18K purity, since that's how
// jewellery and coins are usually quoted in India/UAE.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const GRAMS_PER_TROY_OZ = 31.1034768;
const PURITIES = { '24k': 24, '22k': 22, '18k': 18 };

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

async function getChartPrice(symbol) {
  const data = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  return meta.regularMarketPrice;
}

function gramRates(usdPerGram24k, fxUsdToTarget) {
  const perGram24kInTarget = usdPerGram24k * fxUsdToTarget;
  const out = {};
  Object.entries(PURITIES).forEach(([label, karat]) => {
    out[label] = Math.round((perGram24kInTarget * (karat / 24)) * 100) / 100;
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  let usdPerOz, usdInr, usdAed;
  try {
    [usdPerOz, usdInr, usdAed] = await Promise.all([
      getChartPrice('GC=F'),
      getChartPrice('INR=X'),
      getChartPrice('AED=X')
    ]);
  } catch (e) {
    res.status(502).json({ error: "Live gold rate is unavailable right now — please enter today's rate manually." });
    return;
  }

  if (usdPerOz == null || usdInr == null || usdAed == null) {
    res.status(502).json({ error: "Couldn't retrieve a full live gold rate right now — please enter today's rate manually." });
    return;
  }

  const usdPerGram24k = usdPerOz / GRAMS_PER_TROY_OZ;

  res.status(200).json({
    asOf: new Date().toISOString(),
    usdPerTroyOz: Math.round(usdPerOz * 100) / 100,
    usdInr,
    usdAed,
    rates: {
      INR: gramRates(usdPerGram24k, usdInr),
      AED: gramRates(usdPerGram24k, usdAed)
    }
  });
};
