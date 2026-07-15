# Contributing to TinyTopo

Thanks for helping bring printable maps back to the world. Contributions of all
kinds are welcome — code, docs, test prints, bug reports, data-source expertise.

## Ground rules

- **License:** all contributions are made under
  [AGPL-3.0-or-later](LICENSE), the same license as the project. There is no
  CLA and there never will be one. Copyright stays with each contributor,
  which means no single party — including the maintainer — can ever relicense
  or close this project without the consent of everyone who built it. That is
  by design.
- **Sign your work (DCO):** every commit must carry a `Signed-off-by` line
  certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

  ```
  Signed-off-by: Your Name <you@example.com>
  ```

  Add it automatically with `git commit -s`. By signing off you certify that
  you wrote the contribution or otherwise have the right to submit it under
  the project's license.
- **Keep it printable:** geometry changes should be validated against real
  slicers (PrusaSlicer / Bambu Studio / Cura). Watertight, manifold output is
  a hard requirement.
- **Keep it static:** TinyTopo is a pure client-side app. Changes that require
  a mandatory backend will not be accepted; optional self-hostable proxies are
  fine.
- **Respect data licenses:** OpenStreetMap (ODbL), Overture, Mapterhorn, AWS
  Terrain Tiles, and Nominatim all have attribution and usage requirements.
  Any new data source must be open and its attribution wired into the UI and
  exports before merge.

## Name and forks

The TinyTopo name and logo identify *this* project. Forks are not just
permitted but part of the survival plan — however, if you operate a public
deployment of a modified version, please run it under a different name so
users know whose build they're trusting.
