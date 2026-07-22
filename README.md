# TinyTopo

**Turn any place on Earth into a 3D-printable model — entirely in your browser.**

TinyTopo lets you select an area on a map and generates a printable 3D model of the
terrain, buildings, roads, water, and greenery inside it, exported as STL or
multicolor 3MF. No account, no watermark, no backend — everything runs client-side
from open data.

TinyTopo is an open-source spiritual successor to
[Map2Model](https://map2model.com/), the beloved hobby project that was shut down in
June 2026 after its author received legal threats he couldn't afford to fight. This
project exists so that can't happen again: the code is open, the app is a pure static
site, and anyone can fork and redeploy it. See [RESEARCH.md](RESEARCH.md) for the full
history of the original, how it worked, and the phased plan this project follows.

## Data sources

Full details in [docs/SOURCES.md](docs/SOURCES.md).

- **[OpenStreetMap](https://www.openstreetmap.org/copyright)** — buildings, roads,
  water, land use (ODbL)
- **[Overture Maps](https://overturemaps.org/)** — alternative building source (planned)
- **[Mapterhorn](https://mapterhorn.com/)** / **[AWS Terrain
  Tiles](https://registry.opendata.aws/terrain-tiles/)** — elevation
- **[Nominatim](https://nominatim.org/)** — place search

## Status

Alpha. Working today: rectangle selection, place search, terrain with real
relief, extruded buildings (incl. building:part), roads, water, and greenery
as colored layers, Three.js preview, binary STL export, **multicolor 3MF
export** ready for AMS/multi-material filament mapping, and **puzzle mode**
— cut the terrain into interlocking jigsaw pieces, each its own watertight,
printable object. See the phased plan in [RESEARCH.md](RESEARCH.md) for
what's next (Overture source, Manifold booleans, water cutout, puzzle-cut
map-detail layers).

## Develop

```sh
npm install
npm run dev        # Vite dev server on :5173
npm run typecheck
npm run build      # static bundle in dist/
```

## Deploy your own

TinyTopo is a pure static site — that's a design guarantee, not an
implementation detail. Host `dist/` anywhere: GitHub Pages, any web server,
or a USB stick.

The official deployment is GitHub Pages: the
[deploy workflow](.github/workflows/deploy.yml) publishes `main` automatically
— forks get the same free hosting by enabling Pages (Settings → Pages →
Source: GitHub Actions).

A [wrangler.toml](wrangler.toml) is also included for Cloudflare Workers
static assets (`npx wrangler login && npm run deploy`) if you prefer.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). No CLA, ever — contributions are
accepted under the project license with a [DCO](https://developercertificate.org/)
sign-off, so the project can never be relicensed or closed by any single party.

## License

- **Code:** [AGPL-3.0-or-later](LICENSE). Use it, fork it, deploy it — but
  every derivative, including one offered as a network service, must publish
  its source under the same terms. TinyTopo can be copied; it cannot be taken
  private.
- **Documentation** (README, RESEARCH.md): [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Trademark

"TinyTopo" identifies this project and its official deployments. The AGPL
grants no trademark rights: forks are welcome and encouraged, but public
deployments of modified versions should use a different name.
