// National Highways "Road and Lane Closures" v2 (DATEX II JSON): fetch, parse and filter to the A14, Newmarket (J37) to Felixstowe (J62).
// Shared by the live endpoint (functions/a14.mjs) and the scheduled poller (functions/poll.mjs).

const API = "https://api.data.nationalhighways.co.uk/roads/v2.0/closures";
const MAX_PAGES = 4;

// Corridor box around the A14 from Newmarket to Felixstowe (a little padding either side).
const BOX = { minLat: 51.93, maxLat: 52.32, minLon: 0.33, maxLon: 1.37 };

// Approximate junction positions, west → east. Used to label where an event is.
export const JUNCTIONS = [
  ["37", 52.2738, 0.3923, "Newmarket / Exning (A142)"],
  ["38", 52.2808, 0.4405, "A11 Thetford, Norwich"],
  ["39", 52.2656, 0.4985, "Kentford"],
  ["40", 52.2611, 0.5642, "Higham"],
  ["41", 52.2562, 0.6432, "Risby"],
  ["42", 52.2536, 0.6893, "Bury St Edmunds West"],
  ["43", 52.2583, 0.7128, "Bury St Edmunds Central (A134)"],
  ["44", 52.2421, 0.7423, "Bury St Edmunds East"],
  ["45", 52.2398, 0.7722, "Rougham / Great Barton"],
  ["46", 52.2449, 0.8371, "Thurston / Beyton"],
  ["47", 52.2369, 0.8921, "Woolpit (A1088)"],
  ["47A", 52.2212, 0.9441, "Haughley / Wetherden"],
  ["49", 52.2119, 0.9781, "Tot Hill (A1308)"],
  ["50", 52.1951, 1.0052, "Stowmarket (A1120)"],
  ["51", 52.1532, 1.0631, "Beacon Hill (A140)"],
  ["52", 52.1081, 1.1041, "Claydon"],
  ["53", 52.0801, 1.1152, "Whitehouse (A1156)"],
  ["54", 52.0571, 1.1001, "Sproughton"],
  ["55", 52.0312, 1.1052, "Copdock (A12)"],
  ["56", 52.0281, 1.1401, "Wherstead (A137)"],
  ["57", 52.0392, 1.2152, "Nacton (A1189)"],
  ["58", 52.0401, 1.2551, "Seven Hills (A12)"],
  ["59", 51.9901, 1.3051, "Trimley"],
  ["60", 51.9702, 1.3252, "Dock Spur roundabout (A154)"],
  ["61", 51.9621, 1.3272, "Dock Gate 2"],
  ["62", 51.9521, 1.3381, "Dock Gate 1"],
];
export const ORWELL = { lat: 52.0305, lon: 1.1735, radiusKm: 1.6 };

// Fetch planned + unplanned closures and return the A14 (J37–J62) events. Throws only if every request failed.
export async function getClosures(key, now = new Date(), debug = false) {
  const iso = (d) => d.toISOString().slice(0, 19); // API format YYYY-MM-DDThh:mm:ss (UTC)
  const hours = (h) => new Date(now.getTime() + h * 3600e3);
  const queries = [
    { closureType: "unplanned", startDateTime: iso(hours(-24)), endDateTime: iso(hours(1)) },
    { closureType: "planned", startDateTime: iso(hours(-1)), endDateTime: iso(hours(24)) },
  ];
  const raw = [], errors = [];
  for (const q of queries) {
    try {
      const pages = await fetchAll(q, key);
      raw.push(...pages.map((p) => ({ closureType: q.closureType, body: p })));
    } catch (e) { errors.push(`closures ${q.closureType}: ${e.message}`); }
  }
  if (!raw.length && errors.length) throw new Error(errors.join(" · "));

  const events = [], a14Raw = [], seen = new Set();
  let totalRaw = 0;
  for (const { closureType, body } of raw) {
    const evs = extractEvents(body, closureType);
    totalRaw += evs.length;
    for (const ev of evs) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const verdict = corridorVerdict(ev, now);
      if (!verdict) events.push(decorate(ev, now));
      if (debug && [...ev.roads, ...ev.places, ...ev.comments].some((t) => /\bA14\b/i.test(t))) {
        a14Raw.push({ id: ev.id, type: closureType, kept: !verdict, reason: verdict, roads: ev.roads, location: ev.places, comments: ev.comments,
          causes: ev.causes, details: ev.details, mgmt: ev.mgmt, status: ev.status, start: ev.start, end: ev.end, firstPoint: ev.coords[0] || null });
      }
    }
  }
  events.sort((a, b) => rank(a) - rank(b) || (b.updated || "").localeCompare(a.updated || ""));
  const out = { events, warnings: errors };
  if (debug) out.debug = { totalRecordsInFeed: totalRaw, pages: raw.map((r) => r.closureType), a14RecordsInFeed: a14Raw };
  return out;
}

