import { fileURLToPath } from "node:url";
import path from "node:path";
import { KobraXMqttClient } from "../mqttClient.js";
import { fetchKobraXCredentials } from "../credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read-only probe: lists files stored on the printer's own flash. Usage: tsx probeFilesCli.ts <ip> */
async function main() {
  const [ip] = process.argv.slice(2);
  if (!ip) {
    console.error("Usage: tsx src/tools/probeFilesCli.ts <printer-ip>");
    process.exit(1);
  }
  const creds = await fetchKobraXCredentials(ip);
  const client = new KobraXMqttClient({
    ip,
    username: creds.username,
    password: creds.password,
    modeId: creds.modeId,
    deviceId: creds.deviceId,
    certPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.crt"),
    keyPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.key"),
    clientId: "kobramorda-probe-files",
  });
  await client.connect();
  const list = await (client as any).request(
    "file",
    "listLocal",
    { page_num: 1, page_size: 200, path: "/" },
    5000,
  );
  console.log("\nlistLocal:", JSON.stringify(list, null, 2));

  const details = await (client as any).request(
    "file",
    "fileDetails",
    { root: "local", filename: "Saturn_Bracket_PETG.gcode" },
    8000,
  );
  console.log("\nfileDetails:", JSON.stringify(details, null, 2)?.slice(0, 2000));
  await new Promise((r) => setTimeout(r, 1000));
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
