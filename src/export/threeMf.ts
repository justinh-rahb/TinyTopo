import JSZip from 'jszip';
import * as THREE from 'three';

/** A printable body: one 3MF object/part, one slicer filament slot. */
export interface NamedBody {
  name: string;
  color: number;
  geometry: THREE.BufferGeometry;
}

/** Optional preview snapshots embedded as Bambu cover thumbnails. */
export interface Thumbnails {
  large: Blob; // ~512px square
  small: Blob; // ~128px square
}

/**
 * Serialize bodies as a Bambu-Studio-flavored 3MF project, mirroring the
 * structure Bambu Studio itself writes (production extension, geometry in
 * 3D/Objects/object_1.model, model_settings/project_settings configs, cover
 * thumbnails). Bambu Studio opens it as a project: parts named, one filament
 * slot per part, our palette in the filament list — no import dialogs.
 *
 * Deliberately omitted: printer/process profiles, so opening a model never
 * hijacks the user's machine or slicing settings.
 *
 * Other slicers read it too: the core-spec basematerials ride along in the
 * object file for PrusaSlicer/Cura color display.
 */
export async function toThreeMf(bodies: NamedBody[], thumbnails?: Thumbnails): Promise<Blob> {
  const assemblyId = bodies.length + 1;
  const uuid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-4444-4444-8888-000000000000`);
  // Center of a 256mm bed; on larger beds the model is off-center but on-plate.
  const PLATE_TRANSFORM = '1 0 0 0 1 0 0 0 1 128 128 0';
  const NS =
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
    'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ' +
    'requiredextensions="p"';

  // --- 3D/Objects/object_1.model: the actual meshes ---
  const obj: string[] = [];
  obj.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" ${NS}>`,
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <resources>',
    `  <basematerials id="${assemblyId + 1}">`,
  );
  for (const body of bodies) {
    obj.push(`   <base name="${escapeXml(body.name)}" displaycolor="${hexColor(body.color)}" />`);
  }
  obj.push('  </basematerials>');

  const faceCounts: number[] = [];
  bodies.forEach((body, i) => {
    const { vertexLines, triangleLines, triangleCount } = indexMesh(body.geometry);
    faceCounts.push(triangleCount);
    obj.push(
      `  <object id="${i + 1}" p:UUID="${uuid()}" type="model" pid="${assemblyId + 1}" pindex="${i}">`,
      '   <mesh>',
      '    <vertices>',
      vertexLines.join('\n'),
      '    </vertices>',
      '    <triangles>',
      triangleLines.join('\n'),
      '    </triangles>',
      '   </mesh>',
      '  </object>',
    );
  });
  obj.push(' </resources>', ' <build/>', '</model>');

  // --- 3D/3dmodel.model: assembly of components ---
  const root: string[] = [];
  root.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" ${NS}>`,
    // Bambu Studio only opens a 3MF in project mode (parts, extruders, and
    // filament colors honored, no import dialog) when Application identifies
    // as BambuStudio — an interop string, like browsers sending Mozilla/5.0.
    ' <metadata name="Application">BambuStudio-02.07.01.62</metadata>',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <metadata name="Title">TinyTopo</metadata>',
    ' <metadata name="Designer">TinyTopo (tinytopo map export)</metadata>',
    ` <metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>`,
  );
  if (thumbnails) {
    root.push(
      ' <metadata name="Thumbnail_Middle">/Metadata/plate_1.png</metadata>',
      ' <metadata name="Thumbnail_Small">/Metadata/plate_1_small.png</metadata>',
    );
  }
  root.push(' <resources>', `  <object id="${assemblyId}" p:UUID="${uuid()}" type="model">`, '   <components>');
  bodies.forEach((_, i) => {
    root.push(
      `    <component p:path="/3D/Objects/object_1.model" objectid="${i + 1}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`,
    );
  });
  root.push(
    '   </components>',
    '  </object>',
    ' </resources>',
    ` <build p:UUID="${uuid()}">`,
    `  <item objectid="${assemblyId}" p:UUID="${uuid()}" transform="${PLATE_TRANSFORM}" printable="1"/>`,
    ' </build>',
    '</model>',
  );

  // --- Metadata/model_settings.config: parts, extruders, plate ---
  const settings: string[] = [];
  settings.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    `  <object id="${assemblyId}">`,
    '    <metadata key="name" value="TinyTopo"/>',
    '    <metadata key="extruder" value="1"/>',
    `    <metadata face_count="${faceCounts.reduce((a, b) => a + b, 0)}"/>`,
  );
  bodies.forEach((body, i) => {
    settings.push(
      `    <part id="${i + 1}" subtype="normal_part">`,
      `      <metadata key="name" value="${escapeXml(body.name)}"/>`,
      '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
      `      <metadata key="extruder" value="${i + 1}"/>`,
      `      <mesh_stat face_count="${faceCounts[i]}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>`,
      '    </part>',
    );
  });
  settings.push(
    '  </object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="plater_name" value=""/>',
    '    <metadata key="locked" value="false"/>',
    '    <metadata key="filament_map_mode" value="Auto For Flush"/>',
    `    <metadata key="filament_maps" value="${bodies.map(() => '1').join(' ')}"/>`,
  );
  if (thumbnails) {
    settings.push('    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>');
  }
  settings.push(
    '    <model_instance>',
    `      <metadata key="object_id" value="${assemblyId}"/>`,
    '      <metadata key="instance_id" value="0"/>',
    '      <metadata key="identify_id" value="463"/>',
    '    </model_instance>',
    '  </plate>',
    '  <assemble>',
    `   <assemble_item object_id="${assemblyId}" instance_id="0" transform="${PLATE_TRANSFORM}" offset="0 0 0" />`,
    '  </assemble>',
    '</config>',
  );

  // --- Metadata/project_settings.config: filaments only, no printer/process ---
  const projectSettings = JSON.stringify(
    {
      filament_colour: bodies.map((b) => hexColor(b.color)),
      filament_multi_colour: bodies.map((b) => hexColor(b.color)),
      filament_type: bodies.map(() => 'PLA'),
      filament_diameter: bodies.map(() => '1.75'),
    },
    null,
    2,
  );

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${
   thumbnails
     ? `
 <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>
 <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>`
     : ''
 }
