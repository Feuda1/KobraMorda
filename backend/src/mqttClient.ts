import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import mqtt, { type MqttClient } from "mqtt";

export interface KobraXMqttOptions {
  ip: string;
  port?: number; // MQTT-over-TLS port, default 9883
  username: string;
  password: string;
  modeId: string;
  deviceId: string;
  /** Paths to the shared Anycubic Slicer client cert/key (mTLS). */
  certPath: string;
  keyPath: string;
  clientId?: string;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
  /** If true, a reply with data:null for this action is treated as an intermediate ack, not the final answer (see fileDetails). */
  skipNullData: boolean;
}

const TOPIC_ROOT = "anycubic/anycubicCloud/v1";

/**
 * Minimal client for Anycubic's reverse-engineered local MQTT protocol.
 *
 * Envelope: {type, action, msgid, timestamp, data}. Requests are published
 * on the "slicer/printer" topic. Replies are correlated by TOPIC ("report
 * key", e.g. "info/report"), not by msgid: verified live against a real
 * printer, the printer sends a lightweight per-request ack on
 * ".../{deviceId}/response" that echoes our msgid but carries no payload
 * (data: null) - the actual "{msgType}/report" push that carries the real
 * data has its own, unrelated msgid. Because of this, replies for the same
 * msgType can't be reliably told apart if two requests for it are in flight
 * at once - so requests sharing a msgType are queued and sent strictly one
 * at a time (see `request()`); different msgTypes still run concurrently.
 * The printer only tolerates one live mTLS session at a time, so only one
 * KobraXMqttClient should ever be connected to a given printer.
 */
export class KobraXMqttClient extends EventEmitter {
  private readonly opts: Required<Omit<KobraXMqttOptions, "port" | "clientId">> & {
    port: number;
    clientId: string;
  };
  private client: MqttClient | undefined;
  private readonly pendingByReportKey = new Map<string, PendingRequest>();
  private readonly queueTailByMsgType = new Map<string, Promise<void>>();

  constructor(options: KobraXMqttOptions) {
    super();
    this.opts = {
      port: 9883,
      clientId: "kobramorda",
      ...options,
    };
  }

  private get reqTopicBase(): string {
    return `${TOPIC_ROOT}/slicer/printer/${this.opts.modeId}/${this.opts.deviceId}`;
  }

  private get webTopicBase(): string {
    return `${TOPIC_ROOT}/web/printer/${this.opts.modeId}/${this.opts.deviceId}`;
  }

  private get subTopic(): string {
    return `${TOPIC_ROOT}/printer/public/${this.opts.modeId}/${this.opts.deviceId}/#`;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect({
        protocol: "mqtts",
        host: this.opts.ip,
        port: this.opts.port,
        username: this.opts.username,
        password: this.opts.password,
        clientId: this.opts.clientId,
        clean: true,
        keepalive: 60,
        protocolVersion: 4,
        reconnectPeriod: 4000,
        connectTimeout: 8000,
        cert: readFileSync(this.opts.certPath),
        key: readFileSync(this.opts.keyPath),
        rejectUnauthorized: false, // printer presents a self-signed LAN cert
        ciphers: "DEFAULT:@SECLEVEL=0", // printer's TLS stack needs weak ciphers allowed
      } as mqtt.IClientOptions);

      client.once("connect", () => {
        client.subscribe(this.subTopic, { qos: 0 }, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

      client.on("message", (topic, payload) => this.handleMessage(topic, payload));
      client.on("error", (err) => this.emit("error", err));
      client.on("reconnect", () => this.emit("reconnect"));
      client.on("close", () => this.emit("close"));

      client.once("connect", () => this.emit("connect"));

      this.client = client;
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }
      this.client.end(false, {}, () => resolve());
    });
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  private handleMessage(topic: string, payload: Buffer) {
    let msg: {
      msgid?: string;
      state?: string;
      data?: unknown;
      type?: string;
      action?: string;
      code?: number;
      msg?: string;
    };
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      // Not JSON - ignore silently rather than crash the client on one bad frame.
      return;
    }

    const segments = topic.split("/");
    const reportKey = segments.slice(-2).join("/"); // e.g. "info/report"

    this.emit("report", { reportKey, topic, message: msg });

    const pending = this.pendingByReportKey.get(reportKey);
    if (!pending) {
      return;
    }

    // The firmware reports failures with a non-200 `code` and/or
    // state:"failed" rather than an MQTT-level error - surface those as a
    // rejected promise instead of silently "succeeding" (bit us for both
    // file listing and the light toggle during testing).
    if (msg.state === "failed" || (typeof msg.code === "number" && msg.code !== 200)) {
      clearTimeout(pending.timer);
      this.pendingByReportKey.delete(reportKey);
      pending.reject(new Error(`${msg.msg || "Принтер отклонил команду"} (код ${msg.code})`));
      return;
    }

    // Some actions (verified live: file/fileDetails on larger files) send a
    // quick code:200/data:null ack on this same report key before the real
    // payload arrives as a second message - if we're expecting real data,
    // treat a null-data reply for OUR action as non-final and keep waiting
    // rather than resolving the caller with an empty result.
    if (pending.skipNullData && msg.data === null && msg.action === pending.action) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingByReportKey.delete(reportKey);
    pending.resolve(msg);
  }

