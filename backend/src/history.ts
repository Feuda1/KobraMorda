import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { PrinterTelemetry } from "./telemetry.js";
import type { ModelStore, StoredModel } from "./modelStore.js";
import type { AmsSlot } from "./state.js";

export type PrintResult = "complete" | "cancelled" | "error" | "interrupted";

export interface HistoryFilament {
  tool: number;
  slot: number | null;
  color: string;
  type: string;
  grams: number;
}

export interface HistoryEntry {
  id: string;
  filename: string;
  startedAt: number;
  endedAt: number;
  result: PrintResult;
  durationSec: number;
  layersDone: number;
  totalLayers: number;
  filament: HistoryFilament[];
  totalGrams: number;
  costRub: number | null;
  modelId: string | null;
  hasThumbnail: boolean;
  timelapseId: string | null;
}

interface ActiveJob {
  startedAt: number;
  filename: string;
  maxLayer: number;
  totalLayers: number;
  modelId: string | null;
}

const IDLE_GRACE_MS = 90_000;
const MAX_ENTRIES = 1000;

/** Filament weight per tool from the slicer's own "filament used [g] = a, b, c" line (falls back to the total on the first tool). */
function gramsPerTool(model: StoredModel): Map<number, number> {
  const result = new Map<number, number>();
  const raw = model.meta.rawSettings["filament used [g]"];
  const parts = raw ? raw.split(",").map((p) => Number(p.trim())) : [];
  if (parts.length > 1 && parts.every((n) => Number.isFinite(n))) {
    parts.forEach((g, i) => g > 0 && result.set(i + 1, g));
  } else {
    result.set(model.meta.toolOrder[0] ?? 1, model.meta.filamentWeightG || 0);
  }
  return result;
}

/**
 * Records every print as a history entry (start, end, result, spools used,
 * filament grams, cost) by watching printer state, and keeps a per-slot
 * counter of how much has been printed from the currently loaded spool.
 * A job in progress survives a bridge restart.
 */
export class HistoryRecorder extends EventEmitter {
  private entries: HistoryEntry[] = [];
  private job: ActiveJob | null = null;
  private recovered = false;
  private idleSince = 0;
  private readonly file: string;
  private readonly activeFile: string;
  private readonly thumbDir: string;
  private readonly ledgerFile: string;
  private ledger: Record<number, { sig: string; grams: number }> = {};

  constructor(
    private readonly telemetry: PrinterTelemetry,
    private readonly modelStore: ModelStore,
    private readonly currentSlots: () => AmsSlot[],
    dataDir: string,
  ) {
    super();
    this.file = path.join(dataDir, "history.json");
    this.activeFile = path.join(dataDir, "history-active.json");
    this.thumbDir = path.join(dataDir, "history-thumbs");
    this.ledgerFile = path.join(dataDir, "spool-ledger.json");
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.entries = readJson(this.file, []);
    this.ledger = readJson(this.ledgerFile, {});

    telemetry.on("change", () => {
      this.trackSpools();
      this.onChange();
    });
    setInterval(() => this.onChange(), 30_000).unref();
  }

  list(): HistoryEntry[] {
    return this.entries;
  }

  thumbnailPath(id: string): string | null {
    const file = path.join(this.thumbDir, `${id.replace(/[^0-9]/g, "")}.png`);
    return fs.existsSync(file) ? file : null;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    fs.rmSync(path.join(this.thumbDir, `${id.replace(/[^0-9]/g, "")}.png`), { force: true });
    this.save();
    return true;
  }

