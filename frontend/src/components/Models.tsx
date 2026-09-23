import { ChevronDown, FileBox, Printer, Trash2, X } from "lucide-react";
import { Portal } from "./Portal";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  assignModelSlots,
  deleteModel,
  fetchModel,
  fetchModels,
  printModel,
  type AmsSlot,
  type ModelDetails,
  type ModelSummary,
} from "../api";
import { formatBytes, formatDuration, formatGrams, formatRub } from "../format";
import { groupSettings } from "../settingsDictionary";
import { useShowMore } from "../useShowMore";
import { useAmsSlots } from "./AmsSlots";
import { Card } from "./Card";
import { Select } from "./Select";

/** Rows revealed at a time in a thumbnail grid (2 rows of the widest, 6-column layout). */
const GRID_PAGE = 12;

// three.js is a heavy dependency - only fetched once a 3D view is actually shown.
const ToolpathViewer = lazy(() => import("./ToolpathViewer").then((m) => ({ default: m.ToolpathViewer })));

function ModelCard({
  model,
  confirming,
  onDeleteClick,
  onOpen,
}: {
  model: ModelSummary;
  confirming: boolean;
  onDeleteClick: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="group lift relative rounded-lg">
      <button
        onClick={onOpen}
        className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg"
        style={{ background: model.thumbnail ? "#fff" : "var(--border)" }}
      >
        {model.thumbnail ? (
          <img src={model.thumbnail} alt="" className="h-full w-full object-contain p-1" />
        ) : (
          <FileBox size={20} style={{ color: "var(--text-muted)" }} />
        )}
      </button>
      {model.filamentColors.length > 0 && (
        <div className="mt-1.5 flex gap-1">
          {model.filamentColors.map((c, i) => (
            <span
              key={i}
              className="h-3 w-3 rounded-full border"
              style={{ background: `#${c}`, borderColor: "var(--border)" }}
            />
          ))}
        </div>
      )}
      <div className="mt-1 truncate text-xs font-medium" title={model.filename}>
        {model.filename}
      </div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
        {model.filamentGrams ? formatGrams(model.filamentGrams) : formatBytes(model.size)}
        {model.estimatedTimeSec ? ` · ${formatDuration(model.estimatedTimeSec)}` : ""}
      </div>
      <button
        onClick={onDeleteClick}
        className={`absolute right-1 top-1 flex h-6 items-center justify-center rounded-md text-xs font-medium transition-opacity ${
          confirming ? "px-2 opacity-100" : "w-6 opacity-0 group-hover:opacity-100"
        }`}
        style={{ background: confirming ? "var(--err)" : "rgba(0,0,0,0.55)", color: "#fff" }}
      >
        {confirming ? "Удалить?" : <Trash2 size={13} />}
      </button>
    </div>
  );
}

function SlotAssignRow({
  toolIndex,
  color,
  material,
  assignedSlot,
  slots,
  onChange,
}: {
  toolIndex: number;
  color: string | undefined;
  material: string | undefined;
  assignedSlot: number | undefined;
  slots: AmsSlot[];
  onChange: (slotIndex: number) => void;
}) {
  const occupied = slots.filter((s) => s.occupied);

  return (
    <div className="flex items-center gap-3">
      <span
        className="h-5 w-5 shrink-0 rounded-full border"
        style={{ background: color ? `#${color}` : "var(--border)", borderColor: "var(--border)" }}
      />
      <span className="w-16 shrink-0 text-sm" style={{ color: "var(--text-muted)" }}>
        {material || `Тул ${toolIndex}`}
      </span>
      {occupied.length === 0 ? (
        <span className="flex-1 text-sm" style={{ color: "var(--err)" }}>
          Нет заряженных катушек
        </span>
      ) : (
        <div className="flex-1">
          <Select
            value={assignedSlot !== undefined ? String(assignedSlot) : ""}
            onChange={(v) => onChange(Number(v))}
            placeholder="Выберите катушку"
            options={occupied.map((s) => ({
              value: String(s.index),
              label: `Слот ${s.index + 1} — ${s.materialType || "?"}`,
              leftNode: (
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full border"
                  style={{ background: `#${s.colorHex}`, borderColor: "var(--border)" }}
                />
              ),
            }))}
          />
        </div>
      )}
    </div>
  );
}

