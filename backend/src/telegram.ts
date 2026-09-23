import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { fetch, FormData, ProxyAgent } from "undici";
import type { PrinterRegistry } from "./printerRegistry.js";
import type { PrinterInstance } from "./printerInstance.js";
import type { HistoryEntry } from "./history.js";
import { handlePrintControl } from "./printControl.js";
import { currentAmsSlots } from "./bridgeContext.js";
import { isPrePrintState } from "./state.js";

export interface TelegramSettings {
  token: string;
  /** Optional http(s) proxy URL - Telegram is not reachable directly from every network. */
  proxy: string;
  chats: Array<{ id: number; name: string }>;
  pairingCode: string;
  notify: { started: boolean; finished: boolean; failed: boolean; milestones: boolean };
}

export type TelegramStatus = "off" | "connecting" | "ok" | "error";

const DEFAULTS: TelegramSettings = {
  token: "",
  proxy: "",
  chats: [],
  pairingCode: "",
  notify: { started: true, finished: true, failed: true, milestones: false },
};

const MILESTONES = [25, 50, 75];
const CLIP_SECONDS = 6;
const MAX_UPLOAD_BYTES = 49 * 1024 * 1024;

const PANEL_LIVE_MS = 15 * 60_000;

const STATE_TEXT: Record<string, string> = {
  standby: "ожидание",
  printing: "печать",
  paused: "пауза",
  complete: "готово",
  error: "ошибка",
};

const PREP_LABELS: Record<string, string> = {
  preheating: "нагрев",
  auto_leveling: "выравнивание стола",
  checking: "проверка",
  init: "подготовка",
  updated: "подготовка",
};

type Screen = "home" | "history" | "printers" | "stop" | "timelapses";
interface Panel {
  messageId: number;
  screen: Screen;
  touched: number;
}

