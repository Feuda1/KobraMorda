import { Loader2, Plus, Printer, Settings, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchPrinters, LEGACY_PRINTER_ID, setActivePrinter, type PrinterSummary } from "./api";
import { useDashboardSocket } from "./useDashboardSocket";
import { Camera } from "./components/Camera";
import { ProgressCard } from "./components/ProgressCard";
import { TempCard } from "./components/TempCard";
import { PrinterFiles } from "./components/PrinterFiles";
import { Timelapse } from "./components/Timelapse";
import { AmsSlots } from "./components/AmsSlots";
import { Models } from "./components/Models";
import { History } from "./components/History";
import { DoneBanner } from "./components/DoneBanner";
import { useActiveSlots } from "./useActiveSlots";
import { PrintViewerCard, useLiveModelId } from "./components/PrintViewerCard";
import { AddPrinterModal } from "./components/AddPrinterModal";
import { SettingsModal } from "./components/SettingsModal";
import { Card } from "./components/Card";
import { isPreparing, printStateLabel } from "./format";
import type { PrinterState } from "./types";

const STATE_COLOR: Record<PrinterState["printState"], string> = {
  standby: "var(--text-muted)",
  printing: "var(--accent)",
  paused: "var(--warn)",
  complete: "var(--ok)",
  error: "var(--err)",
};

function StatusBadge({ state }: { state: PrinterState }) {
  const prep = isPreparing(state);
  const color = prep ? "var(--warn)" : STATE_COLOR[state.printState];
  return (
    <div className="flex items-center gap-1.5 text-sm font-medium" style={{ color }}>
      <span className="relative flex h-2 w-2">
        {(prep || state.printState === "printing") && (
          <span className="absolute inset-0 rounded-full" style={{ background: color, animation: "ping-soft 1.8s ease-out infinite" }} />
        )}
        <span className="relative h-2 w-2 rounded-full" style={{ background: color }} />
      </span>
      {prep ? "Подготовка" : printStateLabel(state.printState)}
    </div>
  );
}

const LEGACY_PRINTER: PrinterSummary = {
  id: LEGACY_PRINTER_ID,
  name: "Kobra X",
  ip: "",
  status: "online",
  error: "",
  printState: "standby",
  deviceState: "",
  filename: null,
  progress: 0,
  currentLayer: 0,
  totalLayers: 0,
  remainTimeSec: 0,
  nozzleTemp: 0,
  bedTemp: 0,
  orcaHost: "",
};

function usePrinters() {
  const [printers, setPrinters] = useState<PrinterSummary[] | null>(null);
  const reload = useCallback(() => {
    fetchPrinters()
      .then((r) => setPrinters(r.items))
      .catch(() => {
        // a bridge that predates multi-printer support: treat it as one printer on plain URLs
        setPrinters((prev) => prev ?? [LEGACY_PRINTER]);
      });
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [reload]);
  return { printers, reload };
}

function PrinterTab({ printer, active, onClick }: { printer: PrinterSummary; active: boolean; onClick: () => void }) {
  const printing = printer.printState === "printing" || printer.printState === "paused";
  const dot = printer.status !== "online" ? "var(--err)" : printing ? "var(--accent)" : "var(--ok)";
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-medium"
      style={{
        background: active ? "var(--card)" : "transparent",
        border: `1px solid ${active ? "var(--border)" : "transparent"}`,
        color: active ? "var(--text)" : "var(--text-muted)",
      }}
    >
      {printer.status === "connecting" ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Printer size={15} style={{ color: dot }} />
      )}
      {printer.name}
      {printing && printer.status === "online" && (
        <span className="text-xs tabular-nums" style={{ color: "var(--accent)" }}>
          {Math.round(printer.progress * 100)}%
        </span>
      )}
    </button>
  );
}

function OfflinePrinter({ printer }: { printer: PrinterSummary }) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 py-10" style={{ color: "var(--text-muted)" }}>
        {printer.status === "connecting" ? <Loader2 size={28} className="animate-spin" /> : <WifiOff size={28} />}
        <div className="font-medium" style={{ color: "var(--text)" }}>
          {printer.name}
        </div>
        {printer.error && <div className="text-sm">{printer.error}</div>}
      </div>
    </Card>
  );
}

