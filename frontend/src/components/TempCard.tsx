import { Fan, Flame, Thermometer } from "lucide-react";
import type { ReactNode } from "react";
import { useTween } from "../useTween";
import type { PrinterState } from "../types";
import { Card } from "./Card";

function TempRow({
  icon,
  label,
  current,
  target,
}: {
  icon: ReactNode;
  label: string;
  current: number;
  target: number;
}) {
  const heating = target > 0;
  const shown = useTween(current, 900);
  const warming = heating && current < target - 2;
  const pct = heating ? Math.min(100, Math.max(0, (current / target) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
          {icon} {label}
        </span>
        <span className="tabular-nums">
          <span className="text-2xl font-semibold">{Math.round(shown)}°</span>
          {heating && (
            <span className="ml-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
              / {Math.round(target)}°
            </span>
          )}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
        <div
          className={`h-full rounded-full transition-all duration-700 ${warming ? "bar-fill" : ""}`}
          style={{ width: `${pct}%`, background: heating && pct < 97 ? "var(--warn)" : "var(--ok)" }}
        />
      </div>
    </div>
  );
}

export function TempCard({ state }: { state: PrinterState }) {
  return (
    <Card className="flex flex-col justify-between gap-4">
      <TempRow icon={<Flame size={14} />} label="Сопло" current={state.nozzleTemp} target={state.nozzleTarget} />
      <TempRow icon={<Thermometer size={14} />} label="Стол" current={state.bedTemp} target={state.bedTarget} />
      <div className="flex items-center justify-between text-sm" style={{ color: "var(--text-muted)" }}>
        <span className="flex items-center gap-1.5">
          <Fan size={14} /> Обдув
        </span>
        <span className="tabular-nums" style={{ color: "var(--text)" }}>
          {Math.round(state.fanPct)}%
        </span>
      </div>
    </Card>
  );
}
