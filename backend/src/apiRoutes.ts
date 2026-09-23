import { Router } from "express";
import fs from "node:fs";
import { currentAmsSlots, type BridgeContext } from "./bridgeContext.js";
import type { CameraPipeline } from "./camera.js";
import type { TimelapseRecorder } from "./timelapse.js";
import { startModelPrint } from "./printControl.js";
import type { StoredModel } from "./modelStore.js";
import { buildToolpath, type Toolpath } from "./toolpath.js";

interface PrinterFileRecord {
  display_name?: string;
  fileKey?: string;
  filename: string;
  is_dir?: boolean;
  size?: number;
  timestamp?: number;
}

interface PrinterFileDetails {
  thumbnail: string | null;
  filamentGrams: number | null;
  estimatedTimeSec: number | null;
  layerCount: number | null;
  nozzleTemp: number | null;
  bedTemp: number | null;
}

const detailsCache = new Map<string, PrinterFileDetails>();

/**
 * The printer's fileDetails.svg_image is an object-selection overlay (each
 * part drawn at opacity 0, meant to be toggled visible by an exclude-object
 * picker), not a plain preview - verified live (every <g> has opacity="0.0").
 * Force full visibility and a visible fill for use as a static thumbnail.
 */
function normalizeOutlineSvg(base64Svg: string): string {
  let svg: string;
  try {
    svg = Buffer.from(base64Svg, "base64").toString("utf8");
  } catch {
    return base64Svg;
  }
  svg = svg.replace(/opacity="0(?:\.0+)?"/g, 'opacity="1"').replace(/fill="red"/gi, 'fill="#3bb2f6"');
  return Buffer.from(svg, "utf8").toString("base64");
}

function modelSummary(m: StoredModel) {
  return {
    id: m.id,
    filename: m.filename,
    uploadedAt: m.uploadedAt,
    size: m.size,
    thumbnail: m.meta.thumbnailDataUri,
    filamentColors: m.meta.filamentColors,
    filamentTypes: m.meta.filamentTypes,
    toolOrder: m.meta.toolOrder.length ? m.meta.toolOrder : m.meta.filamentColors.length ? [1] : [],
    filamentGrams: m.meta.filamentWeightG || null,
    filamentCost: m.meta.filamentCost,
    estimatedTimeSec: m.meta.estimatedTimeSec || null,
    slotAssignment: m.slotAssignment,
  };
}

