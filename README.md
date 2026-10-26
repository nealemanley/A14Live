# A14 Live · Suffolk

Live incidents, accidents, lane closures and road closures on the A14 from Newmarket (J37) to Felixstowe (J62), including the Orwell Bridge. Tap any item in the list to highlight it on the map.

## What's in the folder

- `index.html` – the app: Live (list, filters, Orwell Bridge status, map, "Open in Waze / Google Maps" links), Accidents (last 24 hours), Waze (official Waze live map) and Local (Suffolk Constabulary posts) tabs
- `netlify/functions/a14.mjs` – the page's data endpoint: closures, overhead sign messages and the 24-hour accident list (cached for 90 seconds)
- `netlify/functions/poll.mjs` – runs every 5 minutes on its own so accidents are recorded even when nobody has the page open
- `netlify/functions/route.mjs` – the A14's real shape and junction positions from OpenStreetMap (cached for a week)
- `netlify/shared/` – the code that reads the National Highways feeds and keeps the accident record (stored in Netlify Blobs)
- `netlify/shared/vendor/blobs/` – Netlify's storage library (@netlify/blobs 8.2.0), included so drag-and-drop deploys need no install step
- `netlify.toml` – Netlify settings

## Set it up (about 10 minutes)

1. **Get a free API key.** Sign up at https://developer.data.nationalhighways.co.uk, go to Subscriptions, subscribe to **Road and Lane Closures** and **Digital Variable Message Signs**, then copy your key from your Profile page. If the signs subscription gives you a different key, add it as `NH_DVMS_KEY` as well.
2. **Deploy to Netlify.** Link this GitHub repository to the Netlify site (Project configuration → Build & deploy → Link repository). Every push to `main` then deploys automatically.
3. **Add the key.** In Netlify: Site configuration → Environment variables → add `NH_API_KEY` with your key.
4. **Redeploy** (Deploys → Trigger deploy). Open the site and the list fills with live data.

To preview the design without a key, open the site with `#sample` on the end of the address. Sample data is clearly marked and is never mixed with live data.

## Notes

- The National Highways API allows 10 calls a minute. The shared 90-second cache plus the 5-minute background check stay well inside that however many people use the page.
- The 24-hour accident list only knows about accidents seen since it was switched on, and only those National Highways records as an accident (in a closure or on an overhead sign).
- To see everything the feed currently says about the A14 (including records the app filtered out, and why), open `/api/a14?debug=1` on your site. The parser follows the official Road and Lane Closures v2 OpenAPI spec.
- Junction positions are approximate. Local council roadworks (for example on slip-road roundabouts run by Suffolk County Council) are not in the National Highways feed.
