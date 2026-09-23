import { networkInterfaces } from "node:os";

/** Best-effort detection of this machine's LAN IPv4 address (not localhost). */
export function detectLanIp(): string {
  if (process.env.BRIDGE_HOST_IP) {
    return process.env.BRIDGE_HOST_IP;
  }
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}
