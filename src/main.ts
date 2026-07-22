import './style.css';
import * as THREE from 'three';
import { Bounds, ModelSpace, widthMeters, heightMeters } from './geo';
import { loadDem } from './elevation';
import { fetchMapFeatures, MapFeatures } from './overpass';
import { sampleGrid, buildTerrain, buildBase } from './geometry/terrain';
import { buildBuildings } from './geometry/buildings';
import {
  buildPolygonOverlay,
  buildRoadOverlay,
  mergeSoups,
  ROAD_STYLE,
  WATER_STYLE,
  GREEN_STYLE,
} from './geometry/overlays';
import { Preview } from './preview';
import { downloadStl } from './export/stl';
import { downloadThreeMf, NamedBody } from './export/threeMf';
import { createMap, setupSearch } from './map';
import { buildPuzzlePieces, fitPuzzleGrid } from './geometry/puzzle';

const COLORS = {
  base: 0x3d3a36,
  terrain: 0x9a9080,
  buildings: 0xe8e4da,
  roads: 0x4f4a45,
  water: 0x4f81ad,
  green: 0x7aa05e,
};

const el = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const btnGenerate = el<HTMLButtonElement>('#btn-generate');
const btnDownload = el<HTMLButtonElement>('#btn-download');
const btnDownload3mf = el<HTMLButtonElement>('#btn-download-3mf');
const status = el<HTMLSpanElement>('#status');
const mapHint = el<HTMLDivElement>('#map-hint');
const previewEmpty = el<HTMLDivElement>('#preview-empty');

// Puzzle mode replaces Base+Terrain with cut pieces; map-detail layers
// aren't cut into pieces yet, so they're forced off while it's active.
const puzzleCheckbox = el<HTMLInputElement>('#opt-puzzle');
const puzzleColsInput = el<HTMLInputElement>('#opt-puzzle-cols');
const puzzleRowsInput = el<HTMLInputElement>('#opt-puzzle-rows');
const layerCheckboxIds = ['#opt-buildings', '#opt-roads', '#opt-water', '#opt-green'];
puzzleCheckbox.addEventListener('change', () => {
  const on = puzzleCheckbox.checked;
  puzzleColsInput.disabled = !on;
  puzzleRowsInput.disabled = !on;
  for (const id of layerCheckboxIds) {
    const input = el<HTMLInputElement>(id);
    input.disabled = on;
    if (on) input.checked = false;
  }
});

let selection: Bounds | null = null;
let exportBodies: NamedBody[] = [];
let generating = false;

const mapController = createMap(el('#map'), (bounds) => {
  selection = bounds;
  btnGenerate.disabled = bounds === null || generating;
  mapHint.hidden = bounds !== null;
});
setupSearch(mapController);

const preview = new Preview(el<HTMLCanvasElement>('#preview'));

function setStatus(text: string): void {
  status.textContent = text;
}

const checked = (id: string): boolean => el<HTMLInputElement>(id).checked;

