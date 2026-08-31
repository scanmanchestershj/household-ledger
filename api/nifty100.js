// Serverless proxy that returns the current Nifty 100 constituent list
// (name + NSE symbol) for the batch technical scanner. Fetched live from
// NSE Indices' public CSV (rebalanced twice a year, so we don't want to
// hardcode it and go stale) with a fallback to a short list of well-known
// large caps if that source is ever unreachable — good enough to keep the
// scanner working, though clearly not a substitute for the real index.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CSV_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty100list.csv';

// Fallback only used if the live CSV can't be reached — a short list of
// enduring large caps, not a claim of exact, current Nifty 100 membership.
const FALLBACK_LIST = [
  ['Reliance Industries', 'RELIANCE'], ['Tata Consultancy Services', 'TCS'], ['HDFC Bank', 'HDFCBANK'],
  ['ICICI Bank', 'ICICIBANK'], ['Infosys', 'INFY'], ['State Bank of India', 'SBIN'],
  ['Bharti Airtel', 'BHARTIARTL'], ['ITC', 'ITC'], ['Kotak Mahindra Bank', 'KOTAKBANK'],
  ['Larsen & Toubro', 'LT'], ['Axis Bank', 'AXISBANK'], ['Bajaj Finance', 'BAJFINANCE'],
  ['Hindustan Unilever', 'HINDUNILVR'], ['Maruti Suzuki', 'MARUTI'], ['Sun Pharma', 'SUNPHARMA'],
  ['Titan Company', 'TITAN'], ['NTPC', 'NTPC'], ['Oil & Natural Gas Corp', 'ONGC'],
  ['Wipro', 'WIPRO'], ['Adani Enterprises', 'ADANIENT'], ['Tata Motors', 'TATAMOTORS'],
  ['Tata Steel', 'TATASTEEL'], ['Mahindra & Mahindra', 'M&M'], ['UltraTech Cement', 'ULTRACEMCO'],
  ['Asian Paints', 'ASIANPAINT'], ['HCL Technologies', 'HCLTECH'], ['Power Grid Corp', 'POWERGRID'],
  ['Nestle India', 'NESTLEIND'], ['JSW Steel', 'JSWSTEEL'], ['Bajaj Finserv', 'BAJAJFINSV'],
  ['IndusInd Bank', 'INDUSINDBK'], ['Grasim Industries', 'GRASIM'], ['Tech Mahindra', 'TECHM'],
  ['Coal India', 'COALINDIA'], ['Hindalco Industries', 'HINDALCO'], ['Dr Reddy\'s Labs', 'DRREDDY'],
  ['Cipla', 'CIPLA'], ['Eicher Motors', 'EICHERMOT'], ['Britannia Industries', 'BRITANNIA'],
  ['Divi\'s Laboratories', 'DIVISLAB'], ['Apollo Hospitals', 'APOLLOHOSP'], ['Bharat Petroleum', 'BPCL'],
  ['SBI Life Insurance', 'SBILIFE'], ['HDFC Life Insurance', 'HDFCLIFE'], ['Shriram Finance', 'SHRIRAMFIN'],
  ['LTIMindtree', 'LTIM'], ['Adani Ports', 'ADANIPORTS'], ['Bajaj Auto', 'BAJAJ-AUTO'],
  ['Vedanta', 'VEDL'], ['DLF', 'DLF'],
  ['Trent', 'TRENT'], ['Zomato', 'ETERNAL'], ['Adani Green Energy', 'ADANIGREEN'], ['Adani Power', 'ADANIPOWER'],
  ['Ambuja Cements', 'AMBUJACEM'], ['ACC', 'ACC'], ['Godrej Consumer Products', 'GODREJCP'], ['Pidilite Industries', 'PIDILITIND'],
  ['Siemens', 'SIEMENS'], ['ABB India', 'ABB'], ['Havells India', 'HAVELLS'], ['Bharat Electronics', 'BEL'],
  ['Hindustan Aeronautics', 'HAL'], ['InterGlobe Aviation', 'INDIGO'], ['Zydus Lifesciences', 'ZYDUSLIFE'], ['Lupin', 'LUPIN'],
  ['Aurobindo Pharma', 'AUROPHARMA'], ['Torrent Pharmaceuticals', 'TORNTPHARM'], ['Bank of Baroda', 'BANKBARODA'], ['Canara Bank', 'CANBK'],
  ['PNB', 'PNB'], ['Union Bank of India', 'UNIONBANK'], ['IDFC First Bank', 'IDFCFIRSTB'], ['Federal Bank', 'FEDERALBNK'],
  ['Bandhan Bank', 'BANDHANBNK'], ['Yes Bank', 'YESBANK'], ['GAIL India', 'GAIL'],
  ['Indian Oil Corporation', 'IOC'], ['Hindustan Petroleum', 'HINDPETRO'], ['LIC of India', 'LICI'],
  ['PB Fintech', 'POLICYBZR'], ['Info Edge', 'NAUKRI'], ['United Spirits', 'MCDOWELL-N']
];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) { // skip header row
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;
    const name = cols[0].trim();
    const symbol = cols[2].trim();
    if (!name || !symbol) continue;
    out.push({ name, symbol: symbol + '.NS' });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  try {
    const r = await withTimeout(fetch(CSV_URL, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.niftyindices.com/', 'Cache-Control': 'no-cache' } }), 10000);
    if (!r.ok) throw new Error('bad status ' + r.status);
    const text = await r.text();
    const list = parseCsv(text);
    if (list.length < 50) throw new Error('parsed list too short, likely not real CSV content');
    res.status(200).json({ source: 'live', count: list.length, list });
  } catch (e) {
    const list = FALLBACK_LIST.map(([name, symbol]) => ({ name, symbol: symbol + '.NS' }));
    res.status(200).json({ source: 'fallback', count: list.length, list, note: 'Live Nifty 100 list unavailable — showing a fallback set of well-known large caps instead. Reason: ' + (e && e.message ? e.message : 'unknown error') });
  }
};
