// Serverless proxy that returns NSE constituent lists (name + NSE symbol).
//   GET /api/nifty500         -> Nifty 500 only (original behaviour)
//   GET /api/nifty500?all=1   -> Nifty 500 + Midcap 150 + Smallcap 250 + Microcap 250 (deduplicated,
//                                each stock tagged with its cap group). Used by the Warren Buffett screen.
// Fetched live from NSE Indices' public CSVs, with a fallback to a short list of well-known names if the
// Nifty 500 source is unreachable. One function serves every list (Vercel Hobby = 12-function limit).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.niftyindices.com/IndexConstituent/';
const CSV_URL = BASE + 'ind_nifty500list.csv';
// Extra lists for ?all=1. Order matters: first tag wins when a stock is in several lists
// (Nifty 500 is already Largecap 100 + Midcap 150 + Smallcap 250; Microcap 250 is ranks 501-750).
const EXTRA_CSVS = [
  ['MIDCAP', BASE + 'ind_niftymidcap150list.csv'],
  ['SMALLCAP', BASE + 'ind_niftysmallcap250list.csv'],
  ['MICROCAP', BASE + 'ind_niftymicrocap250_list.csv']
];

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

async function fetchCsv(url) {
  const r = await withTimeout(fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.niftyindices.com/', 'Cache-Control': 'no-cache' } }), 8000);
  if (!r.ok) throw new Error('bad status ' + r.status);
  return parseCsv(await r.text());
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
  const all = !!(req.query && (req.query.all === '1' || req.query.all === 'true'));
  try {
    const base = await fetchCsv(CSV_URL);
    if (base.length < 200) throw new Error('parsed list too short, likely not real CSV content');
    if (!all) { res.status(200).json({ source: 'live', count: base.length, list: base }); return; }
    // ?all=1 -> union of Nifty 500 + Midcap 150 + Smallcap 250 + Microcap 250, tagged by cap group
    const tag = new Map(); // symbol -> { name, symbol, cap }
    const groups = { NIFTY500: base.length }, failed = [];
    const extras = await Promise.allSettled(EXTRA_CSVS.map(([, url]) => fetchCsv(url)));
    // cap tags: Midcap/Smallcap lists first so Nifty 500 members get a real cap group; the rest are Large
    const capOf = new Map();
    extras.forEach((e, i) => {
      const cap = EXTRA_CSVS[i][0];
      if (e.status === 'fulfilled' && e.value.length >= 50) { groups[cap] = e.value.length; e.value.forEach(x => { if (!capOf.has(x.symbol)) capOf.set(x.symbol, cap); }); }
      else failed.push(cap);
    });
    base.forEach(x => tag.set(x.symbol, { name: x.name, symbol: x.symbol, cap: capOf.get(x.symbol) || 'LARGECAP' }));
    capOf.forEach((cap, symbol) => { if (!tag.has(symbol)) { const hit = extras.flatMap(e => e.status === 'fulfilled' ? e.value : []).find(x => x.symbol === symbol); tag.set(symbol, { name: hit ? hit.name : symbol, symbol, cap }); } });
    const list = Array.from(tag.values());
    res.status(200).json({ source: 'live', count: list.length, list, groups, failed, note: failed.length ? 'Could not load: ' + failed.join(', ') : undefined });
  } catch (e) {
    const list = FALLBACK_LIST.map(([name, symbol]) => ({ name, symbol: symbol + '.NS' }));
    res.status(200).json({ source: 'fallback', count: list.length, list, note: 'Live Nifty 500 list unavailable — showing a short fallback set instead. Reason: ' + (e && e.message ? e.message : 'unknown error') });
  }
};
