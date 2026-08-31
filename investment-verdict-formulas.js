/**
 * Smart AI PA — India Investment Screener
 * Verdict Scoring Module
 *
 * Currently a standalone utility — nothing in the deployed app requires()
 * this file yet. It's kept in sync with the two real data shapes the app
 * already produces, so it's a genuine drop-in if you want to wire it into
 * a screener endpoint later:
 *
 *   - Fundamentals: exactly the fields scrCollectValues() builds from the
 *     Screener/Fundamentals form in index.html (price, pe, industryPe, peg,
 *     pb, de, currentRatio, roe, roce3yr, salesGrowth3yr, profitGrowth3yr,
 *     epsGrowth5yr, fcf3yr, ocf3yr, fcf5yr, fcfPrecYear, shares, pledged, rsi)
 *   - Technicals: exactly the JSON /api/technical-analysis.js returns
 *     (movingAverages[], movingAverageVerdict, oscillators[], oscillatorVerdict,
 *     overallVerdict, buySignals, sellSignals, totalSignals)
 *
 * FORMULA 1: Fundamental Score  (0–50, from the Fundamentals form fields)
 * FORMULA 2: Technical Score    (0–50, from a live /api/technical-analysis.js response)
 * FORMULA 3: Combined Verdict   (Strong Buy / Buy / Neutral / Sell / Strong Sell —
 *                                 same wording the app already uses, not a new scale)
 *
 * Run `node investment-verdict-formulas.js` directly to execute the
 * self-test at the bottom against realistic sample data — no network or
 * deployment needed to check the logic itself is sound.
 */

// ---------------------------------------------------------------------------
// FORMULA 1: Fundamental Score (max 50)
// Input: the object scrCollectValues() returns. Any field can be null
// (the Fundamentals form doesn't require every field) — null fields simply
// score 0 rather than throwing.
// ---------------------------------------------------------------------------
function calculateFundamentalScore(v) {
  let score = 0;
  if (v.roce3yr != null && v.roce3yr > 15) score += 10;                          // Avg ROCE (3yr)
  if (v.roe != null && v.roe > 15) score += 10;                                  // Return on equity
  if (v.de != null && v.de < 1) score += 8;                                      // Debt to equity
  if (v.salesGrowth3yr != null && v.salesGrowth3yr > 10) score += 7;             // Sales growth (3yr)
  if (v.profitGrowth3yr != null && v.profitGrowth3yr > 10) score += 7;           // Profit growth (3yr)
  if (v.pe != null && v.pe > 0 && v.industryPe != null && v.pe < v.industryPe) score += 8; // PE vs industry PE
  return Math.min(score, 50);
}

// ---------------------------------------------------------------------------
// FORMULA 2: Technical Score (max 50)
// Input: the JSON body /api/technical-analysis.js returns for one stock.
// Reads movingAverages/oscillators directly rather than assuming named
// sma50/sma200/macdLine fields, since that's the shape the live endpoint
// actually produces.
// ---------------------------------------------------------------------------
function calculateTechnicalScore(technicals) {
  let score = 0;
  const mas = technicals.movingAverages || [];
  const oscs = technicals.oscillators || [];

  const ma50 = mas.find(m => m.period === 50);
  const ma200 = mas.find(m => m.period === 200);
  if (ma50 && ma50.signal === 'Buy') score += 10;                 // price above 50-day SMA
  if (ma50 && ma200 && ma50.value != null && ma200.value != null && ma50.value > ma200.value) score += 10; // golden-cross state

  const rsi = oscs.find(o => o.name === 'RSI (14)');
  if (rsi && rsi.value != null) {
    if (rsi.value >= 40 && rsi.value <= 60) score += 10;           // healthy momentum
    else if (rsi.value > 60 && rsi.value <= 70) score += 5;        // strong but nearing overbought
  }

  const macd = oscs.find(o => o.name === 'MACD (12,26,9)');
  if (macd) {
    if (macd.signal === 'Buy') score += 15;                       // bullish MACD crossover
    if (macd.value != null && macd.value > 0) score += 5;         // positive histogram
  }

  return Math.min(score, 50);
}

// ---------------------------------------------------------------------------
// FORMULA 3: Combined Verdict (0–100 total)
// Wording matches what the app already shows elsewhere (Strong Buy / Buy /
// Neutral / Sell / Strong Sell) rather than introducing a new "Hold" label.
// ---------------------------------------------------------------------------
function calculateVerdict(fundamentalScore, technicalScore) {
  const total = fundamentalScore + technicalScore;
  let verdict;
  if (total >= 80) verdict = 'Strong Buy';
  else if (total >= 65) verdict = 'Buy';
  else if (total >= 45) verdict = 'Neutral';
  else if (total >= 30) verdict = 'Sell';
  else verdict = 'Strong Sell';
  return { total, verdict };
}

// ---------------------------------------------------------------------------
// Full pipeline for one stock: fundamentals (scrCollectValues shape) +
// technicals (a /api/technical-analysis.js response) -> combined verdict.
// ---------------------------------------------------------------------------
function scoreStock(fundamentals, technicals) {
  const fundamentalScore = calculateFundamentalScore(fundamentals || {});
  const technicalScore = calculateTechnicalScore(technicals || {});
  const { total, verdict } = calculateVerdict(fundamentalScore, technicalScore);
  return {
    symbol: (technicals && technicals.symbol) || null,
    fundamentalScore,
    technicalScore,
    totalScore: total,
    verdict,
  };
}

