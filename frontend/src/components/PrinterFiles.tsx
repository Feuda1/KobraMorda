import { ChevronDown, FileBox, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deletePrinterFile, fetchFileDetails, fetchPrinterFiles, type PrinterFile, type PrinterFileDetails } from "../api";
import { formatBytes, formatDuration, formatGrams } from "../format";
import { useShowMore } from "../useShowMore";
import { Card } from "./Card";
import { Portal } from "./Portal";

/** Rows revealed at a time in a thumbnail grid (2 rows of the widest, 6-column layout). */
const GRID_PAGE = 12;

function useDetails(filename: string) {
  const [details, setDetails] = useState<PrinterFileDetails | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchFileDetails(filename)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => !cancelled && setDetails(null));
    return () => {
      cancelled = true;
    };
  }, [filename]);
  return details;
}

function FileCard({
  file,
  confirming,
  onDeleteClick,
  onOpen,
}: {
  file: PrinterFile;
  confirming: boolean;
  onDeleteClick: () => void;
  onOpen: () => void;
}) {
  const details = useDetails(file.filename);

  return (
    <div className="group lift relative rounded-lg">
      <button
        onClick={onOpen}
        className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg"
        style={{ background: details?.thumbnail ? "#fff" : "var(--border)" }}
      >
        {details?.thumbnail ? (
          <img src={details.thumbnail} alt="" className="h-full w-full object-contain p-1" />
        ) : (
          <FileBox size={20} style={{ color: "var(--text-muted)" }} />
        )}
      </button>
      <div className="mt-1.5 truncate text-xs font-medium" title={file.displayName}>
        {file.displayName}
      </div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
        {details?.filamentGrams ? formatGrams(details.filamentGrams) : formatBytes(file.size)}
        {details?.estimatedTimeSec ? ` · ${formatDuration(details.estimatedTimeSec)}` : ""}
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

function FileModal({ file, onClose }: { file: PrinterFile; onClose: () => void }) {
  const details = useDetails(file.filename);

  return (
    <Portal>
    <div className="fade-in fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-5" onClick={onClose}>
      <div
        className="max-h-full w-full max-w-md overflow-auto rounded-2xl border p-5"
        style={{ background: "var(--card)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="truncate text-lg font-medium">{file.displayName}</div>
          <button onClick={onClose} style={{ color: "var(--text-muted)" }}>
            <X size={18} />
          </button>
        </div>

        <div
          className="mt-3 flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl"
          style={{ background: "#fff" }}
        >
          {details?.thumbnail ? (
            <img src={details.thumbnail} alt="" className="h-full w-full object-contain p-4" />
          ) : (
            <FileBox size={32} style={{ color: "var(--text-muted)" }} />
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div style={{ color: "var(--text-muted)" }}>Пластик</div>
            <div className="font-medium tabular-nums">
              {details?.filamentGrams ? formatGrams(details.filamentGrams) : "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)" }}>Время печати</div>
            <div className="font-medium tabular-nums">
              {details?.estimatedTimeSec ? formatDuration(details.estimatedTimeSec) : "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)" }}>Слоёв</div>
            <div className="font-medium tabular-nums">{details?.layerCount ?? "—"}</div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)" }}>Сопло / стол</div>
            <div className="font-medium tabular-nums">
              {details?.nozzleTemp ?? "—"}° / {details?.bedTemp ?? "—"}°
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)" }}>Размер файла</div>
            <div className="font-medium tabular-nums">{formatBytes(file.size)}</div>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

export function PrinterFiles() {
  const [files, setFiles] = useState<PrinterFile[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<PrinterFile | null>(null);

  const reload = () => {
    fetchPrinterFiles()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  };

  useEffect(reload, []);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const onDeleteClick = async (filename: string) => {
    if (confirming !== filename) {
      setConfirming(filename);
      return;
    }
    setConfirming(null);
    setFiles((prev) => prev?.filter((f) => f.filename !== filename) ?? null);
    try {
      await deletePrinterFile(filename);
    } catch {
      reload();
    }
  };

  const { shown, hasMore, showMore } = useShowMore(files?.length ?? 0, GRID_PAGE);

  if (files === null) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between text-sm font-medium" style={{ color: "var(--text-muted)" }}>
        Файлы на принтере
        {files.length > 0 && <span className="tabular-nums">{files.length}</span>}
      </div>
      {files.length === 0 ? (
        <div className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          —
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {files.slice(0, shown).map((f) => (
            <FileCard
              key={f.filename}
              file={f}
              confirming={confirming === f.filename}
              onDeleteClick={() => onDeleteClick(f.filename)}
              onOpen={() => setOpen(f)}
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
      {open && <FileModal file={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
