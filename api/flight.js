// Live position and flown path for one aircraft, from adsb.lol (ODbL).
// GET /api/flight?id=<callsign | registration | 6-digit hex>[&hex=<hex from an earlier reply>]
// Passing hex back keeps the path coming while the plane is out of receiver range
// (the live lookup finds nothing then) or the lookup is rate-limited.
// The browser can't call adsb.lol directly (no CORS), so live.html polls this.
// Stateless: each call rebuilds the path from adsb.lol's own trace files.

const API = 'https://api.adsb.lol/v2';
const TRACES = 'https://adsb.lol/data/traces';
const TIMEOUT_MS = 6000;
// trace_recent only fills the ~15 minutes trace_full lags behind, and is often slow.
const RECENT_TIMEOUT_MS = 3000;
const MAX_POINTS = 1500;
// A ground stop or a gap this long ends one flight and starts the next.
const NEW_FLIGHT_GAP_S = 3 * 3600;

async function getJson(url, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'endurancefreek.com live tracker' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function findAircraft(id) {
  const tries = /^[0-9a-f]{6}$/i.test(id) ? ['hex', 'callsign', 'reg'] : ['callsign', 'reg'];
  for (const kind of tries) {
    const data = await getJson(`${API}/${kind}/${encodeURIComponent(id)}`);
    const ac = data && Array.isArray(data.ac) ? data.ac[0] : null;
    if (ac) return { hex: ac.hex.toLowerCase(), live: ac };
  }
  return null;
}

// Trace rows are [secondsAfterTimestamp, lat, lon, altitudeFt | "ground", groundSpeedKt, track, ...].
function tracePoints(trace) {
  if (!trace || !Array.isArray(trace.trace)) return [];
  return trace.trace
    .filter((p) => typeof p[1] === 'number' && typeof p[2] === 'number')
    .map((p) => ({ t: trace.timestamp + p[0], lat: p[1], lon: p[2], alt: p[3] === 'ground' ? 0 : p[3], ground: p[3] === 'ground', gs: p[4] }));
}

// Keep only the most recent flight: back from the end to the last ground stop
// or long silence before it took off.
function currentFlight(points) {
  let end = points.length - 1;
  while (end > 0 && points[end].ground && points[end - 1].ground) end--;
  let start = end;
  while (start > 0) {
    const prev = points[start - 1];
    if (points[start].t - prev.t > NEW_FLIGHT_GAP_S) break;
    if (prev.ground && start < end && !points[start].ground) { start--; break; }
    start--;
  }
  return points.slice(start, points.length);
}

function thin(points) {
  if (points.length <= MAX_POINTS) return points;
  const step = (points.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, i) => points[Math.round(i * step)]);
}

module.exports = async function handler(req, res) {
  const id = String((req.query && req.query.id) || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9-]{2,10}$/.test(id)) {
    res.status(400).json({ error: 'id must be a callsign, registration, or 6-digit hex code' });
    return;
  }
  const known = String((req.query && req.query.hex) || '').toLowerCase();
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
  try {
    let found = null;
    try {
      found = await findAircraft(id);
    } catch (err) {
      if (!/^[0-9a-f]{6}$/.test(known)) throw err;
    }
    const hex = found ? found.hex : /^[0-9a-f]{6}$/.test(known) ? known : /^[0-9A-F]{6}$/.test(id) ? id.toLowerCase() : null;
    if (!hex) {
      res.status(200).json({ id, seen: false });
      return;
    }
    const dir = `${TRACES}/${hex.slice(-2)}`;
    const [full, recent] = await Promise.all([
      getJson(`${dir}/trace_full_${hex}.json`).catch(() => null),
      getJson(`${dir}/trace_recent_${hex}.json`, RECENT_TIMEOUT_MS).catch(() => null),
    ]);
    const byTime = new Map();
    for (const p of [...tracePoints(full), ...tracePoints(recent)]) byTime.set(Math.round(p.t), p);
    const live = found && found.live;
    if (live && typeof live.lat === 'number') {
      const t = Date.now() / 1000 - (live.seen_pos ?? live.seen ?? 0);
      byTime.set(Math.round(t), { t, lat: live.lat, lon: live.lon, alt: live.alt_baro === 'ground' ? 0 : live.alt_baro, ground: live.alt_baro === 'ground', gs: live.gs });
    }
    const points = currentFlight([...byTime.values()].sort((a, b) => a.t - b.t));
    const info = full || recent || {};
    const last = points[points.length - 1];

    res.status(200).json({
      id,
      seen: points.length > 0,
      hex,
      callsign: live && live.flight ? live.flight.trim() : undefined,
      registration: (live && live.r) || info.r,
      aircraft: (live && live.desc) || info.desc || (live && live.t) || info.t,
      inRange: !!(live && typeof live.lat === 'number'),
      position: last
        ? {
            lat: last.lat,
            lon: last.lon,
            altitudeFt: typeof last.alt === 'number' ? last.alt : null,
            onGround: last.ground,
            speedKt: live && typeof live.gs === 'number' ? live.gs : last.gs ?? null,
            heading: live && typeof live.track === 'number' ? live.track : null,
            time: Math.round(last.t * 1000),
          }
        : null,
      departed: points.length ? Math.round(points[0].t * 1000) : null,
      path: thin(points).map((p) => [Number(p.lat.toFixed(4)), Number(p.lon.toFixed(4))]),
    });
  } catch (err) {
    console.error('flight', id, err && err.message);
    res.status(502).json({ error: 'flight data is unavailable right now' });
  }
};
