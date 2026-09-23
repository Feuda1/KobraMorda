import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_BACKOFF_MS = 30_000;
const STALL_MS = 10_000;
const BASE_BACKOFF_MS = 2_000;

/**
 * RTSP -> MJPEG bridge for the printer's built-in camera. Runs a single
 * ffmpeg process (transcoding, not just passthrough) and fans decoded JPEG
 * frames out to any number of HTTP listeners (snapshot cache + live
 * multipart stream), respawning with exponential backoff if ffmpeg dies or
 * the printer's camera stream drops.
 */
type Bytes = ReturnType<typeof Buffer.alloc>;

export class CameraPipeline extends EventEmitter {
  private proc: ChildProcess | undefined;
  private buffer: Bytes = Buffer.alloc(0);
  private lastFrame: Bytes | undefined;
  private failCount = 0;
  private stopped = true;
  private activeUrl: string | undefined;
  private respawnTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastActivity = 0;

  constructor(private readonly getRtspUrl: () => string | null) {
    super();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    // ffmpeg can hang without exiting (printer stops feeding the stream but
    // keeps the socket open) - restart it when frames stop arriving.
    this.watchdog = setInterval(() => {
      if (this.stopped || !this.proc) return;
      if (Date.now() - this.lastActivity > STALL_MS) {
        this.failCount = 0;
        this.emit("stalled");
        this.proc.kill();
      }
    }, 3000);
    this.tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.respawnTimer);
    this.proc?.kill();
    this.proc = undefined;
  }

  getSnapshot(): Bytes | undefined {
    return this.lastFrame;
  }

  /** Call whenever telemetry refreshes the RTSP URL - restarts immediately if it changed (printer reboot rotates it). */
  notifyUrlMayHaveChanged() {
    const url = this.getRtspUrl();
    if (url && url !== this.activeUrl && this.proc) {
      this.failCount = 0;
      this.proc.kill();
    }
  }

  private tick() {
    if (this.stopped) return;
    const url = this.getRtspUrl();
    if (!url) {
      this.respawnTimer = setTimeout(() => this.tick(), 2000);
      return;
    }
    this.activeUrl = url;
    this.spawn(url);
  }

  private spawn(url: string) {
    // Despite the field name, the printer's "rtspUrl" is sometimes an
    // http:// FLV stream rather than true RTSP - verified live (Kobra X
    // returns an http://.../live/... URL). Each needs different input
    // tuning: real RTSP wants a tiny probesize/zero analyzeduration for low
    // latency; FLV-over-HTTP needs a real probe (its timestamps aren't
    // reliably monotonic) or ffmpeg hangs trying to detect the format.
    const isRtsp = url.startsWith("rtsp://");
    const inputArgs = isRtsp
      ? ["-rtsp_transport", "tcp", "-probesize", "32", "-analyzeduration", "0", "-timeout", "10000000"]
      : ["-use_wallclock_as_timestamps", "1", "-probesize", "500000", "-analyzeduration", "500000"];

    const args = [
      ...inputArgs,
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-i",
      url,
      "-vf",
      "fps=8,scale=640:-2",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "4",
      "-",
    ];
    // The printer is always on the LAN - never go through a system/corporate
    // HTTP(S) proxy to reach it, even if one is configured for the machine.
    const env = { ...process.env };
    delete env.http_proxy;
    delete env.HTTP_PROXY;
    delete env.https_proxy;
    delete env.HTTPS_PROXY;

    const proc = spawn(ffmpegInstaller.path, args, { stdio: ["ignore", "pipe", "pipe"], env });
    this.proc = proc;
    this.lastActivity = Date.now();
    this.buffer = Buffer.alloc(0);

    proc.stdout.on("data", (chunk: Bytes) => this.onData(chunk));
    if (process.env.CAMERA_DEBUG) {
      proc.stderr.on("data", (chunk: Bytes) => process.stderr.write(chunk));
    }
    proc.on("exit", (code, signal) => {
      if (process.env.CAMERA_DEBUG) console.warn(`[camera] ffmpeg exited code=${code} signal=${signal}`);
      this.proc = undefined;
      if (this.stopped) return;
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.failCount, MAX_BACKOFF_MS);
      this.failCount++;
      this.respawnTimer = setTimeout(() => this.tick(), delay);
    });
  }

  private onData(chunk: Bytes) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start === -1) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const end = this.buffer.indexOf(EOI, start + 2);
      if (end === -1) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return;
      }
      const frame = Buffer.from(this.buffer.subarray(start, end + 2));
      this.lastFrame = frame;
      this.lastActivity = Date.now();
      this.failCount = 0;
      this.emit("frame", frame);
      this.buffer = this.buffer.subarray(end + 2);
    }
  }
}
