// Serverless proxy that returns the current Nifty Smallcap 250 constituent
// list (name + NSE symbol) for the batch technical scanner. Same pattern
// as nifty100.js.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CSV_URL = 'https://www.niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv';

// Fallback only used if the live CSV can't be reached.
const FALLBACK_LIST = [
  ['Route Mobile', 'ROUTE'], ['CarTrade Tech', 'CARTRADE'], ['Craftsman Automation', 'CRAFTSMAN'],
  ['Sonata Software', 'SONATSOFTW'], ['Rainbow Children\'s Medicare', 'RAINBOW'], ['Aster DM Healthcare', 'ASTERDM'],
  ['Radico Khaitan', 'RADICO'], ['Poonawalla Fincorp', 'POONAWALLA'], ['Kaynes Technology India', 'KAYNES'],
  ['Cholamandalam Financial Holdings', 'CHOLAHLDNG'], ['Central Depository Services', 'CDSL'], ['NBCC (India)', 'NBCC'],
  ['Delhivery', 'DELHIVERY'], ['Laurus Labs', 'LAURUSLABS'], ['Multi Commodity Exchange', 'MCX'],
  ['Chambal Fertilisers', 'CHAMBLFERT'], ['Sundram Fasteners', 'SUNDRMFAST'], ['KEI Industries', 'KEI'],
  ['Finolex Cables', 'FINCABLES'], ['Amber Enterprises', 'AMBER'], ['Century Plyboards', 'CENTURYPLY'],
  ['Greenpanel Industries', 'GREENPANEL'], ['Vedant Fashions', 'VEDANTFASHN'], ['Metro Brands', 'METROBRAND'],
  ['Aavas Financiers', 'AAVAS'], ['CreditAccess Grameen', 'CREDITACC'], ['Home First Finance', 'HOMEFIRST'],
  ['Sansera Engineering', 'SANSERA'], ['Endurance Technologies', 'ENDURANCE'], ['Suprajit Engineering', 'SUPRAJIT'],
  ['Triveni Turbine', 'TRITURBINE'], ['Thermax', 'THERMAX'], ['Elgi Equipments', 'ELGIEQUIP'],
  ['Ratnamani Metals & Tubes', 'RATNAMANI'], ['Grindwell Norton', 'GRINDWELL'], ['Carborundum Universal', 'CARBORUNIV']
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
    if (list.length < 150) throw new Error('parsed list too short, likely not real CSV content');
    res.status(200).json({ source: 'live', count: list.length, list });
  } catch (e) {
    const list = FALLBACK_LIST.map(([name, symbol]) => ({ name, symbol: symbol + '.NS' }));
    res.status(200).json({ source: 'fallback', count: list.length, list, note: 'Live Nifty Smallcap 250 list unavailable — showing a short fallback set instead.' });
  }
};
