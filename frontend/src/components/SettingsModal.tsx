import { Check, Copy, Pencil, Plus, RefreshCw, Send, Trash2, Unlink, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchSpoolmanSettings,
  fetchTelegram,
  removePrinter,
  removeTelegramChat,
  renamePrinter,
  resetTelegramPairing,
  setSpoolmanUrl,
  testTelegram,
  updateTelegram,
  type PrinterSummary,
  type TelegramInfo,
} from "../api";
import { inputStyle, Modal, Switch } from "./Modal";

const NOTIFY_LABELS: Array<[keyof TelegramInfo["notify"], string]> = [
  ["started", "Начало печати"],
  ["finished", "Завершение и таймлапс"],
  ["failed", "Отмена и ошибки"],
  ["milestones", "Прогресс 25 / 50 / 75%"],
];

function PrinterRow({ printer, onChanged }: { printer: PrinterSummary; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(printer.name);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);

  const save = async () => {
    setEditing(false);
    if (name.trim() && name !== printer.name) {
      await renamePrinter(printer.id, name).catch(() => {});
      onChanged();
    }
  };

  const remove = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    try {
      await removePrinter(printer.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      setConfirm(false);
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(printer.orcaHost).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="min-w-0 flex-1 rounded-lg border px-2 py-1 text-sm outline-none"
            style={inputStyle}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">{printer.name}</span>
            <button onClick={() => setEditing(true)} style={{ color: "var(--text-muted)" }}>
              <Pencil size={14} />
            </button>
          </>
        )}
        <button
          onClick={remove}
          className={`flex h-7 items-center justify-center rounded-md text-xs font-medium ${confirm ? "px-2" : "w-7"}`}
          style={{ background: confirm ? "var(--err)" : "var(--border)", color: confirm ? "#fff" : "var(--text-muted)" }}
        >
          {confirm ? "Удалить?" : <Trash2 size={13} />}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
        <span>{printer.ip}</span>
        <button onClick={copy} className="flex items-center gap-1" title="Адрес для OrcaSlicer">
          {copied ? <Check size={12} /> : <Copy size={12} />} {printer.orcaHost}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-xs" style={{ color: "var(--err)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function SpoolmanSection() {
  const [url, setUrl] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchSpoolmanSettings()
      .then((r) => {
        setUrl(r.url);
        setOk(r.url ? r.ok : null);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    const r = await setSpoolmanUrl(url);
    setUrl(r.url);
    setOk(r.url ? r.ok : null);
  };

  if (!loaded) return null;
  if (failed) {
    return (
      <div className="flex justify-center py-8" style={{ color: "var(--text-muted)" }}>
        <WifiOff size={24} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 rounded-full" style={{ background: ok === null ? "var(--text-muted)" : ok ? "var(--ok)" : "var(--err)" }} />
        <span style={{ color: ok === null ? "var(--text-muted)" : ok ? "var(--ok)" : "var(--err)" }}>
          {ok === null ? "Не подключён" : ok ? "Подключён" : "Нет связи"}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.0.5:7912"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
        <button onClick={save} className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "var(--accent)", color: "#fff" }}>
          <Check size={15} />
        </button>
      </div>
    </div>
  );
}

function TelegramSection() {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [token, setToken] = useState("");
  const [proxy, setProxy] = useState("");
  const [testState, setTestState] = useState<"idle" | "ok" | "err">("idle");

  const load = () =>
    fetchTelegram()
      .then((i) => {
        setInfo(i);
        setProxy((p) => (p === "" ? i.proxy : p));
      })
      .catch(() => {});

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  if (!info) {
    return (
      <div className="flex justify-center py-8" style={{ color: "var(--text-muted)" }}>
        <WifiOff size={24} />
      </div>
    );
  }

  const saveConnection = async () => {
    setInfo(await updateTelegram({ token: token || undefined, proxy }));
    setToken("");
  };

  const toggle = async (key: keyof TelegramInfo["notify"]) => {
    setInfo(await updateTelegram({ notify: { [key]: !info.notify[key] } }));
  };

  const test = async () => {
    try {
      await testTelegram();
      setTestState("ok");
    } catch {
      setTestState("err");
    }
    setTimeout(() => setTestState("idle"), 2500);
  };

  const statusColor = info.status === "ok" ? "var(--ok)" : info.status === "error" ? "var(--err)" : "var(--text-muted)";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 rounded-full" style={{ background: statusColor }} />
        <span style={{ color: statusColor }}>
          {info.status === "ok" ? `@${info.botName}` : info.status === "error" ? info.error : info.hasToken ? "Подключение" : "Не подключён"}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={info.hasToken ? "Токен сохранён" : "Токен бота"}
          className="rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
        <input
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
          placeholder="Прокси, если Telegram недоступен напрямую (http://host:port)"
          className="rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
        <button
          onClick={saveConnection}
          className="self-start rounded-lg px-4 py-2 text-sm font-medium"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          <Check size={15} />
        </button>
      </div>

      {info.hasToken && (
        <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-sm">/start {info.pairingCode}</div>
            <button
              onClick={() => resetTelegramPairing().then(setInfo)}
              style={{ color: "var(--text-muted)" }}
              title="Новый код"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {info.chats.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {info.chats.map((c) => (
                <div key={c.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{c.name}</span>
                  <button onClick={() => removeTelegramChat(c.id).then(setInfo)} style={{ color: "var(--text-muted)" }}>
                    <Unlink size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {NOTIFY_LABELS.map(([key, label]) => (
          <div key={key} className="flex items-center justify-between text-sm">
            {label}
            <Switch on={info.notify[key]} onClick={() => toggle(key)} />
          </div>
        ))}
      </div>

      {info.chats.length > 0 && (
        <button
          onClick={test}
          className="flex items-center gap-2 self-start rounded-lg px-3 py-2 text-sm"
          style={{ background: "var(--border)", color: testState === "err" ? "var(--err)" : "var(--text)" }}
        >
          {testState === "ok" ? <Check size={15} /> : <Send size={15} />}
        </button>
      )}
    </div>
  );
}

export function SettingsModal({
  printers,
  onClose,
  onChanged,
  onAdd,
}: {
  printers: PrinterSummary[];
  onClose: () => void;
  onChanged: () => void;
  onAdd: () => void;
}) {
  const [tab, setTab] = useState<"printers" | "telegram" | "spoolman">("printers");
  const tabs: Array<["printers" | "telegram" | "spoolman", string]> = [
    ["printers", "Принтеры"],
    ["telegram", "Telegram"],
    ["spoolman", "Spoolman"],
  ];

  return (
    <Modal title="Настройки" onClose={onClose}>
      <div className="mb-4 flex gap-1 rounded-xl p-1" style={{ background: "var(--bg)" }}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium"
            style={{ background: tab === id ? "var(--border)" : "transparent", color: tab === id ? "var(--text)" : "var(--text-muted)" }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "printers" ? (
        <div className="flex flex-col gap-3">
          {printers.map((p) => (
            <PrinterRow key={p.id} printer={p} onChanged={onChanged} />
          ))}
          <button
            onClick={onAdd}
            className="flex items-center justify-center rounded-xl border border-dashed py-2.5"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            <Plus size={16} />
          </button>
        </div>
      ) : tab === "telegram" ? (
        <TelegramSection />
      ) : (
        <SpoolmanSection />
      )}
    </Modal>
  );
}