// ---------- upstream ----------
export async function fetchAll(params, key, base = API, maxPages = MAX_PAGES) {
  const pages = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    // x-next is a full URL to the next page (per the portal's OpenAPI specs); fall back to treating it as a bare cursor.
    let u;
    if (cursor && /^https:\/\/api\.data\.nationalhighways\.co\.uk\//i.test(cursor)) {
      u = new URL(cursor);
    } else {
      u = new URL(base);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (cursor) {
        const m = String(cursor).match(/pageCursor=([^&]+)/i);
        u.searchParams.set("pageCursor", m ? decodeURIComponent(m[1]) : cursor);
      }
    }
    const r = await fetch(u, {
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "X-Response-MediaType": "application/json",
        "X-Data-Format": "DATEXII",
        "Cache-Control": "no-cache",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 204) break;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    pages.push(await r.json());
    cursor = r.headers.get("x-next");
    if (!cursor) break;
  }
  return pages;
}

// ---------- DATEX II parsing (National Highways Road and Lane Closures v2 schema) ----------
// D2Payload.situation[] → situationRecord[] → { sitRoadOrCarriagewayOrLaneManagement: {...} }
function extractEvents(body, closureType) {
  const situations = body?.D2Payload?.situation || body?.situation || [];
  return situations.map((s, i) => summarise(s, closureType, i)).filter(Boolean);
}

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
// The feed sometimes pads values with spaces, so trim every enum.
const enumVal = (x) => { const v = x == null ? null : typeof x === "string" ? x : x.extendedValueG || x.value || null; return v == null ? null : String(v).trim() || null; };

