import { fileURLToPath } from "node:url";
import path from "node:path";
import { KobraXMqttClient } from "../mqttClient.js";
import { fetchKobraXCredentials } from "../credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function getSlots(client: KobraXMqttClient) {
  const r = (await client.request("multiColorBox", "getInfo", null, 8000)) as any;
  return r.data.multi_color_box[0].slots;
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
    clientId: "kobramorda-probe-ams-set",
  });
  client.on("report", ({ reportKey, message }) => {
    if (reportKey === "multiColorBox/report") {
      console.log(`[live report] ${JSON.stringify(message.data?.multi_color_box?.[0]?.slots ?? message)}`);
    }
  });
  await client.connect();

  console.log("--- BEFORE ---");
  console.log(JSON.stringify(await getSlots(client), null, 2));

  console.log("\n--- sending setInfo: slot 0 -> PLA, red ---");
  client.publishWeb("multiColorBox", "setInfo", {
    multi_color_box: [{ id: 0, slots: [{ index: 0, type: "PLA", color: [255, 0, 0] }] }],
  });

  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n--- AFTER (re-query) ---");
  console.log(JSON.stringify(await getSlots(client), null, 2));

  await new Promise((r) => setTimeout(r, 2000));
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
