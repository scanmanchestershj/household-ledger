// Combined serverless endpoint for the two new Investment tab features
// (Live Gold Rate + Monthly Portfolio Digest). Merged into one file rather
// than two separate ones because the Vercel Hobby plan caps a deployment at
// 12 Serverless Functions, and this project's /api directory was already
// at 11.
//
//   GET  /api/portfolio-tools                       -> live gold rate
//   POST /api/portfolio-tools  { month, summary }    -> AI (or fallback) digest

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

async function handleGoldRate(res) {
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
}

async function handleDigest(req, res) {
  const { month, summary } = req.body || {};
  if (!summary || !String(summary).trim()) {
    res.status(400).json({ error: 'Missing "summary".' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(200).json({ digest: null, source: 'none', reason: 'No ANTHROPIC_API_KEY set on this Vercel project.' });
    return;
  }

  const systemPrompt = `You write a short monthly portfolio digest for one household's personal finance app. Input is a plain-text data summary the app already computed (real numbers — never invent figures not present in it). Write 120-220 words, plain text only (no markdown headers, no asterisks), friendly but concise, suitable to paste straight into WhatsApp. Cover: overall portfolio value and P&L, the biggest mover(s), and the rebalancing suggestions if present. End with one line noting this isn't financial advice. Do not add emoji beyond what's tasteful (a few at most).`;

  try {
    const response = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Month: ${month || 'this month'}\n\nData summary:\n${summary}` }
        ]
      })
    }), 15000);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      res.status(200).json({ digest: null, source: 'none', reason: `Anthropic API error ${response.status}: ${errText.slice(0, 200)}` });
      return;
    }

    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) {
      res.status(200).json({ digest: null, source: 'none', reason: 'Empty response from Anthropic API.' });
      return;
    }

    res.status(200).json({ digest: text, source: 'ai' });
  } catch (e) {
    res.status(200).json({ digest: null, source: 'none', reason: 'Request to Anthropic API failed or timed out.' });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await handleDigest(req, res);
  } else {
    await handleGoldRate(res);
  }
};
