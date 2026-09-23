import { Loader2, Plus, Radar } from "lucide-react";
import { useEffect, useState } from "react";
import { addPrinter, scanPrinters } from "../api";
import { inputStyle, Modal } from "./Modal";

export function AddPrinterModal({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [found, setFound] = useState<Array<{ ip: string; added: boolean }> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ip, setIp] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const scan = () => {
    setScanning(true);
    scanPrinters()
      .then((r) => setFound(r.items))
      .catch(() => setFound([]))
      .finally(() => setScanning(false));
  };

  useEffect(scan, []);

  const add = async (address: string) => {
    setBusy(true);
    setError("");
    try {
      const p = await addPrinter(address, name || undefined);
      onAdded(p.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Добавить принтер" onClose={onClose}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
          <Radar size={15} /> Найдено в сети
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ background: "var(--border)" }}
        >
          {scanning ? <Loader2 size={15} className="animate-spin" /> : <Radar size={15} />}
        </button>
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {found?.map((f) => (
          <button
            key={f.ip}
            disabled={f.added || busy}
            onClick={() => add(f.ip)}
            className="flex items-center justify-between rounded-xl border px-3 py-2.5 text-left disabled:opacity-40"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="font-medium tabular-nums">{f.ip}</span>
            {!f.added && <Plus size={16} style={{ color: "var(--accent)" }} />}
          </button>
        ))}
        {found && found.length === 0 && !scanning && (
          <div className="py-2 text-sm" style={{ color: "var(--text-muted)" }}>
            —
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="192.168.0.10"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
        <button
          onClick={() => add(ip)}
          disabled={busy || !ip.trim()}
          className="flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        </button>
      </div>
      {error && (
        <div className="mt-3 text-sm" style={{ color: "var(--err)" }}>
          {error}
        </div>
      )}
    </Modal>
  );
}
