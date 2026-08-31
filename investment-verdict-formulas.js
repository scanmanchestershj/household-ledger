/**
 * Smart AI PA — India Investment Screener
 * Combined Verdict Scoring Module
 *
 * Drop this into your project (suggested path: /lib/investment-formulas.js
 * or wherever your screener API routes import shared scoring logic from).
 *
 * FORMULA 1: Fundamental Score   (Screener.in-based ratios)
 * FORMULA 2: Technical Score     (Yahoo Finance SMA/RSI/MACD, via your existing technical-analysis.js)
 * FORMULA 3: Combined Verdict    (Strong Buy / Buy / Hold / Sell / Strong Sell)
 * FORMULA 4: Style Tag           (Buffett-style Quality vs Jhunjhunwala-style Multibagger)
 */

// ---------------------------------------------------------------------------
// FORMULA 1: Fundamental Score (max 50)
// Input: object with Screener.in-style fields for a single stock
// ---------------------------------------------------------------------------
function calculateFundamentalScore(stock) {
  let score = 0;

  if (stock.roce > 15) score += 10;                 // Return on capital employed
  if (stock.roe > 15) score += 10;                   // Return on equity
  if (stock.debtToEquity < 1) score += 8;            // Debt to equity
  if (stock.salesGrowth3Y > 10) score += 7;          // Sales growth 3Years
  if (stock.profitGrowth3Y > 10) score += 7;         // Profit growth 3Years
  if (stock.pe > 0 && stock.pe < stock.industryPe) score += 8; // PE vs Industry PE

  return Math.min(score, 50);
}

// ---------------------------------------------------------------------------
// FORMULA 2: Technical Score (max 50)
// Input: object with SMA50, SMA200, RSI14, MACD line/signal/histogram
// (this is exactly what your /api/technical-analysis.js already computes)
// ---------------------------------------------------------------------------
function calculateTechnicalScore(technicals) {
  let score = 0;
  const { price, sma50, sma200, rsi14, macdLine, macdSignal, macdHistogram, macdHistogramRising } = technicals;

  if (price > sma50) score += 10;
  if (sma50 > sma200) score += 10;                   // golden cross state

  if (rsi14 >= 40 && rsi14 <= 60) score += 10;        // healthy momentum
  else if (rsi14 > 60) score += 5;                    // strong but watch overbought

  if (macdLine > macdSignal) score += 15;             // bullish crossover
  if (macdHistogram > 0 && macdHistogramRising) score += 5;

  return Math.min(score, 50);
}

// ---------------------------------------------------------------------------
// FORMULA 3: Combined Verdict (0–100 total)
// ---------------------------------------------------------------------------
function calculateVerdict(fundamentalScore, technicalScore) {
  const total = fundamentalScore + technicalScore;

  let verdict;
  if (total >= 80) verdict = "STRONG BUY";
  else if (total >= 65) verdict = "BUY";
  else if (total >= 45) verdict = "HOLD";
  else if (total >= 30) verdict = "SELL";
  else verdict = "STRONG SELL";

  return { total, verdict };
}

// ---------------------------------------------------------------------------
// FORMULA 4: Style Tag — classify a stock as Quality Compounder or
// Growth Multibagger (or neither). Run as a separate filter pass, NOT
// combined with formulas 1–3, since the two styles pull in opposite
// directions (low-PE stability vs high-growth momentum).
// ---------------------------------------------------------------------------
function classifyStyle(stock) {
  const isBuffettStyle =
    stock.roce > 20 &&
    stock.roe > 18 &&
    stock.debtToEquity < 0.3 &&
    stock.profitGrowth5Y > 12 &&
    stock.salesGrowth5Y > 10 &&
    stock.opm5Y > 15 &&
    stock.pe > 0 && stock.pe < 30 &&
    stock.interestCoverage > 8 &&
    stock.freeCashFlow > 0;

  const isJhunjhunwalaStyle =
    stock.salesGrowth3Y > 20 &&
    stock.profitGrowth3Y > 25 &&
    stock.roe > 15 &&
    stock.debtToEquity < 0.5 &&
    stock.promoterHolding > 40 &&
    stock.promoterHoldingChange3Y > 0 &&
    stock.marketCap > 500 && stock.marketCap < 20000 &&
    stock.pe > 0 && stock.pe < 40;

  if (isBuffettStyle) return "Quality Compounder";
  if (isJhunjhunwalaStyle) return "Growth Multibagger";
  return null;
}

// ---------------------------------------------------------------------------
// Example: full pipeline for one stock
// ---------------------------------------------------------------------------
function scoreStock(fundamentals, technicals) {
  const fundamentalScore = calculateFundamentalScore(fundamentals);
  const technicalScore = calculateTechnicalScore(technicals);
  const { total, verdict } = calculateVerdict(fundamentalScore, technicalScore);
  const styleTag = classifyStyle(fundamentals);

  return {
    symbol: fundamentals.symbol,
    fundamentalScore,
    technicalScore,
    totalScore: total,
    verdict,
    styleTag, // "Quality Compounder" | "Growth Multibagger" | null
  };
}

module.exports = {
  calculateFundamentalScore,
  calculateTechnicalScore,
  calculateVerdict,
  classifyStyle,
  scoreStock,
};
