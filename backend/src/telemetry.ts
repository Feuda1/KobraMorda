import { EventEmitter } from "node:events";
import type { KobraXMqttClient } from "./mqttClient.js";
import { createInitialState, isPrePrintState, mapKobraState, type AmsSlot, type PrinterState } from "./state.js";

interface ReportEvent {
  reportKey: string;
  topic: string;
  message: { type?: string; action?: string; state?: string; code?: number; data?: unknown };
}

interface ProjectLike {
  filename?: string;
  progress?: number; // 0..1 in some payloads, 0..100 in others - normalized defensively
  curr_layer?: number;
  total_layers?: number;
  print_time?: number; // minutes
  remain_time?: number; // minutes
  state?: string;
}

interface TempLike {
  curr_nozzle_temp?: number;
  target_nozzle_temp?: number;
  curr_hotbed_temp?: number;
  target_hotbed_temp?: number;
}

function applyTemps(state: PrinterState, temp: TempLike | undefined) {
  if (!temp) return;
  if (typeof temp.curr_nozzle_temp === "number") state.nozzleTemp = temp.curr_nozzle_temp;
  if (typeof temp.target_nozzle_temp === "number") state.nozzleTarget = temp.target_nozzle_temp;
  if (typeof temp.curr_hotbed_temp === "number") state.bedTemp = temp.curr_hotbed_temp;
  if (typeof temp.target_hotbed_temp === "number") state.bedTarget = temp.target_hotbed_temp;
}

function normalizeProgress(raw: number | undefined): number | undefined {
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  // The firmware reports whole percent (0..100). A bare integer 1 is 1%, not
  // 100% - only a non-integer value <= 1 is a genuine 0..1 fraction.
  if (raw > 1) return Math.min(raw / 100, 1);
  return Number.isInteger(raw) ? raw / 100 : raw;
}

function applyProject(state: PrinterState, project: ProjectLike, opts: { skipProgress?: boolean } = {}) {
  if (typeof project.filename === "string") state.filename = project.filename;
  if (!opts.skipProgress) {
    const progress = normalizeProgress(project.progress);
    if (progress !== undefined) state.progress = progress;
  }
  if (typeof project.curr_layer === "number") state.currentLayer = project.curr_layer;
  if (typeof project.total_layers === "number") state.totalLayers = project.total_layers;
  if (typeof project.print_time === "number") state.printDurationSec = project.print_time * 60;
  if (typeof project.remain_time === "number") state.remainTimeSec = project.remain_time * 60;
}

function resetJobFields(state: PrinterState) {
  state.filename = null;
  state.progress = 0;
  state.currentLayer = 0;
  state.totalLayers = 0;
  state.printDurationSec = 0;
  state.remainTimeSec = 0;
}

/**
 * Owns the normalized PrinterState for one printer, fed by MQTT report
 * pushes. Emits "change" whenever the state is mutated so HTTP/WS layers
 * can re-broadcast.
 *
 * NOTE: the exact shape of the unsolicited "print/report"/"status/report"
 * pushes that arrive *during* an active print has not yet been captured
 * live (only "info/report" and "tempature/report" have been verified
 * against the real printer while idle) - this normalizer is written from
 * the documented protocol spec and defensive fallbacks, and should be
 * re-checked against a live capture the first time a real print runs
 * through this bridge.
 */
export class PrinterTelemetry extends EventEmitter {
  readonly state: PrinterState = createInitialState();

  constructor(mqttClient: KobraXMqttClient) {
    super();
    mqttClient.on("connect", () => {
      this.state.connected = true;
      this.emit("change");
    });
    mqttClient.on("close", () => {
      this.state.connected = false;
      this.emit("change");
    });
    mqttClient.on("report", (evt: ReportEvent) => this.handleReport(evt));
  }

