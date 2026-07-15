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

- **[OpenStreetMap](https://www.openstreetmap.org/copyright)** — buildings, roads,
  water, land use (ODbL)
- **[Overture Maps](https://overturemaps.org/)** — alternative building source (planned)
- **[Mapterhorn](https://mapterhorn.com/)** / **[AWS Terrain
  Tiles](https://registry.opendata.aws/terrain-tiles/)** — elevation
- **[Nominatim](https://nominatim.org/)** — place search

## Status

Pre-alpha. Currently: research and planning. See the phased plan in
[RESEARCH.md](RESEARCH.md).

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
