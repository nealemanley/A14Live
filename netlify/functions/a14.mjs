// A14 Live — the page's data endpoint. Returns closures, overhead sign messages and the last 24 hours of accidents.
// Set NH_API_KEY in Netlify (Site configuration → Environment variables). Optional NH_DVMS_KEY if your signs key differs.

import { refresh } from "../shared/store.mjs";

export default async (req) => {
  const debug = new URL(req.url).searchParams.get("debug") === "1";
  try {
    const snap = await refresh({ debug });
    return json(snap, 200, debug ? 0 : 90);
  } catch (e) {
    return json({ ok: false, error: e.code || "upstream", message: e.message }, e.code === "missing_key" ? 500 : 502, 0);
  }
};

function json(obj, status, maxAge) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // One shared cache for every visitor keeps calls well inside National Highways' 10-per-minute limit.
      "Netlify-CDN-Cache-Control": maxAge ? `public, durable, s-maxage=${maxAge}, stale-while-revalidate=60` : "no-store",
      "Cache-Control": "no-cache",
    },
  });
}

export const config = { path: "/api/a14" };
