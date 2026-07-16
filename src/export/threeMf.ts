import JSZip from 'jszip';
import * as THREE from 'three';

/** A printable body: one 3MF object, one slicer filament slot. */
export interface NamedBody {
  name: string;
  color: number;
  geometry: THREE.BufferGeometry;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

/**
 * Serialize bodies into a core-spec 3MF: one object per body with a
 * basematerial display color, so slicers (Bambu Studio, PrusaSlicer, Cura)
 * import separate colorable parts for multi-material printing.
 * Geometry is Z-up millimeters, which is exactly 3MF's coordinate space.
 */
export async function toThreeMf(bodies: NamedBody[]): Promise<Blob> {
  const xml: string[] = [];
  xml.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <resources>',
    '  <basematerials id="1">',
  );
  for (const body of bodies) {
    const hex = `#${body.color.toString(16).padStart(6, '0').toUpperCase()}`;
    xml.push(`   <base name="${escapeXml(body.name)}" displaycolor="${hex}" />`);
  }
  xml.push('  </basematerials>');

  bodies.forEach((body, i) => {
    const objectId = i + 2; // id 1 is the material group
    xml.push(
      `  <object id="${objectId}" type="model" pid="1" pindex="${i}" name="${escapeXml(body.name)}">`,
      '   <mesh>',
      '    <vertices>',
    );
    const { vertexLines, triangleLines } = indexMesh(body.geometry);
    xml.push(...vertexLines, '    </vertices>', '    <triangles>', ...triangleLines, '    </triangles>', '   </mesh>', '  </object>');
  });

  xml.push(' </resources>', ' <build>');
  bodies.forEach((_, i) => xml.push(`  <item objectid="${i + 2}" />`));
  xml.push(' </build>', '</model>');

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('3D/3dmodel.model', xml.join('\n'));
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'model/3mf',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** Dedupe triangle-soup vertices (0.1µm grid) into indexed 3MF XML lines. */
function indexMesh(geometry: THREE.BufferGeometry): { vertexLines: string[]; triangleLines: string[] } {
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : pos.count;

  const vertexLines: string[] = [];
  const triangleLines: string[] = [];
  const seen = new Map<string, number>();
  const tri: number[] = [0, 0, 0];

  for (let i = 0; i < count; i += 3) {
    for (let c = 0; c < 3; c++) {
      const vi = index ? index.getX(i + c) : i + c;
      const x = pos.getX(vi).toFixed(4);
      const y = pos.getY(vi).toFixed(4);
      const z = pos.getZ(vi).toFixed(4);
      const key = `${x} ${y} ${z}`;
      let id = seen.get(key);
      if (id === undefined) {
        id = seen.size;
        seen.set(key, id);
        vertexLines.push(`     <vertex x="${x}" y="${y}" z="${z}" />`);
      }
      tri[c] = id;
    }
    // Vertices snapped to the same grid point make a zero-area triangle.
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[2] !== tri[0]) {
      triangleLines.push(`     <triangle v1="${tri[0]}" v2="${tri[1]}" v3="${tri[2]}" />`);
    }
  }
  return { vertexLines, triangleLines };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export async function downloadThreeMf(bodies: NamedBody[], filename: string): Promise<void> {
  const blob = await toThreeMf(bodies);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
