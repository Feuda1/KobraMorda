import { useRef, useState } from "react";

/**
 * Vertical two-thumb layer slider modelled on OrcaSlicer's: the top thumb
 * is the highest layer shown, the bottom one the lowest, everything between
 * is drawn. Thumbs stop at each other instead of crossing. Drag a thumb, or
 * click the track to move the nearest one; arrow keys nudge the last-used
 * thumb (Shift = 10 layers). `locked` shows the same control read-only (the
 * live print view drives it).
 */
export function LayerSlider({
  count,
  low,
  high,
  onChange,
  locked = false,
  heightOf,
}: {
  count: number;
  low: number;
  high: number;
  onChange: (low: number, high: number) => void;
  locked?: boolean;
  heightOf: (layer: number) => number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const active = useRef<"low" | "high">("high");
  const [dragging, setDragging] = useState(false);
  const max = Math.max(count - 1, 1);

  const pct = (layer: number) => (1 - layer / max) * 100; // 0% = top of the track

  const layerAt = (clientY: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const t = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1);
    return Math.round((1 - t) * max);
  };

  const move = (which: "low" | "high", layer: number) => {
    if (which === "high") onChange(low, Math.max(layer, low));
    else onChange(Math.min(layer, high), high);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (locked) return;
    const layer = layerAt(e.clientY);
    // grab the nearer thumb; on a tie prefer the one that can actually move
    const dLow = Math.abs(layer - low);
    const dHigh = Math.abs(layer - high);
    active.current = dLow < dHigh || (dLow === dHigh && layer < low) ? "low" : "high";
    move(active.current, layer);
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || locked) return;
    move(active.current, layerAt(e.clientY));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (locked) return;
    const step = e.shiftKey ? 10 : 1;
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const current = active.current === "high" ? high : low;
    move(active.current, Math.min(Math.max(current + dir * step, 0), count - 1));
  };

  const Thumb = ({ layer, which }: { layer: number; which: "low" | "high" }) => (
    <div className="absolute left-1/2 z-10 -translate-x-1/2 -translate-y-1/2" style={{ top: `${pct(layer)}%` }}>
      <div
        className="h-4 w-4 rounded-full border-2"
        style={{
          background: locked ? "var(--card)" : "#fff",
          borderColor: "var(--accent)",
          boxShadow: dragging && active.current === which ? "0 0 0 4px rgba(59,178,246,0.25)" : "none",
        }}
      />
      <div
        className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] tabular-nums"
        style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--text)" }}
      >
        {layer + 1} · {heightOf(layer).toFixed(2)}
      </div>
    </div>
  );

  return (
    <div
      tabIndex={locked ? -1 : 0}
      onKeyDown={onKeyDown}
      className="relative h-full w-32 shrink-0 outline-none"
      style={{ touchAction: "none", cursor: locked ? "default" : "pointer" }}
    >
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="absolute bottom-3 right-2 top-3 w-8"
      >
        <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full" style={{ background: "var(--border)" }} />
        <div
          className="absolute left-1/2 w-1 -translate-x-1/2 rounded-full"
          style={{ top: `${pct(high)}%`, bottom: `${100 - pct(low)}%`, background: "var(--accent)" }}
        />
        <Thumb layer={low} which="low" />
        <Thumb layer={high} which="high" />
      </div>
    </div>
  );
}
