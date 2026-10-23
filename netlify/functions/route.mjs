// A14 Live — real road shape and junction positions for the map, from OpenStreetMap (via the Overpass API).
// The result is cached on Netlify's CDN for a week, so OpenStreetMap is asked at most a few times a week.
// Map data © OpenStreetMap contributors, ODbL.

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// A14 main carriageways between Newmarket (J37) and Felixstowe docks, plus the junction nodes on them.
const QUERY = `[out:json][timeout:60];
way["highway"~"^(motorway|trunk|primary)$"]["ref"~"(^|;) *A14 *(;|$)"](51.935,0.37,52.31,1.365)->.a;
.a out geom;
node(w.a)["highway"="motorway_junction"];
out;`;

const WANTED = new Set(["37","38","39","40","41","42","43","44","45","46","47","47A","48","49","50","51","52","53","54","55","56","57","58","59","60","61","62"]);

export default async () => {
  let data = null, lastErr = "";
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "A14-Live/1.0 (netlify)" },
        body: "data=" + encodeURIComponent(QUERY),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { lastErr = `${url} HTTP ${r.status}`; continue; }
      data = await r.json();
      if (data?.elements?.length) break;
      lastErr = `${url} returned no elements`;
    } catch (e) { lastErr = `${url} ${e.message}`; }
  }
  if (!data?.elements?.length) return json({ ok: false, message: lastErr || "OpenStreetMap could not be reached" }, 502, 0);
  return json(build(data.elements), 200, 604800);
};

export function build(elements) {
  const lines = [], bridge = [], jn = {};
  for (const el of elements) {
    if (el.type === "way" && Array.isArray(el.geometry)) {
      const pts = simplify(el.geometry.map((g) => [round(g.lat), round(g.lon)]), 0.00008);
      if (pts.length < 2) continue;
      lines.push(pts);
      const t = el.tags || {};
      if (t.bridge && t.bridge !== "no" && (/orwell/i.test(t.name || "") || /orwell/i.test(t["bridge:name"] || ""))) bridge.push(pts);
    } else if (el.type === "node" && el.tags?.ref) {
      for (const raw of String(el.tags.ref).split(/[;,]/)) {
        const ref = raw.trim().toUpperCase().replace(/^J/, "");
        if (!WANTED.has(ref)) continue;
        (jn[ref] ||= { ref, lat: 0, lon: 0, n: 0, name: el.tags.name || null }).n++;
        jn[ref].lat += el.lat; jn[ref].lon += el.lon;
        if (!jn[ref].name && el.tags.name) jn[ref].name = el.tags.name;
      }
    }
  }
  const junctions = Object.values(jn).map((j) => ({ ref: j.ref, lat: round(j.lat / j.n), lon: round(j.lon / j.n), name: j.name }));
  return { ok: true, source: "OpenStreetMap", lines, bridge, junctions };
}

function round(x) { return Math.round(x * 1e5) / 1e5; }

// Douglas–Peucker line simplification (tolerance in degrees, ~9 m at 0.00008).
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) { const d = segDist(pts[i], pts[a], pts[b]); if (d > max) { max = d; idx = i; } }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function segDist(p, a, b) {
  const dx = b[1] - a[1], dy = b[0] - a[0], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / L)) : 0;
  return Math.hypot(p[1] - (a[1] + t * dx), p[0] - (a[0] + t * dy));
}

function json(obj, status, maxAge) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Netlify-CDN-Cache-Control": maxAge ? `public, durable, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}` : "no-store",
      "Cache-Control": maxAge ? "public, max-age=86400" : "no-cache",
    },
  });
}

export const config = { path: "/api/route" };
