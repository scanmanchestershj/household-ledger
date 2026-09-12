// Serverless proxy for the Travel tab's Flight Price Checker.
//
// GET /api/flights?from=Dubai&to=Mumbai&departDate=2026-11-01&returnDate=&adults=1&currency=INR
//
// Uses Amadeus for Developers' free Self-Service API (test environment —
// generous free tier, ~2000 calls/month, no credit card required):
//   1. OAuth2 client_credentials token exchange
//   2. Airport & City Search, to resolve a typed city/airport name to an
//      IATA code when the person didn't type one directly
//   3. Flight Offers Search for the actual fares
//
// Requires AMADEUS_API_KEY and AMADEUS_API_SECRET env vars on the Vercel
// project (sign up free at https://developers.amadeus.com). Without them,
// this returns a clear "not configured" response rather than an error, so
// the UI can show setup instructions instead of failing silently.
//
// Note on data: Amadeus's free/test environment returns real fare-search
// results but from a smaller, cached dataset than their paid production
// tier — prices are indicative and should always be reconfirmed at
// booking, same as any comparison site.

const BASE = 'https://test.api.amadeus.com';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function getToken(apiKey, apiSecret) {
  const res = await withTimeout(fetch(`${BASE}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(apiSecret)}`
  }), 8000);
  if (!res.ok) throw new Error('Amadeus auth failed: ' + res.status);
  const data = await res.json();
  return data.access_token;
}

async function resolveLocation(token, query) {
  const trimmed = (query || '').trim();
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  const res = await withTimeout(fetch(`${BASE}/v1/reference-data/locations?subType=AIRPORT,CITY&keyword=${encodeURIComponent(trimmed)}&page[limit]=1`, {
    headers: { Authorization: `Bearer ${token}` }
  }), 8000);
  if (!res.ok) return null;
  const data = await res.json();
  const first = data.data && data.data[0];
  return first ? first.iataCode : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');

  const apiKey = process.env.AMADEUS_API_KEY;
  const apiSecret = process.env.AMADEUS_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(200).json({ offers: null, reason: 'not_configured', message: 'No AMADEUS_API_KEY/AMADEUS_API_SECRET set on this Vercel project. Sign up free at https://developers.amadeus.com, create an app, and add both as environment variables.' });
    return;
  }

  const { from, to, departDate, returnDate, adults, currency } = req.query || {};
  if (!from || !to || !departDate) {
    res.status(400).json({ error: 'Missing from, to, or departDate.' });
    return;
  }

  try {
    const token = await getToken(apiKey, apiSecret);
    const [origin, destination] = await Promise.all([resolveLocation(token, from), resolveLocation(token, to)]);
    if (!origin || !destination) {
      res.status(200).json({ offers: null, reason: 'unresolved', message: `Couldn't recognize "${!origin ? from : to}" as a city or airport — try the 3-letter airport code instead.` });
      return;
    }

    const params = new URLSearchParams({
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate: departDate,
      adults: String(adults || 1),
      currencyCode: currency || 'INR',
      max: '10'
    });
    if (returnDate) params.set('returnDate', returnDate);

    const searchRes = await withTimeout(fetch(`${BASE}/v2/shopping/flight-offers?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    }), 12000);
    const searchData = await searchRes.json();
    if (!searchRes.ok) {
      const msg = (searchData.errors && searchData.errors[0] && searchData.errors[0].detail) || `Amadeus API error ${searchRes.status}`;
      res.status(200).json({ offers: null, reason: 'search_failed', message: msg });
      return;
    }

    const dictionaries = searchData.dictionaries || {};
    const carriers = dictionaries.carriers || {};
    const offers = (searchData.data || []).map(offer => {
      const itineraries = offer.itineraries || [];
      const firstItin = itineraries[0];
      const segments = firstItin ? firstItin.segments : [];
      const firstSeg = segments[0];
      const lastSeg = segments[segments.length - 1];
      const carrierCode = firstSeg && firstSeg.carrierCode;
      return {
        price: offer.price ? offer.price.total : null,
        currency: offer.price ? offer.price.currency : (currency || 'INR'),
        airline: carrierCode ? (carriers[carrierCode] || carrierCode) : 'Unknown',
        stops: segments.length ? segments.length - 1 : null,
        duration: firstItin ? firstItin.duration : null,
        departure: firstSeg ? firstSeg.departure.at : null,
        arrival: lastSeg ? lastSeg.arrival.at : null,
        returnDuration: itineraries[1] ? itineraries[1].duration : null
      };
    }).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    res.status(200).json({ offers, origin, destination, source: 'amadeus' });
  } catch (e) {
    res.status(200).json({ offers: null, reason: 'error', message: "Couldn't reach the flight search service right now — try again shortly." });
  }
};