/** Best occupied slot for a model color/material, among slots not already claimed by another tool of the same model - same material required, exact color preferred. Never guesses across materials. */
function pickAutoSlot(color: string | undefined, material: string | undefined, candidates: AmsSlot[]): AmsSlot | undefined {
  const wantMaterial = (material || "").trim().toUpperCase();
  if (!wantMaterial) return undefined;
  const sameMaterial = candidates.filter((s) => s.materialType.trim().toUpperCase() === wantMaterial);
  if (sameMaterial.length === 0) return undefined;
  const wantColor = (color || "").toUpperCase();
  return sameMaterial.find((s) => s.colorHex.toUpperCase() === wantColor) ?? sameMaterial[0];
}

function ModelModal({ id, onClose, onPrinted }: { id: string; onClose: () => void; onPrinted: () => void }) {
  const [model, setModel] = useState<ModelDetails | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [show3d, setShow3d] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slots] = useAmsSlots();
  // guards the auto-pick below to "once per opened model, once real slot data
  // has arrived" - never re-guesses over a choice the user already made or changed
  const autoAssignedFor = useRef<string | null>(null);

  const reload = () => fetchModel(id).then(setModel).catch(() => {});
  useEffect(() => {
    reload();
  }, [id]);

  const toolOrder = model?.toolOrder.length ? model.toolOrder : model?.filamentColors.length ? [1] : [];

  // Pre-fill each tool with a matching loaded spool (same material, exact
  // color if there's a choice) so a straightforward single- or multi-color
  // print doesn't need manual selection - the dropdown still lets the user
  // override any of it before printing.
  useEffect(() => {
    if (!model) return;
    const occupied = slots.filter((s) => s.occupied);
    if (occupied.length === 0) return;
    if (autoAssignedFor.current === model.id) return;
    autoAssignedFor.current = model.id;

    const next = { ...model.slotAssignment };
    const used = new Set(Object.values(next));
    let changed = false;
    for (const toolIndex of toolOrder) {
      if (next[toolIndex] !== undefined) continue;
      const pick = pickAutoSlot(
        model.filamentColors[toolIndex - 1],
        model.filamentTypes[toolIndex - 1],
        occupied.filter((s) => !used.has(s.index)),
      );
      if (!pick) continue;
      next[toolIndex] = pick.index;
      used.add(pick.index);
      changed = true;
    }
    if (changed) {
      setModel((m) => (m ? { ...m, slotAssignment: next } : m));
      assignModelSlots(model.id, next).catch(() => reload());
    }
  }, [model, slots, toolOrder]);

  const onAssign = async (toolIndex: number, slotIndex: number) => {
    if (!model) return;
    const next = { ...model.slotAssignment, [toolIndex]: slotIndex };
    setModel({ ...model, slotAssignment: next });
    try {
      await assignModelSlots(id, next);
    } catch {
      reload();
    }
  };

  const onPrint = async () => {
    setPrinting(true);
    setError(null);
    try {
      await printModel(id);
      onPrinted();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setPrinting(false);
    }
  };

  if (!model) return null;

  const settingGroups = groupSettings(model.rawSettings);
  const settingsCount = settingGroups.reduce((n, g) => n + g.items.length, 0);

  return (
    <Portal>
    <div className="fade-in fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-5" onClick={onClose}>
      <div
        className="modal-in max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border p-5"
        style={{ background: "var(--card)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="truncate text-lg font-medium">{model.filename}</div>
          <button onClick={onClose} style={{ color: "var(--text-muted)" }}>
            <X size={18} />
          </button>
        </div>

        <div
          className="mt-3 flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl"
          style={{ background: "#fff" }}
        >
          {model.thumbnail ? (
            <img src={model.thumbnail} alt="" className="h-full w-full object-contain p-4" />
          ) : (
            <FileBox size={32} style={{ color: "var(--text-muted)" }} />
          )}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div>
            <div style={{ color: "var(--text-muted)" }}>Пластик</div>
            <div className="font-medium tabular-nums">
              {model.filamentGrams ? formatGrams(model.filamentGrams) : "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)" }}>Стоимость</div>
            <div className="font-medium tabular-nums">
              {model.filamentCost !== null ? formatRub(model.filamentCost) : "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)" }}>Время</div>
            <div className="font-medium tabular-nums">
              {model.estimatedTimeSec ? formatDuration(model.estimatedTimeSec) : "—"}
            </div>
          </div>
        </div>

        <button
          onClick={() => setShow3d((v) => !v)}
          className="mt-4 flex w-full items-center justify-between text-sm font-medium"
          style={{ color: "var(--text-muted)" }}
        >
          3D-просмотр слоёв
          <ChevronDown size={16} style={{ transform: show3d ? "rotate(180deg)" : "none" }} />
        </button>
        {show3d && (
          <div className="mt-2 h-96">
            <Suspense fallback={<div className="skeleton h-full w-full rounded-xl" />}>
              <ToolpathViewer modelId={id} />
            </Suspense>
          </div>
        )}

        {toolOrder.length > 0 && (
          <div className="mt-5 space-y-2">
            <div className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
              Катушки для печати
            </div>
            {toolOrder.map((toolIndex) => (
              <SlotAssignRow
                key={toolIndex}
                toolIndex={toolIndex}
                color={model.filamentColors[toolIndex - 1]}
                material={model.filamentTypes[toolIndex - 1]}
                assignedSlot={model.slotAssignment[toolIndex]}
                slots={slots}
                onChange={(slotIndex) => onAssign(toolIndex, slotIndex)}
              />
            ))}
          </div>
        )}

        <button
          onClick={() => setShowSettings((v) => !v)}
          className="mt-5 flex w-full items-center justify-between text-sm font-medium"
          style={{ color: "var(--text-muted)" }}
        >
          Все настройки ({settingsCount})
          <ChevronDown size={16} style={{ transform: showSettings ? "rotate(180deg)" : "none" }} />
        </button>
        {showSettings && (
          <div className="scrollbar-thin mt-2 max-h-72 space-y-3 overflow-auto pr-1">
            {settingGroups.map((group) => (
              <div key={group.title}>
                <div
                  className="px-1 pb-1 text-xs font-medium uppercase tracking-wide"
                  style={{ color: "var(--text-muted)" }}
                >
                  {group.title}
                </div>
                <div className="overflow-hidden rounded-lg" style={{ background: "var(--bg)" }}>
                  {group.items.map((item) => (
                    <div
                      key={item.key}
                      className="flex justify-between gap-3 border-b px-3 py-1.5 text-xs last:border-0"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <span style={{ color: "var(--text-muted)" }}>{item.label}</span>
                      <span className="text-right">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg px-3 py-2 text-sm" style={{ background: "rgba(245,85,108,0.12)", color: "var(--err)" }}>
            {error}
          </div>
        )}

        <button
          onClick={onPrint}
          disabled={printing || toolOrder.some((t) => model.slotAssignment[t] === undefined)}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          <Printer size={16} /> Печать
        </button>
      </div>
    </div>
    </Portal>
  );
}

export function Models() {
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // A model freshly uploaded from OrcaSlicer ("Upload") opens straight in the
  // regular model window, where the user decides whether to print. Models that
  // were already there when the page opened never trigger it.
  const knownIds = useRef<Set<string> | null>(null);

  const reload = () => {
    fetchModels()
      .then((r) => {
        setModels(r.items);
        if (knownIds.current === null) {
          knownIds.current = new Set(r.items.map((m) => m.id));
          return;
        }
        const fresh = r.items.filter((m) => !knownIds.current!.has(m.id));
        fresh.forEach((m) => knownIds.current!.add(m.id));
        if (fresh.length > 0) setOpenId(fresh[0].id);
      })
      .catch(() => setModels([]));
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const onDeleteClick = async (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    setModels((prev) => prev?.filter((m) => m.id !== id) ?? null);
    try {
      await deleteModel(id);
    } catch {
      reload();
    }
  };

  const { shown, hasMore, showMore } = useShowMore(models?.length ?? 0, GRID_PAGE);

  if (models === null) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between text-sm font-medium" style={{ color: "var(--text-muted)" }}>
        Загруженные модели
        {models.length > 0 && <span className="tabular-nums">{models.length}</span>}
      </div>
      {models.length === 0 ? (
        <div className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          —
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {models.slice(0, shown).map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              confirming={confirming === m.id}
              onDeleteClick={() => onDeleteClick(m.id)}
              onOpen={() => setOpenId(m.id)}
            />
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
      {openId && <ModelModal id={openId} onClose={() => setOpenId(null)} onPrinted={reload} />}
    </Card>
  );
}
