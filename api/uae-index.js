// Serverless endpoint for the UAE Index Screener's stock list.
//
// Unlike NSE (India), neither DFM nor ADX publish a clean, reliably
// fetchable, unauthenticated constituent CSV — Dubai Pulse's open-data
// portal blocks automated access and ADX has no public equivalent. So
// this is a curated list of the largest, most liquid names on each index
// (DFM General Index and the FTSE ADX General Index), sourced from public
// index-component data and kept as a maintained list rather than a live
// feed. It will need occasional manual updates as index composition
// changes — it is NOT pulled live the way the Nifty scanners are.

const LIST = [
  // DFM General Index (Dubai Financial Market) — largest constituents
  ['Emirates NBD Bank', 'EMIRATESNBD', 'DFM'],
  ['Dubai Electricity & Water Authority', 'DEWA', 'DFM'],
  ['Emaar Properties', 'EMAAR', 'DFM'],
  ['Mashreqbank', 'MASQ', 'DFM'],
  ['Dubai Islamic Bank', 'DIB', 'DFM'],
  ['Emaar Development', 'EMAARDEV', 'DFM'],
  ['du (Emirates Integrated Telecom)', 'DU', 'DFM'],
  ['Salik Company', 'SALIK', 'DFM'],
  ['Commercial Bank of Dubai', 'CBD', 'DFM'],
  ['Talabat Holding', 'TALABAT', 'DFM'],
  // FTSE ADX General Index (Abu Dhabi Securities Exchange) — largest constituents
  ['International Holding Company', 'IHC', 'ADX'],
  ['Abu Dhabi National Energy Co (TAQA)', 'TAQA', 'ADX'],
  ['ADNOC Gas', 'ADNOCGAS', 'ADX'],
  ['First Abu Dhabi Bank', 'FAB', 'ADX'],
  ['e& (Etisalat Group)', 'EAND', 'ADX'],
  ['Abu Dhabi Commercial Bank', 'ADCB', 'ADX'],
  ['ADNOC Drilling', 'ADNOCDRILL', 'ADX'],
  ['Abu Dhabi Islamic Bank', 'ADIB', 'ADX'],
  ['Alpha Dhabi Holding', 'ALPHADHABI', 'ADX'],
  ['Borouge', 'BOROUGE', 'ADX']
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  const list = LIST.map(([name, symbol, exchange]) => ({ name: `${name} (${exchange})`, symbol: symbol + '.AE' }));
  res.status(200).json({
    source: 'curated',
    count: list.length,
    list,
    note: 'Curated list of the largest DFM General Index and FTSE ADX General Index constituents — not a live index feed (no public unauthenticated one exists for DFM/ADX). Update this list by hand if index composition changes.'
  });
};