  /**
   * Sends a request and waits for its correlated reply. Requests sharing a
   * msgType are queued and run strictly one at a time (see class doc) - e.g.
   * fetching fileDetails for several files in parallel (the printer-files
   * grid does this, one call per visible card) queues cleanly instead of
   * the second call stomping on / losing the first's reply.
   */
  request(
    msgType: string,
    action: string,
    data: unknown = null,
    timeoutMs = 5000,
    opts: { skipNullData?: boolean } = {},
  ): Promise<unknown> {
    const tail = this.queueTailByMsgType.get(msgType) ?? Promise.resolve();
    const settle = () => {}; // advance the queue regardless of this request's outcome
    const run = tail.then(() => this.sendOnce(msgType, action, data, timeoutMs, opts));
    this.queueTailByMsgType.set(
      msgType,
      run.then(settle, settle),
    );
    return run;
  }

  private sendOnce(
    msgType: string,
    action: string,
    data: unknown,
    timeoutMs: number,
    opts: { skipNullData?: boolean },
  ): Promise<unknown> {
    if (!this.client) {
      return Promise.reject(new Error("Not connected"));
    }
    const reportKey = `${msgType}/report`;
    const envelope = {
      type: msgType,
      action,
      msgid: randomUUID(),
      timestamp: Date.now(),
      data,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByReportKey.delete(reportKey);
        reject(new Error(`Timed out waiting for ${reportKey}`));
      }, timeoutMs);

      this.pendingByReportKey.set(reportKey, { resolve, reject, timer, action, skipNullData: !!opts.skipNullData });

      this.client!.publish(`${this.reqTopicBase}/${msgType}`, JSON.stringify(envelope), { qos: 0 }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingByReportKey.delete(reportKey);
          reject(err);
        }
      });
    });
  }

  /** Fire-and-forget send on the "web" topic - no response is awaited. */
  publishWeb(msgType: string, action: string, data: unknown = null) {
    const envelope = { type: msgType, action, msgid: randomUUID(), timestamp: Date.now(), data };
    this.client?.publish(`${this.webTopicBase}/${msgType}`, JSON.stringify(envelope), { qos: 0 });
  }

  // --- Convenience command wrappers (see docs/protocol-spec.md for the full table) ---

  queryInfo() {
    return this.request("info", "query");
  }

  queryStatus() {
    return this.request("status", "query");
  }

  /** AMS/multi-material box status - verified live (4-slot ACE-style box). */
  queryMulticolorBox() {
    return this.request("multiColorBox", "getInfo", null, 8000);
  }

  setTemperature(nozzle: number, bed: number) {
    return this.request("tempature", "set", { target_nozzle_temp: nozzle, target_hotbed_temp: bed });
  }

  setFan(pct: number) {
    return this.request("fan", "set", { fan_speed_pct: pct });
  }

  setLight(on: boolean, brightness = 80) {
    // type:2 is what the reference project uses, but verified live against
    // this printer (camera-luminance sweep across type 1-4) that it's a
    // no-op here - type:3 is the one that actually drives the visible LED.
    // Firmware/hardware revisions may differ, so this may need revisiting
    // on other units.
    return this.request("light", "control", { type: 3, status: on ? 1 : 0, brightness });
  }

  startCamera() {
    return this.request("video", "startCapture");
  }

  stopCamera() {
    return this.request("video", "stopCapture");
  }

  /** Files stored on the printer's own onboard flash/SD. Verified live. */
  listPrinterFiles(dirPath = "/", pageNum = 1, pageSize = 200) {
    return this.request("file", "listLocal", { page_num: pageNum, page_size: pageSize, path: dirPath }, 8000);
  }

  /** Slicer metadata + thumbnail/outline-SVG for one file on the printer's storage. Verified live. */
  fileDetails(filename: string, root: "local" = "local") {
    // Large files (many MB) can take the printer a while to parse - verified
    // live that an 8MB file's real answer can arrive >10s after the initial
    // empty ack, so this needs real headroom.
    return this.request("file", "fileDetails", { root, filename }, 25000, { skipNullData: true });
  }

  deletePrinterFiles(filenames: string[], root: "local" = "local") {
    return this.request(
      "file",
      "deleteBatch",
      { root, files: filenames.map((filename) => ({ path: "/", filename })) },
      8000,
    );
  }

  pausePrint(taskid = "-1") {
    return this.request("print", "pause", { taskid });
  }

  resumePrint(taskid = "-1") {
    return this.request("print", "resume", { taskid });
  }

  stopPrint(taskid = "-1") {
    return this.request("print", "stop", { taskid });
  }

  startPrint(payload: Record<string, unknown>) {
    return this.request("print", "start", payload, 15000);
  }

  skipObjects(names: string[]) {
    return this.request("skip", "start", { objects_skip_parts: names });
  }

  private moveAxis(axis: number, moveType: number, distance: number, timeoutMs = 5000) {
    return this.request("axis", "move", { axis, move_type: moveType, distance }, timeoutMs);
  }

  homeAll() {
    return this.moveAxis(4, 2, 0, 30000);
  }

  /** axis: 1=Y, 2=X, 3=Z */
  homeAxis(axis: 1 | 2 | 3) {
    return this.moveAxis(axis, 2, 0, 30000);
  }

  /** axis: 1=Y, 2=X, 3=Z; direction: 0=negative, 1=positive */
  jog(axis: 1 | 2 | 3, direction: 0 | 1, distanceMm = 1) {
    return this.moveAxis(axis, direction, distanceMm);
  }
}