async function generate(): Promise<void> {
  if (!selection || generating) return;
  const bounds = selection;
  generating = true;
  btnGenerate.disabled = true;
  btnDownload.disabled = true;
  btnDownload3mf.disabled = true;

  try {
    const widthMm = Number(el<HTMLInputElement>('#opt-width').value) || 120;
    const zFactor = Number(el<HTMLInputElement>('#opt-zscale').value) || 1.5;
    const baseMm = Number(el<HTMLInputElement>('#opt-base').value) || 4;
    const puzzleOn = puzzleCheckbox.checked;
    const layers = {
      buildings: !puzzleOn && checked('#opt-buildings'),
      roads: !puzzleOn && checked('#opt-roads'),
      water: !puzzleOn && checked('#opt-water'),
      green: !puzzleOn && checked('#opt-green'),
    };
    const wantDetails = Object.values(layers).some(Boolean);

    const wM = widthMeters(bounds);
    const hM = heightMeters(bounds);
    if (wM < 50 || hM < 50) throw new Error('Selection is too small — draw a bigger rectangle.');
    if (wM > 60000 || hM > 60000) throw new Error('Selection is too large — keep it under ~60 km.');
    if (wantDetails && (wM > 6000 || hM > 6000)) {
      throw new Error('Map details need a selection under ~6 km — shrink it or untick the detail layers.');
    }

    setStatus('Fetching elevation…');
    const dem = await loadDem(bounds);

    let features: MapFeatures | null = null;
    if (wantDetails) {
      setStatus('Fetching map data from OpenStreetMap…');
      features = await fetchMapFeatures(bounds);
    }

    setStatus('Building terrain…');
    const depthMm = (hM / wM) * widthMm;
    const grid = sampleGrid(bounds, dem, widthMm, depthMm);
    const space = new ModelSpace(bounds, widthMm, zFactor, baseMm, grid.minElevation);

    let bodies: NamedBody[];
    if (puzzleOn) {
      const requestedCols = Number(puzzleColsInput.value) || 3;
      const requestedRows = Number(puzzleRowsInput.value) || 2;
      const layout = fitPuzzleGrid(space.widthMm, space.depthMm, requestedCols, requestedRows);
      setStatus(`Cutting ${layout.cols}×${layout.rows} puzzle pieces…`);
      bodies = buildPuzzlePieces(bounds, space, dem, grid, layout).map((p) => ({
        name: `Piece ${p.row + 1}-${p.col + 1}`,
        geometry: p.geometry,
        color: COLORS.terrain,
      }));
      if (layout.cols !== requestedCols || layout.rows !== requestedRows) {
        puzzleColsInput.value = String(layout.cols);
        puzzleRowsInput.value = String(layout.rows);
      }
    } else {
      bodies = [
        { name: 'Base', geometry: buildBase(grid, space), color: COLORS.base },
        { name: 'Terrain', geometry: buildTerrain(grid, space), color: COLORS.terrain },
      ];
    }

    if (features) {
      const add = (name: string, geometry: THREE.BufferGeometry | null, color: number) => {
        if (geometry) bodies.push({ name, geometry, color });
      };
      // Water is computed first so greenery can be excluded from its cells
      // (reserves/forests in OSM often contain their lakes), but body order
      // stays stable so filament slot mapping doesn't shift.
      let water = null;
      if (layers.water) {
        setStatus(`Draping ${features.water.length} water bodies…`);
        water = buildPolygonOverlay(features.water, bounds, space, dem, grid, WATER_STYLE);
      }
      if (layers.green) {
        setStatus(`Draping ${features.green.length} green areas…`);
        add(
          'Greenery',
          buildPolygonOverlay(features.green, bounds, space, dem, grid, GREEN_STYLE, water?.mask).geometry,
          COLORS.green,
        );
      }
      if (water) add('Water', water.geometry, COLORS.water);
      if (layers.roads) {
        setStatus(`Buffering ${features.roads.length} roads…`);
        add(
          'Roads',
          mergeSoups(
            buildRoadOverlay(features.roads, bounds, space, dem, ROAD_STYLE),
            buildPolygonOverlay(features.aprons, bounds, space, dem, grid, ROAD_STYLE).geometry,
          ),
          COLORS.roads,
        );
      }
      if (layers.buildings) {
        setStatus(`Extruding ${features.buildings.length} buildings…`);
        add('Buildings', buildBuildings(features.buildings, bounds, space, dem), COLORS.buildings);
      }
    }

    preview.show(bodies);
    previewEmpty.hidden = true;
    exportBodies = bodies;
    btnDownload.disabled = false;
    btnDownload3mf.disabled = false;

    const tris = bodies.reduce((n, b) => n + b.geometry.getAttribute('position').count / 3, 0);
    const pieceNote = puzzleOn ? `, ${bodies.length} pieces` : '';
    setStatus(
      `Done — ${space.widthMm.toFixed(0)}×${space.depthMm.toFixed(0)} mm${pieceNote}, ` +
        `${Math.round(tris).toLocaleString()} triangles (${dem.source})`,
    );
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : 'Generation failed — see console.');
  } finally {
    generating = false;
    btnGenerate.disabled = selection === null;
  }
}

btnGenerate.addEventListener('click', () => void generate());
btnDownload.addEventListener('click', () => {
  if (exportBodies.length > 0) {
    downloadStl(exportBodies.map((b) => b.geometry), 'tinytopo.stl');
  }
});
btnDownload3mf.addEventListener('click', () => {
  if (exportBodies.length === 0) return;
  void (async () => {
    const large = await preview.snapshot(512);
    const small = await preview.snapshot(128);
    await downloadThreeMf(
      exportBodies,
      'tinytopo.3mf',
      large && small ? { large, small } : undefined,
    );
  })();
});

if (import.meta.env.DEV) {
  // Debug hooks for tests: set a selection without the map UI, trigger a
  // build, and read back the export bytes.
  (window as unknown as Record<string, unknown>).__tinytopo = {
    select: (b: Bounds) => {
      selection = b;
      btnGenerate.disabled = generating;
      mapHint.hidden = true;
    },
    generate: () => generate(),
    stl: async () => {
      const { toBinaryStl } = await import('./export/stl');
      return toBinaryStl(exportBodies.map((b) => b.geometry));
    },
    threeMf: async () => {
      const { toThreeMf } = await import('./export/threeMf');
      const large = await preview.snapshot(512);
      const small = await preview.snapshot(128);
      return toThreeMf(exportBodies, large && small ? { large, small } : undefined);
    },
  };
}
