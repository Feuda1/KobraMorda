import { WebSocketServer, WebSocket } from "ws";
import type { BridgeContext } from "./bridgeContext.js";

export const DASHBOARD_WS_PATH = "/ws/dashboard";

/**
 * Simple JSON WebSocket for our OWN frontend, deliberately kept separate
 * from the strict Moonraker-shaped /websocket so that surface never has to
 * bend to fit dashboard-specific needs (or vice versa).
 *
 * `noServer` mode - see moonrakerWs.ts for why a shared upgrade dispatcher
 * (in server.ts) is required instead of each WS server attaching itself
 * directly to the http.Server.
 */
export function attachDashboardWs(ctx: BridgeContext): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = () => {
    const payload = JSON.stringify({ type: "state", state: ctx.telemetry.state });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "state", state: ctx.telemetry.state }));
  });

  ctx.telemetry.on("change", broadcast);

  return wss;
}
