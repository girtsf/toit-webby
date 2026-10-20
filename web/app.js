// Toit Webby — flash Jaguar onto an ESP32 over USB, then compile & run Toit
// code on it, entirely in the browser. Serial-first (no network needed).
import * as toit from "./toit-runtime.js";
import { requestPort, detectChip, flashImage, WebSerialTransport, isSupported } from "./web-serial.js";
import { JaguarUart } from "./jaguar-uart.js";
import { createEditor } from "./editor.js";

const SDK_VERSION = "v2.0.0-alpha.199";
// Prefer a same-origin copy: GitHub's release assets send no CORS/CORP headers,
// so a cross-origin fetch is blocked under cross-origin isolation (COEP). Vendor
// the envelopes next to the app (assets/) and serve them from the same origin.
// assets/envelopes.json lists the vendored envelope names (see fetch-assets.sh).
const envelopeLocal = (name) => `./assets/firmware-${name}.envelope.gz`;
const envelopeUrl = (name) => `https://github.com/toitlang/envelopes/releases/download/${SDK_VERSION}/firmware-${name}.envelope.gz`;
const UART_BAUD = 921600;

const $ = (id) => document.getElementById(id);
const state = { port: null, transport: null, jag: null, deviceId: null, chip: null, envelope: null };

function log(msg, cls = "") {
  const el = $("console");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function setStatus(s) { $("status").textContent = s; }
function enable(id, on) { $(id).disabled = !on; }

const DEFAULT_CODE = `// Edit, then "Compile & Run" to push over USB.
import gpio

main:
  print "Hello from Toit Webby!"
  count := 0
  5.repeat:
    print "tick $count"
    count++
    sleep --ms=500
  print "done"
`;

const editor = createEditor($("editor"), DEFAULT_CODE);

// ---- Connect -------------------------------------------------------------
$("connect").addEventListener("click", async () => {
  let port;
  try {
    port = await requestPort();
  } catch (e) { log("Connect cancelled: " + e.message, "err"); return; }
  await disconnectJag();
  state.port = port;
  state.chip = null;
  showDevice(null);
  enable("flash", false); enable("run", false); enable("connect", false);
  try {
    setStatus("detecting chip…");
    log("Serial port selected. Detecting chip (resets the device)…");
    state.chip = await detectChip(port, { onLog: (t) => { if (t && t.trim()) log(t.trim(), "dim"); } });
    showDevice(state.chip);
    log("Detected " + state.chip.description + ".", "ok");
    await populateEnvelopes(state.chip.chip);
    setStatus("connected: " + state.chip.name);
  } catch (e) {
    log("Chip detection failed: " + (e.stack || e.message), "err");
    setStatus("detection failed");
  } finally {
    enable("connect", true);
    enable("run", true);
    enable("flash", !!state.chip && $("envelope").options.length > 0);
  }
});

function showDevice(chip) {
  const el = $("devinfo");
  el.hidden = !chip;
  if (!chip) return;
  const rows = [
    ["Chip", chip.description],
    ["Features", chip.features.map((f) => f.trim()).join(", ")],
    ["Flash", chip.flashSize ? chip.flashSize + " MB" : "unknown"],
    ["MAC", chip.mac],
  ];
  el.replaceChildren(...rows.map(([k, v]) => {
    const row = document.createElement("div");
    const kEl = document.createElement("span"); kEl.textContent = k;
    const vEl = document.createElement("span"); vEl.textContent = v;
    row.append(kEl, vEl);
    return row;
  }));
}

let envelopeNames = null;
// Fill the envelope dropdown with the envelopes built for `chip` ("esp32s3"
// matches "esp32s3" and "esp32s3-*", but not "esp32s3x").
async function populateEnvelopes(chip) {
  if (!envelopeNames) {
    const resp = await fetch("./assets/envelopes.json");
    if (!resp.ok) throw new Error("envelopes.json: HTTP " + resp.status);
    envelopeNames = await resp.json();
  }
  const names = envelopeNames.filter((n) => n === chip || n.startsWith(chip + "-"));
  const sel = $("envelope");
  sel.replaceChildren(...names.map((n) => {
    const o = document.createElement("option");
    o.value = n; o.textContent = n;
    return o;
  }));
  if (names.includes(chip)) sel.value = chip;
  if (!names.length) log("No Toit envelopes available for " + chip + ".", "err");
}

// ---- Flash Jaguar --------------------------------------------------------
$("flash").addEventListener("click", async () => {
  if (!state.port) return;
  const name = $("devname").value.trim() || "webby-device";
  const ssid = $("ssid").value;
  const pass = $("pass").value;
  try {
    enable("flash", false); enable("run", false); enable("connect", false);
    setStatus("flashing…");
    await disconnectJag();
    const envName = $("envelope").value;
    log("Fetching firmware envelope '" + envName + "' (~11 MB)…");
    const envelope = await getEnvelope(envName);
    log("Loading Jaguar runtime…");
    const jaguarSnapshot = new Uint8Array(await (await fetch("./assets/jaguar.snapshot")).arrayBuffer());
    state.deviceId = crypto.randomUUID();
    log("Building firmware image in-browser (name='" + name + "', id=" + state.deviceId + ")…");
    const flashBin = await toit.buildFlashImage(envelope, {
      name, id: state.deviceId, chip: state.chip.chip, wifiSsid: ssid, wifiPassword: pass,
      uartBaud: UART_BAUD, jaguarSnapshot,
    });
    log("Flash image built: " + flashBin.length + " bytes. Writing over USB…");
    await flashImage(state.port, flashBin, {
      onProgress: (f) => setStatus("flashing… " + Math.round(f * 100) + "%"),
      onLog: (t) => { if (t && t.trim()) log(t.trim(), "dim"); },
    });
    log("Flash complete. Device is rebooting into Jaguar.", "ok");
    setStatus("flashed");
  } catch (e) {
    log("Flash failed: " + (e.stack || e.message), "err");
    setStatus("flash failed");
  } finally {
    enable("flash", !!state.chip); enable("run", true); enable("connect", true);
  }
});

// ---- Compile & Run -------------------------------------------------------
$("run").addEventListener("click", async () => {
  if (!state.port) return;
  try {
    enable("run", false); enable("flash", false);
    setStatus("compiling…");
    log("Compiling Toit source…");
    const image = await toit.buildImage(editor.getValue());
    log("Compiled to device image: " + image.length + " bytes.", "ok");

    await ensureConnected();
    setStatus("running…");
    log("Sending program to device…");
    await state.jag.run(image, {});
    log("Program started on device. Output:", "ok");
    setStatus("running");
  } catch (e) {
    log("Run failed: " + (e.stack || e.message), "err");
    setStatus("run failed");
  } finally {
    enable("run", true); enable("flash", !!state.chip);
  }
});

// Open the UART link to a device that's already running Jaguar. We do NOT pulse
// a reset here — the device is already up, and `run()` re-syncs+retries on its
// own. (A reset pulse can drop some boards into the ROM bootloader.)
async function ensureConnected() {
  if (state.jag) return;
  const t = new WebSerialTransport(state.port);
  await t.open(UART_BAUD);
  state.transport = t;
  state.jag = new JaguarUart(t, {
    onConsole: (txt) => appendConsole(txt),
    onLog: (m) => log("[uart] " + m, "dim"),
  });
  // Best-effort sync + identify so we can show what we're connected to; harmless
  // if dropped (the subsequent run() establishes its own sync and retries).
  try {
    await state.jag.sync({ timeoutMs: 8000 });
    const id = await state.jag.identify();
    log("Connected to '" + id.name + "' (SDK " + id.sdkVersion + ").", "ok");
  } catch (_) {}
}

// Release the port so esptool can take it (detect/flash).
async function disconnectJag() {
  if (!state.transport) return;
  await state.transport.close();
  state.transport = null;
  state.jag = null;
}

let consoleLineBuf = "";
function appendConsole(txt) {
  consoleLineBuf += txt;
  const lines = consoleLineBuf.split("\n");
  consoleLineBuf = lines.pop();
  for (const l of lines) if (l.trim()) log(l, "device");
}

// ---- Envelope fetch (with manual-file fallback) --------------------------
async function gunzip(stream) {
  return new Uint8Array(await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
async function getEnvelope(name) {
  if (state.envelope?.name === name) return state.envelope.data;
  // 1) same-origin vendored copy (works under COEP); 2) GitHub (often CORS-blocked).
  for (const [where, url] of [["app server", envelopeLocal(name)], ["GitHub", envelopeUrl(name)]]) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      state.envelope = { name, data: await gunzip(resp.body) };
      return state.envelope.data;
    } catch (e) {
      log("Envelope fetch from " + where + " failed (" + e.message + ").", "dim");
    }
  }
  // 3) manual file picker
  log("Pick the firmware .envelope.gz file manually.", "err");
  const file = await pickFile(".gz,.envelope");
  const raw = new Uint8Array(await file.arrayBuffer());
  const data = file.name.endsWith(".gz")
    ? await gunzip(new Blob([raw]).stream())
    : raw;
  state.envelope = { name, data };
  return data;
}

function pickFile(accept) {
  return new Promise((res, rej) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept;
    inp.onchange = () => inp.files[0] ? res(inp.files[0]) : rej(new Error("no file"));
    inp.click();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Init ----------------------------------------------------------------
if (!isSupported()) {
  setStatus("Web Serial not supported");
  log("This browser doesn't support Web Serial. Use Chrome, Edge, or Opera over HTTPS/localhost.", "err");
  enable("connect", false);
} else {
  setStatus(window.crossOriginIsolated ? "ready" : "ready (no cross-origin isolation — VM may fail)");
  if (!window.crossOriginIsolated) log("Not cross-origin isolated; the Toit VM needs it. The service worker should reload the page once.", "dim");
}
