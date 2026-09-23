import { CheckCircle2, ChevronDown, Film, History as HistoryIcon, Layers, Trash2, XCircle, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteHistoryEntry, fetchHistory, pp, type HistoryEntry } from "../api";
import { formatDuration, formatGrams, formatRub } from "../format";
import { Card } from "./Card";

const RESULT_ICON = {
  complete: <CheckCircle2 size={16} style={{ color: "var(--ok)" }} />,
  cancelled: <XCircle size={16} style={{ color: "var(--text-muted)" }} />,
  error: <AlertTriangle size={16} style={{ color: "var(--err)" }} />,
  interrupted: <AlertTriangle size={16} style={{ color: "var(--warn)" }} />,
} as const;

const PAGE = 8;

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function History({ refreshKey }: { refreshKey: string }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = () =>
    fetchHistory()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));

  // refreshKey changes when a print starts/ends, so a finished job shows up without waiting for the timer
  useEffect(() => {
    reload();
    const t = setInterval(reload, 20000);
    return () => clearInterval(t);
  }, [refreshKey]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (!items || items.length === 0) return null;

  const done = items.filter((i) => i.result === "complete");
  const totalGrams = items.reduce((a, i) => a + i.totalGrams, 0);
  const totalCost = items.reduce((a, i) => a + (i.costRub ?? 0), 0);
  const totalSec = items.reduce((a, i) => a + i.durationSec, 0);

  const remove = async (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? null);
    await deleteHistoryEntry(id).catch(reload);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-muted)" }}>
          <HistoryIcon size={15} /> История
        </div>
        <div className="flex items-center gap-4 text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          <span className="flex items-center gap-1">
            <CheckCircle2 size={12} /> {done.length} / {items.length}
          </span>
          <span>{formatDuration(totalSec)}</span>
          <span>{formatGrams(totalGrams)}</span>
          {totalCost > 0 && <span>{formatRub(totalCost)}</span>}
        </div>
      </div>

      <div className="mt-3 flex flex-col">
        {items.slice(0, shown).map((e) => (
          <div key={e.id} className="group flex flex-wrap items-center gap-x-3 gap-y-2 border-t py-2.5 first:border-t-0" style={{ borderColor: "var(--border)" }}>
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg"
              style={{ background: e.hasThumbnail ? "#fff" : "var(--border)" }}
            >
              {e.hasThumbnail ? (
                <img src={pp(`/api/history/${e.id}/thumbnail`)} alt="" className="h-full w-full object-contain p-0.5" />
              ) : (
                <Layers size={18} style={{ color: "var(--text-muted)" }} />
              )}
            </div>

            <div className="min-w-0 max-w-md flex-1">
              <div className="flex items-center gap-2">
                {RESULT_ICON[e.result]}
                <span className="truncate text-sm font-medium" title={e.filename}>
                  {e.filename}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                <span>{formatDate(e.startedAt)}</span>
                <span>{formatDuration(e.durationSec)}</span>
                {e.totalLayers > 0 && e.result !== "complete" && (
                  <span>
                    {e.layersDone} / {e.totalLayers}
                  </span>
                )}
                {e.totalGrams > 0 && <span>{formatGrams(e.totalGrams)}</span>}
                {e.costRub !== null && e.costRub > 0 && <span>{formatRub(e.costRub)}</span>}
                <span className="flex items-center gap-1">
                  {e.filament.map((f) => (
                    <span
                      key={f.tool}
                      className="h-3 w-3 rounded-full border"
                      title={f.type}
                      style={{ background: f.color ? `#${f.color}` : "transparent", borderColor: "var(--border)" }}
                    />
                  ))}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {e.timelapseId && (
                <a
                  href={pp(`/api/timelapses/${e.timelapseId}/video`)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-7 w-7 items-center justify-center rounded-md"
                  style={{ background: "var(--border)", color: "var(--text-muted)" }}
                >
                  <Film size={14} />
                </a>
              )}
              <button
                onClick={() => remove(e.id)}
                className={`flex h-7 items-center justify-center rounded-md text-xs font-medium transition-opacity ${
                  confirming === e.id ? "px-2 opacity-100" : "w-7 opacity-0 group-hover:opacity-100"
                }`}
                style={{ background: confirming === e.id ? "var(--err)" : "var(--border)", color: confirming === e.id ? "#fff" : "var(--text-muted)" }}
              >
                {confirming === e.id ? "Удалить?" : <Trash2 size={13} />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {items.length > shown && (
        <button
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-2 flex w-full items-center justify-center rounded-lg py-1.5"
          style={{ background: "var(--border)", color: "var(--text-muted)" }}
        >
          <ChevronDown size={16} />
        </button>
      )}
    </Card>
  );
}