</Relationships>`;

  const modelRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="01.00.00.00"/>
  </header>
</config>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('3D/3dmodel.model', root.join('\n'));
  zip.file('3D/_rels/3dmodel.model.rels', modelRels);
  zip.file('3D/Objects/object_1.model', obj.join('\n'));
  zip.file('Metadata/model_settings.config', settings.join('\n'));
  zip.file('Metadata/project_settings.config', projectSettings);
  zip.file('Metadata/slice_info.config', sliceInfo);
  zip.file('Metadata/filament_sequence.json', '{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}');
  if (thumbnails) {
    zip.file('Metadata/plate_1.png', thumbnails.large);
    zip.file('Metadata/plate_1_small.png', thumbnails.small);
  }
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
function indexMesh(geometry: THREE.BufferGeometry): {
  vertexLines: string[];
  triangleLines: string[];
  triangleCount: number;
} {
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
        vertexLines.push(`     <vertex x="${x}" y="${y}" z="${z}"/>`);
      }
      tri[c] = id;
    }
    // Vertices snapped to the same grid point make a zero-area triangle.
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[2] !== tri[0]) {
      triangleLines.push(`     <triangle v1="${tri[0]}" v2="${tri[1]}" v3="${tri[2]}"/>`);
    }
  }
  return { vertexLines, triangleLines, triangleCount: triangleLines.length };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export async function downloadThreeMf(
  bodies: NamedBody[],
  filename: string,
  thumbnails?: Thumbnails,
): Promise<void> {
  const blob = await toThreeMf(bodies, thumbnails);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
