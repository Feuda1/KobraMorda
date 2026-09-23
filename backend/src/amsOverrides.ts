import fs from "node:fs";
import path from "node:path";
import type { AmsSlot } from "./state.js";

export interface AmsSlotOverride {
  colorHex?: string;
  materialType?: string;
  /** Explicit user correction of occupancy - e.g. marking a slot empty when the printer's stale status still claims otherwise. */
  occupied?: boolean;
}

/**
 * This AMS unit has no RFID/weight sensing - verified live that
 * multiColorBox/report keeps reporting whatever was last configured
 * (including a flat, meaningless 100% on every slot) regardless of what's
 * physically loaded, and swapping a spool by hand doesn't change it.
 * Writing a correction back via the firmware's own multiColorBox "setInfo"
 * command was tested live too: the printer rejects it outright (code 10501,
 * "设置失败" / "setting failed") - not merely unreliable, it flatly doesn't
 * work on this firmware. So slot color/material is tracked here instead, as
 * the actual source of truth for our dashboard and for what we tell the
 * printer to print with. Remaining-quantity tracking is deliberately NOT
 * offered anywhere - there's no sensor to ever make that honest, and a
 * manually-typed number would just be theater.
 */
export class AmsOverrideStore {
  private overrides: Record<number, AmsSlotOverride> = {};
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "ams-overrides.json");
    try {
      this.overrides = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.overrides = {};
    }
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.overrides));
  }

  set(index: number, patch: AmsSlotOverride) {
    this.overrides[index] = { ...this.overrides[index], ...patch };
    this.save();
  }

  clear(index: number) {
    delete this.overrides[index];
    this.save();
  }

  apply(slots: AmsSlot[]): AmsSlot[] {
    return slots.map((s) => {
      const o = this.overrides[s.index];
      if (!o) return s;
      return {
        ...s,
        colorHex: o.colorHex ?? s.colorHex,
        materialType: o.materialType ?? s.materialType,
        // Setting a color/material is itself a declaration that the slot is
        // loaded; an explicit `occupied` (e.g. "mark empty") always wins.
        occupied: o.occupied ?? (o.colorHex || o.materialType ? true : s.occupied),
      };
    });
  }
}
