import { fetchKobraXCredentials, redactCredentials } from "../credentials.js";

/**
 * Manual smoke test: fetches and decrypts MQTT credentials from a real
 * printer on the LAN. HTTP-only (GET /info, POST /ctrl) - never opens an
 * MQTT/TLS session, so it cannot interfere with an in-progress print.
 *
 * Usage: npm run fetch-credentials -- <printer-ip> [port]
 */
async function main() {
  const [ip, portArg] = process.argv.slice(2);
  if (!ip) {
    console.error("Usage: npm run fetch-credentials -- <printer-ip> [port]");
    process.exit(1);
  }
  const port = portArg ? Number(portArg) : undefined;

  console.log(`Fetching credentials from ${ip}${port ? `:${port}` : ""} ...`);
  const creds = await fetchKobraXCredentials(ip, port);
  console.log("Decrypted credentials (secrets redacted):");
  console.log(JSON.stringify(redactCredentials(creds), null, 2));
}

main().catch((err) => {
  console.error("Failed to fetch credentials:", err);
  process.exit(1);
});