function summarise(sit, closureType, i) {
  const records = asList(sit.situationRecord).map((r) => r?.sitRoadOrCarriagewayOrLaneManagement || Object.values(r || {})[0]).filter(isObj);
  if (!records.length) return null;

  const mgmt = new Set(), causes = new Set(), details = new Set(), comments = [], roads = new Set(),
        dirs = new Set(), places = [], coords = [], carriageways = new Set();
  let start = null, end = null, updated = sit.situationVersionTime || null, lanes = null, opLanes = null, status = null, source = null;

  for (const rec of records) {
    const m = enumVal(rec.roadOrCarriagewayOrLaneManagementType); if (m) mgmt.add(m);
    if (rec.cause?.causeType) causes.add(String(rec.cause.causeType).trim());
    for (const v of Object.values(rec.cause?.detailedCauseType || {})) for (const d of asList(v)) { const e = enumVal(d); if (e && e !== "other" && e !== "extendedG") details.add(e); }
    for (const c of asList(rec.generalPublicComment)) { const t = cleanComment(c?.comment); if (t) comments.push(t); }
    const vt = rec.validity?.validityTimeSpecification || {};
    if (vt.overallStartTime && (!start || vt.overallStartTime < start)) start = vt.overallStartTime;
    if (vt.overallEndTime && (!end || vt.overallEndTime > end)) end = vt.overallEndTime;
    if (rec.situationRecordVersionTime && (!updated || rec.situationRecordVersionTime > updated)) updated = rec.situationRecordVersionTime;
    status = rec.validity?.validityStatus ? String(rec.validity.validityStatus).trim() : status;
    source = rec.source?.sourceIdentification || source;

    // Location: walk only the location keys we know about.
    walk(rec.locationReference || {}, (node, k) => {
      if (k === "roadName" && typeof node === "string") roads.add(node.trim());
      else if ((k === "directionOnLinearSection" || k === "directionAtPoint" || k === "direction") && typeof node === "string") dirs.add(node);
      else if (k === "locationDescription" && typeof node === "string") places.push(node.trim());
      else if (k === "posList" && typeof node === "string") {
        const n = node.trim().split(/[\s,]+/).map(Number).filter((x) => !isNaN(x));
        for (let j = 0; j + 1 < n.length; j += 2) addCoord(coords, n[j], n[j + 1]);
      } else if (k === "pointCoordinates" && isObj(node)) addCoord(coords, +node.latitude, +node.longitude);
      else if (k === "numberOfLanesRestricted" && typeof node === "number") lanes = Math.max(lanes || 0, node);
      else if (k === "numberOfOperationalLanes" && typeof node === "number") opLanes = Math.max(opLanes || 0, node);
      else if (k === "carriageway" && isObj(node) && (node.value || node.extendedValueG)) carriageways.add(enumVal(node));
    });
  }

  return {
    id: String(sit.idG || records[0].idG || `${closureType}-${i}`), closureType,
    mgmt: [...mgmt], causes: [...causes], details: [...details], roads: [...roads], dirs: [...dirs],
    places: dedupe(places), comments: dedupe(comments), carriageways: [...carriageways],
    coords: coords.slice(0, 400), start, end, updated: updated || start, lanes, opLanes, status, source,
  };
}

// Drop comments that are just an enum echo ("laneClosures") and trim engineering references in brackets.
function cleanComment(c) {
  if (typeof c !== "string") return null;
  const t = c.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!t || /^[a-z]+([A-Z][a-z]*)+$/.test(t) || /^[a-z]+$/i.test(t) && t.length < 14) return null;
  return t;
}

// Why an event was kept or dropped (null = kept). Used for filtering and for ?debug=1.
function corridorVerdict(ev, now) {
  // The road must be named A14 in the record's own road names or location description (not just mentioned in a comment, e.g. a diversion).
  const ownWords = [...ev.roads, ...ev.places];
  if (!ownWords.some((r) => /\bA14\b/i.test(r))) return "not on the A14";
  // Unplanned end times are rolling estimates that get extended, so only drop records that are clearly over.
  if (ev.end && new Date(ev.end) < new Date(now.getTime() - 90 * 60e3) && ev.status !== "active") return "ended";
  if (ev.coords.length) {
    const d = Math.min(...ev.coords.map(([la, lo]) => distToRouteKm(la, lo)));
    return d <= 2.5 ? null : `outside Newmarket–Felixstowe (${d.toFixed(1)} km from route)`;
  }
  return [...ownWords, ...ev.comments].some((t) => /\bJ(unction)?\s?(3[7-9]|4\d|5\d|6[0-2])\b|Newmarket|Bury|Stowmarket|Ipswich|Orwell|Felixstowe|Copdock|Nacton|Trimley|Claydon|Woolpit|Haughley|Kentford|Sproughton/i.test(t)) ? null : "no location on this stretch";
}

