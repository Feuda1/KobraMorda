import type { PrinterState } from "./state.js";
import type { GcodeMeta } from "./gcodeMeta.js";

/** Klipper "printer objects" that are static/expensive - sent once at WS connect, omitted from periodic pushes. */
export const STATIC_OBJECT_KEYS = ["configfile", "webhooks", "heaters", "history"] as const;

function estimateCurrentZ(state: PrinterState, fileMeta: GcodeMeta | undefined): number {
  if (!fileMeta || !fileMeta.layerHeightMm || state.currentLayer <= 0) return 0;
  const first = fileMeta.firstLayerHeightMm || fileMeta.layerHeightMm;
  if (state.currentLayer <= 1) return first;
  return first + (state.currentLayer - 1) * fileMeta.layerHeightMm;
}

/**
 * Builds the Klipper-shaped "printer objects" dict that OrcaSlicer's
 * Klipper print-host connection parses. Field/object names here are load-
 * bearing - OrcaSlicer's parser is strict about them (see docs/protocol-spec.md).
 */
export function buildPrinterObjects(
  state: PrinterState,
  opts: { fileMeta?: GcodeMeta; omitStatic?: boolean } = {},
): Record<string, unknown> {
  const z = estimateCurrentZ(state, opts.fileMeta);
  const isActive = state.printState === "printing";

  const dynamic: Record<string, unknown> = {
    extruder: { temperature: state.nozzleTemp, target: state.nozzleTarget, power: 0.0 },
    heater_bed: { temperature: state.bedTemp, target: state.bedTarget, power: 0.0 },
    print_stats: {
      state: state.printState,
      filename: state.filename ?? "",
      print_duration: state.printDurationSec,
      total_duration: state.printDurationSec,
      remain_time: state.remainTimeSec,
      info: { current_layer: state.currentLayer, total_layer: state.totalLayers },
    },
    display_status: { progress: state.progress, message: "" },
    virtual_sdcard: {
      progress: state.progress,
      is_active: isActive,
      file_path: state.filename ?? "",
      file_position: 0,
    },
    toolhead: {
      position: [0, 0, z, 0],
      homed_axes: "xyz",
      print_time: state.printDurationSec,
      estimated_print_time: state.printDurationSec,
    },
    gcode_move: {
      speed_factor: 1.0,
      extrude_factor: 1.0,
      speed: 0,
      gcode_position: [0, 0, z, 0],
      position: [0, 0, z, 0],
    },
    motion_report: {
      live_position: [0, 0, z, 0],
      live_velocity: 0.0,
      live_extruder_velocity: 0.0,
    },
    fan: { speed: state.fanPct / 100, rpm: null },
  };

  if (opts.omitStatic) {
    return dynamic;
  }

  return {
    ...dynamic,
    heaters: { available_heaters: ["extruder", "heater_bed"] },
    webhooks: { state: "ready", state_message: "Printer is ready" },
    history: { job_totals: {}, current_job: null },
    configfile: { config: {}, settings: {}, warnings: [] },
  };
}
