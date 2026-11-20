'use strict';
// New Tab weather widget (opt-in, off by default). Uses Open-Meteo, which needs no account
// or key. The only thing sent is the city name you type (to find it) and then its rounded
// coordinates; nothing about your browsing. Results are cached for 30 minutes.

const { net } = require('electron');

const TTL = 30 * 60 * 1000;
const cache = new Map(); // "lat,lon,unit" -> { at, data }

// WMO weather interpretation codes → label + icon name used by the New Tab page.
const CODES = [
  [[0], 'Clear', 'sun'],
  [[1, 2], 'Partly cloudy', 'cloudSun'],
  [[3], 'Cloudy', 'cloud'],
  [[45, 48], 'Fog', 'fog'],
  [[51, 53, 55, 56, 57], 'Drizzle', 'rain'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'Rain', 'rain'],
  [[71, 73, 75, 77, 85, 86], 'Snow', 'snow'],
  [[95, 96, 99], 'Thunderstorm', 'storm']
];
function describe(code) {
  const hit = CODES.find(([list]) => list.includes(code));
  return hit ? { label: hit[1], icon: hit[2] } : { label: 'Weather', icon: 'cloud' };
}

async function getJson(url) {
  const res = await net.fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`The weather service answered ${res.status}`);
  return res.json();
}

/** Find cities by name (for the widget's settings). */
async function geocode(name) {
  const q = String(name || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(q)}`);
  return (j.results || []).map((r) => ({ name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', ').slice(0, 120), lat: Math.round(r.latitude * 100) / 100, lon: Math.round(r.longitude * 100) / 100 }));
}

async function current({ lat, lon }, unit = 'c') {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Choose a city first');
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${unit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const u = unit === 'f' ? '&temperature_unit=fahrenheit' : '';
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto${u}`);
  const c = j.current || {};
  const d = describe(c.weather_code);
  const data = {
    temp: Math.round(c.temperature_2m),
    unit: unit === 'f' ? '°F' : '°C',
    label: d.label,
    icon: c.is_day === 0 && d.icon === 'sun' ? 'moon' : d.icon,
    high: Math.round(j.daily?.temperature_2m_max?.[0]),
    low: Math.round(j.daily?.temperature_2m_min?.[0]),
    at: Date.now()
  };
  if (!Number.isFinite(data.temp)) throw new Error('The weather service sent an unexpected answer');
  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { geocode, current, describe };
