import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import { Bounds } from './geo';

export interface MapController {
  map: L.Map;
  getSelection(): Bounds | null;
  flyTo(bounds: Bounds): void;
}

export function createMap(
  container: HTMLElement,
  onSelectionChange: (bounds: Bounds | null) => void,
): MapController {
  const map = L.map(container, { zoomControl: true }).setView([43.2557, -79.8711], 13);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.pm.addControls({
    position: 'topleft',
    drawMarker: false,
    drawCircleMarker: false,
    drawPolyline: false,
    drawPolygon: false,
    drawCircle: false,
    drawText: false,
    drawRectangle: true,
    editMode: true,
    dragMode: true,
    cutPolygon: false,
    rotateMode: false,
    removalMode: true,
  });

  let selection: L.Rectangle | null = null;

  const boundsOf = (layer: L.Rectangle): Bounds => {
    const b = layer.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  };

  const notify = () => onSelectionChange(selection ? boundsOf(selection) : null);

  map.on('pm:create', (e) => {
    if (e.shape !== 'Rectangle') return;
    if (selection) selection.remove();
    selection = e.layer as L.Rectangle;
    selection.on('pm:edit', notify);
    selection.on('pm:dragend', notify);
    notify();
  });

  map.on('pm:remove', (e) => {
    if (e.layer === selection) {
      selection = null;
      notify();
    }
  });

  return {
    map,
    getSelection: () => (selection ? boundsOf(selection) : null),
    flyTo: (b) =>
      map.fitBounds(
        L.latLngBounds([b.south, b.west], [b.north, b.east]),
        { maxZoom: 16 },
      ),
  };
}

interface NominatimResult {
  display_name: string;
  boundingbox: [string, string, string, string]; // south, north, west, east
}

/** Wire the place-search box to Nominatim (search on Enter only, per usage policy). */
export function setupSearch(controller: MapController): void {
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  const results = document.querySelector<HTMLUListElement>('#search-results')!;

  const hide = () => {
    results.hidden = true;
    results.replaceChildren();
  };

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
      );
      if (!resp.ok) throw new Error(`Nominatim: ${resp.status}`);
      const places = (await resp.json()) as NominatimResult[];
      results.replaceChildren(
        ...places.map((p) => {
          const li = document.createElement('li');
          li.textContent = p.display_name;
          li.addEventListener('click', () => {
            const [s, n, w, ee] = p.boundingbox.map(Number);
            controller.flyTo({ south: s, north: n, west: w, east: ee });
            hide();
          });
          return li;
        }),
      );
      results.hidden = places.length === 0;
    } catch (err) {
      console.error('Search failed', err);
    }
  });

  document.addEventListener('click', (e) => {
    if (!results.contains(e.target as Node) && e.target !== input) hide();
  });
}