function PrinterView({ printer }: { printer: PrinterSummary }) {
  const { state, socketOpen } = useDashboardSocket(printer.id);
  const liveModelId = useLiveModelId(state);
  const activeSlots = useActiveSlots(state);

  if (!state) {
    return <div className="flex min-h-[50vh] items-center justify-center" style={{ color: "var(--text-muted)" }} />;
  }

  const connected = socketOpen && state.connected;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <StatusBadge state={state} />
        <span style={{ color: connected ? "var(--ok)" : "var(--err)" }}>
          {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
        {liveModelId ? (
          <>
            <div className="enter md:col-span-3" style={{ ["--i" as string]: 0 }}>
              <PrintViewerCard modelId={liveModelId} state={state} />
            </div>
            <div className="enter md:col-span-3" style={{ ["--i" as string]: 1 }}>
              <Camera connected={connected} lightOn={state.lightOn} />
            </div>
          </>
        ) : (
          <div className="enter md:col-span-6 md:mx-auto md:w-2/3" style={{ ["--i" as string]: 2 }}>
            <Camera connected={connected} lightOn={state.lightOn} />
          </div>
        )}

        <div className="enter md:col-span-4" style={{ ["--i" as string]: 3 }}>
          <ProgressCard state={state} />
        </div>
        <div className="enter md:col-span-2" style={{ ["--i" as string]: 4 }}>
          <TempCard state={state} />
        </div>

        <div className="enter md:col-span-3" style={{ ["--i" as string]: 5 }}>
          <AmsSlots activeSlots={activeSlots} />
        </div>
        <div className="enter md:col-span-3" style={{ ["--i" as string]: 6 }}>
          <Timelapse />
        </div>
        <div className="enter md:col-span-6" style={{ ["--i" as string]: 7 }}>
          <Models />
        </div>
        <div className="enter md:col-span-6" style={{ ["--i" as string]: 8 }}>
          <History refreshKey={state.printState} />
        </div>
        <div className="enter md:col-span-6" style={{ ["--i" as string]: 9 }}>
          <PrinterFiles />
        </div>
      </div>

      <DoneBanner printState={state.printState} />
    </>
  );
}

const SELECTED_KEY = "kobramorda.printer";

export default function App() {
  const { printers, reload } = usePrinters();
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  });
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);

  const current = printers?.find((p) => p.id === selected) ?? printers?.[0] ?? null;
  // must be set before any child renders and fetches
  setActivePrinter(current?.id ?? null);

  const select = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      // storage unavailable - the choice just is not remembered
    }
  };

  if (!printers) {
    return <div className="flex min-h-screen items-center justify-center" style={{ color: "var(--text-muted)" }} />;
  }

  return (
    <div className="mx-auto min-h-screen max-w-6xl p-5">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="scrollbar-thin flex min-w-0 items-center gap-1 overflow-x-auto">
          {printers.map((p) => (
            <PrinterTab key={p.id} printer={p} active={p.id === current?.id} onClick={() => select(p.id)} />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1" style={{ color: "var(--text-muted)" }}>
          <button onClick={() => setAdding(true)} className="flex h-8 w-8 items-center justify-center rounded-lg">
            <Plus size={17} />
          </button>
          <button onClick={() => setSettings(true)} className="flex h-8 w-8 items-center justify-center rounded-lg">
            <Settings size={17} />
          </button>
        </div>
      </header>

      {!current ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-12">
            <Printer size={32} style={{ color: "var(--text-muted)" }} />
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              <Plus size={16} /> Добавить принтер
            </button>
          </div>
        </Card>
      ) : current.status !== "online" ? (
        <OfflinePrinter printer={current} />
      ) : (
        <PrinterView key={current.id} printer={current} />
      )}

      {adding && (
        <AddPrinterModal
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            select(id);
            reload();
          }}
        />
      )}
      {settings && (
        <SettingsModal
          printers={printers}
          onClose={() => setSettings(false)}
          onChanged={reload}
          onAdd={() => {
            setSettings(false);
            setAdding(true);
          }}
        />
      )}
    </div>
  );
}
