const https = require('https');
const { URL } = require('url');

// Simple in-memory LRU-ish cache using Map (insertion order preserved)
const CACHE_MAX = 500;
const cache = new Map();

const makeRequest = (url, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const options = {
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: 'GET',
    headers
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });

  req.on('error', (err) => reject(err));
  req.end();
});

const roundCoordKey = (lat, lng) => `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;

const reverseGeocode = async (lat, lng) => {
  if (lat == null || lng == null) return null;
  const key = roundCoordKey(lat, lng);
  if (cache.has(key)) {
    // refresh order
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  // Nominatim reverse geocoding - free but rate-limited. Use a polite User-Agent.
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=en`;
  try {
    const data = await makeRequest(url, { 'User-Agent': 'HRM-App/1.0 (maintainer@example.com)' });
    let place = null;
    if (data) {
      if (data.display_name) {
        // display_name is a readable full address; we will trim to a shorter form if possible
        place = data.display_name;
      }
      // Prefer structured address if available to build a concise place name
      if (data.address) {
        const a = data.address;
        const locality = a.city || a.town || a.village || a.hamlet || a.county;
        const state = a.state || a.region || a.state_district;
        const country = a.country;
        const parts = [];
        if (locality) parts.push(locality);
        if (state) parts.push(state);
        if (country) parts.push(country);
        if (parts.length > 0) place = parts.join(', ');
      }
    }

    if (!place && data && data.display_name) place = data.display_name;
    if (!place) place = null;

    // cache result
    cache.set(key, place);
    // evict oldest if over capacity
    if (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }

    return place;
  } catch (err) {
    // On failure, don't block check-in; return null
    console.warn('Reverse geocode failed:', err && err.message ? err.message : err);
    return null;
  }
};

module.exports = reverseGeocode;