module.exports = {
  calculateFundamentalScore,
  calculateTechnicalScore,
  calculateVerdict,
  scoreStock,
};

// ---------------------------------------------------------------------------
// Self-test — run with `node investment-verdict-formulas.js`.
// Uses realistic sample shapes (not the real network calls) so this checks
// the scoring logic itself, independent of Yahoo Finance being reachable.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');

  // A strong fundamentals sample (mirrors scrCollectValues() output).
  const strongFundamentals = {
    price: 1450, pe: 22, industryPe: 30, peg: 0.9, pb: 4.2, de: 0.3,
    currentRatio: 1.8, roe: 19, roce3yr: 18, salesGrowth3yr: 14,
    profitGrowth3yr: 16, epsGrowth5yr: 12, fcf3yr: 1200, ocf3yr: 1500,
    fcf5yr: 5000, fcfPrecYear: 900, shares: 60, pledged: 0, rsi: 55
  };
  const weakFundamentals = {
    price: 300, pe: 45, industryPe: 30, peg: 3, pb: 8, de: 1.8,
    currentRatio: 0.8, roe: 8, roce3yr: 6, salesGrowth3yr: 2,
    profitGrowth3yr: -5, epsGrowth5yr: 1, fcf3yr: -100, ocf3yr: 50,
    fcf5yr: -200, fcfPrecYear: -50, shares: 60, pledged: 12, rsi: 75
  };

  // A realistic /api/technical-analysis.js response shape.
  const bullishTechnicals = {
    symbol: 'RELIANCE.NS', price: 1450,
    movingAverages: [
      { period: 5, value: 1440, signal: 'Buy' }, { period: 10, value: 1420, signal: 'Buy' },
      { period: 20, value: 1400, signal: 'Buy' }, { period: 50, value: 1380, signal: 'Buy' },
      { period: 100, value: 1340, signal: 'Buy' }, { period: 200, value: 1300, signal: 'Buy' }
    ],
    oscillators: [
      { name: 'RSI (14)', value: 55, signal: 'Neutral' },
      { name: 'MACD (12,26,9)', value: 8.2, signal: 'Buy' }
    ],
    overallVerdict: 'Strong Buy', buySignals: 7, sellSignals: 0, totalSignals: 8
  };
  const bearishTechnicals = {
    symbol: 'WEAK.NS', price: 300,
    movingAverages: [
      { period: 5, value: 310, signal: 'Sell' }, { period: 10, value: 320, signal: 'Sell' },
      { period: 20, value: 330, signal: 'Sell' }, { period: 50, value: 350, signal: 'Sell' },
      { period: 100, value: 370, signal: 'Sell' }, { period: 200, value: 400, signal: 'Sell' }
    ],
    oscillators: [
      { name: 'RSI (14)', value: 75, signal: 'Sell' },
      { name: 'MACD (12,26,9)', value: -3.1, signal: 'Sell' }
    ],
    overallVerdict: 'Strong Sell', buySignals: 0, sellSignals: 8, totalSignals: 8
  };

  // Formula 1
  const strongFScore = calculateFundamentalScore(strongFundamentals);
  const weakFScore = calculateFundamentalScore(weakFundamentals);
  assert.ok(strongFScore > weakFScore, 'strong fundamentals should score higher than weak ones');
  assert.ok(strongFScore <= 50 && weakFScore >= 0, 'fundamental score must stay within 0–50');

  // Formula 2
  const bullTScore = calculateTechnicalScore(bullishTechnicals);
  const bearTScore = calculateTechnicalScore(bearishTechnicals);
  assert.ok(bullTScore > bearTScore, 'bullish technicals should score higher than bearish ones');
  assert.ok(bullTScore <= 50 && bearTScore >= 0, 'technical score must stay within 0–50');

  // Formula 3
  const { verdict: strongVerdict } = calculateVerdict(strongFScore, bullTScore);
  const { verdict: weakVerdict } = calculateVerdict(weakFScore, bearTScore);
  assert.strictEqual(strongVerdict, 'Strong Buy', `expected Strong Buy, got ${strongVerdict}`);
  assert.strictEqual(weakVerdict, 'Strong Sell', `expected Strong Sell, got ${weakVerdict}`);

  // Missing/partial data shouldn't throw.
  assert.doesNotThrow(() => calculateFundamentalScore({}));
  assert.doesNotThrow(() => calculateTechnicalScore({}));
  assert.doesNotThrow(() => scoreStock(null, null));
  const emptyResult = scoreStock({}, {});
  assert.strictEqual(emptyResult.totalScore, 0);
  assert.strictEqual(emptyResult.verdict, 'Strong Sell');

  // Full pipeline
  const fullResult = scoreStock(strongFundamentals, bullishTechnicals);
  assert.strictEqual(fullResult.symbol, 'RELIANCE.NS');
  assert.strictEqual(fullResult.verdict, 'Strong Buy');

  console.log('✓ All investment-verdict-formulas.js self-tests passed.');
  console.log('  Strong sample  →', fullResult);
  console.log('  Weak sample    →', scoreStock(weakFundamentals, bearishTechnicals));
}
