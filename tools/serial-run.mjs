// Hardware validation: run a Toit image on the flashed device over serial,
// using the SAME jaguar-uart.js the browser app uses.
// Usage: node serial-run.mjs <port> <baud> <image.bin>
import { SerialPort } from "serialport";
import fs from "node:fs";
import { JaguarUart } from "../web/jaguar-uart.js";

const [portPath, baudStr, imgPath] = process.argv.slice(2);
const image = new Uint8Array(fs.readFileSync(imgPath));
const port = new SerialPort({ path: portPath, baudRate: parseInt(baudStr, 10) });

const transport = {
  write: (bytes) => new Promise((res, rej) => port.write(Buffer.from(bytes), (e) => e ? rej(e) : res())),
  onData: (cb) => port.on("data", (buf) => cb(new Uint8Array(buf))),
};

await new Promise((res) => port.on("open", res));
// Give the board time to boot and switch the console to the endpoint baud.
await new Promise((r) => setTimeout(r, 1800));

const jag = new JaguarUart(transport, {
  onConsole: (txt) => process.stdout.write(txt),
  onLog: (m) => console.error("[jag] " + m),
});

console.error("[jag] syncing...");
for (let i = 1; ; i++) {
  try { await jag.sync({ timeoutMs: 8000 }); break; }
  catch (e) { if (i >= 4) throw e; console.error("[jag] sync retry " + i); }
}
try { console.error("[jag] identity: " + JSON.stringify(await jag.identify())); } catch (e) { console.error("[jag] identify skipped: " + e.message); }
console.error("[jag] running image (" + image.length + " bytes)...");
await jag.run(image, {});
console.error("[jag] run issued; streaming console for 6s...");
await new Promise((res) => setTimeout(res, 9000));
port.close();
process.exit(0);
