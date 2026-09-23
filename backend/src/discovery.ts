import { detectLanIp } from "./net.js";

export interface DiscoveredPrinter {
  ip: string;
}

async function probe(ip: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:18910/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { token?: unknown; data?: { token?: unknown } };
    return typeof body.token === "string" || typeof body.data?.token === "string";
  } catch {
    return false;
  }
}

/** Looks for Kobra printers (HTTP handshake port 18910) in this machine's /24 subnet. */
export async function scanNetwork(timeoutMs = 1500): Promise<DiscoveredPrinter[]> {
  const own = detectLanIp();
  const parts = own.split(".");
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join(".");
  const candidates = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== own);

  const found: DiscoveredPrinter[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const ip = candidates[next++];
      if (await probe(ip, timeoutMs)) found.push({ ip });
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  return found.sort((a, b) => Number(a.ip.split(".")[3]) - Number(b.ip.split(".")[3]));
}
