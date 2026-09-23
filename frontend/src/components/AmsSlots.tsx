import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchAmsSlots, fetchSpools, linkSpool, setAmsSlot, type AmsSlot, type SpoolInfo } from "../api";
import { formatGrams } from "../format";
import { Card } from "./Card";
import { Select } from "./Select";

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC"];

export function useAmsSlots(pollMs = 5000): [AmsSlot[], () => void] {
  const [slots, setSlots] = useState<AmsSlot[]>([]);
  const load = () =>
    fetchAmsSlots()
      .then((r) => setSlots(r.slots))
      .catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
  return [slots, load];
}

function SlotEditor({
  slot,
  onClose,
  onSaved,
}: {
  slot: AmsSlot;
  onClose: () => void;
  onSaved: (slots: AmsSlot[]) => void;
}) {
  const [color, setColor] = useState(slot.occupied ? `#${slot.colorHex}` : "#3bb2f6");
  const [material, setMaterial] = useState(slot.materialType || "PLA");
  const [spools, setSpools] = useState<SpoolInfo[]>([]);
  const [spoolId, setSpoolId] = useState<string>(slot.spoolId ? String(slot.spoolId) : "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchSpools()
      .then((r) => setSpools(r.items))
      .catch(() => setSpools([]));
  }, []);

  const pickSpool = (value: string) => {
    setSpoolId(value);
    const spool = spools.find((s) => String(s.id) === value);
    if (!spool) return;
    if (spool.colorHex) setColor(`#${spool.colorHex}`);
    if (spool.material) setMaterial(spool.material.toUpperCase());
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);

  const save = async () => {
    const r = await setAmsSlot(slot.index, { colorHex: color, materialType: material, occupied: true });
    await linkSpool(slot.index, spoolId ? Number(spoolId) : null).catch(() => {});
    onSaved(r.slots);
    onClose();
  };

  const markEmpty = async () => {
    const r = await setAmsSlot(slot.index, { occupied: false });
    onSaved(r.slots);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-20 mt-2 w-56 rounded-xl border p-3 shadow-lg"
      style={{ background: "var(--card)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-9 w-9 shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0"
        />
        <div className="flex-1">
          <Select value={material} onChange={setMaterial} options={MATERIALS.map((m) => ({ value: m, label: m }))} />
        </div>
      </div>
      {spools.length > 0 && (
        <div className="mt-2">
          <Select
            value={spoolId}
            onChange={pickSpool}
            placeholder="Spoolman"
            options={[
              { value: "", label: "—" },
              ...spools.map((s) => ({
                value: String(s.id),
                label: `${s.vendor ? s.vendor + " " : ""}${s.name}${s.remainingWeight !== null ? ` · ${s.remainingWeight} г` : ""}`,
                leftNode: (
                  <span
                    className="h-3 w-3 rounded-full border"
                    style={{ background: s.colorHex ? `#${s.colorHex}` : "transparent", borderColor: "var(--border)" }}
                  />
                ),
              })),
            ]}
          />
        </div>
      )}
      <button
        onClick={save}
        className="mt-2 w-full rounded-lg py-1.5 text-sm font-medium"
        style={{ background: "var(--accent)", color: "#fff" }}
      >
        Сохранить
      </button>
      {slot.occupied && (
        <button onClick={markEmpty} className="mt-1.5 w-full py-1 text-xs" style={{ color: "var(--text-muted)" }}>
          Отметить пустым
        </button>
      )}
    </div>
  );
}

function SlotCard({
  slot,
  active,
  editing,
  onToggleEdit,
  onSaved,
}: {
  slot: AmsSlot;
  /** the running print draws from this slot */
  active: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onSaved: (slots: AmsSlot[]) => void;
}) {
  // a spool that just appeared plays a short "filament feeds in" animation
  const wasOccupied = useRef(slot.occupied);
  const [feeding, setFeeding] = useState(false);
  useEffect(() => {
    if (slot.occupied && !wasOccupied.current) {
      setFeeding(true);
      const t = setTimeout(() => setFeeding(false), 1600);
      wasOccupied.current = slot.occupied;
      return () => clearTimeout(t);
    }
    wasOccupied.current = slot.occupied;
  }, [slot.occupied]);

  const color = `#${slot.colorHex}`;

  return (
    <div className="relative">
      <button
        onClick={onToggleEdit}
        className="group lift flex w-full flex-col items-center gap-1.5 rounded-xl border px-3 py-3"
        style={{
          borderColor: active ? "var(--accent)" : "var(--border)",
          opacity: slot.occupied ? 1 : 0.55,
          background: active ? "rgba(59,178,246,0.06)" : undefined,
        }}
      >
        <div className="flex w-full items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs" style={{ color: active ? "var(--accent)" : "var(--text-muted)" }}>
            {active && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 rounded-full" style={{ background: "var(--accent)", animation: "ping-soft 1.6s ease-out infinite" }} />
                <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
              </span>
            )}
            Слот {slot.index + 1}
          </span>
          <Pencil size={11} className="opacity-0 transition-opacity group-hover:opacity-60" />
        </div>
        <span className="relative mt-2 flex h-8 w-8 items-center justify-center">
          {feeding && (
            <>
              <span
                className="absolute -top-9 left-1/2 h-9 w-1 -translate-x-1/2 rounded-full"
                style={{ background: color, animation: "feed-in 0.9s ease-out both" }}
              />
              <span
                className="absolute inset-0 rounded-full border-2"
                style={{ borderColor: color, animation: "ring-out 1.2s ease-out 0.7s both" }}
              />
            </>
          )}
          {active && (
            <span
              className="spin-slow absolute -inset-1.5 rounded-full border-2 border-dashed"
              style={{ borderColor: "var(--accent)" }}
            />
          )}
          <span
            className={`h-8 w-8 rounded-full border-2 ${feeding ? "pop" : ""}`}
            style={{
              background: slot.occupied ? color : "transparent",
              borderColor: slot.occupied ? "var(--border)" : "var(--text-muted)",
              borderStyle: slot.occupied ? "solid" : "dashed",
              animationDelay: feeding ? "0.6s" : undefined,
              boxShadow: slot.occupied ? `0 0 14px ${color}55` : undefined,
            }}
          />
        </span>
        <span className="text-sm font-medium" style={{ color: slot.occupied ? "var(--text)" : "var(--text-muted)" }}>
          {slot.occupied ? slot.materialType || "?" : "Пусто"}
        </span>
        {slot.occupied && slot.spoolRemaining != null && (
          <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
            {slot.spoolRemaining} г
          </span>
        )}
        {slot.occupied && slot.spoolRemaining == null && (slot.usedGrams ?? 0) > 0 && (
          <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
            −{formatGrams(slot.usedGrams ?? 0)}
          </span>
        )}
      </button>
      {editing && <SlotEditor slot={slot} onClose={onToggleEdit} onSaved={onSaved} />}
    </div>
  );
}

export function AmsSlots({ activeSlots = [] }: { activeSlots?: number[] }) {
  const [slots, reload] = useAmsSlots();
  const [editing, setEditing] = useState<number | null>(null);

  if (slots.length === 0) return null;

  return (
    <Card>
      <div className="mb-3 text-sm font-medium" style={{ color: "var(--text-muted)" }}>
        Катушки AMS
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[...slots]
          .sort((a, b) => a.index - b.index)
          .map((s) => (
            <SlotCard
              key={s.index}
              slot={s}
              active={activeSlots.includes(s.index)}
              editing={editing === s.index}
              onToggleEdit={() => setEditing(editing === s.index ? null : s.index)}
              onSaved={reload}
            />
          ))}
      </div>
    </Card>
  );
}
