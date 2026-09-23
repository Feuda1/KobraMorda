/**
 * Extrusion toolpath extraction from slicer gcode, for the 3D print viewer.
 * Only extruding XY moves are kept (travels are irrelevant to "what does the
 * part look like"), grouped by feature type (walls / infill / skin /
 * support ...) and by layer. Layers are detected by Z changes on extruding
 * moves, so no slicer-specific layer comments are required; feature type
 * comes from the ";TYPE:" comments OrcaSlicer/PrusaSlicer/Cura-style
 * slicers write.
 */

export const TOOLPATH_GROUPS = [
  "Внешняя стенка",
  "Внутренние стенки",
  "Заполнение",
  "Верх и низ",
  "Поддержки",
  "Юбка и кайма",
  "Прочее",
] as const;

function classify(type: string): number {
  const t = type.toLowerCase();
  if (t.includes("outer wall") || t.includes("external perimeter") || t === "wall-outer") return 0;
  if (t.includes("inner wall") || t.includes("overhang wall") || t.includes("perimeter") || t === "wall-inner") return 1;
  if (t.includes("support")) return 4;
  if (t.includes("top surface") || t.includes("bottom surface") || t.includes("bridge") || t.includes("skin"))
    return 3;
  if (t.includes("infill") || t.includes("gap fill")) return 2;
  if (t.includes("skirt") || t.includes("brim")) return 5;
  return 6;
}

export interface ToolpathMeta {
  bounds: { minX: number; maxX: number; minY: number; maxY: number; maxZ: number };
  layerZ: number[];
  groups: { title: string; start: number; layerOffsets: number[] }[];
  totalSegments: number;
  /** data holds uint16 values: coordinate = value / scale + origin (0.01 mm precision unless the part is huge). */
  scale: number;
  originX: number;
  originY: number;
}

export interface Toolpath {
  meta: ToolpathMeta;
  /** Quantized x1,y1,x2,y2 per segment, groups concatenated (see meta.groups[].start), layers ascending inside each group. */
  data: Uint16Array;
}

export function buildToolpath(buf: Buffer): Toolpath {
  const text = buf.toString("latin1");
  const lines = text.split("\n");

  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let relativeE = false;
  let group = 6;

  const layerZ: number[] = [];
  const perGroup: number[][][] = TOOLPATH_GROUPS.map(() => []);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const coordRe = /([XYZE])(-?\d*\.?\d+)/g;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.charCodeAt(0) === 59 /* ; */) {
      const m = line.match(/^;\s*TYPE:\s*(.+)$/i);
      if (m) group = classify(m[1]);
      continue;
    }

    const cmd = line.slice(0, 3).toUpperCase();
    if (cmd === "M83") {
      relativeE = true;
      continue;
    }
    if (cmd === "M82") {
      relativeE = false;
      continue;
    }
    if (cmd === "G92") {
      const m = line.match(/E(-?\d*\.?\d+)/i);
      if (m) e = Number(m[1]);
      continue;
    }
    // G0/G1 straight moves; G2/G3 arcs are approximated by their chord.
    const isMove = cmd === "G1 " || cmd === "G0 " || cmd === "G2 " || cmd === "G3 " || cmd === "G1" || cmd === "G0";
    if (!isMove) continue;

    let nx = x;
    let ny = y;
    let nz = z;
    let ev: number | undefined;
    coordRe.lastIndex = 0;
    const body = line.split(";")[0];
    let m: RegExpExecArray | null;
    while ((m = coordRe.exec(body.toUpperCase()))) {
      const v = Number(m[2]);
      if (m[1] === "X") nx = v;
      else if (m[1] === "Y") ny = v;
      else if (m[1] === "Z") nz = v;
      else ev = v;
    }

    let de = 0;
    if (ev !== undefined) {
      de = relativeE ? ev : ev - e;
      if (!relativeE) e = ev;
    }

    const moved = nx !== x || ny !== y;
    if (de > 0 && moved) {
      if (layerZ.length === 0 || Math.abs(nz - layerZ[layerZ.length - 1]) > 1e-4) {
        if (layerZ.length === 0 || nz > layerZ[layerZ.length - 1]) layerZ.push(nz);
      }
      const layer = layerZ.length - 1;
      const layers = perGroup[group];
      while (layers.length <= layer) layers.push([]);
      layers[layer].push(x, y, nx, ny);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (nx < minX) minX = nx;
      if (nx > maxX) maxX = nx;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (ny < minY) minY = ny;
      if (ny > maxY) maxY = ny;
    }
    x = nx;
    y = ny;
    z = nz;
  }

  const layerCount = layerZ.length;
  let total = 0;
  for (const g of perGroup) for (const l of g) total += l.length / 4;

  const safeMinX = Number.isFinite(minX) ? minX : 0;
  const safeMinY = Number.isFinite(minY) ? minY : 0;
  const range = Math.max(maxX - safeMinX, maxY - safeMinY, 1);
  const scale = Math.min(100, 65535 / range);
  const data = new Uint16Array(total * 4);
  const groups: ToolpathMeta["groups"] = [];
  let cursor = 0; // in segments
  for (let g = 0; g < perGroup.length; g++) {
    const start = cursor;
    const layerOffsets: number[] = [0];
    for (let l = 0; l < layerCount; l++) {
      const segs = perGroup[g][l];
      if (segs) {
        const base = cursor * 4;
        for (let i = 0; i < segs.length; i += 2) {
          data[base + i] = Math.round((segs[i] - safeMinX) * scale);
          data[base + i + 1] = Math.round((segs[i + 1] - safeMinY) * scale);
        }
        cursor += segs.length / 4;
      }
      layerOffsets.push(cursor - start);
    }
    groups.push({ title: TOOLPATH_GROUPS[g], start, layerOffsets });
  }

  return {
    meta: {
      bounds: {
        minX: Number.isFinite(minX) ? minX : 0,
        maxX: Number.isFinite(maxX) ? maxX : 0,
        minY: Number.isFinite(minY) ? minY : 0,
        maxY: Number.isFinite(maxY) ? maxY : 0,
        maxZ: layerCount ? layerZ[layerCount - 1] : 0,
      },
      layerZ,
      groups,
      totalSegments: total,
      scale,
      originX: safeMinX,
      originY: safeMinY,
    },
    data,
  };
}
