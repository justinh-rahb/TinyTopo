import './style.css';
import * as THREE from 'three';
import { Bounds, ModelSpace, widthMeters, heightMeters } from './geo';
import { loadDem } from './elevation';
import { fetchMapFeatures, MapFeatures } from './overpass';
import { sampleGrid, buildTerrain } from './geometry/terrain';
import { buildBuildings } from './geometry/buildings';
import {
  buildPolygonOverlay,
  buildRoadOverlay,
  ROAD_STYLE,
  WATER_STYLE,
  GREEN_STYLE,
} from './geometry/overlays';
import { Preview, PreviewItem } from './preview';
import { downloadStl } from './export/stl';
import { createMap, setupSearch } from './map';

const COLORS = {
  terrain: 0x9a9080,
  buildings: 0xe8e4da,
  roads: 0x4f4a45,
  water: 0x4f81ad,
  green: 0x7aa05e,
};

const el = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const btnGenerate = el<HTMLButtonElement>('#btn-generate');
const btnDownload = el<HTMLButtonElement>('#btn-download');
const status = el<HTMLSpanElement>('#status');
const mapHint = el<HTMLDivElement>('#map-hint');
const previewEmpty = el<HTMLDivElement>('#preview-empty');

let selection: Bounds | null = null;
let exportGeometries: THREE.BufferGeometry[] = [];
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

  try {
    const widthMm = Number(el<HTMLInputElement>('#opt-width').value) || 120;
    const zFactor = Number(el<HTMLInputElement>('#opt-zscale').value) || 1.5;
    const baseMm = Number(el<HTMLInputElement>('#opt-base').value) || 4;
    const layers = {
      buildings: checked('#opt-buildings'),
      roads: checked('#opt-roads'),
      water: checked('#opt-water'),
      green: checked('#opt-green'),
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
    const items: PreviewItem[] = [{ geometry: buildTerrain(grid, space), color: COLORS.terrain }];

    if (features) {
      const add = (geometry: THREE.BufferGeometry | null, color: number) => {
        if (geometry) items.push({ geometry, color });
      };
      if (layers.green) {
        setStatus(`Draping ${features.green.length} green areas…`);
        add(buildPolygonOverlay(features.green, bounds, space, dem, GREEN_STYLE), COLORS.green);
      }
      if (layers.water) {
        setStatus(`Draping ${features.water.length} water bodies…`);
        add(buildPolygonOverlay(features.water, bounds, space, dem, WATER_STYLE), COLORS.water);
      }
      if (layers.roads) {
        setStatus(`Buffering ${features.roads.length} roads…`);
        add(buildRoadOverlay(features.roads, bounds, space, dem, ROAD_STYLE), COLORS.roads);
      }
      if (layers.buildings) {
        setStatus(`Extruding ${features.buildings.length} buildings…`);
        add(buildBuildings(features.buildings, bounds, space, dem), COLORS.buildings);
      }
    }

    preview.show(items);
    previewEmpty.hidden = true;
    exportGeometries = items.map((i) => i.geometry);
    btnDownload.disabled = false;

    const tris = exportGeometries.reduce((n, g) => n + g.getAttribute('position').count / 3, 0);
    setStatus(
      `Done — ${space.widthMm.toFixed(0)}×${space.depthMm.toFixed(0)} mm, ` +
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
  if (exportGeometries.length > 0) downloadStl(exportGeometries, 'tinytopo.stl');
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
      return toBinaryStl(exportGeometries);
    },
  };
}
