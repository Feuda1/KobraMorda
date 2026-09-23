import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { KobraXMqttClient } from "../mqttClient.js";
import { fetchKobraXCredentials } from "../credentials.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function grabFrame(rtspUrl: string, outPath: string): Promise<void> {
  const isRtsp = rtspUrl.startsWith("rtsp://");
  const inputArgs = isRtsp
    ? ["-rtsp_transport", "tcp", "-probesize", "32", "-analyzeduration", "0"]
    : ["-use_wallclock_as_timestamps", "1", "-probesize", "500000", "-analyzeduration", "500000"];
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.HTTP_PROXY;
  await execFileAsync(
    ffmpegInstaller.path,
    [...inputArgs, "-i", rtspUrl, "-frames:v", "1", "-y", outPath],
    { env },
  );
}

async function avgLuma(imgPath: string): Promise<number> {
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.HTTP_PROXY;
  const { stderr } = await execFileAsync(
    ffmpegInstaller.path,
    ["-i", imgPath, "-vf", "signalstats,metadata=print", "-f", "null", "-"],
    { env },
  );
  const m = stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}

async function main() {
  const [ip] = process.argv.slice(2);
  const creds = await fetchKobraXCredentials(ip);
  const client = new KobraXMqttClient({
    ip,
    username: creds.username,
    password: creds.password,
    modeId: creds.modeId,
    deviceId: creds.deviceId,
    certPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.crt"),
    keyPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.key"),
    clientId: "kobramorda-probe-light",
  });
  await client.connect();
  const info = (await client.queryInfo()) as any;
  const rtspUrl: string = info.data.urls.rtspUrl;
  console.log("rtspUrl:", rtspUrl);

  const tmp = path.join(__dirname, "..", "..", "_light_test");
  fs.mkdirSync(tmp, { recursive: true });

  for (const type of [1, 2, 3, 4]) {
    for (const status of [1, 0]) {
      await client.request("light", "control", { type, status, brightness: 100 }, 5000);
      await new Promise((r) => setTimeout(r, 1200));
      const file = path.join(tmp, `type${type}_status${status}.jpg`);
      await grabFrame(rtspUrl, file);
      const y = await avgLuma(file);
      console.log(`type=${type} status=${status} -> YAVG=${y.toFixed(2)}`);
    }
  }

  // make sure we end with everything off
  await client.request("light", "control", { type: 2, status: 0, brightness: 0 }, 5000);
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