  private handleReport({ reportKey, message }: ReportEvent) {
    const data = message.data as Record<string, unknown> | null | undefined;

    switch (reportKey) {
      case "info/report":
        this.applyInfoReport(data);
        break;
      case "tempature/report":
        applyTemps(this.state, data as TempLike);
        break;
      case "status/report":
      case "print/report":
        // Documented shape: progress/curr_layer/total_layers/print_time/
        // remain_time flattened directly under `data`, plus a top-level
        // `state`. Treated the same way as an info.project payload.
        this.applyProject(data as ProjectLike, message.state);
        break;
      case "light/report":
        // Two shapes: a query reply carries {lights:[{type,status,brightness}]},
        // a control reply / touchscreen toggle carries the flat {type,status,brightness}.
        // type 3 is the lamp that actually lights up this printer (see setLight).
        if (data) {
          const lights = data.lights as Array<{ type?: number; status?: number }> | undefined;
          const lamp = lights?.find((l) => l.type === 3) ?? lights?.[0] ?? (data as { type?: number; status?: number });
          if (typeof lamp.status === "number") this.state.lightOn = lamp.status === 1;
        }
        break;
      case "multiColorBox/report":
        this.applyMulticolorBox(data);
        break;
      default:
        return; // don't emit "change" for reports we don't understand yet
    }
    this.emit("change");
  }

  private applyInfoReport(data: Record<string, unknown> | null | undefined) {
    if (!data) return;
    const s = this.state;
    if (typeof data.printerName === "string") s.printerName = data.printerName;
    if (typeof data.version === "string") s.firmwareVersion = data.version;
    applyTemps(s, data.temp as TempLike);
    if (typeof data.fan_speed_pct === "number") s.fanPct = data.fan_speed_pct;

    const urls = data.urls as { rtspUrl?: string; fileUploadurl?: string } | undefined;
    if (urls?.rtspUrl) s.rtspUrl = urls.rtspUrl;
    if (urls?.fileUploadurl) s.fileUploadUrl = urls.fileUploadurl;

    const deviceState = data.state as string | undefined;
    const project = data.project as ProjectLike | null | undefined;
    if (deviceState) s.deviceState = deviceState;

    if (project) {
      this.applyProject(project, project.state ?? deviceState);
    } else if (deviceState === "free") {
      // A bare "free" with no attached project is only trustworthy when we
      // don't already believe a job is running. Verified live: right after
      // a print is sent, an info/report can arrive with state:"free" and no
      // project (the firmware hasn't attached one to /info yet) while the
      // separate status/report stream already correctly says "auto_leveling"
      // - blindly trusting this one flipped the dashboard back to
      // "Ожидание" and back on every such report, mid-heating. The real
      // end-of-job signal is the explicit finished/stoped/canceled branch
      // in applyProject below, not this racy one.
      if (s.filename) return;
      s.printState = "standby";
    } else {
      s.printState = mapKobraState(deviceState);
    }
  }

  private applyMulticolorBox(data: Record<string, unknown> | null | undefined) {
    // Occupancy is decided SOLELY by slot.status === 5 (verified against the
    // reference project's own logic, independently confirmed live: with
    // three slots stuck at status 4 carrying stale leftover type/color from
    // a previous physical spool, and one at status 5, only the status-5 slot
    // matched what was actually loaded). status 0-4 all mean "not occupied",
    // regardless of what type/color still says - those fields are ignored
    // for occupied slots below.
    const boxes = data?.multi_color_box as
      | Array<{
          slots?: Array<{
            index?: number;
            color?: number[];
            type?: string;
            brand_name?: string;
            status?: number;
          }>;
        }>
      | undefined;
    const slots = boxes?.[0]?.slots;
    if (!slots) return;
    this.state.amsSlots = slots.map(
      (s): AmsSlot => ({
        index: s.index ?? 0,
        colorHex: (s.color ?? [255, 255, 255])
          .slice(0, 3)
          .map((c) => c.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase(),
        materialType: s.type ?? "",
        brand: s.brand_name ?? "",
        occupied: s.status === 5,
      }),
    );
  }

  private applyProject(project: ProjectLike | null | undefined, rawState: string | undefined) {
    if (!project) return;
    const s = this.state;
    s.printState = mapKobraState(rawState);
    if (rawState) s.deviceState = rawState;
    const incomingLayer = typeof project.curr_layer === "number" ? project.curr_layer : s.currentLayer;
    applyProject(s, project, { skipProgress: isPrePrintState(rawState, incomingLayer) });
    if (rawState === "finished" || rawState === "stoped" || rawState === "canceled") {
      resetJobFields(s);
      s.printState = mapKobraState(rawState);
    }
  }
}
