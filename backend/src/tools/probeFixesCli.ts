import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { KobraXMqttClient } from "../mqttClient.js";
import { fetchKobraXCredentials } from "../credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    clientId: "kobramorda-probe-fixes",
  });
  await client.connect();

  console.log("--- setLight(true) ---");
  try {
    const r = await client.setLight(true);
    console.log(JSON.stringify(r, null, 2));
  } catch (err) {
    console.error("setLight failed:", (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log("--- setLight(false) ---");
  try {
    const r = await client.setLight(false);
    console.log(JSON.stringify(r, null, 2));
  } catch (err) {
    console.error("setLight failed:", (err as Error).message);
  }

  console.log("\n--- fileDetails (full, saved to file) ---");
  try {
    const details = await client.fileDetails("Saturn_Bracket_PETG.gcode");
    fs.writeFileSync(path.join(__dirname, "..", "..", "_fileDetails.json"), JSON.stringify(details, null, 2));
    console.log("saved to backend/_fileDetails.json, top-level keys of data.file_details:");
    console.log(Object.keys((details as any)?.data?.file_details ?? {}));
    console.log("thumbnail field present:", !!(details as any)?.data?.file_details?.thumbnail);
  } catch (err) {
    console.error("fileDetails failed:", (err as Error).message);
  }

  await new Promise((r) => setTimeout(r, 1000));
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
