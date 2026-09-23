import { AlertTriangle, Film, Layers, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchHistory, pp, type HistoryEntry } from "../api";
import { formatDuration, formatGrams, formatRub } from "../format";
import { VideoLightbox } from "./VideoLightbox";

const FRESH_MS = 45 * 60_000;
const dismissedKey = (id: string) => `kobramorda.done.${id}`;

function wasDismissed(id: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(id)) === "1";
  } catch {
    return false;
  }
}

const THEME: Record<HistoryEntry["result"], { color: string; tint: string; title: string }> = {
  complete: { color: "var(--ok)", tint: "rgba(61,220,132,0.10)", title: "Печать завершена" },
  error: { color: "var(--err)", tint: "rgba(245,85,108,0.10)", title: "Ошибка печати" },
  cancelled: { color: "var(--text-muted)", tint: "var(--card)", title: "Печать остановлена" },
  interrupted: { color: "var(--warn)", tint: "rgba(245,181,68,0.10)", title: "Печать прервана" },
};

// small burst of dots behind the success icon - precomputed so it doesn't recompute per render
const CONFETTI = Array.from({ length: 10 }, (_, i) => {
  const angle = (i / 10) * Math.PI * 2 + i * 0.4;
  const dist = 26 + (i % 3) * 8;
  return {
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist,
    delay: i * 25,
    color: ["var(--accent)", "var(--ok)", "var(--warn)"][i % 3],
  };
});

function ResultIcon({ result }: { result: HistoryEntry["result"] }) {
  const theme = THEME[result];
  if (result === "complete") {
    return (
      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
        {CONFETTI.map((c, i) => (
          <span
            key={i}
            className="absolute h-1.5 w-1.5 rounded-full"
            style={{
              background: c.color,
              animation: `confetti-burst 0.7s ease-out ${c.delay}ms both`,
              ["--dx" as string]: `${c.x}px`,
              ["--dy" as string]: `${c.y}px`,
            }}
          />
        ))}
        <svg width="44" height="44" viewBox="0 0 44 44" className="relative">
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            stroke={theme.color}
            strokeWidth="2.5"
            strokeDasharray="120"
            strokeDashoffset="120"
            style={{ animation: "draw 0.6s ease-out forwards" }}
          />
          <path
            d="M13 23 L20 30 L32 15"
            fill="none"
            stroke={theme.color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="34"
            strokeDashoffset="34"
            style={{ animation: "draw 0.45s ease-out 0.5s forwards" }}
          />
        </svg>
      </span>
    );
  }
  const Icon = result === "error" ? AlertTriangle : XCircle;
  return (
    <span
      className="pop flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
      style={{ background: theme.tint, color: theme.color }}
    >
      <Icon size={20} />
    </span>
  );
}

/** A floating notice for the most recent finished job - success gets a small flourish, failures stay calm. */
export function DoneBanner({ printState }: { printState: string }) {
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchHistory()
      .then((r) => {
        const last = r.items[0];
        const fresh = last && Date.now() - last.endedAt < FRESH_MS && !wasDismissed(last.id);
        if (!cancelled) setEntry(fresh ? last : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [printState]);

  const theme = useMemo(() => (entry ? THEME[entry.result] : null), [entry]);

  if (!entry || !theme) return null;

  const dismiss = () => {
    setLeaving(true);
    setTimeout(() => {
      try {
        localStorage.setItem(dismissedKey(entry.id), "1");
      } catch {
        // storage unavailable - it just reappears after a reload
      }
      setEntry(null);
    }, 220);
  };

  return (
    <div
      className="fixed bottom-5 right-5 z-30 w-80"
      style={{ animation: leaving ? "toast-out 0.22s ease-in both" : "toast-in 0.45s cubic-bezier(0.2,0.8,0.2,1) both" }}
    >
      <div
        className="overflow-hidden rounded-2xl border shadow-lg backdrop-blur"
        style={{ background: "var(--card)", borderColor: "var(--border)" }}
      >
        <div className="flex items-start gap-3 p-4" style={{ background: theme.tint }}>
          {entry.hasThumbnail ? (
            <div
              className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl border"
              style={{ background: "#fff", borderColor: "var(--border)" }}
            >
              <img src={pp(`/api/history/${entry.id}/thumbnail`)} alt="" className="h-full w-full object-contain p-0.5" />
            </div>
          ) : (
            <ResultIcon result={entry.result} />
          )}

          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-sm font-semibold" style={{ color: theme.color }}>
              {theme.title}
            </div>
            <div className="mt-0.5 truncate text-sm" title={entry.filename}>
              {entry.filename}
            </div>
          </div>
          <button onClick={dismiss} className="-m-1 shrink-0 rounded-full p-1" style={{ color: "var(--text-muted)" }}>
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
            <span>{formatDuration(entry.durationSec)}</span>
            {entry.result !== "complete" && entry.totalLayers > 0 && (
              <span className="flex items-center gap-1">
                <Layers size={12} /> {entry.layersDone} / {entry.totalLayers}
              </span>
            )}
            {entry.totalGrams > 0 && <span>{formatGrams(entry.totalGrams)}</span>}
            {entry.costRub !== null && entry.costRub > 0 && <span>{formatRub(entry.costRub)}</span>}
          </div>
          {entry.timelapseId && (
            <button
              onClick={() => setPlaying(true)}
              className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium"
              style={{ background: "var(--border)", color: "var(--text)" }}
            >
              <Film size={12} /> Таймлапс
            </button>
          )}
        </div>
      </div>

      {playing && entry.timelapseId && (
        <VideoLightbox
          src={pp(`/api/timelapses/${entry.timelapseId}/video`)}
          filename={entry.filename}
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
