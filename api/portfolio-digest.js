// Serverless endpoint for the Monthly Portfolio Digest (Investment tab).
// The client already computes and sends a plain-text summary of holdings,
// PnL and rebalancing suggestions (same numbers already shown on screen) —
// this endpoint just asks Claude to turn that into a short, readable,
// WhatsApp-ready digest.
//
// POST /api/portfolio-digest   body: { month: "September 2026", summary: "…" }
//
// Requires an ANTHROPIC_API_KEY env var on the Vercel project. If it isn't
// set (or the call fails for any reason), this returns { digest: null,
// source: 'none' } rather than an error — the front end falls back to a
// rule-based digest built from the same summary so the feature still works
// without an API key.

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

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
};
