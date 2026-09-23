import { createHash, createDecipheriv, randomInt } from "node:crypto";

/**
 * Auto-fetches MQTT connection credentials directly from a Kobra X printer
 * on the LAN, mirroring the handshake the vendor's own slicer uses:
 *
 *   1. GET  /info               -> a long opaque "full token" string
 *   2. POST /ctrl?ts&nonce&sign -> an AES-encrypted JSON blob
 *   3. decrypt that blob using two substrings of the full token
 *
 * No credentials are stored anywhere by the printer beyond this token
 * exchange - everything needed is derived per-request.
 */

export interface KobraXCredentials {
  ip: string;
  username: string;
  password: string;
  deviceId: string;
  modeId: string;
  modelName?: string;
  broker?: string;
  /** Optional per-device client cert/key, if the printer hands them out. */
  devicecrt?: string;
  devicepk?: string;
}

const DEFAULT_HTTP_PORT = 18910;
const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomNonce(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)];
  }
  return out;
}

function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

async function fetchFullToken(ip: string, port: number): Promise<string> {
  const res = await fetch(`http://${ip}:${port}/info`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`GET /info failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error("GET /info response did not contain a 'token' field");
  }
  return body.token;
}

async function fetchEncryptedConfig(
  ip: string,
  port: number,
  fullToken: string,
): Promise<{ info: string; token: string }> {
  const ts = Date.now().toString();
  const nonce = randomNonce();
  const sign = md5Hex(md5Hex(fullToken.slice(0, 16)) + ts + nonce);

  const url = new URL(`http://${ip}:${port}/ctrl`);
  url.searchParams.set("ts", ts);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("sign", sign);
  url.searchParams.set("did", "random");

  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`POST /ctrl failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { info?: string; token?: string } };
  if (!body.data?.info || !body.data?.token) {
    throw new Error("POST /ctrl response did not contain data.info / data.token");
  }
  return { info: body.data.info, token: body.data.token };
}

function decryptConfig(encryptedInfoB64: string, fullToken: string, responseToken: string): KobraXCredentials {
  const key = Buffer.from(fullToken.slice(16, 32), "utf8"); // AES-128-CBC (16 bytes)
  const iv = Buffer.from(responseToken, "utf8");
  if (key.length !== 16) {
    throw new Error(`Unexpected AES key length ${key.length} (expected 16 bytes from token[16:32])`);
  }
  if (iv.length !== 16) {
    throw new Error(`Unexpected AES IV length ${iv.length} (expected 16 bytes from the /ctrl response token)`);
  }

  const ciphertext = Buffer.from(encryptedInfoB64, "base64");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(plaintext.toString("utf8")) as KobraXCredentials;
}

export async function fetchKobraXCredentials(
  ip: string,
  port: number = DEFAULT_HTTP_PORT,
): Promise<KobraXCredentials> {
  const fullToken = await fetchFullToken(ip, port);
  const { info, token: responseToken } = await fetchEncryptedConfig(ip, port, fullToken);
  return decryptConfig(info, fullToken, responseToken);
}

/** Redacts private-key-shaped fields before logging/printing credentials. */
export function redactCredentials(creds: KobraXCredentials): Record<string, unknown> {
  const { devicecrt, devicepk, ...safe } = creds;
  return {
    ...safe,
    devicecrt: devicecrt ? "<redacted>" : undefined,
    devicepk: devicepk ? "<redacted>" : undefined,
  };
}
