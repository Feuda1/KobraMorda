import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import express, { Router } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { fetchKobraXCredentials } from "./credentials.js";
import { KobraXMqttClient } from "./mqttClient.js";
import { PrinterTelemetry } from "./telemetry.js";
import { ModelStore } from "./modelStore.js";
import { AmsOverrideStore } from "./amsOverrides.js";
import { CameraPipeline } from "./camera.js";
import { TimelapseRecorder } from "./timelapse.js";
import { createMoonrakerApi } from "./moonrakerApi.js";
import { attachMoonrakerWs, MOONRAKER_WS_PATH } from "./moonrakerWs.js";
import { attachDashboardWs, DASHBOARD_WS_PATH } from "./dashboardWs.js";
import { attachCameraWs, CAMERA_WS_PATH } from "./cameraWs.js";
import { createApiRoutes } from "./apiRoutes.js";
import { createInitialState, type PrinterState } from "./state.js";
import { currentAmsSlots, type BridgeContext } from "./bridgeContext.js";
import { HistoryRecorder, type HistoryEntry } from "./history.js";
import { SpoolLinkStore, type SpoolmanClient } from "./spoolman.js";

export interface PrinterConfig {
  id: string;
  name: string;
  ip: string;
  /** Extra listening port with a Moonraker-compatible host for this printer (OrcaSlicer). The first printer uses the main port. */
  port?: number;
}

export type PrinterLinkStatus = "connecting" | "online" | "offline";

const CERT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "certs");
const RETRY_MS = 10_000;

/** Network failures as a short Russian message instead of the raw fetch/socket error. */
function humanError(err: Error): string {
  if (/[а-яё]/i.test(err.message)) return err.message;
  if (/timeout|aborted|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|fetch failed|ECONN/i.test(err.message)) {
    return "Принтер не отвечает";
  }
  return "Не удалось подключиться";
}
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Everything that belongs to one physical printer: MQTT session, telemetry,
 * models, AMS overrides, camera, timelapse and the HTTP/WS surface. It keeps
 * trying to reach the printer in the background, so an offline printer never
 * blocks startup or the other printers.
 */
export class PrinterInstance extends EventEmitter {
  status: PrinterLinkStatus = "connecting";
  lastError = "";
  ctx: BridgeContext | undefined;
  camera: CameraPipeline | undefined;
  timelapse: TimelapseRecorder | undefined;

  private router: Router | undefined;
  private wss: { moonraker: WebSocketServer; dashboard: WebSocketServer; camera: WebSocketServer } | undefined;
  private mqtt: KobraXMqttClient | undefined;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private cameraCaptureRequested = false;
  private intervals: NodeJS.Timeout[] = [];

  /** Placeholder state shown while the printer is unreachable. */
  private readonly offlineState: PrinterState;
  /** Dashboard sockets opened before the printer came online. */
  private readonly pendingDashboard = new Set<WebSocket>();
  private offlineWss: WebSocketServer | undefined;

  constructor(
    readonly config: PrinterConfig,
    readonly dataDir: string,
    private readonly bridgeOrigin: string,
    private readonly spoolman: SpoolmanClient,
  ) {
    super();
    this.offlineState = { ...createInitialState(), printerName: config.name };
  }

  get state(): PrinterState {
    return this.ctx?.telemetry.state ?? this.offlineState;
  }

  /** Base URL the printer itself uses to fetch files from us. */
  get baseUrl(): string {
    return `${this.bridgeOrigin}/p/${this.config.id}`;
  }

  start() {
    void this.connectLoop();
  }

