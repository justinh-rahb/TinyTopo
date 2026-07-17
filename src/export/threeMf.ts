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
 * Serialize bodies into a multicolor 3MF that both worlds understand:
 * - Core spec: leaf objects carry basematerial display colors, and a single
 *   assembly object composes them, so PrusaSlicer/Cura import one model with
 *   colored parts.
 * - Bambu/Orca flavor: Metadata/model_settings.config declares each leaf as a
 *   part with a 1-based `extruder`, so Bambu Studio maps parts to AMS filament
 *   slots instead of dumping everything on filament 1.
 * Geometry is Z-up millimeters, which is exactly 3MF's coordinate space.
 */
export async function toThreeMf(bodies: NamedBody[]): Promise<Blob> {
  const assemblyId = bodies.length + 2; // ids: 1 = materials, 2..n+1 = leaves

  const xml: string[] = [];
  xml.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <metadata name="Application">TinyTopo</metadata>',
    ' <resources>',
    '  <basematerials id="1">',
  );
  for (const body of bodies) {
    xml.push(`   <base name="${escapeXml(body.name)}" displaycolor="${hexColor(body.color)}" />`);
  }
  xml.push('  </basematerials>');

  bodies.forEach((body, i) => {
    const objectId = i + 2;
    xml.push(
      `  <object id="${objectId}" type="model" pid="1" pindex="${i}" name="${escapeXml(body.name)}">`,
      '   <mesh>',
      '    <vertices>',
    );
    // join() rather than push(...lines): spreading 100k+ elements as
    // arguments overflows the call stack on large meshes.
    const { vertexLines, triangleLines } = indexMesh(body.geometry);
    xml.push(vertexLines.join('\n'), '    </vertices>', '    <triangles>', triangleLines.join('\n'), '    </triangles>', '   </mesh>', '  </object>');
  });

  xml.push(`  <object id="${assemblyId}" type="model" name="TinyTopo">`, '   <components>');
  bodies.forEach((_, i) => xml.push(`    <component objectid="${i + 2}" />`));
  xml.push('   </components>', '  </object>', ' </resources>', ' <build>', `  <item objectid="${assemblyId}" />`, ' </build>', '</model>');

  const settings: string[] = [];
  settings.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    `  <object id="${assemblyId}">`,
    '    <metadata key="name" value="TinyTopo"/>',
    '    <metadata key="extruder" value="1"/>',
  );
  bodies.forEach((body, i) => {
    settings.push(
      `    <part id="${i + 2}" subtype="normal_part">`,
      `      <metadata key="name" value="${escapeXml(body.name)}"/>`,
      `      <metadata key="extruder" value="${i + 1}"/>`,
      '    </part>',
    );
  });
  settings.push('  </object>', '</config>');

  // Minimal project settings: gives Bambu Studio our palette for its
  // filament slots ("color data" in the third-party import path) without
  // shipping printer/process settings that would stomp the user's own.
  const projectSettings = JSON.stringify(
    {
      filament_colour: bodies.map((b) => hexColor(b.color)),
      filament_type: bodies.map(() => 'PLA'),
    },
    null,
    2,
  );

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('3D/3dmodel.model', xml.join('\n'));
  zip.file('Metadata/model_settings.config', settings.join('\n'));
  zip.file('Metadata/project_settings.config', projectSettings);
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'model/3mf',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
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
