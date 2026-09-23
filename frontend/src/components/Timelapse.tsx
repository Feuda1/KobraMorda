import { ChevronDown, Circle, Film, Play, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  deleteTimelapse,
  pp,
  fetchTimelapseSettings,
  fetchTimelapses,
  setTimelapseEnabled,
  type TimelapseItem,
} from "../api";
import { formatBytes } from "../format";
import { useShowMore } from "../useShowMore";
import { Card } from "./Card";
import { VideoLightbox } from "./VideoLightbox";

/** Rows revealed at a time in a thumbnail grid (2 rows of the widest, 6-column layout). */
const GRID_PAGE = 12;

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative inline-block h-6 w-11 shrink-0 rounded-full border-0 p-0 transition-colors"
      style={{ background: on ? "var(--accent)" : "var(--border)" }}
    >
      <span
        className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform"
        style={{ background: "#fff", transform: on ? "translateX(20px)" : "translateX(0)" }}
      />
    </button>
  );
}

export function Timelapse() {
  const [enabled, setEnabled] = useState(false);
  const [recording, setRecording] = useState(false);
  const [items, setItems] = useState<TimelapseItem[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [playing, setPlaying] = useState<TimelapseItem | null>(null);
  const suppressSettingsUntil = useRef(0);
  const { shown, hasMore, showMore } = useShowMore(items?.length ?? 0, GRID_PAGE);

  const reload = () => {
    if (Date.now() >= suppressSettingsUntil.current) {
      fetchTimelapseSettings().then((r) => {
        setEnabled(r.enabled);
        setRecording(r.recording);
      });
    }
    fetchTimelapses()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    suppressSettingsUntil.current = Date.now() + 5000;
    try {
      await setTimelapseEnabled(next);
    } catch {
      setEnabled(!next);
      suppressSettingsUntil.current = 0;
    }
  };

  const onDeleteClick = async (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? null);
    try {
      await deleteTimelapse(id);
    } catch {
      reload();
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-muted)" }}>
          <Film size={15} /> Таймлапс
          {recording && <Circle size={8} fill="var(--err)" color="var(--err)" />}
        </div>
        <Toggle on={enabled} onClick={toggle} />
      </div>

      {items && items.length === 0 && (
        <div className="flex h-24 items-center justify-center" style={{ color: "var(--border)" }}>
          <Film size={28} />
        </div>
      )}

      {items && items.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {items.slice(0, shown).map((it) => (
            <div key={it.id} className="group lift relative rounded-lg">
              <button
                onClick={() => setPlaying(it)}
                className="flex aspect-square w-full items-center justify-center rounded-lg"
                style={{ background: "var(--border)" }}
              >
                <Play size={20} style={{ color: "var(--text-muted)" }} />
              </button>
              <div className="mt-1.5 truncate text-xs font-medium" title={it.filename}>
                {it.filename}
              </div>
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                {formatBytes(it.sizeBytes)}
              </div>
              <button
                onClick={() => onDeleteClick(it.id)}
                className={`absolute right-1 top-1 flex h-6 items-center justify-center rounded-md text-xs font-medium transition-opacity ${
                  confirming === it.id ? "px-2 opacity-100" : "w-6 opacity-0 group-hover:opacity-100"
                }`}
                style={{ background: confirming === it.id ? "var(--err)" : "rgba(0,0,0,0.55)", color: "#fff" }}
              >
                {confirming === it.id ? "Удалить?" : <Trash2 size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
      {hasMore && (
        <button
          onClick={showMore}
          className="mt-3 flex w-full items-center justify-center rounded-lg py-1.5"
          style={{ background: "var(--border)", color: "var(--text-muted)" }}
        >
          <ChevronDown size={16} />
        </button>
      )}

      {playing && (
        <VideoLightbox src={pp(`/api/timelapses/${playing.id}/video`)} filename={playing.filename} onClose={() => setPlaying(null)} />
      )}
    </Card>
  );
}