const REPLY_KEYBOARD = {
  keyboard: [[{ text: "Панель" }]],
  resize_keyboard: true,
  is_persistent: true,
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** File name without the slicer's noisy extension. */
const shortName = (name: string) => name.replace(/\.(gcode|bgcode)$/i, "");

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const bar = (pct: number) => {
  const filled = Math.round(pct / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
};

function newCode(): string {
  return String(randomInt(100000, 1000000));
}

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return "0 мин";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function fmtClock(fromNowSec: number): string {
  return new Date(Date.now() + fromNowSec * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** The stored cost is already kopeck-accurate (history.ts rounds to 2 decimals from OrcaSlicer's own value) - keep up to 2 decimals instead of always rounding to a whole ruble. */
function fmtRub(value: number): string {
  return `${value.toFixed(2).replace(/\.?0+$/, "")} ₽`;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number; first_name?: string; title?: string; username?: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
}

type Button = { text: string; callback_data: string };

/**
 * Telegram control + notification bot (long polling, no extra dependencies).
 * A chat can only use it after entering the pairing code shown in the
 * dashboard - the bot can show the camera and stop prints, so it must never
 * answer strangers.
 */
export class TelegramBot extends EventEmitter {
  settings: TelegramSettings;
  status: TelegramStatus = "off";
  error = "";
  botName = "";

  private readonly file: string;
  private abort: AbortController | undefined;
  private generation = 0;
  private offset = 0;
  private dispatcher: ProxyAgent | undefined;
  private readonly watched = new WeakSet<PrinterInstance>();
  private readonly milestoneSent = new Map<string, number>();

  constructor(
    private readonly registry: PrinterRegistry,
    dataDir: string,
  ) {
    super();
    this.file = path.join(dataDir, "telegram.json");
    this.settings = this.load();
    if (!this.settings.pairingCode) {
      this.settings.pairingCode = newCode();
      this.save();
    }

    for (const inst of registry.list()) this.watch(inst);
    registry.on("added", (inst: PrinterInstance) => this.watch(inst));
    registry.on("online", (inst: PrinterInstance) => this.watch(inst));
    this.restart();
  }

  private load(): TelegramSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { ...DEFAULTS, ...raw, notify: { ...DEFAULTS.notify, ...raw.notify } };
    } catch {
      return { ...DEFAULTS, notify: { ...DEFAULTS.notify } };
    }
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
  }

  // ---- settings surface (used by the dashboard) ------------------------------------

  publicSettings() {
    return {
      status: this.status,
      error: this.error,
      botName: this.botName,
      hasToken: !!this.settings.token,
      proxy: this.settings.proxy,
      chats: this.settings.chats,
      pairingCode: this.settings.pairingCode,
      notify: this.settings.notify,
    };
  }

  update(patch: { token?: string; proxy?: string; notify?: Partial<TelegramSettings["notify"]> }) {
    let restart = false;
    if (typeof patch.token === "string" && patch.token.trim() !== this.settings.token) {
      this.settings.token = patch.token.trim();
      restart = true;
    }
    if (typeof patch.proxy === "string" && patch.proxy.trim() !== this.settings.proxy) {
      this.settings.proxy = patch.proxy.trim();
      restart = true;
    }
    if (patch.notify) this.settings.notify = { ...this.settings.notify, ...patch.notify };
    this.save();
    if (restart) this.restart();
  }

  resetPairing() {
    this.settings.pairingCode = newCode();
    this.save();
  }

  removeChat(id: number) {
    this.settings.chats = this.settings.chats.filter((c) => c.id !== id);
    this.save();
  }

  async sendTest(): Promise<void> {
    if (this.settings.chats.length === 0) throw new Error("Нет подключённых чатов");
    await this.broadcast("Уведомления работают");
  }

  // ---- lifecycle -------------------------------------------------------------------

  private restart() {
    this.abort?.abort();
    this.generation++;
    this.botName = "";
    this.error = "";
    if (!this.settings.token) {
      this.status = "off";
      this.emit("status");
      return;
    }
    try {
      this.dispatcher = this.settings.proxy ? new ProxyAgent(this.settings.proxy) : undefined;
    } catch {
      this.status = "error";
      this.error = "Некорректный адрес прокси";
      this.emit("status");
      return;
    }
    this.status = "connecting";
    this.emit("status");
    void this.pollLoop(this.generation);
  }

  private async api<T = unknown>(method: string, body?: object | FormData, signal?: AbortSignal): Promise<T> {
    const isForm = body instanceof FormData;
    const init: Record<string, unknown> = {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      dispatcher: this.dispatcher,
    };
    if (body) {
      init.body = isForm ? body : JSON.stringify(body);
      if (!isForm) init.headers = { "Content-Type": "application/json" };
    }
    // Telegram is reached over an unreliable route for many users - verified
    // live from this bridge's own machine: the *first* request after a quiet
    // spell can fail outright after a ~10s connection stall (DNS/TCP/TLS
    // never completing), while the very next attempt succeeds in well under
    // a second. That first failure used to skip getUpdates specifically and
    // fall through to the poll loop's own backoff (2s, then 4s, 8s...),
    // which is what actually made every button in the bot feel slow - not
    // the button handling itself, but the long-poll silently going quiet
    // for several seconds to a minute after one bad connection attempt.
    // Retrying here is safe for every method including getUpdates: nothing
    // is sent until a response is read, and getUpdates itself is idempotent
    // (the offset only advances after a batch is successfully processed).
    let res: Awaited<ReturnType<typeof fetch>> | undefined;
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await fetch(`https://api.telegram.org/bot${this.settings.token}/${method}`, init as never);
      } catch (err) {
        if (attempt >= 3 || signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    const json = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
    if (!json.ok) {
      const err = new Error(json.description ?? `HTTP ${res.status}`) as Error & { code?: number };
      err.code = json.error_code;
      throw err;
    }
    return json.result;
  }

  private async pollLoop(gen: number) {
    const abort = new AbortController();
    this.abort = abort;
    let backoff = 2000;
    while (gen === this.generation) {
      try {
        if (!this.botName) {
          const me = await this.api<{ username: string }>("getMe", undefined, abort.signal);
          this.botName = me.username;
          void this.api("setMyCommands", {
            commands: [
              { command: "menu", description: "Панель управления" },
              { command: "photo", description: "Снимок с камеры" },
              { command: "video", description: "Короткое видео" },
              { command: "history", description: "История печатей" },
              { command: "timelapse", description: "Последний таймлапс" },
            ],
          }).catch(() => {});
        }
        this.status = "ok";
        this.error = "";
        this.emit("status");
        backoff = 2000;
        const updates = await this.api<Update[]>(
          "getUpdates",
          { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
          abort.signal,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((err) => console.warn("[telegram]", (err as Error).message));
        }
      } catch (err) {
        if (gen !== this.generation) return;
        const e = err as Error & { code?: number };
        this.status = "error";
        this.error = e.code === 401 ? "Неверный токен" : "Нет связи с Telegram";
        this.emit("status");
        if (e.code === 401) return; // a wrong token will not fix itself
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  // ---- panel state -------------------------------------------------------------------

  /** One live "control panel" message per chat, edited in place instead of piling up new messages. */
  private readonly panels = new Map<number, Panel>();
  private readonly chatPrinter = new Map<number, string>();
  private refreshTimer: NodeJS.Timeout | undefined;

  private startAutoRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.status !== "ok") return;
      for (const [chatId, panel] of this.panels) {
        if (panel.screen !== "home" || Date.now() - panel.touched > PANEL_LIVE_MS) continue;
        void this.renderPanel(chatId, panel).catch(() => {});
      }
    }, 15_000);
    this.refreshTimer.unref();
  }

  private printerFor(chatId: number): PrinterInstance | undefined {
    const chosen = this.chatPrinter.get(chatId);
    return (chosen ? this.registry.get(chosen) : undefined) ?? this.registry.primary();
  }

  // ---- incoming --------------------------------------------------------------------

  private isPaired(chatId: number) {
    return this.settings.chats.some((c) => c.id === chatId);
  }

  private async handleUpdate(u: Update) {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (!this.isPaired(chatId)) {
      const m = /^\/start\s+(\d{6})$/.exec(text);
      if (m && m[1] === this.settings.pairingCode) {
        const name = msg.chat.username ? `@${msg.chat.username}` : (msg.chat.first_name ?? msg.chat.title ?? String(chatId));
        this.settings.chats.push({ id: chatId, name });
        this.settings.pairingCode = newCode();
        this.save();
        this.emit("status");
        await this.send(chatId, "<b>Чат подключён</b>\nУправление и уведомления о печати теперь приходят сюда.", {
          reply_markup: REPLY_KEYBOARD,
        });
        await this.openPanel(chatId);
      } else {
        await this.send(chatId, "Введите код из панели управления:\n<code>/start 123456</code>");
      }
      return;
    }

    const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/menu":
      case "/status":
      case "панель":
        await this.openPanel(chatId);
        break;
      case "/photo":
        await this.sendSnapshot(chatId);
        break;
      case "/video":
        await this.sendClip(chatId);
        break;
      case "/history":
        await this.openPanel(chatId, "history");
        break;
      case "/timelapse":
        await this.openPanel(chatId, "timelapses");
        break;
      default:
        await this.send(chatId, "Выберите действие в панели", { reply_markup: REPLY_KEYBOARD });
    }
  }

  private async handleCallback(cb: NonNullable<Update["callback_query"]>) {
    const chatId = cb.message?.chat.id;
    const messageId = cb.message?.message_id;
    if (chatId === undefined || messageId === undefined || !cb.data || !this.isPaired(chatId)) {
      void this.api("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      return;
    }

    let toast: string | undefined;
    let alert = false;
    try {
      toast = await this.runAction(chatId, messageId, cb.data);
    } catch (err) {
      toast = (err as Error).message;
      alert = true;
    }
    void this.api("answerCallbackQuery", { callback_query_id: cb.id, text: toast, show_alert: alert }).catch(() => {});
  }

  /** Executes a button press; returns a short toast text for the user, if any. */
  private async runAction(chatId: number, messageId: number, data: string): Promise<string | undefined> {
    const [action, arg] = data.split(":");
    const panel = this.panels.get(chatId);
    const isPanel = panel?.messageId === messageId;

    if (action === "close") {
      await this.api("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
      return;
    }
    if (action === "pr") {
      if (arg && this.registry.get(arg)) this.chatPrinter.set(chatId, arg);
      return this.goto(chatId, messageId, "home");
    }

    const inst = this.printerFor(chatId);
    if (!inst) return "Принтеров нет";

    switch (action) {
      case "home":
        return this.goto(chatId, messageId, "home");
      case "hist":
        return this.goto(chatId, messageId, "history");
      case "printers":
        return this.goto(chatId, messageId, "printers");
      case "stop":
        return this.goto(chatId, messageId, "stop");
      case "photo":
        void this.sendSnapshot(chatId);
        return;
      case "photoup": {
        const frame = inst.camera?.getSnapshot();
        if (!frame) throw new Error("Камера не отдаёт кадры");
        await this.editPhoto(chatId, messageId, frame, this.photoCaption(inst));
        return "Кадр обновлён";
      }
      case "video":
        void this.sendClip(chatId);
        return `Записываю ${CLIP_SECONDS} сек…`;
      case "tls":
        return this.goto(chatId, messageId, "timelapses");
      case "tl": {
        const list = inst.timelapse?.list() ?? [];
        const meta = arg ? list.find((t) => t.id === arg) : list[0];
        const file = meta && inst.timelapse?.videoPath(meta.id);
        if (!meta || !file) throw new Error("Таймлапс не найден");
        void this.sendVideoFile(chatId, file, `<b>${esc(inst.config.name)}</b> · таймлапс\n${esc(shortName(meta.filename))}`, this.mediaKeyboard(false));
        return;
      }
    }

    if (inst.status !== "online" || !inst.ctx) throw new Error("Нет связи с принтером");
    const ctx = inst.ctx;

    switch (action) {
      case "refresh":
        if (isPanel && panel) await this.renderPanel(chatId, panel);
        return "Обновлено";
      case "light": {
        const next = !(inst.state.lightOn ?? false);
        await ctx.mqttClient.setLight(next);
        inst.state.lightOn = next;
        if (isPanel && panel) await this.renderPanel(chatId, panel);
        return next ? "Свет включён" : "Свет выключен";
      }
      case "pause":
        await handlePrintControl("pause", {}, ctx);
        await this.goto(chatId, messageId, "home");
        return "Печать поставлена на паузу";
      case "resume":
        await handlePrintControl("resume", {}, ctx);
        await this.goto(chatId, messageId, "home");
        return "Печать продолжена";
      case "stopyes":
        await handlePrintControl("cancel", {}, ctx);
        await this.goto(chatId, messageId, "home");
        return "Печать остановлена";
    }
  }

  /** Switches the panel message to another screen. */
  private async goto(chatId: number, messageId: number, screen: Screen): Promise<undefined> {
    let panel = this.panels.get(chatId);
    if (!panel || panel.messageId !== messageId) {
      panel = { messageId, screen, touched: Date.now() };
      this.panels.set(chatId, panel);
    }
    panel.screen = screen;
    panel.touched = Date.now();
    await this.renderPanel(chatId, panel);
    return undefined;
  }

  // ---- screens ---------------------------------------------------------------------

  private async openPanel(chatId: number, screen: Screen = "home") {
    const old = this.panels.get(chatId);
    // Not awaited: deleting the old panel and sending the new one are
    // independent Telegram API calls, and waiting for the first serializes
    // two full network round-trips for no reason (see the note in `api()`
    // about why every one of those matters here).
    if (old) void this.api("deleteMessage", { chat_id: chatId, message_id: old.messageId }).catch(() => {});
    const panel: Panel = { messageId: 0, screen, touched: Date.now() };
    const view = this.renderView(chatId, panel);
    const sent = await this.api<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: view.text,
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
    panel.messageId = sent.message_id;
    this.panels.set(chatId, panel);
    this.startAutoRefresh();
  }

  private async renderPanel(chatId: number, panel: Panel) {
    const view = this.renderView(chatId, panel);
    try {
      await this.api("editMessageText", {
        chat_id: chatId,
        message_id: panel.messageId,
        text: view.text,
        parse_mode: "HTML",
        reply_markup: view.keyboard,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (/not modified/i.test(msg)) return;
      if (/not found|can't be edited/i.test(msg)) this.panels.delete(chatId);
      throw err;
    }
  }

  private renderView(chatId: number, panel: Panel): { text: string; keyboard: object } {
    const inst = this.printerFor(chatId);
    if (!inst) return { text: "Принтеров нет", keyboard: { inline_keyboard: [] } };
    const btn = (text: string, data: string): Button => ({ text, callback_data: data });
    const multi = this.registry.list().length > 1;

    if (panel.screen === "printers") {
      return {
        text: "<b>Выберите принтер</b>",
        keyboard: {
          inline_keyboard: [
            ...this.registry.list().map((i) => [
              btn(`${i.config.id === inst.config.id ? "● " : "○ "}${i.config.name}${i.status !== "online" ? " (нет связи)" : ""}`, `pr:${i.config.id}`),
            ]),
            [btn("◀ Назад", "home")],
          ],
        },
      };
    }

    if (panel.screen === "history") {
      const items = inst.ctx?.history.list().slice(0, 6) ?? [];
      const body =
        items.length === 0
          ? "Пока пусто"
          : items
              .map((e) => {
                const mark = e.result === "complete" ? "✅" : e.result === "error" ? "⚠️" : "✖️";
                const parts = [fmtDuration(e.durationSec)];
                if (e.totalGrams > 0) parts.push(`${e.totalGrams} г`);
                if (e.costRub) parts.push(fmtRub(e.costRub));
                return `${mark} <b>${esc(shortName(e.filename))}</b>\n<i>${fmtDate(e.startedAt)} · ${parts.join(" · ")}</i>`;
              })
              .join("\n\n");
      return {
        text: `<b>${esc(inst.config.name)} · История</b>\n\n${body}`,
        keyboard: { inline_keyboard: [[btn("🎞 Таймлапсы", "tls")], [btn("◀ Назад", "home")]] },
      };
    }

    if (panel.screen === "timelapses") {
      const items = inst.timelapse?.list().slice(0, 8) ?? [];
      return {
        text: `<b>${esc(inst.config.name)} · Таймлапсы</b>${items.length === 0 ? "\n\nПока пусто" : ""}`,
        keyboard: {
          inline_keyboard: [
            ...items.map((t) => [btn(`${fmtDate(t.createdAt)} · ${shortName(t.filename).slice(0, 40)}`, `tl:${t.id}`)]),
            [btn("◀ Назад", "home")],
          ],
        },
      };
    }

    if (panel.screen === "stop") {
      return {
        text: `<b>Остановить печать?</b>\n${esc(shortName(inst.state.filename ?? ""))}\n\nПродолжить её будет нельзя.`,
        keyboard: { inline_keyboard: [[btn("⏹ Да, остановить", "stopyes"), btn("Отмена", "home")]] },
      };
    }

    // home
    const s = inst.state;
    const online = inst.status === "online";
    const printing = s.printState === "printing" || s.printState === "paused";
    const rows: Button[][] = [[btn("📷 Камера", "photo"), btn("🎥 Видео", "video"), btn(s.lightOn ? "💡 Свет · вкл" : "💡 Свет", "light")]];
    if (online && printing) {
      rows.push(
        s.printState === "paused" ? [btn("▶ Продолжить", "resume"), btn("⏹ Стоп", "stop")] : [btn("⏸ Пауза", "pause"), btn("⏹ Стоп", "stop")],
      );
    }
    rows.push([btn("🕘 История", "hist"), btn("🎞 Таймлапсы", "tls")]);
    rows.push(multi ? [btn("🖨 Принтеры", "printers"), btn("🔄 Обновить", "refresh")] : [btn("🔄 Обновить", "refresh")]);
    return { text: this.homeText(inst), keyboard: { inline_keyboard: rows } };
  }

  private homeText(inst: PrinterInstance): string {
    const s = inst.state;
    const name = `<b>${esc(inst.config.name)}</b>`;
    if (inst.status !== "online") return `${name} · нет связи\n<i>${esc(inst.lastError || "Подключение…")}</i>`;

    const prep = isPrePrintState(s.deviceState, s.currentLayer);
    const prepLabel = prep ? (PREP_LABELS[s.deviceState] ?? "подготовка") : null;
    const stateText = prepLabel ?? STATE_TEXT[s.printState] ?? s.printState;
    const lines = [`${name} · ${stateText}`];

    const printing = s.printState === "printing" || s.printState === "paused";
    if (printing) {
      lines.push(`<b>${esc(shortName(s.filename ?? "—"))}</b>`, "");
      if (!prepLabel) {
        const pct = Math.round(Math.min(Math.max(s.progress, 0), 1) * 100);
        lines.push(`${bar(pct)}  <b>${pct}%</b>`);
        if (s.totalLayers) lines.push(`Слой ${s.currentLayer} из ${s.totalLayers}`);
        if (s.remainTimeSec > 0) lines.push(`Осталось ${fmtDuration(s.remainTimeSec)} · будет готово в ${fmtClock(s.remainTimeSec)}`);
      } else {
        lines.push("Печать начнётся, когда всё прогреется");
      }
      const spools = this.spoolLine(inst);
      if (spools) lines.push(`Пластик: ${spools}`);
    } else {
      const last = inst.ctx?.history.list()[0];
      if (last) {
        const mark = last.result === "complete" ? "завершена" : last.result === "error" ? "с ошибкой" : "остановлена";
        lines.push("", `Последняя печать ${mark}:`, `<b>${esc(shortName(last.filename))}</b> · ${fmtDuration(last.durationSec)}`);
      }
    }
    lines.push("", `Сопло ${Math.round(s.nozzleTemp)}° / ${Math.round(s.nozzleTarget)}°   Стол ${Math.round(s.bedTemp)}° / ${Math.round(s.bedTarget)}°`);
    if (s.lightOn !== null) lines.push(`Свет ${s.lightOn ? "включён" : "выключен"}`);
    return lines.join("\n");
  }

  private spoolLine(inst: PrinterInstance): string {
    const ctx = inst.ctx;
    const filename = inst.state.filename;
    const model = ctx && filename ? ctx.modelStore.getByFilename(filename) : undefined;
    if (!ctx || !model) return "";
    const slots = currentAmsSlots(ctx);
    return model.meta.toolOrder
      .map((tool, i) => {
        const idx = model.slotAssignment[tool];
        const slot = idx !== undefined ? slots.find((x) => x.index === idx) : undefined;
        const type = slot?.occupied ? slot.materialType : (model.meta.filamentTypes[i] ?? "");
        return `${esc(type || "?")}${idx !== undefined ? ` (слот ${idx + 1})` : ""}`;
      })
      .join(", ");
  }

  // ---- media -----------------------------------------------------------------------

  private photoCaption(inst: PrinterInstance): string {
    return `<b>${esc(inst.config.name)}</b> · ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }

  private mediaKeyboard(update: boolean) {
    const row: Button[] = [];
    if (update) row.push({ text: "🔄 Обновить кадр", callback_data: "photoup" }, { text: "💡 Свет", callback_data: "light" });
    return { inline_keyboard: [...(row.length ? [row] : []), [{ text: "✖ Закрыть", callback_data: "close" }]] };
  }

  private async sendSnapshot(chatId: number) {
    const inst = this.printerFor(chatId);
    const frame = inst?.camera?.getSnapshot();
    if (!inst || !frame) {
      await this.send(chatId, "Камера не отдаёт кадры");
      return;
    }
    await this.sendPhoto(chatId, frame, this.photoCaption(inst), this.mediaKeyboard(true));
  }

  private async editPhoto(chatId: number, messageId: number, jpeg: Buffer, caption: string) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("message_id", String(messageId));
    form.set("media", JSON.stringify({ type: "photo", media: "attach://file", caption, parse_mode: "HTML" }));
    form.set("reply_markup", JSON.stringify(this.mediaKeyboard(true)));
    form.set("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "snapshot.jpg");
    try {
      await this.api("editMessageMedia", form);
    } catch (err) {
      if (!/not modified/i.test((err as Error).message)) throw err;
    }
  }

  private async sendClip(chatId: number) {
    const inst = this.printerFor(chatId);
    if (!inst?.camera) {
      await this.send(chatId, "Камера недоступна");
      return;
    }
    try {
      const clip = await recordClip(inst.camera, CLIP_SECONDS);
      await this.sendVideo(chatId, clip, `<b>${esc(inst.config.name)}</b> · ${CLIP_SECONDS} сек`, this.mediaKeyboard(false));
    } catch (err) {
      await this.send(chatId, (err as Error).message);
    }
  }

  // ---- outgoing --------------------------------------------------------------------

  private async send(chatId: number, text: string, extra: object = {}) {
    await this.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  }

  private async sendPhoto(chatId: number, jpeg: Buffer, caption: string, keyboard?: object) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    if (keyboard) form.set("reply_markup", JSON.stringify(keyboard));
    form.set("photo", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "snapshot.jpg");
    await this.api("sendPhoto", form);
  }

  private async sendVideo(chatId: number, mp4: Buffer, caption: string, keyboard?: object) {
    if (mp4.length > MAX_UPLOAD_BYTES) throw new Error("Видео слишком большое для Telegram");
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    form.set("supports_streaming", "true");
    if (keyboard) form.set("reply_markup", JSON.stringify(keyboard));
    form.set("video", new Blob([new Uint8Array(mp4)], { type: "video/mp4" }), "clip.mp4");
    await this.api("sendVideo", form);
  }

  private async sendVideoFile(chatId: number, file: string, caption: string, keyboard?: object) {
    await this.sendVideo(chatId, fs.readFileSync(file), caption, keyboard);
  }

  private async broadcast(text: string, photo?: Buffer) {
    let failed = 0;
    for (const chat of this.settings.chats) {
      try {
        if (photo) await this.sendPhoto(chat.id, photo, text);
        else await this.send(chat.id, text);
      } catch (err) {
        failed++;
        console.warn(`[telegram] send to ${chat.name} failed:`, (err as Error).message);
      }
    }
    if (failed > 0 && failed === this.settings.chats.length) throw new Error("Не удалось отправить сообщение");
  }

  // ---- notifications ---------------------------------------------------------------

  private watch(inst: PrinterInstance) {
    if (this.watched.has(inst) || !inst.ctx) return;
    this.watched.add(inst);
    const { history, telemetry } = inst.ctx;
    const name = () => `<b>${esc(inst.config.name)}</b>`;
    const snapshot = () => inst.camera?.getSnapshot();

    // "started" fires the moment the firmware accepts the job, which is well
    // before it actually lays down plastic - heating, bed leveling and a
    // nozzle purge all happen first and can take minutes. Saying "печать
    // началась" during that prep would be an outright false claim, so the
    // notification waits for prep to end (see the telemetry watcher below).
    // A bridge restart mid-print re-attaches to a job already in progress
    // (see HistoryRecorder.recover) without a fresh "started" event - pick up
    // where it left off instead of staying silent for the rest of the job.
    const alreadyActive = telemetry.state.printState === "printing" || telemetry.state.printState === "paused";
    let startedNotified = !alreadyActive || !isPrePrintState(telemetry.state.deviceState, telemetry.state.currentLayer);
    let startedFilename = alreadyActive ? (telemetry.state.filename ?? "") : "";
    history.on("started", (job: { filename: string }) => {
      this.milestoneSent.set(inst.config.id, 0);
      startedNotified = false;
      startedFilename = job.filename;
    });

    history.on("finished", (e: HistoryEntry) => {
      startedNotified = true;
      startedFilename = "";
      const ok = e.result === "complete";
      if (ok ? !this.settings.notify.finished : !this.settings.notify.failed) return;
      const facts = [fmtDuration(e.durationSec)];
      if (e.totalGrams > 0) facts.push(`${e.totalGrams} г`);
      if (e.costRub) facts.push(fmtRub(e.costRub));
      const head = { complete: "печать завершена", cancelled: "печать остановлена", error: "ошибка печати", interrupted: "печать прервана" }[e.result];
      const layers = !ok && e.totalLayers ? `\nДошла до слоя ${e.layersDone} из ${e.totalLayers}` : "";
      void this.broadcast(`${name()} · ${head}\n<b>${esc(shortName(e.filename))}</b>\n${facts.join(" · ")}${layers}`, snapshot()).catch(() => {});
    });

    inst.on("timelapse", (meta: { id: string; filename: string }) => {
      if (!this.settings.notify.finished) return;
      const file = inst.timelapse?.videoPath(meta.id);
      if (!file) return;
      for (const chat of this.settings.chats) {
        this.sendVideoFile(chat.id, file, `${name()} · таймлапс\n${esc(shortName(meta.filename))}`, this.mediaKeyboard(false)).catch((err) =>
          console.warn("[telegram] timelapse send failed:", (err as Error).message),
        );
      }
    });

    telemetry.on("change", () => {
      const s = telemetry.state;
      const active = s.printState === "printing" || s.printState === "paused";

      if (!startedNotified && active && startedFilename && !isPrePrintState(s.deviceState, s.currentLayer)) {
        startedNotified = true;
        if (this.settings.notify.started) {
          void this.broadcast(`${name()} · печать началась\n<b>${esc(shortName(startedFilename))}</b>`, snapshot()).catch(() => {});
        }
      }

      if (!this.settings.notify.milestones || s.printState !== "printing") return;
      if (isPrePrintState(s.deviceState, s.currentLayer)) return;
      const pct = Math.round(s.progress * 100);
      const last = this.milestoneSent.get(inst.config.id) ?? 0;
      const reached = MILESTONES.filter((m) => pct >= m && m > last).pop();
      if (!reached) return;
      this.milestoneSent.set(inst.config.id, reached);
      const eta = s.remainTimeSec > 0 ? `\nОсталось ${fmtDuration(s.remainTimeSec)}` : "";
      void this.broadcast(`${name()} · ${bar(reached)} <b>${reached}%</b>${eta}`, snapshot()).catch(() => {});
    });
  }
}

/** Collects `seconds` of live camera frames and encodes them to a small mp4. */
function recordClip(camera: import("./camera.js").CameraPipeline, seconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `kobramorda-clip-${Date.now()}.mp4`);
    const ff = spawn(
      ffmpegInstaller.path,
      ["-y", "-f", "image2pipe", "-framerate", "8", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    let frames = 0;
    const onFrame = (f: Buffer) => {
      frames++;
      ff.stdin.write(f);
    };
    ff.stdin.on("error", () => {});
    camera.on("frame", onFrame);
    const first = camera.getSnapshot();
    if (first) onFrame(first);
    const timer = setTimeout(() => {
      camera.off("frame", onFrame);
      ff.stdin.end();
    }, seconds * 1000);
    ff.on("error", (err) => {
      clearTimeout(timer);
      camera.off("frame", onFrame);
      reject(err);
    });
    ff.on("exit", (code) => {
      clearTimeout(timer);
      camera.off("frame", onFrame);
      try {
        if (code !== 0 || frames < 2) throw new Error("Не удалось записать видео");
        resolve(fs.readFileSync(out));
      } catch (err) {
        reject(err);
      } finally {
        fs.rmSync(out, { force: true });
      }
    });
  });
}
