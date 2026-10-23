// National Highways "Digital Variable Message Signs" v1 (DATEX II JSON): what the overhead electronic signs on the A14 are showing.
// Signs are usually set within minutes of an incident, often before a closure record exists.
// Spec: https://api.data.nationalhighways.co.uk/dvms/v1.0/vms — needs a subscription to "Digital Variable Message Signs".

import { fetchAll, JUNCTIONS, ORWELL, distToRouteKm, nearestJunctionIndex, km } from "./closures.mjs";

const API = "https://api.data.nationalhighways.co.uk/dvms/v1.0/vms";
const BOX = [51.93, 0.33, 52.32, 1.37]; // lat/lon corners around the Newmarket–Felixstowe A14
let bboxOrder = "latlon"; // remembered across warm invocations once we learn which order the API accepts

// Messages worth showing: incidents, closures, queues, hazards. Travel times, campaigns and blank signs are skipped.
const WORTH = /CLOSED|CLOSURE|ACCIDENT|COLLISION|CRASH|INCIDENT|QUEUE|CONGESTION|OBSTRUCTION|BROKEN|ANIMAL|DEBRIS|FIRE|SMOKE|FLOOD|SPILL|DELAY|SLOW|STOPPED|DIVERSION|DIVERTED|FOLLOW|ICE|FOG|WIND|SKID|ROADWORKS|WORKS|POLICE|EMERGENCY|PEDESTRIAN|CYCLIST|HAZARD|ABNORMAL LOAD|WRONG WAY|CAUTION|DANGER|REPORT OF|LANE/;
const SKIP_TYPES = new Set(["campaignMessage", "travelTime", "temperature", "dateTime"]);

export async function getSigns(key, debug = false) {
  const tries = bboxOrder === "latlon" ? ["latlon", "lonlat", "none"] : bboxOrder === "lonlat" ? ["lonlat", "latlon", "none"] : ["none"];
  let pages = null, used = null, lastErr = null;
  for (const order of tries) {
    const params = {};
    if (order === "latlon") params.bBox = BOX.join(",");
    if (order === "lonlat") params.bBox = [BOX[1], BOX[0], BOX[3], BOX[2]].join(",");
    try {
      const p = await fetchAll(params, key, API, order === "none" ? 3 : 2);
      const n = p.reduce((a, b) => a + (b?.D2Payload?.vmsControllerStatus?.length || 0), 0);
      if (n > 0 || order === "none") { pages = p; used = order; break; }
    } catch (e) { lastErr = e; if (/HTTP 40[13]/.test(e.message)) break; }
  }
  if (!pages) throw new Error(`signs: ${lastErr ? lastErr.message : "no data"}`);
  bboxOrder = used;

  const signs = [], all = [];
  let total = 0;
  for (const page of pages) for (const ctrl of page?.D2Payload?.vmsControllerStatus || []) {
    for (const vs of ctrl.vmsStatus || []) {
      total++;
      const st = vs.vmsStatus || {};
      const s = summariseSign(ctrl, st);
      if (s) signs.push(s);
      if (debug) all.push(rawView(ctrl, st, !!s));
    }
  }
  const items = group(signs);
  const out = { items };
  if (debug) out.debug = { signsInResponse: total, a14SignsWithMessages: signs.length, bbox: used, sample: signs.slice(0, 15), allSigns: all };
  return out;
}