  /** Grams printed from whatever spool currently sits in each slot. */
  usedGramsBySlot(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [slot, v] of Object.entries(this.ledger)) out[Number(slot)] = Math.round(v.grams * 10) / 10;
    return out;
  }

  linkTimelapse(filename: string, timelapseId: string) {
    const entry = this.entries.find((e) => e.filename === filename && !e.timelapseId);
    if (!entry) return;
    entry.timelapseId = timelapseId;
    this.save();
  }

  /** A physically replaced or removed spool starts counting from zero again. */
  private trackSpools() {
    let changed = false;
    for (const s of this.currentSlots()) {
      const sig = s.occupied ? `${s.materialType}|${s.colorHex}` : "empty";
      const known = this.ledger[s.index];
      if (!known) {
        this.ledger[s.index] = { sig, grams: 0 };
        changed = true;
      } else if (known.sig !== sig) {
        this.ledger[s.index] = { sig, grams: 0 };
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(this.ledgerFile, JSON.stringify(this.ledger));
  }

  private onChange() {
    const { printState, deviceState, filename, currentLayer, totalLayers, printDurationSec } = this.telemetry.state;
    if (!deviceState) return; // nothing real reported yet

    if (!this.recovered) {
      this.recovered = true;
      this.recover(printState, filename);
    }

    const active = printState === "printing" || printState === "paused";
    if (active && !this.job && filename) {
      const model = this.modelStore.getByFilename(filename);
      // a bridge restarted mid-print still knows how long the job has been running
      const startedAt = Date.now() - Math.max(printDurationSec, 0) * 1000;
      this.job = { startedAt, filename, maxLayer: currentLayer, totalLayers, modelId: model?.id ?? null };
      this.saveActive();
      this.emit("started", this.job);
    }

    const job = this.job;
    if (!job) return;

    if (active) {
      this.idleSince = 0;
      let dirty = false;
      if (currentLayer > job.maxLayer) {
        job.maxLayer = currentLayer;
        dirty = true;
      }
      if (totalLayers && totalLayers !== job.totalLayers) {
        job.totalLayers = totalLayers;
        dirty = true;
      }
      if (dirty) this.saveActive();
      return;
    }

    if (printState === "complete") {
      this.finish("complete");
    } else if (["stoped", "canceled"].includes(deviceState)) {
      this.finish("cancelled");
    } else if (printState === "error" || deviceState === "failed") {
      this.finish("error");
    } else if (printState === "standby") {
      // the firmware briefly reports idle around start/stop, so a real end needs it to last
      if (!this.idleSince) this.idleSince = Date.now();
      if (Date.now() - this.idleSince > IDLE_GRACE_MS) this.finish("cancelled");
    }
  }

  /** A job that was running when the bridge stopped: continue it if the same print is still going, otherwise close it out. */
  private recover(printState: string, filename: string | null) {
    const saved = readJson<ActiveJob | null>(this.activeFile, null);
    if (!saved) return;
    if ((printState === "printing" || printState === "paused") && saved.filename === filename) {
      this.job = saved;
      return;
    }
    this.job = saved;
    this.finish("interrupted");
  }

  private finish(result: PrintResult) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    this.idleSince = 0;
    fs.rmSync(this.activeFile, { force: true });

    const model = job.modelId ? this.modelStore.get(job.modelId) : this.modelStore.getByFilename(job.filename);
    const total = job.totalLayers;
    const fraction = result === "complete" ? 1 : total > 0 ? Math.min(job.maxLayer / total, 1) : 0;
    const slots = this.currentSlots();

    const filament: HistoryFilament[] = [];
    if (model) {
      for (const [tool, grams] of gramsPerTool(model)) {
        const slot = model.slotAssignment[tool] ?? null;
        const hw = slot !== null ? slots.find((s) => s.index === slot) : undefined;
        filament.push({
          tool,
          slot,
          color: hw?.occupied ? hw.colorHex : (model.meta.filamentColors[tool - 1] ?? ""),
          type: hw?.occupied ? hw.materialType : (model.meta.filamentTypes[tool - 1] ?? ""),
          grams: Math.round(grams * fraction * 10) / 10,
        });
      }
    }
    const totalGrams = Math.round(filament.reduce((a, f) => a + f.grams, 0) * 10) / 10;

    // the printed amount is taken off the spools that were actually used
    for (const f of filament) {
      if (f.slot !== null && this.ledger[f.slot]) this.ledger[f.slot].grams += f.grams;
    }
    fs.writeFileSync(this.ledgerFile, JSON.stringify(this.ledger));

    const id = String(Date.now());
    let hasThumbnail = false;
    const uri = model?.meta.thumbnailDataUri;
    if (uri) {
      const m = /^data:image\/png;base64,(.+)$/.exec(uri);
      if (m) {
        fs.writeFileSync(path.join(this.thumbDir, `${id}.png`), Buffer.from(m[1], "base64"));
        hasThumbnail = true;
      }
    }

    const endedAt = Date.now();
    const entry: HistoryEntry = {
      id,
      filename: job.filename,
      startedAt: job.startedAt,
      endedAt,
      result,
      durationSec: Math.round((endedAt - job.startedAt) / 1000),
      layersDone: result === "complete" ? total : job.maxLayer,
      totalLayers: total,
      filament,
      totalGrams,
      costRub: model?.meta.filamentCost != null ? Math.round(model.meta.filamentCost * fraction * 100) / 100 : null,
      modelId: model?.id ?? null,
      hasThumbnail,
      timelapseId: null,
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      for (const old of this.entries.splice(MAX_ENTRIES)) {
        fs.rmSync(path.join(this.thumbDir, `${old.id}.png`), { force: true });
      }
    }
    this.save();
    this.emit("finished", entry);
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.entries));
  }

  private saveActive() {
    if (this.job) fs.writeFileSync(this.activeFile, JSON.stringify(this.job));
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