// Route polyline: junctions with the Orwell Bridge deck inserted between J56 and J57.
const ROUTE = (() => {
  const pts = JUNCTIONS.map((j) => [j[1], j[2]]);
  const i57 = JUNCTIONS.findIndex((j) => j[0] === "57");
  pts.splice(i57, 0, [52.0262, 1.1588], [52.0300, 1.1720], [52.0338, 1.1860]);
  return pts;
})();
export function distToRouteKm(la, lo) {
  let best = Infinity;
  const k = Math.cos(52 * Math.PI / 180) * 111.32, kl = 110.57;
  const px = lo * k, py = la * kl;
  for (let i = 0; i + 1 < ROUTE.length; i++) {
    const ax = ROUTE[i][1] * k, ay = ROUTE[i][0] * kl, bx = ROUTE[i + 1][1] * k, by = ROUTE[i + 1][0] * kl;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

const CLOSURE_TYPES = /^(roadClosed|carriagewayClosures|overnightClosures|intermittentShortTermClosures|closedPermanentlyForTheWinter|rollingRoadBlock)$/;
const LANE_TYPES = /^(laneClosures|narrowLanes|contraflow|lanesDeviated|singleAlternateLineTraffic|doNotUseSpecifiedLanesOrCarriageways|useSpecifiedLanesOrCarriageways|keepToTheLeft|keepToTheRight|newRoadworksLayout)$/;
const INCIDENT_CAUSES = /^(vehicleObstruction|obstruction|animalPresence|environmentalObstruction|poorEnvironment|weatherRelatedRoadConditions|nonWeatherRelatedRoadConditions|infrastructureDamageObstruction|equipmentOrSystemFault|disturbance|authorityOperation|abnormalTraffic|earlierIncident|earlierEvent|roadsideAssistance|vandalism)$/;
const WORKS_CAUSES = /^(roadMaintenance|constructionWork)$/;

function decorate(ev, now) {
  const has = (set, re) => set.some((x) => re.test(x));
  const fullClosure = has(ev.mgmt, CLOSURE_TYPES) || (ev.lanes && ev.opLanes === 0);
  const laneClosure = has(ev.mgmt, LANE_TYPES) || (ev.lanes > 0);
  const works = ev.closureType === "planned" || has(ev.causes, WORKS_CAUSES) || /roadworks/i.test(ev.source || "");

  let category;
  if (ev.causes.includes("accident")) category = "accident";
  else if (fullClosure) category = "closure";
  else if (has(ev.causes, INCIDENT_CAUSES)) category = "incident";
  else if (works) category = "roadworks";
  else if (laneClosure) category = "lanes";
  else category = "incident";

  const allText = [...ev.places, ...ev.comments];
  const pts = ev.coords.length ? ev.coords : textJunctionPoints(allText);
  const near = pts.map(([la, lo]) => nearestJunctionIndex(la, lo));
  const textJ = [...allText.join(" ").matchAll(/\bJ(\d{2}A?)\b/g)].map((m) => JUNCTIONS.findIndex((j) => j[0] === m[1])).filter((x) => x >= 0);
  const idx = textJ.length ? textJ : near;
  const lo = idx.length ? Math.min(...idx) : null, hi = idx.length ? Math.max(...idx) : null;
  const orwell = /orwell/i.test(allText.join(" ")) || pts.some(([la, lon]) => km(la, lon, ORWELL.lat, ORWELL.lon) <= ORWELL.radiusKm);

  let direction = null;
  const d = [...ev.dirs, ...ev.places].join(" ");
  const east = /east ?bound/i.test(d), west = /west ?bound/i.test(d);
  if (east && west || /bothWays|allDirections|both directions/i.test(d)) direction = "Both directions";
  else if (east) direction = "Eastbound";
  else if (west) direction = "Westbound";

  const live = !ev.start || new Date(ev.start) <= now;
  const lanesText = ev.lanes ? `${ev.lanes} lane${ev.lanes > 1 ? "s" : ""} closed${ev.opLanes ? ` (${ev.opLanes} open)` : ""}` : null;
  const slip = ev.carriageways.some((c) => /slip|link|entry|exit/i.test(c)) || ev.places.some((p) => /slip road|link road|entry|exit/i.test(p));

  return {
    id: ev.id, category, closureType: ev.closureType, live,
    title: titleFor(category, ev, lanesText, slip),
    location: ev.places[0] || null,
    detail: ev.comments.find((c) => c !== ev.places[0]) || null,
    lanesText, direction, lanes: ev.lanes,
    fromJ: lo != null ? JUNCTIONS[lo][0] : null, toJ: hi != null ? JUNCTIONS[hi][0] : null,
    orwell, start: ev.start, end: ev.end, updated: ev.updated,
    points: thin(pts, 80),
  };
}

function titleFor(cat, ev, lanesText, slip) {
  const detail = ev.details.find((x) => !/^(roadMaintenance|laneClosures|roadClosed|other)$/.test(x));
  const named = detail ? humanise(detail) : null;
  const where = slip ? "Slip road" : "Road";
  switch (cat) {
    case "accident": return named && !/^Accident$/i.test(named) ? `Accident: ${named.toLowerCase()}` : "Accident";
    case "closure": return ev.mgmt.includes("overnightClosures") ? "Overnight closure" : `${where} closed${named && ev.closureType === "unplanned" ? ` · ${named}` : ""}`;
    case "incident": return named || humanise(ev.causes.find((c) => INCIDENT_CAUSES.test(c)) || "incident");
    case "roadworks": return lanesText ? `Roadworks · ${lanesText}` : "Roadworks";
    default: return lanesText || (slip ? "Slip road lane closure" : "Lane closure");
  }
}
const SPECIAL = { brokenDownVehicle: "Broken-down vehicle", vehicleOnFire: "Vehicle fire", animalPresence: "Animal in road", vehicleObstruction: "Vehicle obstruction" };
function humanise(s) { if (SPECIAL[s]) return SPECIAL[s]; const t = s.replace(/([A-Z])/g, " $1").toLowerCase().trim(); return t.charAt(0).toUpperCase() + t.slice(1); }
function rank(e) { return { closure: 0, accident: 1, incident: 2, lanes: 3, roadworks: 4 }[e.category] + (e.live ? 0 : 10); }

function textJunctionPoints(texts) {
  const pts = [];
  for (const t of texts) for (const m of t.matchAll(/\bJ(?:unction)?\s?(\d{2}A?)\b/gi)) {
    const j = JUNCTIONS.find((x) => x[0] === m[1].toUpperCase());
    if (j) pts.push([j[1], j[2]]);
  }
  return pts;
}
export function nearestJunctionIndex(la, lo) {
  let best = 0, bd = Infinity;
  JUNCTIONS.forEach((j, i) => { const d = km(la, lo, j[1], j[2]); if (d < bd) { bd = d; best = i; } });
  return best;
}

// ---------- helpers ----------
function walk(node, fn, key = "", parent = null) {
  fn(node, key, parent);
  if (Array.isArray(node)) node.forEach((c) => walk(c, fn, key, node));
  else if (isObj(node)) for (const [k, v] of Object.entries(node)) walk(v, fn, k, node);
}
function isObj(x) { return x && typeof x === "object" && !Array.isArray(x); }
function addCoord(arr, a, b) {
  // DATEX posList is "lat lon"; guard against lon/lat order by checking UK ranges.
  if (a > 49 && a < 61 && b > -9 && b < 3) arr.push([a, b]);
  else if (b > 49 && b < 61 && a > -9 && a < 3) arr.push([b, a]);
}
export function km(a, b, c, d) {
  const R = 6371, r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R;
}
function dedupe(a) { return [...new Set(a.map((s) => s.replace(/\s+/g, " ")))]; }
export function thin(pts, n) { if (pts.length <= n) return pts; const s = pts.length / n; return Array.from({ length: n }, (_, i) => pts[Math.floor(i * s)]); }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }

