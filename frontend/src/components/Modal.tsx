import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Portal } from "./Portal";

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Portal>
    <div className="fade-in fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-5" onClick={onClose}>
      <div
        className={`modal-in max-h-[90vh] w-full overflow-auto rounded-2xl border p-5 scrollbar-thin ${wide ? "max-w-3xl" : "max-w-xl"}`}
        style={{ background: "var(--card)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-lg font-medium">{title}</div>
          <button onClick={onClose} style={{ color: "var(--text-muted)" }}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
    </Portal>
  );
}

export function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
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

export const inputStyle = {
  background: "var(--bg)",
  borderColor: "var(--border)",
  color: "var(--text)",
} as const;
