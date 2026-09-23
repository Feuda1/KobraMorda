export function formatDuration(totalSec: number): string {
  if (!totalSec || totalSec <= 0) return "0 мин";
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export function formatClockTime(fromNowSec: number): string {
  const finish = new Date(Date.now() + fromNowSec * 1000);
  return finish.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

const STATE_LABELS: Record<string, string> = {
  standby: "Ожидание",
  printing: "Печать",
  paused: "Пауза",
  complete: "Готово",
  error: "Ошибка",
};

import type { PrinterState } from "./types";

/**
 * Heating / leveling / purging before the first layer. Deliberately NOT
 * based on the firmware's named sub-stage (`deviceState`) anymore - verified
 * live that its "printing" state string is not exclusively "a layer is
 * actually extruding": it can appear as a generic "job accepted" signal the
 * moment a print is queued, before heating even finishes, then the state
 * regresses to a specific prep name like "auto_leveling" afterwards. That
 * made the dashboard briefly claim real printing during heating. The one
 * field the firmware only reports >0 once it has actually started a layer
 * is `currentLayer`, so that alone decides prep now, matching the backend's
 * own `isPrePrintState`.
 */
export function isPreparing(s: PrinterState): boolean {
  return s.printState === "printing" && s.currentLayer <= 0;
}

/** Progress 0..1 that never shows the firmware's bogus "100%" at job start. */
export function displayProgress(s: PrinterState): number {
  if (isPreparing(s)) return 0;
  const byLayer = s.totalLayers > 0 ? s.currentLayer / s.totalLayers : null;
  if (byLayer !== null && s.progress >= 0.99 && byLayer < 0.5) return byLayer;
  return Math.min(Math.max(s.progress, 0), 1);
}

export function printStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** Fixed to `digits` decimals, then trims a trailing ".0"/".00" - keeps real precision without cluttering round numbers. */
function trimmed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * The cost stored server-side is already kopeck-accurate (rounded to 2
 * decimals from OrcaSlicer's own filament cost, see history.ts) - showing
 * it as a whole ruble regardless of magnitude threw that precision away for
 * no reason. Real money, so it keeps up to 2 decimals.
 */
export function formatRub(value: number): string {
  return `${trimmed(value, 2)} ₽`;
}

/** Filament weight is stored to 0.1 g (see history.ts) - round display to match instead of throwing that away too. */
export function formatGrams(g: number): string {
  return `${trimmed(g, 1)} г`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

