import './style.css';
import * as THREE from 'three';
import { Bounds, ModelSpace, widthMeters, heightMeters } from './geo';
import { loadDem } from './elevation';
import { fetchBuildings } from './overpass';
import { sampleGrid, buildTerrain } from './geometry/terrain';
import { buildBuildings } from './geometry/buildings';
import { Preview } from './preview';
import { downloadStl } from './export/stl';
import { createMap, setupSearch } from './map';

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
    const wantBuildings = el<HTMLInputElement>('#opt-buildings').checked;

    const wM = widthMeters(bounds);
    const hM = heightMeters(bounds);
    if (wM < 50 || hM < 50) throw new Error('Selection is too small — draw a bigger rectangle.');
    if (wM > 60000 || hM > 60000) throw new Error('Selection is too large — keep it under ~60 km.');
    if (wantBuildings && (wM > 6000 || hM > 6000)) {
      throw new Error('Buildings need a selection under ~6 km — shrink it or untick Buildings.');
    }

    setStatus('Fetching elevation…');
    const dem = await loadDem(bounds);

    let buildingFeatures = null;
    if (wantBuildings) {
      setStatus('Fetching buildings from OpenStreetMap…');
      buildingFeatures = await fetchBuildings(bounds);
    }

    setStatus('Building terrain…');
    const depthMm = (hM / wM) * widthMm;
    const grid = sampleGrid(bounds, dem, widthMm, depthMm);
    const space = new ModelSpace(bounds, widthMm, zFactor, baseMm, grid.minElevation);
    const terrain = buildTerrain(grid, space);

    let buildings: THREE.BufferGeometry | null = null;
    if (buildingFeatures && buildingFeatures.length > 0) {
      setStatus(`Extruding ${buildingFeatures.length} buildings…`);
      buildings = buildBuildings(buildingFeatures, bounds, space, dem);
    }

    preview.show(terrain, buildings);
    previewEmpty.hidden = true;
    exportGeometries = buildings ? [terrain, buildings] : [terrain];
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
  // Debug hook for tests: window.__tinytopo.stl() returns the export bytes.
  (window as unknown as Record<string, unknown>).__tinytopo = {
    stl: async () => {
      const { toBinaryStl } = await import('./export/stl');
      return toBinaryStl(exportGeometries);
    },
  };
}
