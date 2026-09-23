import { currentAmsSlots, type BridgeContext } from "./bridgeContext.js";
import type { ModelStore, StoredModel } from "./modelStore.js";
import { buildAmsMapping, buildAutoAmsMapping, buildPrintStartPayload } from "./printJob.js";
import { uploadGcodeToPrinter } from "./printerUpload.js";

/**
 * Same sequence as the reference bridge: put the file on the printer over
 * HTTP first, then send print/start (which also carries a URL back to our
 * /serve endpoint plus md5/size).
 */
async function uploadAndStart(model: StoredModel, mapping: ReturnType<typeof buildAmsMapping>, ctx: BridgeContext) {
  const data = ctx.modelStore.getData(model.id);
  if (!data) throw new Error("Файл модели не найден на диске");

  const uploadUrl = ctx.telemetry.state.fileUploadUrl;
  if (!uploadUrl) throw new Error("Принтер ещё не сообщил адрес загрузки - попробуйте через пару секунд");
  await uploadGcodeToPrinter(ctx.printerIp, uploadUrl, model.filename, data);

  const fileUrl = `${ctx.bridgeBaseUrl}/serve/${encodeURIComponent(model.filename)}`;
  await ctx.mqttClient.startPrint(buildPrintStartPayload(model, fileUrl, mapping));
}

export type PrintAction = "start" | "pause" | "resume" | "cancel";

/**
 * Handles print start/pause/resume/cancel from either the HTTP or the WS
 * surface (both funnel through here so OrcaSlicer's HTTP-based "print"
 * path and moonraker-obico's WS-based control both behave identically).
 */
export async function handlePrintControl(
  action: PrintAction,
  params: Record<string, unknown>,
  ctx: BridgeContext,
): Promise<void> {
  switch (action) {
    case "start": {
      const filename = params.filename as string | undefined;
      const model = filename ? ctx.modelStore.getByFilename(filename) : ctx.modelStore.latest();
      if (!model) {
        throw new Error("No gcode file to print - upload one first");
      }
      // Slicer-initiated "Upload and print": no slot dialog, so auto-map.
      await uploadAndStart(model, buildAutoAmsMapping(model, currentAmsSlots(ctx)), ctx);
      return;
    }
    case "pause":
      await ctx.mqttClient.pausePrint();
      return;
    case "resume":
      await ctx.mqttClient.resumePrint();
      return;
    case "cancel":
      await ctx.mqttClient.stopPrint();
      return;
  }
}

/** Starts a print for a specific model id, from our own models browser. */
export async function startModelPrint(modelId: string, ctx: BridgeContext): Promise<void> {
  const model = ctx.modelStore.get(modelId);
  if (!model) {
    throw new Error("Model not found");
  }
  await uploadAndStart(model, buildAmsMapping(model, currentAmsSlots(ctx)), ctx);
}

/** Very small G-code passthrough, enough for moonraker-obico's control calls. */
export async function execGcodeScript(script: string, ctx: BridgeContext): Promise<void> {
  const line = script.trim().toUpperCase();
  if (line === "PAUSE" || line === "M25") {
    await ctx.mqttClient.pausePrint();
  } else if (line === "RESUME" || line === "M24") {
    await ctx.mqttClient.resumePrint();
  } else if (["CANCEL_PRINT", "M0", "M1", "M524", "ABORT"].includes(line)) {
    await ctx.mqttClient.stopPrint();
  }
  // Anything else (e.g. G28, temperature macros) is acknowledged but ignored -
  // out of scope for this bridge (see plan doc: no manual gcode console).
}

export function buildFileMetadata(modelStore: ModelStore, filename: string | undefined) {
  const model = filename ? modelStore.getByFilename(filename) : modelStore.latest();
  if (!model) return {};
  return {
    filename: model.filename,
    size: model.size,
    modified: model.uploadedAt / 1000,
    estimated_time: model.meta.estimatedTimeSec,
    layer_height: model.meta.layerHeightMm,
    first_layer_height: model.meta.firstLayerHeightMm,
    layer_count: 0,
    object_height: 0,
    thumbnails: [],
  };
}
