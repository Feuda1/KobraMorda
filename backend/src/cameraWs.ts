import { WebSocketServer, WebSocket } from "ws";
import type { CameraPipeline } from "./camera.js";

export const CAMERA_WS_PATH = "/ws/camera";

/**
 * Binary-frame WebSocket delivery for our own dashboard's camera view.
 * The HTTP multipart/x-mixed-replace endpoint (/api/camera/stream) stays
 * available for external Moonraker-style consumers, but rendering that in
 * our own <img> proved unreliable in-browser (verified: server-side stream
 * is fine via curl, yet the tag shows nothing) - binary WS frames swapped
 * into an object URL is the more robust cross-browser pattern for live
 * MJPEG-ish viewing, same idea most browser-based camera viewers use.
 */
export function attachCameraWs(camera: CameraPipeline): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    const onFrame = (frame: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    };
    camera.on("frame", onFrame);

    const current = camera.getSnapshot();
    if (current) onFrame(current);

    ws.on("close", () => camera.off("frame", onFrame));
  });

  return wss;
}
