/**
 * Extracts slicer-embedded metadata from OrcaSlicer/PrusaSlicer .gcode
 * comments. Only the head and tail of the file are scanned (slicers write
 * this metadata either right after the header or right before EOF), so this
 * stays fast even for large files.
 */

export interface GcodeMeta {
  estimatedTimeSec: number;
  layerHeightMm: number;
  firstLayerHeightMm: number;
  filamentColor: string | null; // hex, no '#' - first/only color, for single-material display
  filamentType: string | null;
  filamentWeightG: number;
  /** Only present if the user configured a filament cost in the slicer's filament profile. */
  filamentCost: number | null;
  /** data: URI (image/png;base64) of the largest embedded slicer thumbnail, if any. */
  thumbnailDataUri: string | null;

  /** Per-AMS-slot color, in slicer slot order (index 0 = slot/tool 1). */
  filamentColors: string[];
  /** Per-AMS-slot material, same order as filamentColors. */
  filamentTypes: string[];
  /** 1-based tool/slot indices actually used in the print, in the order OrcaSlicer declared them. */
  toolOrder: number[];
  /** Every "; key = value" line found in the slicer's embedded config dump - for the full-settings view. */
  rawSettings: Record<string, string>;
}

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 128 * 1024;

function headAndTail(buf: Buffer): string {
  const head = buf.subarray(0, Math.min(HEAD_BYTES, buf.length)).toString("utf8");
  const tail =
    buf.length > HEAD_BYTES
      ? buf.subarray(Math.max(buf.length - TAIL_BYTES, HEAD_BYTES)).toString("utf8")
      : "";
  return head + "\n" + tail;
}

function parseDuration(text: string): number {
  let totalSec = 0;
  const re = /(\d+)\s*([hms])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const value = Number(m[1]);
    const unit = m[2];
    if (unit === "h") totalSec += value * 3600;
    else if (unit === "m") totalSec += value * 60;
    else totalSec += value;
  }
  return totalSec;
}

function extractLargestThumbnail(text: string): string | null {
  const blockRe = /;\s*thumbnail(?:_JPG)? begin\s+(\d+)x(\d+)\s+\d+\r?\n([\s\S]*?);\s*thumbnail(?:_JPG)? end/gi;
  let best: { area: number; dataUri: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const area = Number(m[1]) * Number(m[2]);
    const base64 = m[3]
      .split(/\r?\n/)
      .map((line) => line.replace(/^;\s?/, "").trim())
      .filter(Boolean)
      .join("");
    if (base64 && (!best || area > best.area)) {
      best = { area, dataUri: `data:image/png;base64,${base64}` };
    }
  }
  return best?.dataUri ?? null;
}

/** Every "; key = value" comment line - OrcaSlicer dumps its whole active config this way. */
function extractRawSettings(text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  const lineRe = /^;\s*([a-zA-Z0-9_]+)\s*=\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text))) {
    settings[m[1]] = m[2].trim();
  }
  return settings;
}

