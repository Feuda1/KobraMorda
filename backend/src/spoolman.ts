import fs from "node:fs";
import path from "node:path";

export interface SpoolInfo {
  id: number;
  name: string;
  material: string;
  colorHex: string;
  vendor: string;
  remainingWeight: number | null;
}

interface SpoolmanSpool {
  id: number;
  remaining_weight?: number;
  archived?: boolean;
  filament?: {
    name?: string;
    material?: string;
    color_hex?: string;
    vendor?: { name?: string };
  };
}

const CACHE_MS = 15_000;

/**
 * Minimal client for a Spoolman server (https://github.com/Donkie/Spoolman):
 * lists spools so they can be linked to AMS slots, and reports the filament
 * a finished print used against the linked spool.
 */
export class SpoolmanClient {
  private url = "";
  private readonly file: string;
  private cache: { at: number; items: SpoolInfo[] } | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "spoolman.json");
    try {
      this.url = String(JSON.parse(fs.readFileSync(this.file, "utf8")).url ?? "");
    } catch {
      // not configured yet
    }
  }

  getUrl(): string {
    return this.url;
  }

  setUrl(url: string) {
    this.url = url.trim().replace(/\/+$/, "");
    this.cache = null;
    fs.writeFileSync(this.file, JSON.stringify({ url: this.url }));
  }

  get enabled(): boolean {
    return this.url !== "";
  }

  private async call<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}/api/v1${apiPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Spoolman: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async check(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.call("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }

  async spools(): Promise<SpoolInfo[]> {
    if (!this.enabled) return [];
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.items;
    const raw = await this.call<SpoolmanSpool[]>("GET", "/spool");
    const items = raw
      .filter((s) => !s.archived)
      .map(
        (s): SpoolInfo => ({
          id: s.id,
          name: s.filament?.name ?? `#${s.id}`,
          material: s.filament?.material ?? "",
          colorHex: (s.filament?.color_hex ?? "").replace("#", "").toUpperCase(),
          vendor: s.filament?.vendor?.name ?? "",
          remainingWeight: typeof s.remaining_weight === "number" ? Math.round(s.remaining_weight) : null,
        }),
      );
    this.cache = { at: Date.now(), items };
    return items;
  }

  /** Subtracts printed grams from a spool. */
  async use(spoolId: number, grams: number) {
    if (!this.enabled || grams <= 0) return;
    await this.call("PUT", `/spool/${spoolId}/use`, { use_weight: grams });
    this.cache = null;
  }
}

/** Which Spoolman spool sits in which AMS slot of one printer. */
export class SpoolLinkStore {
  private links: Record<number, number> = {};
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "spool-links.json");
    try {
      this.links = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // no links yet
    }
  }

  all(): Record<number, number> {
    return { ...this.links };
  }

  get(slot: number): number | undefined {
    return this.links[slot];
  }

  set(slot: number, spoolId: number | null) {
    if (spoolId === null) delete this.links[slot];
    else this.links[slot] = spoolId;
    fs.writeFileSync(this.file, JSON.stringify(this.links));
  }
}
