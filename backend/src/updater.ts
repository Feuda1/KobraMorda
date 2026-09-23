import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface UpdateStatus {
  /** false if this checkout isn't a git repository at all (e.g. a zip download) - update is then unavailable. */
  isRepo: boolean;
  branch: string;
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  /** commit subjects between HEAD and origin/<branch>, newest first, capped */
  log: string[];
  /** tracked files with local changes - apply() refuses to touch these rather than discard them */
  dirty: string[];
  checkedAt: number;
  error: string;
}

const LOG_LIMIT = 20;

/**
 * Update via the git repository this checkout came from - no GitHub Releases
 * or CI needed, just `git fetch` + fast-forward + rebuild. Refuses to touch
 * anything if the working tree has local edits to tracked files (data/dist/
 * node_modules are gitignored and don't count), and refuses a non-fast-
 * forward history (diverged local commits) rather than force-reset over it.
 */
export class Updater {
  private readonly root: string;
  private busy = false;

  constructor(root: string) {
    this.root = root;
  }

  private git(args: string[]) {
    return run("git", args, { cwd: this.root, windowsHide: true });
  }

  /**
   * `npm` resolves to npm.cmd on Windows - execFile only finds it with a
   * shell, unlike a plain .exe like git. A single command string (not an
   * args array) avoids Node's shell-quoting deprecation warning; safe here
   * since every caller passes fixed, non-interpolated arguments.
   */
  private npm(command: string, cwd: string) {
    return run(`npm ${command}`, { cwd, windowsHide: true, timeout: 10 * 60_000, shell: true });
  }

  async status(): Promise<UpdateStatus> {
    const base: UpdateStatus = {
      isRepo: false,
      branch: "",
      currentCommit: "",
      latestCommit: "",
      behindBy: 0,
      log: [],
      dirty: [],
      checkedAt: Date.now(),
      error: "",
    };
    if (!fs.existsSync(path.join(this.root, ".git"))) return base;
    base.isRepo = true;

    try {
      const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      base.branch = branch;
      await this.git(["fetch", "--quiet", "origin", branch]);
      base.currentCommit = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
      base.latestCommit = (await this.git(["rev-parse", `origin/${branch}`])).stdout.trim();
      base.behindBy = Number((await this.git(["rev-list", "--count", `HEAD..origin/${branch}`])).stdout.trim());
      if (base.behindBy > 0) {
        const log = (await this.git(["log", "--oneline", `--max-count=${LOG_LIMIT}`, `HEAD..origin/${branch}`])).stdout;
        base.log = log.split("\n").filter(Boolean);
      }
      const dirty = (await this.git(["status", "--porcelain", "--untracked-files=no"])).stdout;
      base.dirty = dirty.split("\n").filter(Boolean);
    } catch (err) {
      base.error = describeGitError(err);
    }
    return base;
  }

  /** Pulls, reinstalls and rebuilds both packages. Throws with a Russian message on any failure - nothing is left half-applied silently. */
  async apply(onProgress: (step: string) => void): Promise<void> {
    if (this.busy) throw new Error("Обновление уже выполняется");
    this.busy = true;
    try {
      const s = await this.status();
      if (!s.isRepo) throw new Error("Это не git-копия проекта - обновление недоступно");
      if (s.dirty.length > 0) {
        throw new Error(`В коде есть несохранённые изменения (${s.dirty.length} файлов) - обновление остановлено, чтобы их не потерять`);
      }
      if (s.behindBy === 0) return; // nothing to do

      onProgress("Загрузка изменений");
      await this.git(["merge", "--ff-only", `origin/${s.branch}`]);

      for (const pkg of ["backend", "frontend"]) {
        onProgress(`Установка зависимостей (${pkg})`);
        await this.npm("install", path.join(this.root, pkg));
        onProgress(`Сборка (${pkg})`);
        await this.npm("run build", path.join(this.root, pkg));
      }
    } catch (err) {
      throw new Error(err instanceof Error && err.message.startsWith("Об") ? err.message : describeGitError(err));
    } finally {
      this.busy = false;
    }
  }

  /**
   * Starts a fresh server process from the (now rebuilt) dist and lets this
   * one exit - the same restart this project has always done safely during
   * a live print (the printer keeps printing; only our own MQTT/monitoring
   * session drops for a few seconds and reconnects).
   *
   * Two things verified live and worth keeping in mind if this ever needs
   * touching again:
   *
   * 1. The child MUST be `node.exe` spawned directly, not wrapped in a
   *    `cmd /c "..."` shell. A `detached: true` child survives its parent
   *    exiting only up to the *first* process in the chain that Windows
   *    actually treats as detached - going through an intermediate cmd.exe
   *    (e.g. for `>>` shell redirection) reliably got killed the moment
   *    this process exited, even with `detached`/`unref()`/`stdio: "ignore"`
   *    all set correctly on the cmd.exe spawn itself.
   * 2. The log file must be reopened via `fs.openSync` and handed to the
   *    child's stdio directly (not shell redirection either): cmd.exe's own
   *    `>>` opens the file with a sharing mode that a second, independent
   *    open of the same path collides with (EBUSY) - which is exactly what
   *    used to happen here, since the *old* process (this one) was itself
   *    started via a `cmd /c "... >> log"` wrapper. Two Node-opened append
   *    handles on the same file, from two different processes, don't
   *    conflict the same way.
   */
  restart(logFile: string): void {
    const backendDir = path.join(this.root, "backend");
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [path.join(backendDir, "dist", "server.js"), ...process.argv.slice(2)], {
      cwd: backendDir,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
    setTimeout(() => process.exit(0), 300);
  }
}

function describeGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not a git repository/i.test(msg)) return "Это не git-копия проекта - обновление недоступно";
  if (/could not resolve host|unable to access|timed? out/i.test(msg)) return "Нет связи с GitHub";
  if (/diverged|non-fast-forward|rejected/i.test(msg)) return "Локальная копия разошлась с GitHub - нужно вмешательство вручную";
  return `Ошибка git: ${msg.split("\n")[0]}`;
}
