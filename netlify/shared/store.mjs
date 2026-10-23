// Fetch everything for the A14 (closures + overhead signs) and keep a rolling 24-hour record of accidents in Netlify Blobs.

import { getStore } from "./vendor/blobs/main.js"; // @netlify/blobs 8.2.0, vendored so no install step is needed
import { getClosures, thin } from "./closures.mjs";
import { getSigns } from "./signs.mjs";

const DAY = 24 * 3600e3;
const HISTORY_KEY = "accidents-24h";

export function apiKeys() {
  const env = (k) => globalThis.Netlify?.env?.get?.(k) || process.env[k];
  const key = env("NH_API_KEY");
  return { key, signsKey: env("NH_DVMS_KEY") || key };
}

export async function refresh({ debug = false } = {}) {
  const { key, signsKey } = apiKeys();
  if (!key) { const e = new Error("The server has no National Highways API key. Add NH_API_KEY in Netlify environment variables and redeploy."); e.code = "missing_key"; throw e; }
  const now = new Date();
  const [c, s] = await Promise.allSettled([getClosures(key, now, debug), getSigns(signsKey, debug)]);
  if (c.status === "rejected" && s.status === "rejected") throw new Error(`${c.reason.message} · ${s.reason.message}`);

  const warnings = [];
  if (c.status === "fulfilled") warnings.push(...c.value.warnings); else warnings.push(c.reason.message);
  let signsStatus = "ok";
  if (s.status === "rejected") {
    signsStatus = /HTTP 40[13]/.test(s.reason.message) ? "not_subscribed" : "error";
    warnings.push(s.reason.message);
  }
  const snap = {
    ok: true, fetchedAt: now.toISOString(), source: "National Highways",
    events: c.status === "fulfilled" ? c.value.events : [],
    signs: s.status === "fulfilled" ? s.value.items : [],
    closuresStatus: c.status === "fulfilled" ? "ok" : "error",
    signsStatus, warnings,
  };
  if (debug) snap.debug = { closures: c.value?.debug, signs: s.value?.debug };

  try { snap.history = await recordAccidents(snap, now); snap.historyStatus = "ok"; }
  catch (e) { snap.history = []; snap.historyStatus = "unavailable"; warnings.push(`history: ${e.message}`); }
  return snap;
}

// Accidents from either source are added or refreshed; anything not seen for 24 hours is dropped.
async function recordAccidents(snap, now) {
  const store = getStore("a14-live");
  const saved = (await store.get(HISTORY_KEY, { type: "json" })) || { items: {} };
  const t = now.toISOString();
  const seen = [
    ...snap.events.filter((e) => e.category === "accident" && e.live).map((e) => ({ ...e, source: "National Highways closure" })),
    ...snap.signs.filter((s) => s.severity === "accident").map((s) => ({ ...s, source: "Overhead sign" })),
  ];
  for (const e of seen) {
    const prev = saved.items[e.id];
    saved.items[e.id] = {
      id: e.id, source: e.source, title: e.title, location: e.location || null, detail: e.detail || null,
      direction: e.direction || null, fromJ: e.fromJ || null, toJ: e.toJ || null, orwell: !!e.orwell,
      points: thin(e.points || [], 30), marks: e.marks || null,
      firstSeen: prev?.firstSeen || (e.start && e.start < t ? new Date(e.start).toISOString() : t),
      lastSeen: t,
    };
  }
  for (const [id, it] of Object.entries(saved.items)) if (now - new Date(it.lastSeen) > DAY) delete saved.items[id];
  saved.checkedAt = t;
  await store.setJSON(HISTORY_KEY, saved);
  return Object.values(saved.items).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
}
