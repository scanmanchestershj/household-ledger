// Serverless proxy that returns the current Nifty 500 constituent list
// (name + NSE symbol) for the batch technical scanner. Same pattern as
// nifty100.js — fetched live from NSE Indices' public CSV, with a fallback
// to a short list of well-known names if that source is ever unreachable.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CSV_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv';

// Fallback only used if the live CSV can't be reached — a short list of
// enduring names across market caps, not a claim of exact, current membership.
const FALLBACK_LIST = [
  ['Reliance Industries', 'RELIANCE'], ['Tata Consultancy Services', 'TCS'], ['HDFC Bank', 'HDFCBANK'],
  ['ICICI Bank', 'ICICIBANK'], ['Infosys', 'INFY'], ['State Bank of India', 'SBIN'],
  ['Bharti Airtel', 'BHARTIARTL'], ['ITC', 'ITC'], ['Larsen & Toubro', 'LT'],
  ['Axis Bank', 'AXISBANK'], ['Bajaj Finance', 'BAJFINANCE'], ['Titan Company', 'TITAN'],
  ['Trent', 'TRENT'], ['Polycab India', 'POLYCAB'], ['Persistent Systems', 'PERSISTENT'],
  ['Coforge', 'COFORGE'], ['Dixon Technologies', 'DIXON'], ['Page Industries', 'PAGEIND'],
  ['Cummins India', 'CUMMINSIND'], ['Voltas', 'VOLTAS'], ['Federal Bank', 'FEDERALBNK'],
  ['IDFC First Bank', 'IDFCFIRSTB'], ['Bandhan Bank', 'BANDHANBNK'], ['Bank of Baroda', 'BANKBARODA'],
  ['Canara Bank', 'CANBK'], ['PNB', 'PNB'], ['Union Bank of India', 'UNIONBANK'],
  ['Godrej Properties', 'GODREJPROP'], ['Oberoi Realty', 'OBEROIRLTY'], ['Phoenix Mills', 'PHOENIXLTD'],
  ['Astral', 'ASTRAL'], ['Supreme Industries', 'SUPREMEIND'], ['Havells India', 'HAVELLS'],
  ['Crompton Greaves Consumer', 'CROMPTON'], ['Whirlpool of India', 'WHIRLPOOL'], ['Blue Star', 'BLUESTARCO'],
  ['Ashok Leyland', 'ASHOKLEY'], ['TVS Motor', 'TVSMOTOR'], ['Bharat Forge', 'BHARATFORG'],
  ['Balkrishna Industries', 'BALKRISIND'], ['Escorts Kubota', 'ESCORTS'], ['Motherson Sumi Wiring', 'MSUMI'],
  ['Jubilant Foodworks', 'JUBLFOOD'], ['United Breweries', 'UBL'], ['Godfrey Phillips India', 'GODFRYPHLP'],
  ['Colgate-Palmolive India', 'COLPAL'], ['Marico', 'MARICO'], ['Dabur India', 'DABUR'],
  ['Zydus Lifesciences', 'ZYDUSLIFE'], ['Lupin', 'LUPIN'], ['Aurobindo Pharma', 'AUROPHARMA'],
  ['Alkem Laboratories', 'ALKEM'], ['Torrent Pharmaceuticals', 'TORNTPHARM'], ['Biocon', 'BIOCON'],
  ['Max Healthcare Institute', 'MAXHEALTH'], ['Fortis Healthcare', 'FORTIS'], ['Lodha Developers', 'LODHA'],
  ['DLF', 'DLF'], ['Indian Hotels', 'INDHOTEL'], ['InterGlobe Aviation', 'INDIGO']
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
    const r = await withTimeout(fetch(CSV_URL, { headers: { 'User-Agent': UA, 'Accept': 'text/csv' } }), 8000);
    if (!r.ok) throw new Error('bad status ' + r.status);
    const text = await r.text();
    const list = parseCsv(text);
    if (list.length < 200) throw new Error('parsed list too short, likely not real CSV content');
    res.status(200).json({ source: 'live', count: list.length, list });
  } catch (e) {
    const list = FALLBACK_LIST.map(([name, symbol]) => ({ name, symbol: symbol + '.NS' }));
    res.status(200).json({ source: 'fallback', count: list.length, list, note: 'Live Nifty 500 list unavailable — showing a short fallback set instead.' });
  }
};
