import type { KobraXMqttClient } from "./mqttClient.js";
import type { PrinterTelemetry } from "./telemetry.js";
import type { ModelStore } from "./modelStore.js";
import type { AmsOverrideStore } from "./amsOverrides.js";
import type { HistoryRecorder } from "./history.js";
import type { SpoolLinkStore, SpoolmanClient } from "./spoolman.js";

/** Everything the HTTP/WS handlers need, wired up once in server.ts. */
export interface BridgeContext {
  mqttClient: KobraXMqttClient;
  telemetry: PrinterTelemetry;
  modelStore: ModelStore;
  amsOverrides: AmsOverrideStore;
  /** e.g. "http://192.168.10.20:7130" - used to build the /serve/{filename} URL the printer fetches. */
  bridgeBaseUrl: string;
  printerIp: string;
  printerId: string;
  history: HistoryRecorder;
  spoolman: SpoolmanClient;
  spoolLinks: SpoolLinkStore;
}

/** Live AMS slots with user-corrected color/material layered over the (unreliable) hardware report. */
export function currentAmsSlots(ctx: BridgeContext) {
  return ctx.amsOverrides.apply(ctx.telemetry.state.amsSlots);
}
