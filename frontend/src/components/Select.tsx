import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  leftNode?: React.ReactNode;
}

/** Fully custom dropdown - native <select> option lists ignore app theming on most platforms. */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Выберите",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
        style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {selected?.leftNode}
          <span className={selected ? "" : "opacity-50"}>{selected?.label ?? placeholder}</span>
        </span>
        <ChevronDown size={15} style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "none" }} />
      </button>

      {open && (
        <div
          className="scrollbar-thin absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-auto rounded-lg border py-1 shadow-lg"
          style={{ background: "var(--card)", borderColor: "var(--border)" }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:brightness-125"
              style={{ background: o.value === value ? "var(--border)" : "transparent" }}
            >
              {o.leftNode}
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.value === value && <Check size={14} style={{ color: "var(--accent)" }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
