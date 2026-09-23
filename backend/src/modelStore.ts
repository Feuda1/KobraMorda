import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseGcodeMeta, parseLayerHeightFromFilename, type GcodeMeta } from "./gcodeMeta.js";

export interface StoredModel {
  id: string;
  filename: string;
  uploadedAt: number;
  size: number;
  md5: string;
  meta: GcodeMeta;
  /** tool index (1-based, matches meta.toolOrder) -> AMS slot index (0-based) the user picked for this model. */
  slotAssignment: Record<number, number>;
}

/**
 * Every file uploaded from OrcaSlicer (plain "Upload", not "Upload and
 * print") lands here as a persistent entry - this is the "loaded models"
 * browser: review settings, pick which physical AMS slot each color in the
 * file should use, then print. Persisted to disk (index + raw .gcode per
 * model) so the browser survives a bridge restart.
 */
export class ModelStore {
  private readonly items = new Map<string, StoredModel>();
  private readonly filesDir: string;
  private readonly indexFile: string;

  constructor(dataDir: string) {
    this.filesDir = path.join(dataDir, "models");
    this.indexFile = path.join(dataDir, "models-index.json");
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.loadIndex();
  }

  private loadIndex() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as StoredModel[];
      for (const model of raw) this.items.set(model.id, model);
    } catch {
      // no index yet - fine on first run
    }
  }

  private saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify([...this.items.values()]));
  }

  add(filename: string, data: Buffer): StoredModel {
    const meta = parseGcodeMeta(data);
    if (!meta.layerHeightMm) {
      meta.layerHeightMm = parseLayerHeightFromFilename(filename) ?? 0;
    }
    const id = String(Date.now());
    const model: StoredModel = {
      id,
      filename,
      uploadedAt: Date.now(),
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
      meta,
      slotAssignment: {},
    };
    fs.writeFileSync(path.join(this.filesDir, `${id}.gcode`), data);
    this.items.set(id, model);
    this.saveIndex();
    return model;
  }

  get(id: string): StoredModel | undefined {
    return this.items.get(id);
  }

  /** Most recent upload matching this filename - used for Moonraker's "current file" semantics. */
  getByFilename(filename: string): StoredModel | undefined {
    return this.list().find((m) => m.filename === filename);
  }

  /** Most recently uploaded model overall. */
  latest(): StoredModel | undefined {
    return this.list()[0];
  }

  list(): StoredModel[] {
    return [...this.items.values()].sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  getData(id: string): Buffer | undefined {
    try {
      return fs.readFileSync(path.join(this.filesDir, `${id}.gcode`));
    } catch {
      return undefined;
    }
  }

  setAssignment(id: string, assignment: Record<number, number>): boolean {
    const model = this.items.get(id);
    if (!model) return false;
    model.slotAssignment = assignment;
    this.saveIndex();
    return true;
  }

  delete(id: string): boolean {
    const existed = this.items.delete(id);
    try {
      fs.rmSync(path.join(this.filesDir, `${id}.gcode`));
    } catch {
      // already gone
    }
    if (existed) this.saveIndex();
    return existed;
  }
}