export function parseGcodeMeta(buf: Buffer): GcodeMeta {
  const text = headAndTail(buf);

  let estimatedTimeSec = 0;
  const orcaTime = text.match(/;\s*total estimated time:\s*([^\r\n]+)/i);
  const prusaTime = text.match(/;\s*estimated printing time \(normal mode\)\s*=\s*([^\r\n]+)/i);
  if (orcaTime) estimatedTimeSec = parseDuration(orcaTime[1]);
  else if (prusaTime) estimatedTimeSec = parseDuration(prusaTime[1]);

  let layerHeightMm = 0;
  const layerHeightMatch = text.match(/;\s*layer_height\s*=\s*([\d.]+)/i);
  if (layerHeightMatch) layerHeightMm = Number(layerHeightMatch[1]);

  let firstLayerHeightMm = 0;
  const firstLayerMatch =
    text.match(/;\s*initial_layer_print_height\s*=\s*([\d.]+)/i) ??
    text.match(/;\s*first_layer_height\s*=\s*([\d.]+)/i);
  firstLayerHeightMm = firstLayerMatch ? Number(firstLayerMatch[1]) : layerHeightMm;

  if (!layerHeightMm) {
    // Fallback: OrcaSlicer's default output filename pattern embeds
    // "..._<layerHeight>_<duration>.gcode", e.g. "..._0.2_41m1s.gcode".
    // Not applicable here since we only have the buffer, not the filename -
    // callers with a filename should call parseLayerHeightFromFilename too.
  }

  // Multi-material files declare one entry per AMS slot/tool, semicolon-
  // separated, e.g. "; filament_colour = #FF0000;#00FF00;#0000FF".
  const colorsLine =
    text.match(/;\s*filament_colour\s*=\s*([^\r\n]+)/i) ?? text.match(/;\s*filament_multi_colour\s*=\s*([^\r\n]+)/i);
  const filamentColors = colorsLine
    ? colorsLine[1]
        .split(";")
        .map((c) => c.replace("#", "").trim().toUpperCase())
        .filter((c) => /^[0-9A-F]{6}$/.test(c))
    : [];

  const typesLine = text.match(/;\s*filament_type\s*=\s*([^\r\n]+)/i);
  const filamentTypes = typesLine
    ? typesLine[1]
        .split(/[;,]/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    : [];

  // Which paints are ACTUALLY used. Preferred source (same as the reference
  // bridge): real "T<n>" tool-change commands in the gcode body (0-based) -
  // a slicer lists every configured filament in its header even when the
  // print only uses one, and mapping unused ones makes the printer demand
  // them. Fallback: the "; filament : 1,2" header list (1-based).
  const usedFromBody = new Set<number>();
  const toolCmd = /^[ \t]*T(\d+)\b/gm;
  const bodyText = buf.toString("latin1");
  let tm: RegExpExecArray | null;
  while ((tm = toolCmd.exec(bodyText))) usedFromBody.add(Number(tm[1]));

  const toolOrderLine = text.match(/;\s*filament\s*:\s*([\d,\s]+)$/im);
  const headerOrder = toolOrderLine
    ? toolOrderLine[1]
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  // Exposed 1-based (T0 -> tool 1) to match how the UI numbers tools.
  const toolOrder = usedFromBody.size
    ? [...usedFromBody].sort((a, b) => a - b).map((n) => n + 1)
    : headerOrder;

  const filamentColor = filamentColors[0] ?? null;
  const filamentType = filamentTypes[0] ?? null;

  let filamentWeightG = 0;
  const orcaWeight = text.match(/;\s*total filament weight \[g\]\s*[:=]\s*([\d.]+)/i);
  const prusaWeight = text.match(/;\s*filament used \[g\]\s*=\s*([\d.]+)/i);
  if (orcaWeight) filamentWeightG = Number(orcaWeight[1]);
  else if (prusaWeight) filamentWeightG = Number(prusaWeight[1]);

  // Only present if the user set a $/kg (or ₽/kg) cost in their filament
  // profile - the slicer then computes and embeds the total in whatever
  // currency/unit that price was entered in, no conversion needed here.
  let filamentCost: number | null = null;
  const orcaCost = text.match(/;\s*total filament cost\s*[:=]\s*([\d.]+)/i);
  const prusaCost = text.match(/;\s*filament cost\s*=\s*([\d.]+)/i);
  if (orcaCost) filamentCost = Number(orcaCost[1]);
  else if (prusaCost) filamentCost = Number(prusaCost[1]);

  const thumbnailDataUri = extractLargestThumbnail(text);
  const rawSettings = extractRawSettings(text);

  return {
    estimatedTimeSec,
    layerHeightMm,
    firstLayerHeightMm,
    filamentColor,
    filamentType,
    filamentWeightG,
    filamentCost,
    thumbnailDataUri,
    filamentColors,
    filamentTypes,
    toolOrder,
    rawSettings,
  };
}

/** Fallback layer-height recovery from OrcaSlicer's default output filename pattern. */
export function parseLayerHeightFromFilename(filename: string): number | null {
  const m = filename.match(/_(\d\.\d+)_\d+[hms]/);
  return m ? Number(m[1]) : null;
}