  private async connectLoop() {
    while (!this.stopped) {
      this.status = "connecting";
      this.emit("status");
      let client: KobraXMqttClient | undefined;
      try {
        const creds = await fetchKobraXCredentials(this.config.ip);
        client = new KobraXMqttClient({
          ip: this.config.ip,
          username: creds.username,
          password: creds.password,
          modeId: creds.modeId,
          deviceId: creds.deviceId,
          certPath: path.join(CERT_DIR, "anycubic_slicer.crt"),
          keyPath: path.join(CERT_DIR, "anycubic_slicer.key"),
          clientId: `kobramorda-${this.config.id}`.slice(0, 23),
        });
        client.on("error", (err: Error) => {
          this.lastError = err.message;
        });
        await Promise.race([
          client.connect(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("Принтер не отвечает по MQTT")), CONNECT_TIMEOUT_MS),
          ),
        ]);
        if (this.stopped) {
          await client.disconnect().catch(() => {});
          return;
        }
        this.wire(client);
        this.status = "online";
        this.lastError = "";
        this.emit("status");
        return;
      } catch (err) {
        this.lastError = humanError(err as Error);
        this.status = "offline";
        this.emit("status");
        await client?.disconnect().catch(() => {});
        await new Promise<void>((r) => {
          this.retryTimer = setTimeout(r, RETRY_MS);
        });
      }
    }
  }

  private wire(mqttClient: KobraXMqttClient) {
    this.mqtt = mqttClient;
    const telemetry = new PrinterTelemetry(mqttClient);
    // the MQTT session is already up by the time telemetry is attached, so its own "connect" event was missed
    telemetry.state.connected = true;
    telemetry.state.printerName = this.config.name;
    const modelStore = new ModelStore(this.dataDir);
    const amsOverrides = new AmsOverrideStore(this.dataDir);
    const history = new HistoryRecorder(telemetry, modelStore, () => currentAmsSlots(ctx), this.dataDir);
    const spoolLinks = new SpoolLinkStore(this.dataDir);
    const ctx: BridgeContext = {
      spoolman: this.spoolman,
      spoolLinks,
      history,
      mqttClient,
      telemetry,
      modelStore,
      amsOverrides,
      bridgeBaseUrl: this.baseUrl,
      printerIp: this.config.ip,
      printerId: this.config.id,
    };
    this.ctx = ctx;

    // the name the user gave the printer wins over the firmware's own
    telemetry.on("change", () => {
      telemetry.state.printerName = this.config.name;
    });

    // a spool physically swapped in the AMS is no longer the one linked in Spoolman
    const hardwareSig = new Map<number, string>();
    telemetry.on("change", () => {
      for (const s of telemetry.state.amsSlots) {
        const sig = s.occupied ? `${s.materialType}|${s.colorHex}` : "empty";
        const before = hardwareSig.get(s.index);
        hardwareSig.set(s.index, sig);
        if (before !== undefined && before !== sig) spoolLinks.set(s.index, null);
      }
    });

    // what a finished print used is taken off the linked spools
    history.on("finished", (entry: HistoryEntry) => {
      for (const f of entry.filament) {
        const spoolId = f.slot !== null ? spoolLinks.get(f.slot) : undefined;
        if (spoolId === undefined) continue;
        this.spoolman.use(spoolId, f.grams).catch((err: Error) => console.warn("[spoolman]", err.message));
      }
    });

    mqttClient.request("light", "query", null, 3000).catch(() => {
      // light state also arrives by push
    });
    this.intervals.push(
      setInterval(() => mqttClient.queryInfo().catch(() => {}), 3000),
      setInterval(() => mqttClient.queryMulticolorBox().catch(() => {}), 5000),
    );
    mqttClient.queryInfo().catch(() => {});

    const camera = new CameraPipeline(() => telemetry.state.rtspUrl);
    this.camera = camera;
    telemetry.on("change", () => {
      if (!telemetry.state.rtspUrl) return;
      if (!this.cameraCaptureRequested) {
        this.cameraCaptureRequested = true;
        mqttClient.startCamera().catch(() => {});
      }
      camera.start();
      camera.notifyUrlMayHaveChanged();
    });
    camera.on("stalled", () => {
      mqttClient
        .stopCamera()
        .catch(() => {})
        .then(() => mqttClient.startCamera())
        .catch(() => {});
    });

    this.timelapse = new TimelapseRecorder(camera, telemetry, this.dataDir);
    this.timelapse.on("recorded", (meta: { id: string; filename: string }) => {
      history.linkTimelapse(meta.filename, meta.id);
      this.emit("timelapse", meta);
    });

    const router = Router();
    router.use(express.json());
    router.use(createMoonrakerApi(ctx));
    router.use(createApiRoutes(ctx, camera, this.timelapse));
    router.get("/serve/:filename", (req, res) => {
      const model = modelStore.getByFilename(req.params.filename);
      const data = model && modelStore.getData(model.id);
      if (!model || !data) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(data);
    });
    this.router = router;

    this.wss = {
      moonraker: attachMoonrakerWs(ctx),
      dashboard: attachDashboardWs(ctx),
      camera: attachCameraWs(camera),
    };
    // sockets opened while the printer was unreachable: close them so the page reconnects to the live channel
    for (const ws of this.pendingDashboard) ws.close();
    this.pendingDashboard.clear();

    this.emit("online", ctx);
  }

  /** Express handler for this printer's surface (mounted at /p/:id and, for the primary printer, at the root). */
  handle(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!this.router) {
      res.status(503).json({ error: "Принтер недоступен", status: this.status, detail: this.lastError });
      return;
    }
    this.router(req, res, next);
  }

  /** WebSocket upgrade for a path relative to this printer (e.g. /ws/camera). */
  handleUpgrade(pathname: string, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!this.wss) {
      if (pathname !== DASHBOARD_WS_PATH) return false;
      // offline: still let the dashboard connect and show the printer as unreachable
      this.offlineWss ??= new WebSocketServer({ noServer: true });
      this.offlineWss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "state", state: this.offlineState }));
        this.pendingDashboard.add(ws);
        ws.on("close", () => this.pendingDashboard.delete(ws));
      });
      return true;
    }
    const target =
      pathname === MOONRAKER_WS_PATH
        ? this.wss.moonraker
        : pathname === DASHBOARD_WS_PATH
          ? this.wss.dashboard
          : pathname === CAMERA_WS_PATH
            ? this.wss.camera
            : undefined;
    if (!target) return false;
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
    return true;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const t of this.intervals) clearInterval(t);
    this.camera?.stop();
    await this.mqtt?.disconnect().catch(() => {});
    for (const ws of this.pendingDashboard) ws.close();
  }

  /** Remove everything stored for this printer (models, timelapses...); the primary printer's legacy folder is left alone. */
  wipeData() {
    if (path.basename(path.dirname(this.dataDir)) === "printers") {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
    }
  }
}
