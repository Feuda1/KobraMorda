import http from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Pushes a gcode file onto the printer's own storage over its HTTP upload
 * endpoint (port 18910, /gcode_upload?s=<session token>). The reference
 * bridge always does this before sending print/start - the file has to be
 * on the printer for the job to start. Wire format (captured by that
 * project with Wireshark from the vendor slicer): multipart with a
 * "filename" text field + a "gcode" file field, and the BambuLab-heritage
 * X-BBL-* headers the printer's HTTP stack expects.
 */
export function uploadGcodeToPrinter(
  printerIp: string,
  uploadUrl: string,
  filename: string,
  data: Buffer,
): Promise<unknown> {
  const token = uploadUrl.split("?s=")[1];
  if (!token) {
    return Promise.reject(new Error(`Upload URL has no session token: ${uploadUrl}`));
  }

  const boundary = "------------------------a3a050b927d92a4c";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${filename}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="gcode"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: printerIp,
        port: 18910,
        path: `/gcode_upload?s=${token}`,
        method: "POST",
        // Direct LAN connection - never via a system proxy.
        agent: false,
        headers: {
          "User-Agent": "AnycubicSlicerNext/1.3.9.4",
          Accept: "*/*",
          "X-BBL-Client-Name": "AnycubicSlicerNext",
          "X-BBL-Client-Type": "slicer",
          "X-BBL-Client-Version": "01.03.09.04",
          "X-BBL-Device-ID": randomUUID(),
          "X-BBL-Language": "de-DE",
          "X-BBL-OS-Type": "windows",
          "X-BBL-OS-Version": "10.0.26200",
          "X-File-Length": String(data.length),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
          Connection: "close",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Unexpected upload response: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    // Large files over slow Wi-Fi can legitimately take a while; the printer
    // also processes the file before replying.
    req.setTimeout(180_000, () => req.destroy(new Error("Printer upload timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
