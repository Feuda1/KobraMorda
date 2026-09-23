import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import type { CameraPipeline } from "./camera.js";
import type { PrinterTelemetry } from "./telemetry.js";

const IDLE_GRACE_MS = 90_000;

export interface TimelapseMeta {
  id: string;
  filename: string;
  createdAt: number;
  frameCount: number;
  sizeBytes: number;
}

/**
 * The printer's own MQTT protocol has a `task_settings.timelapse` field but
 * the reference bridge always sends it disabled (status: 0) - the printer
 * firmware doesn't actually record anything itself over this channel. So
 * timelapses are built here instead: one camera snapshot per layer change
 * during a print, assembled into an mp4 with ffmpeg once the print
 * completes. Layer-change capture (not a fixed interval) matches how
 * OctoPrint/Obico-style "vertical" timelapses are usually made and keeps
 * frame count proportional to the model, not the print duration.
 */
export class TimelapseRecorder extends EventEmitter {
  private enabled = false;
  private currentJob: { dir: string; filename: string; frameCount: number; lastLayer: number } | null = null;
  private readonly framesRoot: string;
  private readonly outputRoot: string;
  private readonly settingsFile: string;

  constructor(
    private readonly camera: CameraPipeline,
    telemetry: PrinterTelemetry,
    dataDir: string,
  ) {
    super();
    this.framesRoot = path.join(dataDir, "timelapse-frames");
    this.outputRoot = path.join(dataDir, "timelapses");
    this.settingsFile = path.join(dataDir, "timelapse-settings.json");
    fs.mkdirSync(this.framesRoot, { recursive: true });
    fs.mkdirSync(this.outputRoot, { recursive: true });
    this.loadSettings();

    let lastPrintState = telemetry.state.printState;
    let recovered = false;
    let standbySince = 0;
    telemetry.on("change", () => {
      const { printState, currentLayer, filename, deviceState, printDurationSec } = telemetry.state;

      // Wait for the first real report before deciding anything about jobs left
      // over from a previous bridge run (restart in the middle of a print).
      if (!recovered) {
        if (!deviceState) return;
        recovered = true;
        this.recoverLeftovers(printState, filename, currentLayer, printDurationSec);
        lastPrintState = printState;
      }

      // The firmware briefly reports idle around job start/stop, so idle only
      // ends a recording once it has lasted a while.
      if (printState === "standby" || printState === "error") {
        if (this.currentJob) {
          if (!standbySince) standbySince = Date.now();
          const gone = printState === "error" || ["stoped", "canceled", "failed"].includes(deviceState);
          if (gone || Date.now() - standbySince > IDLE_GRACE_MS) this.discardJob();
        }
      } else {
        standbySince = 0;
      }

      if (printState === "printing" && !this.currentJob && lastPrintState !== "paused") {
        if (this.enabled) this.startJob(filename ?? "print");
      }
      if (printState === "printing" && this.currentJob && currentLayer > this.currentJob.lastLayer) {
        this.captureFrame(currentLayer);
      } else if (printState === "complete" && this.currentJob) {
        this.finishJob();
      }

      lastPrintState = printState;
    });
    // idle is only re-evaluated on telemetry changes; make sure a quiet printer still expires it
    setInterval(() => telemetry.emit("change"), 30_000).unref();
  }

  private jobFile(dir: string) {
    return path.join(dir, "job.json");
  }

  private persistJob() {
    const j = this.currentJob;
    if (!j) return;
    fs.writeFileSync(
      this.jobFile(j.dir),
      JSON.stringify({ filename: j.filename, frameCount: j.frameCount, lastLayer: j.lastLayer }),
    );
  }

