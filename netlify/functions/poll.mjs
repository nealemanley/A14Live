// A14 Live — scheduled check every 5 minutes, so accidents are recorded for the 24-hour list even when nobody has the page open.

import { refresh } from "../shared/store.mjs";

export default async () => {
  try {
    const snap = await refresh();
    console.log(`poll ok: ${snap.events.length} closures, ${snap.signs.length} sign messages, ${snap.history.length} accidents in 24h`);
  } catch (e) {
    console.log(`poll failed: ${e.message}`);
  }
};

export const config = { schedule: "*/5 * * * *" };
