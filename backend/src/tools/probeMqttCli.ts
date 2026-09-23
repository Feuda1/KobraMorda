import { fileURLToPath } from "node:url";
import path from "node:path";
import { KobraXMqttClient } from "../mqttClient.js";
import { fetchKobraXCredentials } from "../credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * One-shot, minimally-invasive live test: connect, send a single
 * query_info(), print the reply, disconnect immediately.
 *
 * DELIBERATELY NOT run automatically - the printer appears to accept only
 * one live mTLS session at a time, so this must only be executed with the
 * operator's explicit go-ahead at that specific moment (e.g. not while a
 * print is actively running through another bridge instance).
 *
 * Usage: npm run probe-mqtt -- <printer-ip>
 */
async function main() {
  const [ip] = process.argv.slice(2);
  if (!ip) {
    console.error("Usage: npm run probe-mqtt -- <printer-ip>");
    process.exit(1);
  }

  console.log(`Fetching credentials from ${ip} ...`);
  const creds = await fetchKobraXCredentials(ip);
  console.log(`Got credentials for device ${creds.deviceId} (mode ${creds.modeId}). Connecting to MQTT ...`);

  const client = new KobraXMqttClient({
    ip,
    username: creds.username,
    password: creds.password,
    modeId: creds.modeId,
    deviceId: creds.deviceId,
    certPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.crt"),
    keyPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.key"),
    clientId: "kobramorda-probe",
  });

  client.on("report", ({ reportKey, message }) => {
    console.log(`\n[report] ${reportKey}:`);
    console.log(JSON.stringify(message, null, 2));
  });

  await client.connect();
  console.log("Connected. Sending a single query_info(), then listening for 3s for any further pushes ...");
  try {
    const info = await client.queryInfo();
    console.log("\nquery_info() correlated reply:");
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await client.disconnect();
    console.log("\nDisconnected.");
  }
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
