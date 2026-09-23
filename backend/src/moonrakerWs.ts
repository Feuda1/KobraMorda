import { WebSocketServer, WebSocket } from "ws";
import type { BridgeContext } from "./bridgeContext.js";
import { buildPrinterObjects } from "./printerObjects.js";
import { handlePrintControl, execGcodeScript, buildFileMetadata } from "./printControl.js";

interface RpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  id?: number | string;
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function normalizeParams(params: unknown): Record<string, unknown> {
  if (Array.isArray(params)) return (params[0] as Record<string, unknown>) ?? {};
  if (params && typeof params === "object") return params as Record<string, unknown>;
  return {};
}

function currentObjects(ctx: BridgeContext, omitStatic = false) {
  const filename = ctx.telemetry.state.filename;
  const model = filename ? ctx.modelStore.getByFilename(filename) : ctx.modelStore.latest();
  return buildPrinterObjects(ctx.telemetry.state, { fileMeta: model?.meta, omitStatic });
}

/**
 * Moonraker-compatible JSON-RPC 2.0 WebSocket, at /websocket. Only the
 * subset OrcaSlicer's Klipper print-host connection (and the standard
 * upstream `moonraker-obico` companion) actually use is implemented - see
 * docs/protocol-spec.md for the full traced call sequence.
 */
export const MOONRAKER_WS_PATH = "/websocket";

/**
 * Returns a `noServer` WebSocketServer - the caller (server.ts) is
 * responsible for dispatching "upgrade" events to it by pathname. Multiple
 * `ws` servers directly attached to the same http.Server each try to handle
 * every upgrade and 400 on a path mismatch instead of yielding to the next
 * one, so a single shared dispatcher is required whenever more than one WS
 * endpoint lives on the same port (see dashboardWs.ts).
 */
export function attachMoonrakerWs(ctx: BridgeContext): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    send(ws, { jsonrpc: "2.0", method: "notify_klippy_ready", params: [] });
    send(ws, { jsonrpc: "2.0", method: "notify_status_update", params: [currentObjects(ctx), Date.now() / 1000] });

    ws.on("message", async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!req.method) return;

      let result: unknown;
      try {
        result = await handleRpc(req.method, normalizeParams(req.params), ctx);
      } catch (err) {
        if (req.id !== undefined) {
          send(ws, { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: (err as Error).message } });
        }
        return;
      }
      if (req.id !== undefined) {
        send(ws, { jsonrpc: "2.0", id: req.id, result });
      }
    });
  });

  ctx.telemetry.on("change", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "notify_status_update",
      params: [currentObjects(ctx, true), Date.now() / 1000],
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  return wss;
}

async function handleRpc(method: string, params: Record<string, unknown>, ctx: BridgeContext): Promise<unknown> {
  switch (method) {
    case "printer.info":
    case "printer_info":
      return {
        state: "ready",
        state_message: "Printer is ready",
        hostname: "kobramorda",
        software_version: "0.1.0",
        cpu_info: "kobramorda-bridge",
      };

    case "server.info":
    case "server_info":
      return {
        klippy_connected: true,
        klippy_state: "ready",
        moonraker_version: "kobramorda-0.1.0",
        components: [],
        failed_components: [],
        registered_directories: ["gcodes"],
        warnings: [],
      };

    case "printer.objects.list":
      return { objects: Object.keys(currentObjects(ctx)) };

    case "printer.objects.query":
    case "printer.objects.get":
    case "printer.objects.subscribe":
      return { status: currentObjects(ctx), eventtime: Date.now() / 1000 };

    case "printer.print.start":
      await handlePrintControl("start", params, ctx);
      return "ok";
    case "printer.print.pause":
      await handlePrintControl("pause", params, ctx);
      return "ok";
    case "printer.print.resume":
      await handlePrintControl("resume", params, ctx);
      return "ok";
    case "printer.print.cancel":
      await handlePrintControl("cancel", params, ctx);
      return "ok";

    case "printer.gcode.script":
      await execGcodeScript((params.script as string) ?? "", ctx);
      return "ok";

    case "machine.system_info":
      return { system_info: { cpu_info: { cpu_desc: "Kobra X Bridge" } } };

    case "server.files.list":
      return [];

    case "server.files.metadata":
      return buildFileMetadata(ctx.modelStore, params.filename as string | undefined);

    case "server.connection.identify":
      return { connection_id: 1 };

    case "connection.register_remote_method":
      return "ok";

    case "server.webcams.list":
      return { webcams: [] }; // camera pipeline lands in a later phase

    case "server.history.list":
      return { count: 0, jobs: [] };

    case "machine.update.status":
      return { busy: false, version_info: {} };

    default:
      return {};
  }
}
