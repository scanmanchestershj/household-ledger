// Scores a stock's fundamentals (the fields the Fundamentals form in
// index.html already collects via scrCollectValues()) using
// calculateFundamentalScore() from investment-verdict-formulas.js.
//
// POST /api/score-fundamentals   body: scrCollectValues() shape (JSON)
// -> { fundamentalScore: 0-50 }

const { calculateFundamentalScore } = require('../investment-verdict-formulas.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST with a JSON body.' });
    return;
  }
  try {
    let body = req.body;
    if (!body || typeof body !== 'object') {
      // Some Vercel Node runtimes don't auto-parse the body — read it manually if needed.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
    const fundamentalScore = calculateFundamentalScore(body || {});
    res.status(200).json({ fundamentalScore });
  } catch (e) {
    res.status(400).json({ error: 'Could not score fundamentals: ' + (e && e.message ? e.message : 'unknown error') });
  }
};
