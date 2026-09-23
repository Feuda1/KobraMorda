import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fetchKobraXCredentials } from "./credentials.js";
import { PrinterInstance, type PrinterConfig } from "./printerInstance.js";
import type { SpoolmanClient } from "./spoolman.js";

const LEGACY_ID = "main";

/**
 * The set of printers this bridge manages, persisted in data/printers.json.
 * The printer created first keeps the original flat data layout (id "main");
 * every later one stores its files under data/printers/<id>/.
 */
export class PrinterRegistry extends EventEmitter {
  private readonly file: string;
  private readonly instances = new Map<string, PrinterInstance>();

  constructor(
    private readonly dataDir: string,
    private readonly bridgeOrigin: string,
    private readonly spoolman: SpoolmanClient,
  ) {
    super();
    this.file = path.join(dataDir, "printers.json");
    let configs: PrinterConfig[] = [];
    try {
      configs = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // first run
    }
    for (const c of configs) this.instantiate(c);
  }

  private instantiate(config: PrinterConfig): PrinterInstance {
    const dir = config.id === LEGACY_ID ? this.dataDir : path.join(this.dataDir, "printers", config.id);
    fs.mkdirSync(dir, { recursive: true });
    const inst = new PrinterInstance(config, dir, this.bridgeOrigin, this.spoolman);
    this.instances.set(config.id, inst);
    inst.on("status", () => this.emit("status", inst));
    inst.on("online", () => this.emit("online", inst));
    inst.start();
    return inst;
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.list().map((i) => i.config), null, 2));
  }

  list(): PrinterInstance[] {
    return [...this.instances.values()];
  }

  get(id: string): PrinterInstance | undefined {
    return this.instances.get(id);
  }

  /** The first printer: the one plain (un-prefixed) URLs and OrcaSlicer's default host point at. */
  primary(): PrinterInstance | undefined {
    return this.instances.values().next().value;
  }

  findByIp(ip: string): PrinterInstance | undefined {
    return this.list().find((i) => i.config.ip === ip);
  }

  async add(ip: string, name?: string): Promise<PrinterInstance> {
    ip = ip.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Некорректный IP-адрес");
    if (this.findByIp(ip)) throw new Error("Этот принтер уже добавлен");
    let creds;
    try {
      creds = await fetchKobraXCredentials(ip);
    } catch {
      throw new Error("Принтер не найден по этому адресу");
    }
    const first = this.instances.size === 0;
    const id = first ? LEGACY_ID : randomBytes(4).toString("hex");
    const cleanName = name?.trim() || creds.modelName || "Kobra X";
    const inst = this.instantiate({ id, name: cleanName, ip });
    this.save();
    this.emit("added", inst);
    return inst;
  }

  rename(id: string, name: string) {
    const inst = this.get(id);
    if (!inst) throw new Error("Принтер не найден");
    inst.config.name = name.trim() || inst.config.name;
    this.save();
  }

  setPort(id: string, port: number) {
    const inst = this.get(id);
    if (!inst) return;
    inst.config.port = port;
    this.save();
  }

  async remove(id: string) {
    const inst = this.get(id);
    if (!inst) throw new Error("Принтер не найден");
    if (inst.state.printState === "printing" || inst.state.printState === "paused") {
      throw new Error("Идёт печать - принтер нельзя удалить");
    }
    await inst.stop();
    this.instances.delete(id);
    this.save();
    inst.wipeData();
    this.emit("removed", inst);
  }
}
