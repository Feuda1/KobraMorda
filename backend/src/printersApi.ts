import { Router } from "express";
import type { PrinterRegistry } from "./printerRegistry.js";
import type { PrinterInstance } from "./printerInstance.js";
import { scanNetwork } from "./discovery.js";
import { detectLanIp } from "./net.js";
import type { TelegramBot } from "./telegram.js";
import type { SpoolmanClient } from "./spoolman.js";
import type { Updater } from "./updater.js";

const MAIN_PORT = Number(process.env.PORT ?? 7130);

function summary(inst: PrinterInstance, isPrimary: boolean) {
  const s = inst.state;
  return {
    id: inst.config.id,
    name: inst.config.name,
    ip: inst.config.ip,
    status: inst.status,
    error: inst.status === "online" ? "" : inst.lastError,
    printState: s.printState,
    deviceState: s.deviceState,
    filename: s.filename,
    progress: s.progress,
    currentLayer: s.currentLayer,
    totalLayers: s.totalLayers,
    remainTimeSec: s.remainTimeSec,
    nozzleTemp: s.nozzleTemp,
    bedTemp: s.bedTemp,
    // where OrcaSlicer's "host" for this printer points
    orcaHost: `${detectLanIp()}:${isPrimary ? MAIN_PORT : (inst.config.port ?? MAIN_PORT)}`,
  };
}

interface UpdateProgress {
  running: boolean;
  step: string;
  error: string;
  done: boolean;
}

/** Printer management (list / add / rename / remove / network scan) - independent of any single printer. */
export function createPrintersApi(
  registry: PrinterRegistry,
  telegram: TelegramBot,
  spoolman: SpoolmanClient,
  updater: Updater,
  bridgeLogFile: string,
): Router {
  const router = Router();
  let progress: UpdateProgress = { running: false, step: "", error: "", done: false };

  router.get("/api/printers", (_req, res) => {
    const primary = registry.primary();
    res.json({ items: registry.list().map((i) => summary(i, i === primary)) });
  });

  router.post("/api/printers", async (req, res) => {
    try {
      const inst = await registry.add(String(req.body?.ip ?? ""), req.body?.name);
      res.status(201).json(summary(inst, inst === registry.primary()));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/printers/scan", async (_req, res) => {
    const found = await scanNetwork();
    res.json({ items: found.map((f) => ({ ip: f.ip, added: !!registry.findByIp(f.ip) })) });
  });

  router.patch("/api/printers/:id", (req, res) => {
    try {
      registry.rename(req.params.id, String(req.body?.name ?? ""));
      res.json({ result: "ok" });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/printers/:id", async (req, res) => {
    try {
      await registry.remove(req.params.id);
      res.json({ result: "ok" });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/api/telegram", (_req, res) => {
    res.json(telegram.publicSettings());
  });

  router.post("/api/telegram", (req, res) => {
    const b = req.body ?? {};
    telegram.update({
      token: typeof b.token === "string" ? b.token : undefined,
      proxy: typeof b.proxy === "string" ? b.proxy : undefined,
      notify: typeof b.notify === "object" && b.notify ? b.notify : undefined,
    });
    res.json(telegram.publicSettings());
  });

  router.post("/api/telegram/pairing/reset", (_req, res) => {
    telegram.resetPairing();
    res.json(telegram.publicSettings());
  });

  router.post("/api/telegram/test", async (_req, res) => {
    try {
      await telegram.sendTest();
      res.json({ result: "ok" });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/telegram/chats/:id", (req, res) => {
    telegram.removeChat(Number(req.params.id));
    res.json(telegram.publicSettings());
  });

  router.get("/api/spoolman", async (_req, res) => {
    res.json({ url: spoolman.getUrl(), ok: spoolman.enabled ? await spoolman.check() : false });
  });

  router.post("/api/spoolman", async (req, res) => {
    spoolman.setUrl(String(req.body?.url ?? ""));
    res.json({ url: spoolman.getUrl(), ok: spoolman.enabled ? await spoolman.check() : false });
  });

  router.get("/api/spoolman/spools", async (_req, res) => {
    try {
      res.json({ items: await spoolman.spools() });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/api/update/status", async (_req, res) => {
    res.json(await updater.status());
  });

  router.get("/api/update/progress", (_req, res) => {
    res.json(progress);
  });

  // Fire-and-forget: responds immediately, progress is polled separately,
  // and the process restarts itself once the rebuild succeeds (see Updater.restart).
  router.post("/api/update/apply", (_req, res) => {
    if (progress.running) {
      res.status(409).json({ error: "Обновление уже выполняется" });
      return;
    }
    progress = { running: true, step: "Проверка", error: "", done: false };
    res.json({ result: "started" });
    void (async () => {
      try {
        await updater.apply((step) => {
          progress.step = step;
        });
        progress = { running: false, step: "Готово", error: "", done: true };
        // give the frontend's next poll a moment to see "done" before the process exits
        setTimeout(() => updater.restart(bridgeLogFile), 800);
      } catch (err) {
        progress = { running: false, step: "", error: (err as Error).message, done: false };
      }
    })();
  });

  return router;
}
