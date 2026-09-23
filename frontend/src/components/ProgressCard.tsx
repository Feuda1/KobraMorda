import { Layers, Weight } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchCurrentFileDetails, fetchModel, type CurrentFileDetails, type ModelDetails } from "../api";
import {
  displayProgress,
  formatClockTime,
  formatDuration,
  formatGrams,
  formatRub,
  isPreparing,
  printStateLabel,
} from "../format";
import { useTween } from "../useTween";
import { useAmsSlots } from "./AmsSlots";
import type { PrinterState } from "../types";
import { Card } from "./Card";
import { Controls } from "./Controls";

const PREP_STEPS = ["Нагрев", "Выравнивание", "Печать"];

/**
 * Where the printer is in its start-up routine. Deliberately driven by real
 * measured numbers (temps vs. target, current layer), not the firmware's own
 * named sub-stage - verified live that the sub-stage name is unreliable and
 * can jump or repeat (e.g. reporting "nozzle_purging" while the printer is
 * actually already leveling the bed), which showed the wrong step lit up.
 * Real temperatures and the real layer counter don't lie.
 */
function PrepSteps({ state }: { state: PrinterState }) {
  const nozzleReady = state.nozzleTarget > 0 ? state.nozzleTemp >= state.nozzleTarget - 3 : true;
  const bedReady = state.bedTarget > 0 ? state.bedTemp >= state.bedTarget - 2 : true;
  const current = state.currentLayer > 0 ? 2 : nozzleReady && bedReady ? 1 : 0;
  return (
    <div className="mt-4 flex items-center gap-2 text-xs">
      {PREP_STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 font-medium ${i === current ? "animate-pulse" : ""}`}
            style={{
              background: i === current ? "rgba(245,181,68,0.16)" : "transparent",
              color: i < current ? "var(--ok)" : i === current ? "var(--warn)" : "var(--text-muted)",
              border: `1px solid ${i === current ? "rgba(245,181,68,0.4)" : "var(--border)"}`,
            }}
          >
            {label}
          </span>
          {i < PREP_STEPS.length - 1 && <span style={{ color: "var(--border)" }}>—</span>}
        </div>
      ))}
    </div>
  );
}

export function ProgressCard({ state }: { state: PrinterState }) {
  const [details, setDetails] = useState<CurrentFileDetails | null>(null);
  const isActive = state.printState === "printing" || state.printState === "paused";
  const preparing = isPreparing(state);
  const pct = Math.round(displayProgress(state) * 100);
  const pctShown = useTween(pct, 800);
  const [model, setModel] = useState<ModelDetails | null>(null);
  const [slots] = useAmsSlots();

  useEffect(() => {
    if (!details?.id) {
      setModel(null);
      return;
    }
    fetchModel(details.id)
      .then(setModel)
      .catch(() => setModel(null));
  }, [details?.id]);

  // Spools actually assigned to this job's tools (falls back to the file's own colors).
  const used = (model?.toolOrder ?? []).map((tool, i) => {
    const slotIdx = model?.slotAssignment?.[tool];
    const slot = slotIdx !== undefined ? slots.find((s) => s.index === slotIdx) : undefined;
    return {
      key: tool,
      slot: slotIdx,
      color: slot?.occupied ? slot.colorHex : (model?.filamentColors[i] ?? ""),
      type: slot?.occupied ? slot.materialType : (model?.filamentTypes[i] ?? ""),
    };
  });

  useEffect(() => {
    if (!state.filename) {
      setDetails(null);
      return;
    }
    fetchCurrentFileDetails()
      .then(setDetails)
      .catch(() => setDetails(null));
  }, [state.filename]);

  const cost = details?.filamentCost ?? null;

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl"
          style={{ background: details?.thumbnail ? "#fff" : "var(--border)" }}
        >
          {details?.thumbnail ? (
            <img src={details.thumbnail} alt="" className="h-full w-full object-contain p-1" />
          ) : (
            <Layers size={22} style={{ color: "var(--text-muted)" }} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
            <span className={preparing ? "animate-pulse" : ""} style={preparing ? { color: "var(--warn)" } : undefined}>
              {preparing ? "Подготовка" : printStateLabel(state.printState)}
            </span>
            {used.length === 0 && details?.filamentColor && (
              <span
                className="h-3 w-3 rounded-full border"
                style={{ background: `#${details.filamentColor}`, borderColor: "var(--border)" }}
              />
            )}
            {used.length === 0 && details?.filamentType && <span>{details.filamentType}</span>}
            {used.map((u) => (
              <span key={u.key} className="flex items-center gap-1">
                <span
                  className="h-3 w-3 rounded-full border"
                  style={{ background: u.color ? `#${u.color}` : "transparent", borderColor: "var(--border)" }}
                />
                {u.type}
                {u.slot !== undefined && <span className="tabular-nums opacity-70">#{u.slot + 1}</span>}
              </span>
            ))}
          </div>
          <div className="mt-0.5 truncate text-lg font-medium">{state.filename ?? "—"}</div>
        </div>

        <div className="shrink-0 text-3xl font-semibold tabular-nums">{isActive && !preparing ? `${Math.round(pctShown)}%` : "—"}</div>
      </div>

      {preparing && <PrepSteps state={state} />}

      <div className="relative mt-4 h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
        {preparing ? (
          <div className="bar-sweep" style={{ background: "linear-gradient(90deg, transparent, var(--warn), transparent)" }} />
        ) : (
          <div
            className={`h-full rounded-full transition-all duration-1000 ease-out ${state.printState === "printing" ? "bar-fill" : ""}`}
            style={{ width: `${pct}%`, background: state.printState === "paused" ? "var(--warn)" : "var(--accent)" }}
          />
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-end justify-between gap-4 pt-4">
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <div className="min-w-0">
          <div style={{ color: "var(--text-muted)" }} className="flex items-center gap-1">
            <Layers size={14} /> Слой
          </div>
          <div className="mt-0.5 whitespace-nowrap font-medium tabular-nums">
            {state.totalLayers ? `${state.currentLayer} / ${state.totalLayers}` : "—"}
          </div>
        </div>
        <div className="min-w-0">
          <div style={{ color: "var(--text-muted)" }}>Прошло</div>
          <div className="mt-0.5 whitespace-nowrap font-medium tabular-nums">
            {isActive ? formatDuration(state.printDurationSec) : "—"}
          </div>
        </div>
        <div className="min-w-0">
          <div style={{ color: "var(--text-muted)" }}>Готово к</div>
          <div className="mt-0.5 font-medium tabular-nums">
            {isActive && state.remainTimeSec > 0
              ? `${formatClockTime(state.remainTimeSec)} · ${formatDuration(state.remainTimeSec)}`
              : "—"}
          </div>
        </div>
        <div className="min-w-0">
          <div style={{ color: "var(--text-muted)" }} className="flex items-center gap-1">
            <Weight size={14} /> Пластик
          </div>
          <div className="mt-0.5 whitespace-nowrap font-medium tabular-nums">
            {details?.filamentGrams ? formatGrams(details.filamentGrams) : "—"}
          </div>
        </div>
        <div className="min-w-0">
          <div style={{ color: "var(--text-muted)" }}>Стоимость</div>
          <div className="mt-0.5 whitespace-nowrap font-medium tabular-nums">{cost !== null ? formatRub(cost) : "—"}</div>
        </div>
      </div>
      <Controls printState={state.printState} />
      </div>
    </Card>
  );
}
