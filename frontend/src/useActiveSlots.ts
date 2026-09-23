import { useEffect, useState } from "react";
import { fetchCurrentFileDetails, fetchModel } from "./api";
import type { PrinterState } from "./types";

/** AMS slot indexes the running print draws from (empty when nothing is printing). */
export function useActiveSlots(state: PrinterState | null): number[] {
  const [slots, setSlots] = useState<number[]>([]);
  const active = state?.printState === "printing" || state?.printState === "paused";
  const filename = state?.filename;

  useEffect(() => {
    if (!active || !filename) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    fetchCurrentFileDetails()
      .then((d) => (d.id ? fetchModel(d.id) : null))
      .then((m) => {
        if (cancelled || !m) return;
        setSlots(m.toolOrder.map((t) => m.slotAssignment?.[t]).filter((s): s is number => s !== undefined));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, filename]);

  return slots;
}