function summariseSign(ctrl, st) {
  const ext = st.vmsStatusExtensionG || {};
  const loc = ext.vmsLocation?.locPointLocation || {};
  const c = loc.pointByCoordinates?.pointCoordinates;
  if (!c) return null;
  const lat = +c.latitude, lon = +c.longitude;
  const roads = (loc.supplementaryPositionalDescription?.roadInformation || []).map((r) => r.roadName).filter(Boolean);
  const ident = ext.externalIdentifier || ctrl.vmsControllerReference?.idG || "";
  const onA14 = roads.some((r) => /^A14$/i.test(r.trim())) || /(^|\/)A14\//i.test(ident) || /signs\/A14-/i.test(ident);
  if (!onA14 || distToRouteKm(lat, lon) > 1.5) return null;
  if (st.workingStatus && st.workingStatus !== "working") return null;

  for (const m of st.vmsMessage || []) {
    const msg = m.vmsMessage || {};
    const types = msg.messageInformationType || [];
    const lines = [];
    for (const da of msg.displayAreaSettings || []) {
      const tl = da.displayAreaSettings?.vmsTextDisplay?.textLine || [];
      tl.slice().sort((a, b) => (a.lineIndex ?? 0) - (b.lineIndex ?? 0))
        .forEach((l) => { const t = String(l.textLine?.textLine ?? "").replace(/\s+/g, " ").trim(); if (t) lines.push(t.toUpperCase()); });
    }
    if (!lines.length) continue;
    const text = lines.join(" ");
    const onlySkippable = types.length && types.every((t) => SKIP_TYPES.has(t));
    if (!WORTH.test(text) || (onlySkippable && !/CLOSED|ACCIDENT|INCIDENT|QUEUE/.test(text)) || /\bMINS?\b/.test(text) && !/CLOSED|ACCIDENT|INCIDENT/.test(text)) continue;
    const dirRaw = loc.supplementaryPositionalDescription?.supplementaryPositionalDescriptionExtensionG?.direction || "";
    return { ident, lat, lon, lines, text, setAt: msg.timeLastSet || null,
      direction: /east/i.test(dirRaw) ? "Eastbound" : /west/i.test(dirRaw) ? "Westbound" : null };
  }
  return null;
}

// Signs in a row usually show the same message: merge them into one list item.
function group(signs) {
  const byKey = new Map();
  for (const s of signs) {
    const k = `${s.text}|${s.direction || ""}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  const items = [];
  for (const [k, list] of byKey) {
    const idx = list.map((s) => nearestJunctionIndex(s.lat, s.lon));
    const lo = Math.min(...idx), hi = Math.max(...idx);
    const jLo = JUNCTIONS[lo], jHi = JUNCTIONS[hi];
    const t = list[0].text;
    const severity = /ACCIDENT|COLLISION|CRASH/.test(t) ? "accident"
      : /CLOSED/.test(t) && !/LANES? CLOSED|LANE \d|HARD SHOULDER|SLIP ROAD CLOSED/.test(t) ? "closure"
      : /LANES? CLOSED|LANE \d/.test(t) ? "lanes" : "incident";
    const updated = list.map((s) => s.setAt).filter(Boolean).sort().pop() || null;
    items.push({
      id: "sign-" + hash(k), kind: "sign", category: "sign", severity, live: true,
      title: list[0].lines.join(" · "), lines: list[0].lines,
      location: list.length === 1 ? `Overhead sign near J${jLo[0]} ${jLo[3]}` : (lo === hi ? `${list.length} overhead signs near J${jLo[0]} ${jLo[3]}` : `${list.length} overhead signs between J${jLo[0]} and J${jHi[0]}`),
      direction: list.every((s) => s.direction === list[0].direction) ? list[0].direction : null,
      fromJ: jLo[0], toJ: jHi[0],
      orwell: list.some((s) => km(s.lat, s.lon, ORWELL.lat, ORWELL.lon) <= ORWELL.radiusKm + 1.5) || /ORWELL/.test(t),
      updated, start: updated, end: null,
      marks: list.map((s) => [s.lat, s.lon]), signIds: list.map((s) => s.ident),
    });
  }
  const rank = { closure: 0, accident: 1, incident: 2, lanes: 3 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// Debug view of every sign returned: where it is, what it shows, and whether the app kept it.
function rawView(ctrl, st, kept) {
  const ext = st.vmsStatusExtensionG || {}, loc = ext.vmsLocation?.locPointLocation || {};
  const c = loc.pointByCoordinates?.pointCoordinates || {};
  const text = (st.vmsMessage || []).flatMap((m) => (m.vmsMessage?.displayAreaSettings || []).flatMap((d) =>
    (d.displayAreaSettings?.vmsTextDisplay?.textLine || []).map((l) => l.textLine?.textLine).filter(Boolean))).join(" / ");
  return { ident: ext.externalIdentifier || ctrl.vmsControllerReference?.idG, roads: (loc.supplementaryPositionalDescription?.roadInformation || []).map((r) => r.roadName),
    kmFromRoute: c.latitude ? +distToRouteKm(+c.latitude, +c.longitude).toFixed(2) : null, status: st.workingStatus || null,
    types: (st.vmsMessage || []).flatMap((m) => m.vmsMessage?.messageInformationType || []), text: text || null, kept };
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }
