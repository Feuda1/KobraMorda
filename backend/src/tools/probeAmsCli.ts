import { fileURLToPath } from "node:url";
import path from "node:path";
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
    clientId: "kobramorda-probe-ams",
  });
  client.on("report", ({ reportKey, message }) => {
    console.log(`\n[report] ${reportKey}:`);
    console.log(JSON.stringify(message, null, 2));
  });
  await client.connect();
  console.log("--- multiColorBox getInfo ---");
  try {
    const r = await (client as any).request("multiColorBox", "getInfo", null, 8000);
    console.log(JSON.stringify(r, null, 2));
  } catch (err) {
    console.error("failed:", (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 2000));
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
