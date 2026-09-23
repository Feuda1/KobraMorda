/**
 * Normalized, in-memory snapshot of printer state, fed by MQTT telemetry
 * and consumed by both the Moonraker-compatible API (moonrakerApi.ts) and
 * our own dashboard WebSocket (dashboardWs.ts).
 */
export interface PrinterState {
  connected: boolean;
  printerName: string;
  firmwareVersion: string;

  /** Klipper-vocabulary state: standby | printing | paused | complete | error */
  printState: "standby" | "printing" | "paused" | "complete" | "error";

  /** Raw firmware state (free/preheating/auto_leveling/printing/...), for the exact job stage. */
  deviceState: string;

  filename: string | null;
  progress: number; // 0..1
  currentLayer: number;
  totalLayers: number;
  printDurationSec: number;
  remainTimeSec: number;
  estimatedTotalSec: number;

  nozzleTemp: number;
  nozzleTarget: number;
  bedTemp: number;
  bedTarget: number;

  fanPct: number;
  /** null until the printer has reported it - never assume. */
  lightOn: boolean | null;

  rtspUrl: string | null;
  fileUploadUrl: string | null;

  amsSlots: AmsSlot[];
}

export interface AmsSlot {
  index: number;
  colorHex: string; // RRGGBB, no '#'
  materialType: string;
  brand: string;
  /** slot.status === 5 on the wire - verified against the reference project's own logic AND live hardware behavior; any other value means stale/empty, even if type/color still show old data. */
  occupied: boolean;
}

export function createInitialState(): PrinterState {
  return {
    connected: false,
    printerName: "Kobra X",
    firmwareVersion: "",
    printState: "standby",
    deviceState: "",
    filename: null,
    progress: 0,
    currentLayer: 0,
    totalLayers: 0,
    printDurationSec: 0,
    remainTimeSec: 0,
    estimatedTotalSec: 0,
    nozzleTemp: 0,
    nozzleTarget: 0,
    bedTemp: 0,
    bedTarget: 0,
    fanPct: 0,
    lightOn: null,
    rtspUrl: null,
    fileUploadUrl: null,
    amsSlots: [],
  };
}

/**
 * Kobra/Anycubic device state string -> Klipper-vocabulary print_stats.state.
 *
 * This is deliberately NOT an exhaustive allowlist of every sub-stage the
 * firmware can report. Verified live: the firmware invents new prep
 * sub-stage names beyond the documented set (e.g. "nozzle_purging" between
 * heating and leveling) - an early version of this table only recognized
 * "preheating"/"auto_leveling"/"checking"/etc and fell through to its
 * `?? "standby"` default for anything else, which made the dashboard and
 * the Telegram bot both flash back to "idle" (and, worse, chime a false
 * "printing" milestone) every time the firmware passed through an
 * unlisted sub-stage. So the classification is inverted: only the states
 * that are UNAMBIGUOUSLY idle/paused/terminal are listed; anything else
 * that isn't literally "free" defaults to "printing", since a print in
 * progress can pass through far more named sub-stages than genuine idle
 * ever will.
 */
const IDLE_STATES = new Set(["free", "stoped", "canceled"]);
const PAUSED_STATES = new Set(["pausing", "paused"]);
const TERMINAL_STATE: Record<string, PrinterState["printState"]> = {
  finished: "complete",
  failed: "error",
};

export function mapKobraState(raw: string | undefined): PrinterState["printState"] {
  if (!raw) return "standby";
  if (raw in TERMINAL_STATE) return TERMINAL_STATE[raw];
  if (PAUSED_STATES.has(raw)) return "paused";
  if (IDLE_STATES.has(raw)) return "standby";
  return "printing";
}

/**
 * True while a job is active but hasn't produced a real, confirmed layer
 * yet - progress/milestone/"started" notifications during this window are
 * not trustworthy.
 *
 * Deliberately NOT keyed off the firmware's own named sub-stage anymore.
 * An earlier version trusted the raw string "printing" (plus busy/
 * resuming/resumed) as proof of real, physical printing - verified live
 * that this is wrong: the firmware's "printing" state can appear as a
 * generic "job accepted" signal the moment a print is queued, well before
 * heating/leveling/purging finish and any plastic is actually laid down,
 * then the device state regresses to a specific prep sub-stage like
 * "auto_leveling" afterwards. That made the Telegram bot announce
 * "печать началась" during heating. `curr_layer` is the one field the
 * firmware only reports >0 once a layer has actually started printing -
 * far more reliable than any state-name parsing, current or future.
 */
export function isPrePrintState(raw: string | undefined, currentLayer = 0): boolean {
  const state = mapKobraState(raw);
  if (state !== "printing" && state !== "paused") return false; // not an active job at all
  return currentLayer <= 0;
}