  /**
   * Frames left by an earlier run. A print that is still going continues its
   * recording (frames from before and after a restart are joined); anything
   * else that was recorded is assembled as it is.
   */
  private recoverLeftovers(printState: string, filename: string | null, layer: number, printedSec: number) {
    const printing = printState === "printing" || printState === "paused";
    const jobless: string[] = [];

    for (const name of fs.readdirSync(this.framesRoot).sort()) {
      const dir = path.join(this.framesRoot, name);
      let saved: { filename: string; frameCount: number; lastLayer: number } | null = null;
      try {
        saved = JSON.parse(fs.readFileSync(this.jobFile(dir), "utf8"));
      } catch {
        jobless.push(dir);
        continue;
      }
      const frames = this.jpgs(dir).length;
      if (saved && printing && !this.currentJob && saved.filename === filename) {
        this.currentJob = { dir, filename: saved.filename, frameCount: frames, lastLayer: saved.lastLayer };
      } else if (frames >= 2) {
        this.assemble({ dir, filename: saved?.filename ?? "print", frameCount: frames });
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // recordings without a job file (older bridge version): those started during the current print belong to it
    const printStart = Date.now() - printedSec * 1000 - 10 * 60_000;
    const mine = printing && !this.currentJob ? jobless.filter((d) => Number(path.basename(d)) >= printStart) : [];
    for (const d of jobless) {
      if (mine.includes(d)) continue;
      const frames = this.jpgs(d).length;
      if (frames >= 2) this.assemble({ dir: d, filename: "print", frameCount: frames });
      else fs.rmSync(d, { recursive: true, force: true });
    }
    if (mine.length > 0) {
      const base = mine[0];
      let n = this.jpgs(base).length;
      for (const other of mine.slice(1)) {
        for (const f of this.jpgs(other)) {
          fs.renameSync(path.join(other, f), path.join(base, `frame_${String(++n).padStart(5, "0")}.jpg`));
        }
        fs.rmSync(other, { recursive: true, force: true });
      }
      this.currentJob = { dir: base, filename: filename ?? "print", frameCount: n, lastLayer: layer };
      this.persistJob();
    }
  }

  private jpgs(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  }

  frameCount(): number {
    return this.currentJob?.frameCount ?? 0;
  }

  private loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
      this.enabled = !!raw.enabled;
    } catch {
      this.enabled = false;
    }
  }

  private saveSettings() {
    fs.writeFileSync(this.settingsFile, JSON.stringify({ enabled: this.enabled }));
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean) {
    this.enabled = value;
    this.saveSettings();
  }

  isRecording(): boolean {
    return this.currentJob !== null;
  }

  private startJob(filename: string) {
    const dir = path.join(this.framesRoot, String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    this.currentJob = { dir, filename, frameCount: 0, lastLayer: 0 };
    this.persistJob();
  }

  private captureFrame(layer: number) {
    if (!this.currentJob) return;
    const frame = this.camera.getSnapshot();
    if (!frame) return;
    this.currentJob.frameCount++;
    this.currentJob.lastLayer = layer;
    const name = `frame_${String(this.currentJob.frameCount).padStart(5, "0")}.jpg`;
    fs.writeFileSync(path.join(this.currentJob.dir, name), frame);
    this.persistJob();
  }

  private discardJob() {
    if (!this.currentJob) return;
    fs.rmSync(this.currentJob.dir, { recursive: true, force: true });
    this.currentJob = null;
  }

  private finishJob() {
    const job = this.currentJob;
    this.currentJob = null;
    if (job) this.assemble(job);
  }

  private assemble(job: { dir: string; filename: string; frameCount: number }) {
    if (job.frameCount < 2) {
      fs.rmSync(job.dir, { recursive: true, force: true });
      return;
    }

    const id = String(Date.now());
    const outputPath = path.join(this.outputRoot, `${id}.mp4`);
    const args = [
      "-y",
      "-framerate",
      "8",
      "-i",
      path.join(job.dir, "frame_%05d.jpg"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ];
    const proc = spawn(ffmpegInstaller.path, args, { stdio: "ignore" });
    proc.on("exit", (code) => {
      fs.rmSync(job.dir, { recursive: true, force: true });
      if (code !== 0 || !fs.existsSync(outputPath)) return;
      const meta: TimelapseMeta = {
        id,
        filename: job.filename,
        createdAt: Date.now(),
        frameCount: job.frameCount,
        sizeBytes: fs.statSync(outputPath).size,
      };
      fs.writeFileSync(path.join(this.outputRoot, `${id}.json`), JSON.stringify(meta));
      this.emit("recorded", meta);
    });
  }

  list(): TimelapseMeta[] {
    return fs
      .readdirSync(this.outputRoot)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.outputRoot, f), "utf8")) as TimelapseMeta)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  videoPath(id: string): string | null {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
    const file = path.join(this.outputRoot, `${safe}.mp4`);
    return fs.existsSync(file) ? file : null;
  }

  delete(id: string): boolean {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
    const mp4 = path.join(this.outputRoot, `${safe}.mp4`);
    const json = path.join(this.outputRoot, `${safe}.json`);
    let existed = false;
    if (fs.existsSync(mp4)) {
      fs.rmSync(mp4);
      existed = true;
    }
    if (fs.existsSync(json)) fs.rmSync(json);
    return existed;
  }
}
