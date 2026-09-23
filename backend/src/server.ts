import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { detectLanIp } from "./net.js";
import { PrinterRegistry } from "./printerRegistry.js";
import { createPrintersApi } from "./printersApi.js";
import { TelegramBot } from "./telegram.js";
import { SpoolmanClient } from "./spoolman.js";
import type { PrinterInstance } from "./printerInstance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, "..", "..", "frontend", "dist");
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const PORT = Number(process.env.PORT ?? 7130);
const FIRST_EXTRA_PORT = PORT + 1;
const PRINTER_IP = process.env.PRINTER_IP ?? process.argv[2];

function parsePrinterPath(url: string): { id: string; rest: string } | null {
  const m = /^\/p\/([A-Za-z0-9_-]+)(\/[^?]*)?/.exec(url);
  return m ? { id: m[1], rest: m[2] ?? "/" } : null;
}

async function main() {
  const lanOrigin = `http://${detectLanIp()}:${PORT}`;
  const spoolman = new SpoolmanClient(DATA_DIR);
  const registry = new PrinterRegistry(DATA_DIR, lanOrigin, spoolman);

  // Convenience for the very first run: `npm run dev -- <ip>` adds that printer.
  if (PRINTER_IP && !registry.findByIp(PRINTER_IP)) {
    try {
      await registry.add(PRINTER_IP);
    } catch (err) {
      console.warn(`Printer ${PRINTER_IP} was not added: ${(err as Error).message}`);
    }
  }

  const telegram = new TelegramBot(registry, DATA_DIR);

  const app = express();
  app.use((req, _res, next) => {
    if (!req.path.startsWith("/ws")) console.log(`[http] ${req.method} ${req.url}`);
    next();
  });
  app.use(express.json());

  app.use(createPrintersApi(registry, telegram, spoolman));

  // /p/<id>/... - the dashboard addresses a specific printer this way.
  app.use("/p/:pid", (req, res, next) => {
    const inst = registry.get(req.params.pid);
    if (!inst) {
      res.status(404).json({ error: "Принтер не найден" });
      return;
    }
    inst.handle(req, res, next);
  });

  // Plain paths belong to the primary printer: this is what OrcaSlicer (Moonraker host) talks to.
  app.use((req, res, next) => {
    const inst = registry.primary();
    if (!inst) return next();
    if (inst.status !== "online" && !/^\/(api|server|printer|access|machine)\b/.test(req.path)) return next();
    inst.handle(req, res, next);
  });

  app.use(express.static(FRONTEND_DIST));
  app.get(/.*/, (req, res, next) => {
    if (req.method !== "GET" || req.headers.accept?.includes("application/json")) {
      next();
      return;
    }
    res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
      if (err) next();
    });
  });

  const mainServer = http.createServer(app);

  const dispatchUpgrade = (server: http.Server, resolve: (url: string) => { inst?: PrinterInstance; path: string }) => {
    server.on("upgrade", (req, socket, head) => {
      const pathname = (req.url ?? "").split("?")[0];
      const { inst, path: rel } = resolve(pathname);
      if (!inst || !inst.handleUpgrade(rel, req, socket, head)) socket.destroy();
    });
  };

  dispatchUpgrade(mainServer, (pathname) => {
    const p = parsePrinterPath(pathname);
    if (p) return { inst: registry.get(p.id), path: p.rest };
    return { inst: registry.primary(), path: pathname };
  });

  // Every printer other than the first gets its own port with a Moonraker-compatible
  // host on it, since the slicer's host field is just an address.
  const extraServers = new Map<string, http.Server>();
  const listenOnFreePort = (server: http.Server, from: number, taken: Set<number>) =>
    new Promise<number>((resolve, reject) => {
      const tryPort = (port: number) => {
        if (taken.has(port)) return tryPort(port + 1);
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") tryPort(port + 1);
          else reject(err);
        };
        server.once("error", onError);
        server.listen(port, () => {
          server.off("error", onError);
          resolve((server.address() as AddressInfo).port);
        });
      };
      tryPort(from);
    });

  const ensureExtraListener = async (inst: PrinterInstance) => {
    if (inst === registry.primary() || extraServers.has(inst.config.id)) return;
    const perPrinter = express();
    perPrinter.use((req, res, next) => inst.handle(req, res, next));
    const server = http.createServer(perPrinter);
    dispatchUpgrade(server, (pathname) => ({ inst, path: pathname }));
    const taken = new Set(registry.list().filter((i) => i !== inst).map((i) => i.config.port ?? 0));
    const port = await listenOnFreePort(server, inst.config.port ?? FIRST_EXTRA_PORT, taken);
    registry.setPort(inst.config.id, port);
    extraServers.set(inst.config.id, server);
  };

  const dropExtraListener = (inst: PrinterInstance) => {
    extraServers.get(inst.config.id)?.close();
    extraServers.delete(inst.config.id);
  };

  registry.on("added", (inst: PrinterInstance) => void ensureExtraListener(inst).catch(console.warn));
  registry.on("removed", dropExtraListener);
  for (const inst of registry.list()) await ensureExtraListener(inst).catch(console.warn);

  registry.on("online", (inst: PrinterInstance) => console.log(`[${inst.config.name}] connected`));

  mainServer.listen(PORT, () => {
    console.log(`KobraMorda listening on ${lanOrigin}`);
    console.log(`Printers: ${registry.list().map((i) => `${i.config.name} (${i.config.ip})`).join(", ") || "none yet"}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
