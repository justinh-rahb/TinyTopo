# Where the data comes from

Every byte of a TinyTopo model comes from open, public data, fetched live by
your browser at generate time. Nothing is precomputed and no server of ours
sits in the middle.

## Elevation — the terrain shape

**Primary: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)**
(the Mapzen dataset, hosted free under the AWS Open Data program). It is a
global mosaic assembled from many public DEMs:

| Region | Underlying source | Nominal resolution |
|---|---|---|
| Most of the globe (60°N–56°S) | NASA SRTM shuttle radar | ~30 m |
| United States | USGS 3DEP / NED | ~10 m |
| Arctic | ArcticDEM | varies |
| Europe | EU-DEM | ~25 m |
| Oceans | ETOPO1 bathymetry | coarse |

Tiles use **terrarium encoding**: each PNG pixel stores an elevation as
`(R × 256 + G + B / 256) − 32768` meters. The browser decodes the image on a
canvas and bilinearly samples it — no GIS stack required.

**Fallback: [Mapterhorn](https://mapterhorn.com/)** — a newer open terrain
tileset (Swiss-led), same terrarium encoding in webp. TinyTopo fails over to
it automatically if AWS tiles are unavailable.

TinyTopo picks a tile zoom so your selection spans roughly 500 pixels,
then samples a mesh grid at ~0.4 mm pitch on the printed model.

## Map features — everything on the terrain

**[OpenStreetMap](https://www.openstreetmap.org/copyright)** via the public
[Overpass API](https://overpass-api.de/) (with automatic failover across
community instances):

- **Buildings** — footprints plus `building:part`, heights from `height` or
  `building:levels` tags (3 m per level, 8 m default).
- **Roads & rails** — centerlines buffered by highway class (18 m motorways
  down to 2 m footpaths), honoring mapper-tagged `width=*` where sane.
- **Airports** — `aeroway` runways (45 m default), taxiways (18 m), and apron
  polygons.
- **Water & greenery** — lakes, riverbanks, parks, forests, pitches, golf
  courses, cemeteries, and friends.

You are printing the live state of the map: fix something in OSM and
regenerate.

## Search & basemap

Place search is **[Nominatim](https://nominatim.org/)**, OSM's geocoder. The
slippy map you draw on (OSM raster tiles, Esri imagery in future) is display
only — none of it enters the model.

## Why terrain sites all look alike

Nearly every terrain-printing site samples the same two or three public DEMs
(SRTM, USGS, Copernicus derivatives). The real differences are:

1. **Sampling** — tile zoom and mesh density.
2. **Mesh quality** — TinyTopo audits every exported body to zero open edges.
3. **What's on top** — terrain-only tools (TouchTerrain, Terrain2STL,
   TrailPrint3D) stop at the heightmap; TinyTopo adds the OSM layers as
   separately colorable printable bodies.

## Swappable by design

Elevation already has two interchangeable providers behind one interface, and
[Overture Maps](https://overturemaps.org/) is on the roadmap as an alternative
building source, along with self-hosted PMTiles for the rate-limit-free
future. Adding a provider is a small, well-contained PR — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Licenses & attribution

- OpenStreetMap data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)
- Terrain Tiles courtesy of Mapzen/AWS Open Data; underlying DEMs are U.S.
  Government and partner-agency public data
- Mapterhorn tiles per their [attribution](https://download.mapterhorn.com/attribution.json)
- Search by Nominatim under the OSM usage policy

Models you generate are derived from ODbL data — share-alike applies to the
data layer. For personal printing this costs you nothing; if you build a
product on exported models, read the ODbL first.
