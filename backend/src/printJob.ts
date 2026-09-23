import type { StoredModel } from "./modelStore.js";
import type { AmsSlot } from "./state.js";

/** "RRGGBB" -> [r, g, b, 255] - the printer wants colors as RGBA int arrays, not hex strings. */
function rgba(hex: string | undefined): number[] {
  const c = (hex ?? "FFFFFF").replace("#", "").padEnd(6, "F");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), 255];
}

interface AmsBoxMappingEntry {
  paint_index: number;
  ams_index: number;
  paint_color: number[];
  ams_color: number[];
  material_type: string;
}

/**
 * ams_box_mapping as the printer expects it (format taken from the
 * reference bridge, whose prints demonstrably start on this hardware):
 *  - paint_index is the slicer's 0-based tool number (T0, T1...) - our UI
 *    numbers tools from 1, hence `toolIndex - 1`
 *  - ams_index is the physical slot (0-based)
 *  - both colors are [r, g, b, 255], not hex strings
 * Only tools actually used by the file are mapped; a slot that isn't
 * loaded must never be referenced (the printer rejects the whole job).
 */
export function buildAmsMapping(model: StoredModel, amsSlots: AmsSlot[]): AmsBoxMappingEntry[] {
  const toolOrder = model.meta.toolOrder.length ? model.meta.toolOrder : [1];
  const mapping: AmsBoxMappingEntry[] = [];

  for (const toolIndex of toolOrder) {
    const amsIndex = model.slotAssignment[toolIndex];
    if (amsIndex === undefined) {
      throw new Error(`Для тула ${toolIndex} не выбрана катушка`);
    }
    const slot = amsSlots.find((s) => s.index === amsIndex);
    if (!slot || !slot.occupied) {
      throw new Error(`Слот ${amsIndex + 1} пуст - выберите заряженную катушку`);
    }
    mapping.push({
      paint_index: toolIndex - 1,
      ams_index: amsIndex,
      paint_color: rgba(model.meta.filamentColors[toolIndex - 1]),
      ams_color: rgba(slot.colorHex),
      material_type: slot.materialType || model.meta.filamentTypes[toolIndex - 1] || "PLA",
    });
  }
  return mapping;
}

/**
 * Same as above but with no user assignment: map the used paints onto the
 * loaded slots with the same number (paint N -> slot N), as the reference
 * bridge does for "Upload and print" from the slicer. The printer reads the
 * list as ordered (entry N = TN), so gaps get placeholders that point at a
 * definitely-loaded slot - a placeholder referencing an empty tray makes the
 * printer reject the job even if the gcode never calls that tool.
 */
export function buildAutoAmsMapping(model: StoredModel, amsSlots: AmsSlot[]): AmsBoxMappingEntry[] {
  const used = new Set((model.meta.toolOrder.length ? model.meta.toolOrder : [1]).map((t) => t - 1));
  const loaded = amsSlots.filter((s) => s.occupied && used.has(s.index));
  if (loaded.length === 0) return [];

  const byIndex = new Map(loaded.map((s) => [s.index, s]));
  const maxIdx = Math.max(...byIndex.keys());
  const fallback = byIndex.get(maxIdx)!;
  const result: AmsBoxMappingEntry[] = [];
  for (let i = 0; i <= maxIdx; i++) {
    const s = byIndex.get(i) ?? fallback;
    result.push({
      paint_index: i,
      ams_index: s.index,
      paint_color: [255, 255, 255, 255],
      ams_color: rgba(s.colorHex),
      material_type: s.materialType || "PLA",
    });
  }
  return result;
}

export function buildPrintStartPayload(
  model: StoredModel,
  fileUrl: string,
  mapping: AmsBoxMappingEntry[],
) {
  return {
    taskid: "-1",
    url: fileUrl,
    filename: model.filename,
    md5: model.md5,
    filepath: null,
    filetype: 1,
    project_type: 1,
    filesize: model.size,
    ams_settings: {
      use_ams: mapping.length > 0,
      ams_box_mapping: mapping,
    },
    task_settings: {
      auto_leveling: 1,
      vibration_compensation: 0,
      flow_calibration: 0,
      dry_mode: 0,
      ai_settings: { status: 0, count: 0, type: 0 },
      timelapse: { status: 0, count: 0, type: 0 },
      drying_settings: { status: 0, target_temp: 0, duration: 0, remain_time: 0 },
      model_objects_skip_parts: [],
    },
  };
}
