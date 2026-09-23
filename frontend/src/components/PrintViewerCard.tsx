import { lazy, Suspense, useEffect, useState } from "react";
import { isPreparing } from "../format";
import { fetchCurrentFileDetails } from "../api";
import type { PrinterState } from "../types";

// three.js is a heavy dependency - only fetched once a 3D view is actually shown.
const ToolpathViewer = lazy(() => import("./ToolpathViewer").then((m) => ({ default: m.ToolpathViewer })));

/** Id of the stored model matching the active print, or null (e.g. a file that didn't go through this bridge). */
export function useLiveModelId(state: PrinterState | null): string | null {
  const [modelId, setModelId] = useState<string | null>(null);
  const active = state?.printState === "printing" || state?.printState === "paused";
  const filename = state?.filename;

  // The printer's reports flicker between "printing" and idle/no-file during
  // preparation and right after start - so once a live model is found, keep
  // it through short gaps instead of tearing the 3D view down and up again.
  useEffect(() => {
    if (active && filename) {
      fetchCurrentFileDetails()
        .then((d) => d.id && setModelId(d.id))
        .catch(() => {});
      return;
    }
    const t = setTimeout(() => setModelId(null), 30000);
    return () => clearTimeout(t);
  }, [active, filename]);

  return modelId;
}

/** Live layer-by-layer 3D view, sized to sit beside the camera. */
export function PrintViewerCard({ modelId, state }: { modelId: string; state: PrinterState }) {
  return (
    <div
      className="aspect-video w-full overflow-hidden rounded-2xl border"
      style={{ background: "var(--card)", borderColor: "var(--border)" }}
    >
      <Suspense fallback={<div className="skeleton h-full w-full" />}>
        <ToolpathViewer modelId={modelId} live liveLayer={isPreparing(state) ? 0 : state.currentLayer} />
      </Suspense>
    </div>
  );
}
