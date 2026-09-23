import { Router } from "express";
import multer from "multer";
import type { BridgeContext } from "./bridgeContext.js";
import { buildPrinterObjects } from "./printerObjects.js";
import { handlePrintControl, buildFileMetadata } from "./printControl.js";

const SOFTWARE_VERSION = "0.1.0";
const upload = multer({ storage: multer.memoryStorage() });

function currentModel(ctx: BridgeContext) {
  const filename = ctx.telemetry.state.filename;
  return filename ? ctx.modelStore.getByFilename(filename) : ctx.modelStore.latest();
}

function currentObjects(ctx: BridgeContext) {
  return buildPrinterObjects(ctx.telemetry.state, { fileMeta: currentModel(ctx)?.meta });
}

async function handleUpload(req: import("express").Request, res: import("express").Response, ctx: BridgeContext) {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file field in multipart body" });
    return;
  }
  const filename = (req.body?.path as string | undefined) || file.originalname;
  if (!/\.(gcode|bgcode)$/i.test(filename)) {
    res.status(400).json({ error: "Only .gcode/.bgcode files are accepted" });
    return;
  }

  const stored = ctx.modelStore.add(filename, file.buffer);

  const shouldPrint = req.body?.print === "true" || req.query.print === "true";
  if (shouldPrint) {
    try {
      await handlePrintControl("start", { filename: stored.filename }, ctx);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }
  }

  // OctoPrint-shaped response - this is the shape OrcaSlicer's uploader parses.
  res.status(201).json({
    done: true,
    files: {
      local: {
        name: stored.filename,
        origin: "local",
        path: stored.filename,
        refs: {
          download: `${ctx.bridgeBaseUrl}/api/files/local/${encodeURIComponent(stored.filename)}`,
          resource: `${ctx.bridgeBaseUrl}/api/files/local/${encodeURIComponent(stored.filename)}`,
        },
      },
    },
    result: { item: { path: stored.filename, root: "gcodes" }, action: "create_file" },
  });
}

/**
 * The Moonraker-compatible surface OrcaSlicer's Klipper print-host
 * connection (plus the upstream moonraker-obico companion) actually uses.
 * See docs/protocol-spec.md for the traced call sequence and exact field
 * names this must reproduce.
 */
export function createMoonrakerApi(ctx: BridgeContext): Router {
  const router = Router();

  router.get("/server/info", (_req, res) => {
    res.json({
      result: {
        klippy_connected: true,
        klippy_state: "ready",
        moonraker_version: `kobramorda-${SOFTWARE_VERSION}`,
        api_version: [1, 0, 0],
        api_version_string: "1.0.0",
        websocket_count: 0,
        warnings: [],
      },
    });
  });

  router.get("/printer/info", (_req, res) => {
    res.json({
      result: {
        state: "ready",
        state_message: "Printer is ready",
        hostname: "kobramorda",
        software_version: SOFTWARE_VERSION,
        cpu_info: "kobramorda-bridge",
      },
    });
  });

  router.get("/machine/system_info", (_req, res) => {
    res.json({ result: { system_info: { cpu_info: { cpu_desc: "Kobra X Bridge" }, distribution: {}, python: {} } } });
  });

  router.get("/printer/objects/list", (_req, res) => {
    res.json({ result: { objects: Object.keys(currentObjects(ctx)) } });
  });

  router.get("/printer/objects/query", (_req, res) => {
    res.json({ result: { status: currentObjects(ctx), eventtime: Date.now() / 1000 } });
  });

  router.all("/printer/objects/subscribe", (_req, res) => {
    res.json({ result: { status: currentObjects(ctx), eventtime: Date.now() / 1000 } });
  });

  router.get("/server/files/list", (_req, res) => {
    const model = ctx.modelStore.latest();
    res.json({
      result: model
        ? [{ path: model.filename, modified: model.uploadedAt / 1000, size: model.size, permissions: "rw" }]
        : [],
    });
  });

  router.get("/server/files/metadata", (req, res) => {
    res.json({ result: buildFileMetadata(ctx.modelStore, req.query.filename as string | undefined) });
  });

  router.post("/server/files/upload", upload.single("file"), (req, res) => handleUpload(req, res, ctx));
  router.post("/api/files/local", upload.single("file"), (req, res) => handleUpload(req, res, ctx));
  router.post("/api/files/:path", upload.single("file"), (req, res) => handleUpload(req, res, ctx));

  router.post("/printer/print/start", async (req, res) => {
    try {
      await handlePrintControl("start", { filename: req.query.filename as string | undefined }, ctx);
      res.json({ result: "ok" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  for (const [path, action] of [
    ["/printer/print/pause", "pause"],
    ["/printer/print/resume", "resume"],
    ["/printer/print/cancel", "cancel"],
  ] as const) {
    router.post(path, async (_req, res) => {
      try {
        await handlePrintControl(action, {}, ctx);
        res.json({ result: "ok" });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }

  router.post("/printer/gcode/script", async (req, res) => {
    res.json({ result: "ok" });
    void req.body?.script; // full gcode passthrough deliberately out of scope - see plan doc
  });

  router.get("/access/api_key", (_req, res) => {
    res.json({ result: "kobramorda-no-auth-required" });
  });

  router.get("/machine/update/status", (_req, res) => {
    res.json({ result: { busy: false, github_rate_limit: {}, version_info: {} } });
  });

  router.get("/server/history/list", (_req, res) => {
    res.json({ result: { count: 0, jobs: [] } });
  });

  router.get("/server/webcams/list", (_req, res) => {
    res.json({ result: { webcams: [] } }); // camera pipeline lands in a later phase
  });

  // AMS is out of scope, but OrcaSlicer probes this before deciding whether
  // to show AMS UI - an empty namespace list means it won't.
  router.get("/server/database/list", (_req, res) => {
    res.json({ result: { namespaces: [] } });
  });
  router.get("/server/database/item", (req, res) => {
    res.json({ result: { namespace: req.query.namespace, key: req.query.key, value: null } });
  });
  router.post("/server/database/item", (req, res) => {
    res.json({ result: { namespace: req.body?.namespace, key: req.body?.key, value: req.body?.value ?? null } });
  });

  // OctoPrint-compat shim, since OrcaSlicer's uploader also probes this.
  router.get("/api/version", (_req, res) => {
    res.json({ api: "0.1", server: "1.9.0", text: "OctoPrint (KobraMorda Bridge)" });
  });

  return router;
}
