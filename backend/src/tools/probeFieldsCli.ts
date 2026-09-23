import { fileURLToPath } from "node:url";
import path from "node:path";
import { KobraXMqttClient } from "../mqttClient.js";
import { fetchKobraXCredentials } from "../credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const [ip, filename] = process.argv.slice(2);
  const creds = await fetchKobraXCredentials(ip);
  const client = new KobraXMqttClient({
    ip,
    username: creds.username,
    password: creds.password,
    modeId: creds.modeId,
    deviceId: creds.deviceId,
    certPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.crt"),
    keyPath: path.join(__dirname, "..", "..", "certs", "anycubic_slicer.key"),
    clientId: "kobramorda-probe-fields",
  });
  await client.connect();
  const d = (await client.fileDetails(filename)) as any;
  console.log("raw response:", JSON.stringify(d, null, 2).slice(0, 500));
  const fd = d.data?.file_details ?? {};
  console.log("total_filament_used:", fd.total_filament_used);
  console.log("estimated_time_s:", fd.estimated_time_s);
  console.log("layer_count:", fd.layer_count);
  console.log("print_parameters:", JSON.stringify(fd.print_parameters, null, 2));
  console.log("model_dimensions:", JSON.stringify(fd.model_dimensions));
  console.log("paint_infos:", JSON.stringify(fd.paint_infos));
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
