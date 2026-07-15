# Map2Model: Research & Revival Plan

*The revival project described in §4–§6 is named **TinyTopo** (see README.md).*

*Research compiled 2026-07-15 from Wayback Machine captures of map2model.com (including
deminified JS bundles from June 2025 and June 2026), press coverage, and the successor
site map2model.de.*

## 1. What the original was

**Map2Model** (map2model.com) was a free, browser-based tool by the maker known as
**Smoggy3D** ([MakerWorld profile](https://makerworld.com/en/@Smoggy3D)). You drew a
rectangle, circle, or polygon on a map and it generated a 3D-printable model of
everything inside — terrain relief, extruded buildings, roads, railways, water, and
green areas — exported as STL or multicolor 3MF (separate objects per category, ideal
for Bambu AMS multicolor printing). Everything ran client-side; no account, no
watermark, free.

Timeline:

- **2025-06-09** — v0.1.0 initial release. Iterated extremely fast (v0.1.5 by 2025-06-11:
  project saving, water base, railways, golf courses, runways, camping sites).
- **2025–2026** — grew popular; monetized via BuyMeACoffee, Google AdSense, and a
  **Patreon-based commercial license** (personal use free; commercial use of exported
  meshes required a Patreon subscription). Gained a **MakerWorld MakerLab embed mode**
  (the app detected being iframed with an `appId` query param).
- **June 2026** — shut down. The site was still fully live on 2026-06-03 (Wayback), and
  the shutdown notice was captured by 2026-06-25. So this happened weeks ago.

## 2. Why it shut down

From the shutdown notice (still live at [map2model.com](https://map2model.com/)):

> "I recently received legal notices concerning certain aspects of the tool. As
> Map2Model has always been a small personal hobby project, I am not in a position to
> take on a legal dispute."

Press coverage ([Fabbaloo](https://www.fabbaloo.com/news/3d-printable-map-service-map2model-shuts-down-after-legal-notices),
[3Druck](https://3druck.com/en/programs/map2model-offline-3d-printing-map-service-discontinued-due-to-legal-notices-37159804/))
adds the key detail: **the claims were about *design rights*, not map-data licensing**.
Someone asserted that 3D map models the tool could produce might infringe registered
designs they hold. The data sources were open and properly attributed — your instinct
that "it used public information" was correct; that was never the issue.

The claimant has not been publicly named. The category of likely claimant is a
commercial vendor of 3D-printed city-map art (several exist, especially in Germany/EU
where registered designs — *Geschmacksmuster* — plus the *Abmahnung* (cease-and-desist
with fee demand) culture make this kind of threat cheap to send and expensive to fight).
A hobbyist with a single point of failure (one person, one domain, one Cloudflare
account, ad revenue = commercial activity) rationally folded rather than litigate.
**Nothing in the public record says a court ever found infringement.**

The shutdown page lists alternatives: MiniSkyline, TerraPrinter, TrailPrint3D, Topo
Trail, TouchTerrain, Touch Mapper, Terrain2STL, Blosm for Blender — note that almost
all of these are *terrain-only*. The buildings+city-model niche is what Map2Model owned.

An independent, unaffiliated rebuild already exists at
[map2model.de](https://www.map2model.de/) ("carries the idea forward", not affiliated
with Smoggy3D). It is a closed-source Next.js app on Vercel using the same recipe
(OSM + Mapterhorn + Esri). It is subject to the exact same single-operator legal
pressure that killed the original.

## 3. How it worked (from the recovered bundles)

Fully client-side SPA — **Vue 3 + Vite**. Model generation happened entirely in the
browser; the site had no backend of its own.

| Concern | Implementation |
|---|---|
| Map UI / area select | Leaflet + leaflet-geoman (rect/square/circle/polygon draw, edit, drag, rotate) |
| Geocoding search | Nominatim public API (`nominatim.openstreetmap.org/search`) |
| Basemaps | OSM raster tiles (.org/.de/.fr) + Esri World Imagery satellite tiles |
| Buildings/roads/landuse (v0.1, 2025) | **Overpass API** (`overpass-api.de/api/interpreter`), one big query → osmtogeojson-style conversion in browser |
| Buildings/roads/landuse (2026) | Switched to **vector tiles (MVT)** with a user-selectable source: **OpenStreetMap or Overture Maps** (with Overture min-zoom / min-quality settings) |
| Elevation (added post-launch) | **Mapterhorn** webp terrain tiles (512px, `tiles.mapterhorn.com`) or **AWS Terrain Tiles** (Mapzen terrarium PNGs, `s3.amazonaws.com/elevation-tiles-prod`), plus Mapterhorn coverage/attribution JSON and a bundled footprints GeoJSON for per-region attribution |
| Geometry engine | Three.js (ExtrudeGeometry for building extrusion, WebGLRenderer preview); **Turf.js running in web workers** — a `buffer.worker` (buffering road/rail/runway centerlines into printable polygons) and an `intersect.worker` (clipping features to the selection, water cutouts) |
| Features handled | buildings + `building:part` + multipolygon relations, roof shapes (incl. dome/onion), highways/aeroways/railways/runways, water bodies with cutout & water-base options, parks/grass/meadow/forest/scrub, golf courses, pitches, camp sites, GPX track import |
| Export | Binary STL (merged) and **3MF via JSZip** with separate colored objects (terrain, buildings, roads, water, greenery) |
| Persistence | Project saving (local) |

The original Overpass query (recovered from the June 2025 bundle):

```
[out:json][timeout:30];
(
  way["building"]({{bbox}});
  relation["building"]["type"="multipolygon"]({{bbox}});
  way["building:part"]({{bbox}});
  relation["building:part"]["type"="multipolygon"]({{bbox}});
  way[~"^(highway|aeroway|railway)$"~"."]({{bbox}});
  relation[~"^(aeroway|railway)$"~"."]({{bbox}});
  way[~"^(leisure|landuse|natural)$"~"^(park|garden|grass|meadow|recreation_ground|forest|wood|grassland|scrub|golf_course|pitch)$"]({{bbox}});
  relation[~"^(leisure|landuse|natural)$"~"^(park|garden|grass|meadow|...)$"]({{bbox}});
  way["tourism"~"^(camp_site|caravan_site)$"]({{bbox}});
  relation["tourism"~"^(camp_site|caravan_site)$"]["type"="multipolygon"]({{bbox}});
  way[~"^(natural|water|waterway|leisure)$"~"^(water|sea|bay|...)$"]({{bbox}});
  ...
);
```

All data sources are free/open:

- **OpenStreetMap** — ODbL; attribution required. Overpass public instances have
  fair-use limits (why the original moved to vector tiles).
- **Overture Maps** — buildings layer under permissive licensing (CDLA-Permissive-2.0 /
  ODbL for OSM-derived parts); distributed as GeoParquet and PMTiles releases.
- **Mapterhorn** — open terrain tiles (Swisstopo-led), attribution JSON provided.
- **AWS Terrain Tiles (Mapzen terrarium)** — free open dataset on the AWS Open Data
  program.
- **Nominatim** — public instance with usage policy (1 req/s, attribution).
- **Esri World Imagery** — the one *non-open* piece; used only as a display basemap.
  A rebuild can swap this or keep it within Esri's free-tier terms.

## 4. Why "bring it back" needs a different shape, not just a clone

The original didn't die from technology or licensing — it died because **one hobbyist
was the single point of failure** against a legal threat that was never adjudicated.
map2model.de is repeating that shape (closed source, one operator). The resilient way
to bring this back:

1. **Open source the whole thing** (the original and .de are both closed). A permissive
   or copyleft repo on GitHub means a C&D against any one deployment kills nothing —
   anyone can `git clone` and redeploy. Distribution is the defense.
2. **Pure static site** — no backend, all generation in-browser (exactly like the
   original). It can be hosted on GitHub Pages/Cloudflare Pages, mirrored, self-hosted,
   or run from `file://`. Cheap to run, trivial to fork-and-host.
3. **Keep the tool generic.** A registered design protects a *specific product
   appearance* (e.g., a particular framed city-map cube with distinctive styling), not
   the idea of 3D-printed maps. Ship neutral default styles, don't imitate any
   commercial product's trade dress, don't ship presets named after or resembling
   specific commercial products, and put an IP-complaint policy in the repo.
4. **Don't monetize the hosted instance** (at least initially). Ads/Patreon on the
   original made it look like a commercial competitor. A free OSS tool with donations
   to the *project* changes the picture. (Not legal advice; if this grows, a brief
   consult with an IP attorney familiar with EU design law is cheap insurance.)

## 5. Proposed architecture

Static SPA, everything client-side, web workers for heavy geometry.

```
┌─ UI ──────────────────────────────────────────────┐
│ MapLibre GL JS (or Leaflet+geoman) — area select   │
│ Nominatim search · OSM/Esri basemaps               │
│ Three.js preview pane · options panel              │
└──────────────┬─────────────────────────────────────┘
               │ selection polygon + options
┌─ Data layer ─▼─────────────────────────────────────┐
│ Buildings/roads/water/green:                       │
│   MVP: Overpass API → GeoJSON                      │
│   v2: PMTiles/MVT (Protomaps OSM build, Overture)  │
│ Elevation: Mapterhorn webp / AWS terrarium PNG     │
└──────────────┬─────────────────────────────────────┘
┌─ Geometry workers ─▼───────────────────────────────┐
│ clip to selection (turf) · buffer linear features  │
│ terrain grid from DEM + vertical exaggeration      │
│ extrude buildings (height / levels×3m / roofs)     │
│ drape flats · base plinth · manifold union         │
│   (Manifold WASM for robust booleans)              │
└──────────────┬─────────────────────────────────────┘
┌─ Export ─────▼─────────────────────────────────────┐
│ Binary STL (merged) · 3MF (JSZip, object-per-color │
│ for AMS multicolor) · project save (localStorage)  │
└────────────────────────────────────────────────────┘
```

Suggested stack: **Vite + TypeScript**, framework of choice (original was Vue 3),
Three.js, Turf.js, earcut, Manifold (WASM) for watertight booleans — a genuine upgrade
over the original, which reportedly had occasional non-manifold output.

## 6. Phased plan

**Phase 0 — scaffold (a day):** Vite+TS repo, CI → static hosting, map with rectangle
select, Nominatim search.

**Phase 1 — MVP (the "it's back" moment):** rectangle select → fetch Overpass +
terrarium tiles → terrain mesh + extruded buildings on a plinth → Three.js preview →
binary STL export. Correct ODbL/attribution page from day one.

**Phase 2 — parity:** roads/rail/water/green as separate colored bodies; 3MF multicolor
export; polygon/circle/rotated select; water cutout + water base; `building:part` and
roof shapes; project saving; scale/size controls (print bed presets); GPX track overlay.

**Phase 3 — beyond the original:** PMTiles/Overture source toggle (removes Overpass
rate-limit dependency); Manifold-guaranteed watertight output; deep-link/share a
selection; optional self-hostable tile+geocode proxy config; i18n; embed mode.

## 7. Infrastructure

Primary deployment on **Cloudflare**, treated as disposable. The repo — not the
deployment — is the canonical artifact.

**Free-tier fit:**

- **Static hosting (Workers static assets / Pages)** — the app is a static bundle
  and Cloudflare's free plan has *unmetered bandwidth*, so a traffic spike costs
  nothing. Deploy from the GitHub repo via `wrangler`; per-branch preview
  deployments included.
- **Workers (100k req/day free)** — Phase 3's *optional* caching proxy in front of
  Nominatim and Overpass, to respect their public usage policies (~1 req/s). The
  Cache API keeps popular selections (everyone prints Manhattan and the
  Matterhorn) from re-hitting upstreams.
- **R2** — for Phase 3 self-hosted **PMTiles** (a single static file queried via
  HTTP range requests — no tile server). Zero egress fees to the CDN. Reality
  check: free tier is 10GB; a planet-scale OSM/Overture buildings build is
  100GB+, i.e. ~$2–3/month in storage *if* we outgrow Protomaps' public builds.
- **DNS + domain** for tinytopo.com at cost.

Phases 0–2 need **no infrastructure at all** beyond static hosting: Overpass,
Mapterhorn, AWS terrain tiles, and Nominatim are all called directly from the
browser.

**The caveat, on the record:** the original Map2Model also ran on Cloudflare — 
visible in the archived pages — and it didn't help, because the attack was a
legal letter to the human, not a packet to the infrastructure. A single
Cloudflare account is itself a takedown target (a complaint to the host is the
standard playbook). Survival comes from the repo, not the host:

1. `wrangler.toml` and deploy docs live in the repo so anyone can stand up a
   mirror in minutes.
2. The app must always work with zero Cloudflare dependencies — deployable to
   GitHub Pages or served from a local `dist/` with no Workers present
   (CONTRIBUTING.md's "static-first, optional proxies" rule guarantees this).
3. The official deployment is replaceable; the project is not.

## 8. Sources

- [Fabbaloo — Map2Model Shuts Down After Legal Notices](https://www.fabbaloo.com/news/3d-printable-map-service-map2model-shuts-down-after-legal-notices)
- [3Druck — Map2Model offline: discontinued after legal notices](https://3druck.com/en/programs/map2model-offline-3d-printing-map-service-discontinued-due-to-legal-notices-37159804/)
- [map2model.com shutdown notice](https://map2model.com/)
- [map2model.de (unaffiliated successor) — About](https://www.map2model.de/about)
- [Fabbaloo — Map2Model Offers Accessible Way to Generate Cityscapes](https://www.fabbaloo.com/news/map2model-offers-accessible-way-to-generate-cityscapes-for-3d-printing)
- Wayback Machine captures of map2model.com JS bundles (2025-06-11, 2026-06-03),
  including `buffer.worker`, `intersect.worker`, changelog, about, and commercial
  license chunks.