/** Bridge-native endpoints (camera, printer's own file storage, models browser) - not part of the Moonraker surface. */
export function createApiRoutes(ctx: BridgeContext, camera: CameraPipeline, timelapse: TimelapseRecorder): Router {
  const router = Router();
  const withUsage = async (slots: ReturnType<typeof currentAmsSlots>) => {
    const used = ctx.history.usedGramsBySlot();
    const links = ctx.spoolLinks.all();
    const spools = Object.keys(links).length > 0 ? await ctx.spoolman.spools().catch(() => []) : [];
    return slots.map((s) => {
      const spoolId = s.occupied ? links[s.index] : undefined;
      const spool = spools.find((x) => x.id === spoolId);
      return {
        ...s,
        usedGrams: s.occupied ? (used[s.index] ?? 0) : 0,
        spoolId: spoolId ?? null,
        spoolRemaining: spool?.remainingWeight ?? null,
      };
    });
  };

  router.get("/api/camera/snapshot", (_req, res) => {
    const frame = camera.getSnapshot();
    if (!frame) {
      res.status(503).end();
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(frame);
  });

  router.get("/api/camera/stream", (req, res) => {
    const boundary = "kobramorda-frame";
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-store",
      Connection: "close",
      Pragma: "no-cache",
    });

    const onFrame = (frame: Buffer) => {
      res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write("\r\n");
    };
    camera.on("frame", onFrame);
    req.on("close", () => camera.off("frame", onFrame));

    const current = camera.getSnapshot();
    if (current) onFrame(current);
  });

  router.get("/api/printer-files", async (_req, res) => {
    try {
      const result = (await ctx.mqttClient.listPrinterFiles()) as {
        code?: number;
        data?: { records?: PrinterFileRecord[] } | null;
      };
      if (result.code !== 200 || !result.data?.records) {
        res.json({ files: [] });
        return;
      }
      const files = result.data.records
        .filter((r) => !r.is_dir)
        .map((r) => ({
          filename: r.filename,
          displayName: r.display_name || r.filename,
          size: r.size ?? 0,
          timestamp: r.timestamp ?? 0,
        }));
      res.json({ files });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/printer-files/:filename/thumbnail", async (req, res) => {
    const filename = req.params.filename;
    const cached = detailsCache.get(filename);
    if (cached) {
      res.json(cached);
      return;
    }
    try {
      const result = (await ctx.mqttClient.fileDetails(filename)) as {
        data?: {
          file_details?: {
            thumbnail?: string;
            png_image?: string;
            svg_image?: string;
            total_filament_used?: number;
            estimated_time_s?: number;
            layer_count?: number;
            print_parameters?: { temperatures?: { nozzle_temp?: number; bed_temp?: number } };
          };
        } | null;
      };
      const details = result.data?.file_details;
      let thumbnail: string | null = null;
      if (details?.thumbnail) {
        thumbnail = `data:image/png;base64,${details.thumbnail}`;
      } else if (details?.png_image) {
        thumbnail = `data:image/png;base64,${details.png_image}`;
      } else if (details?.svg_image) {
        thumbnail = `data:image/svg+xml;base64,${normalizeOutlineSvg(details.svg_image)}`;
      }
      const entry: PrinterFileDetails = {
        thumbnail,
        filamentGrams: details?.total_filament_used ?? null,
        estimatedTimeSec: details?.estimated_time_s ?? null,
        layerCount: details?.layer_count ?? null,
        nozzleTemp: details?.print_parameters?.temperatures?.nozzle_temp ?? null,
        bedTemp: details?.print_parameters?.temperatures?.bed_temp ?? null,
      };
      detailsCache.set(filename, entry);
      res.json(entry);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/printer-files/delete", async (req, res) => {
    const filenames = req.body?.filenames as string[] | undefined;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      res.status(400).json({ error: "filenames array required" });
      return;
    }
    try {
      await ctx.mqttClient.deletePrinterFiles(filenames);
      for (const f of filenames) detailsCache.delete(f);
      res.json({ result: "ok" });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/current-file/thumbnail", (_req, res) => {
    const filename = ctx.telemetry.state.filename;
    const model = filename ? ctx.modelStore.getByFilename(filename) : ctx.modelStore.latest();
    res.json({
      id: model?.id ?? null,
      thumbnail: model?.meta.thumbnailDataUri ?? null,
      filamentColor: model?.meta.filamentColor ?? null,
      filamentType: model?.meta.filamentType ?? null,
      filamentGrams: model?.meta.filamentWeightG ?? null,
      filamentCost: model?.meta.filamentCost ?? null,
      estimatedTimeSec: model?.meta.estimatedTimeSec ?? null,
    });
  });

  // The "loaded models" browser: every plain "Upload" from OrcaSlicer lands
  // here (as opposed to "Upload and print", which prints immediately via
  // the Moonraker surface above). Lets the user review settings and assign
  // AMS slots before starting the print themselves.
  router.get("/api/models", (_req, res) => {
    res.json({ items: ctx.modelStore.list().map(modelSummary) });
  });

  router.get("/api/models/:id", (req, res) => {
    const model = ctx.modelStore.get(req.params.id);
    if (!model) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ ...modelSummary(model), rawSettings: model.meta.rawSettings });
  });

  router.post("/api/models/:id/assign", (req, res) => {
    const assignment = req.body?.assignment as Record<string, number> | undefined;
    if (!assignment || typeof assignment !== "object") {
      res.status(400).json({ error: "assignment object required" });
      return;
    }
    const normalized: Record<number, number> = {};
    for (const [tool, slot] of Object.entries(assignment)) {
      normalized[Number(tool)] = Number(slot);
    }
    const ok = ctx.modelStore.setAssignment(req.params.id, normalized);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ result: "ok" });
  });

  router.post("/api/models/:id/print", async (req, res) => {
    try {
      await startModelPrint(req.params.id, ctx);
      res.json({ result: "ok" });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/models/:id", (req, res) => {
    const ok = ctx.modelStore.delete(req.params.id);
    res.json({ result: ok ? "ok" : "not_found" });
  });

  // 3D print viewer: toolpath parsed once per model (few seconds for big
  // files) and cached in memory.
  const toolpathCache = new Map<string, Toolpath>();
  const getToolpath = (id: string): Toolpath | undefined => {
    const cached = toolpathCache.get(id);
    if (cached) return cached;
    const data = ctx.modelStore.getData(id);
    if (!data) return undefined;
    const built = buildToolpath(data);
    toolpathCache.set(id, built);
    return built;
  };

  router.get("/api/models/:id/toolpath.json", (req, res) => {
    const tp = getToolpath(req.params.id);
    if (!tp) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(tp.meta);
  });

  router.get("/api/models/:id/toolpath.bin", (req, res) => {
    const tp = getToolpath(req.params.id);
    if (!tp) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(Buffer.from(tp.data.buffer, tp.data.byteOffset, tp.data.byteLength));
  });

  router.get("/api/ams/slots", async (_req, res) => {
    res.json({ slots: await withUsage(currentAmsSlots(ctx)) });
  });

  // Correcting a slot's color/material here (not on the printer - see
  // amsOverrides.ts for why: the printer rejects the write outright).
  router.post("/api/ams/slots/:index", async (req, res) => {
    const index = Number(req.params.index);
    const patch: { colorHex?: string; materialType?: string; occupied?: boolean } = {};
    if (typeof req.body?.colorHex === "string") patch.colorHex = req.body.colorHex.replace("#", "").toUpperCase();
    if (typeof req.body?.materialType === "string") patch.materialType = req.body.materialType;
    if (typeof req.body?.occupied === "boolean") patch.occupied = req.body.occupied;
    ctx.amsOverrides.set(index, patch);
    res.json({ slots: await withUsage(currentAmsSlots(ctx)) });
  });

  router.delete("/api/ams/slots/:index", async (req, res) => {
    ctx.amsOverrides.clear(Number(req.params.index));
    res.json({ slots: await withUsage(currentAmsSlots(ctx)) });
  });

  router.post("/api/spoolman/links/:slot", (req, res) => {
    const spoolId = req.body?.spoolId;
    ctx.spoolLinks.set(Number(req.params.slot), typeof spoolId === "number" ? spoolId : null);
    res.json({ result: "ok" });
  });

  router.get("/api/history", (_req, res) => {
    res.json({ items: ctx.history.list() });
  });

  router.get("/api/history/:id/thumbnail", (req, res) => {
    const file = ctx.history.thumbnailPath(req.params.id);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.type("image/png").sendFile(file);
  });

  router.delete("/api/history/:id", (req, res) => {
    res.json({ result: ctx.history.remove(req.params.id) ? "ok" : "not_found" });
  });

  router.post("/api/light", async (req, res) => {
    try {
      await ctx.mqttClient.setLight(!!req.body?.on, req.body?.brightness ?? 80);
      res.json({ result: "ok" });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/timelapse/settings", (_req, res) => {
    res.json({ enabled: timelapse.getEnabled(), recording: timelapse.isRecording(), frames: timelapse.frameCount() });
  });

  router.post("/api/timelapse/settings", (req, res) => {
    timelapse.setEnabled(!!req.body?.enabled);
    res.json({ result: "ok" });
  });

  router.get("/api/timelapses", (_req, res) => {
    res.json({ items: timelapse.list() });
  });

  router.get("/api/timelapses/:id/video", (req, res) => {
    const file = timelapse.videoPath(req.params.id);
    if (!file) {
      res.status(404).end();
      return;
    }
    // sendFile handles Range requests, so the player can seek
    res.type("video/mp4").sendFile(file);
  });

  router.delete("/api/timelapses/:id", (req, res) => {
    const ok = timelapse.delete(req.params.id);
    res.json({ result: ok ? "ok" : "not_found" });
  });

  return router;
}
