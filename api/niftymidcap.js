// Serverless proxy that returns the current Nifty Midcap 150 constituent
// list (name + NSE symbol) for the batch technical scanner. Same pattern
// as nifty100.js.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CSV_URL = 'https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv';

// Fallback only used if the live CSV can't be reached.
const FALLBACK_LIST = [
  ['Persistent Systems', 'PERSISTENT'], ['Coforge', 'COFORGE'], ['Dixon Technologies', 'DIXON'],
  ['Page Industries', 'PAGEIND'], ['Cummins India', 'CUMMINSIND'], ['Voltas', 'VOLTAS'],
  ['Federal Bank', 'FEDERALBNK'], ['IDFC First Bank', 'IDFCFIRSTB'], ['Bandhan Bank', 'BANDHANBNK'],
  ['Godrej Properties', 'GODREJPROP'], ['Oberoi Realty', 'OBEROIRLTY'], ['Phoenix Mills', 'PHOENIXLTD'],
  ['Astral', 'ASTRAL'], ['Supreme Industries', 'SUPREMEIND'], ['Crompton Greaves Consumer', 'CROMPTON'],
  ['Whirlpool of India', 'WHIRLPOOL'], ['Blue Star', 'BLUESTARCO'], ['Ashok Leyland', 'ASHOKLEY'],
  ['Bharat Forge', 'BHARATFORG'], ['Balkrishna Industries', 'BALKRISIND'], ['Escorts Kubota', 'ESCORTS'],
  ['Jubilant Foodworks', 'JUBLFOOD'], ['United Breweries', 'UBL'], ['Zydus Lifesciences', 'ZYDUSLIFE'],
  ['Aurobindo Pharma', 'AUROPHARMA'], ['Alkem Laboratories', 'ALKEM'], ['Torrent Pharmaceuticals', 'TORNTPHARM'],
  ['Biocon', 'BIOCON'], ['Max Healthcare Institute', 'MAXHEALTH'], ['Fortis Healthcare', 'FORTIS'],
  ['Indian Hotels', 'INDHOTEL'], ['Mphasis', 'MPHASIS'], ['L&T Technology Services', 'LTTS'],
  ['AU Small Finance Bank', 'AUBANK'], ['City Union Bank', 'CUB'], ['Bank of India', 'BANKINDIA'],
  ['Sundram Fasteners', 'SUNDRMFAST'], ['KEI Industries', 'KEI'], ['Finolex Cables', 'FINCABLES'],
  ['Amber Enterprises', 'AMBER'], ['Century Plyboards', 'CENTURYPLY'], ['Vedant Fashions', 'VEDANTFASHN'],
  ['Metro Brands', 'METROBRAND'], ['Aavas Financiers', 'AAVAS'], ['CreditAccess Grameen', 'CREDITACC'],
  ['Suprajit Engineering', 'SUPRAJIT'], ['Thermax', 'THERMAX'], ['Elgi Equipments', 'ELGIEQUIP'],
  ['Ratnamani Metals & Tubes', 'RATNAMANI'], ['Grindwell Norton', 'GRINDWELL'], ['Carborundum Universal', 'CARBORUNIV'],
  ['Godrej Industries', 'GODREJIND'], ['Aditya Birla Capital', 'ABCAPITAL'], ['PI Industries', 'PIIND'],
  ['Tata Elxsi', 'TATAELXSI'], ['ICICI Prudential Life', 'ICICIPRULI'], ['Star Health Insurance', 'STARHEALTH']
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
    if (list.length < 80) throw new Error('parsed list too short, likely not real CSV content');
    res.status(200).json({ source: 'live', count: list.length, list });
  } catch (e) {
    const list = FALLBACK_LIST.map(([name, symbol]) => ({ name, symbol: symbol + '.NS' }));
    res.status(200).json({ source: 'fallback', count: list.length, list, note: 'Live Nifty Midcap 150 list unavailable — showing a short fallback set instead. Reason: ' + (e && e.message ? e.message : 'unknown error') });
  }
};
