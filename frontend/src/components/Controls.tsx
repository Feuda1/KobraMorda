import { Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { cancelPrint, pausePrint, resumePrint } from "../api";

export function Controls({ printState }: { printState: string }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (printState !== "printing" && printState !== "paused") return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void run(cancelPrint);
  };

  return (
    <div className="flex shrink-0 gap-2">
      {printState === "printing" ? (
        <button
          disabled={busy}
          onClick={() => run(pausePrint)}
          className="flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--border)" }}
        >
          <Pause size={16} /> Пауза
        </button>
      ) : (
        <button
          disabled={busy}
          onClick={() => run(resumePrint)}
          className="flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          <Play size={16} /> Продолжить
        </button>
      )}
      <button
        disabled={busy}
        onClick={cancel}
        className="flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-medium transition-colors disabled:opacity-50"
        style={{
          background: confirming ? "var(--err)" : "var(--border)",
          color: confirming ? "#fff" : "var(--err)",
        }}
      >
        <Square size={15} /> {confirming ? "Точно?" : "Стоп"}
      </button>
    </div>
  );
}
