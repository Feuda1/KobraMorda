let activePrinter: string | null = null;

/** Which printer the per-printer endpoints (/api/..., /printer/...) talk to. */
export const setActivePrinter = (id: string | null) => {
  // "legacy" = a bridge without multi-printer support: plain, un-prefixed URLs
  activePrinter = id === LEGACY_PRINTER_ID ? null : id;
};

export const LEGACY_PRINTER_ID = "legacy";

/** Address of a per-printer endpoint under the currently selected printer. */
export const pp = (path: string) => (activePrinter ? `/p/${activePrinter}${path}` : path);

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${pp(path)}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

const req = <T,>(path: string, init?: RequestInit) => request<T>(pp(path), init);
/** Endpoints that are not tied to one printer. */
const greq = <T,>(path: string, init?: RequestInit) => request<T>(path, init);

const post = (path: string) => req(path, { method: "POST" });

export const pausePrint = () => post("/printer/print/pause");
export const resumePrint = () => post("/printer/print/resume");
export const cancelPrint = () => post("/printer/print/cancel");

export const setLight = (on: boolean) =>
  req("/api/light", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  });

export interface PrinterFile {
  filename: string;
  displayName: string;
  size: number;
  timestamp: number;
}

export const fetchPrinterFiles = () => req<{ files: PrinterFile[] }>("/api/printer-files");

export interface PrinterFileDetails {
  thumbnail: string | null;
  filamentGrams: number | null;
  estimatedTimeSec: number | null;
  layerCount: number | null;
  nozzleTemp: number | null;
  bedTemp: number | null;
}

export const fetchFileDetails = (filename: string) =>
  req<PrinterFileDetails>(`/api/printer-files/${encodeURIComponent(filename)}/thumbnail`);

export const deletePrinterFile = (filename: string) =>
  req("/api/printer-files/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames: [filename] }),
  });

export interface ToolpathMeta {
  bounds: { minX: number; maxX: number; minY: number; maxY: number; maxZ: number };
  layerZ: number[];
  groups: { title: string; start: number; layerOffsets: number[] }[];
  totalSegments: number;
  scale: number;
  originX: number;
  originY: number;
}

export async function fetchToolpath(id: string): Promise<{ meta: ToolpathMeta; data: Uint16Array | Float32Array }> {
  const [meta, bin] = await Promise.all([
    req<ToolpathMeta>(`/api/models/${id}/toolpath.json`),
    fetch(pp(`/api/models/${id}/toolpath.bin`)).then((r) => r.arrayBuffer()),
  ]);
  // A bridge started before the compact format existed sends raw float32
  // coordinates and no scale/origin - keep working against it.
  if (meta.scale === undefined) {
    return { meta: { ...meta, scale: 1, originX: 0, originY: 0 }, data: new Float32Array(bin) };
  }
  return { meta, data: new Uint16Array(bin) };
}

export interface CurrentFileDetails {
  id: string | null;
  thumbnail: string | null;
  filamentColor: string | null;
  filamentType: string | null;
  filamentGrams: number | null;
  filamentCost: number | null;
  estimatedTimeSec: number | null;
}

export const fetchCurrentFileDetails = () => req<CurrentFileDetails>("/api/current-file/thumbnail");

export interface AmsSlot {
  index: number;
  /** grams printed from the spool currently in this slot */
  usedGrams?: number;
  spoolId?: number | null;
  spoolRemaining?: number | null;
  colorHex: string;
  materialType: string;
  brand: string;
  occupied: boolean;
}

export const fetchAmsSlots = () => req<{ slots: AmsSlot[] }>("/api/ams/slots");

export const setAmsSlot = (index: number, patch: { colorHex?: string; materialType?: string; occupied?: boolean }) =>
  req<{ slots: AmsSlot[] }>(`/api/ams/slots/${index}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });

export interface ModelSummary {
  id: string;
  filename: string;
  uploadedAt: number;
  size: number;
  thumbnail: string | null;
  filamentColors: string[];
  filamentTypes: string[];
  toolOrder: number[];
  filamentGrams: number | null;
  filamentCost: number | null;
  estimatedTimeSec: number | null;
  slotAssignment: Record<number, number>;
}

export interface ModelDetails extends ModelSummary {
  rawSettings: Record<string, string>;
}

export const fetchModels = () => req<{ items: ModelSummary[] }>("/api/models");

export const fetchModel = (id: string) => req<ModelDetails>(`/api/models/${id}`);

export const assignModelSlots = (id: string, assignment: Record<number, number>) =>
  req(`/api/models/${id}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignment }),
  });

export const printModel = (id: string) => req(`/api/models/${id}/print`, { method: "POST" });

export const deleteModel = (id: string) => req(`/api/models/${id}`, { method: "DELETE" });

export interface TimelapseItem {
  id: string;
  filename: string;
  createdAt: number;
  frameCount: number;
  sizeBytes: number;
}

export const fetchTimelapseSettings = () =>
  req<{ enabled: boolean; recording: boolean }>("/api/timelapse/settings");

export const setTimelapseEnabled = (enabled: boolean) =>
  req("/api/timelapse/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

export const fetchTimelapses = () => req<{ items: TimelapseItem[] }>("/api/timelapses");

export const deleteTimelapse = (id: string) => req(`/api/timelapses/${id}`, { method: "DELETE" });

// ---- printers -------------------------------------------------------------------

export interface PrinterSummary {
  id: string;
  name: string;
  ip: string;
  status: "connecting" | "online" | "offline";
  error: string;
  printState: PrinterStateName;
  deviceState: string;
  filename: string | null;
  progress: number;
  currentLayer: number;
  totalLayers: number;
  remainTimeSec: number;
  nozzleTemp: number;
  bedTemp: number;
  orcaHost: string;
}

type PrinterStateName = "standby" | "printing" | "paused" | "complete" | "error";

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fetchPrinters = () => greq<{ items: PrinterSummary[] }>("/api/printers");
export const addPrinter = (ip: string, name?: string) =>
  greq<PrinterSummary>("/api/printers", { method: "POST", ...json({ ip, name }) });
export const renamePrinter = (id: string, name: string) =>
  greq(`/api/printers/${id}`, { method: "PATCH", ...json({ name }) });
export const removePrinter = (id: string) => greq(`/api/printers/${id}`, { method: "DELETE" });
export const scanPrinters = () =>
  greq<{ items: Array<{ ip: string; added: boolean }> }>("/api/printers/scan", { method: "POST" });

// ---- telegram -------------------------------------------------------------------

export interface TelegramInfo {
  status: "off" | "connecting" | "ok" | "error";
  error: string;
  botName: string;
  hasToken: boolean;
  proxy: string;
  chats: Array<{ id: number; name: string }>;
  pairingCode: string;
  notify: { started: boolean; finished: boolean; failed: boolean; milestones: boolean };
}

export const fetchTelegram = () => greq<TelegramInfo>("/api/telegram");
export const updateTelegram = (patch: {
  token?: string;
  proxy?: string;
  notify?: Partial<TelegramInfo["notify"]>;
}) => greq<TelegramInfo>("/api/telegram", { method: "POST", ...json(patch) });
export const resetTelegramPairing = () => greq<TelegramInfo>("/api/telegram/pairing/reset", { method: "POST" });
export const removeTelegramChat = (id: number) => greq<TelegramInfo>(`/api/telegram/chats/${id}`, { method: "DELETE" });
export const testTelegram = () => greq("/api/telegram/test", { method: "POST" });

// ---- history --------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  filename: string;
  startedAt: number;
  endedAt: number;
  result: "complete" | "cancelled" | "error" | "interrupted";
  durationSec: number;
  layersDone: number;
  totalLayers: number;
  filament: Array<{ tool: number; slot: number | null; color: string; type: string; grams: number }>;
  totalGrams: number;
  costRub: number | null;
  modelId: string | null;
  hasThumbnail: boolean;
  timelapseId: string | null;
}

export const fetchHistory = () => req<{ items: HistoryEntry[] }>("/api/history");
export const deleteHistoryEntry = (id: string) => req(`/api/history/${id}`, { method: "DELETE" });

// ---- spoolman -------------------------------------------------------------------

export interface SpoolInfo {
  id: number;
  name: string;
  material: string;
  colorHex: string;
  vendor: string;
  remainingWeight: number | null;
}

export const fetchSpoolmanSettings = () => greq<{ url: string; ok: boolean }>("/api/spoolman");
export const setSpoolmanUrl = (url: string) =>
  greq<{ url: string; ok: boolean }>("/api/spoolman", { method: "POST", ...json({ url }) });
export const fetchSpools = () => greq<{ items: SpoolInfo[] }>("/api/spoolman/spools");
export const linkSpool = (slot: number, spoolId: number | null) =>
  req(`/api/spoolman/links/${slot}`, { method: "POST", ...json({ spoolId }) });
