// Toit Webby — flash Jaguar* onto an ESP32 over USB, then compile & run Toit
// code on it, entirely in the browser. Code goes over USB (Jaguar's UART
// protocol) or over Wi-Fi (Jaguar*'s HTTP API, see jaguar-http.js).
import * as toit from "./toit-runtime.js";
import { fetchBytes, mb } from "./fetch-progress.js";
import { requestPort, detectChip, flashImage, WebSerialTransport, isSupported } from "./web-serial.js";
import { JaguarUart } from "./jaguar-uart.js";
import { JaguarHttp, mdnsHostname } from "./jaguar-http.js";
import { EXAMPLES } from "./examples.js";
import { createEditor } from "./editor.js";

const SDK_VERSION = "v2.0.0-alpha.199";
// Prefer a same-origin copy: GitHub's release assets send no CORS/CORP headers,
// so a cross-origin fetch is blocked under cross-origin isolation (COEP). Vendor
// the envelopes next to the app (assets/) and serve them from the same origin.
// assets/envelopes.json lists the vendored envelope names (see fetch-assets.sh).
const envelopeLocal = (name) => `./assets/firmware-${name}.envelope.gz`;
const envelopeUrl = (name) => `https://github.com/toitlang/envelopes/releases/download/${SDK_VERSION}/firmware-${name}.envelope.gz`;
const UART_BAUD = 921600;
// Jaguar* (Jaguar + mDNS, CORS, print capture; built by tools/build-snapshots.sh).
const JAGUAR_SNAPSHOT = "./assets/jaguar-webby.snapshot";
// Baked into the firmware: the device's page at "/" sends browsers here.
const APP_URL = new URL(".", location.href).href;

const $ = (id) => document.getElementById(id);
const state = {
  port: null, transport: null, jag: null, deviceId: null, chip: null, envelope: null,
  wifi: null,           // JaguarHttp of the connected Wi-Fi device
  logAbort: null,       // stops the Wi-Fi device's log poll
  snapshots: new Map(), // log source ("program" or container name) -> snapshot, to decode traces
};

function log(msg, cls = "") {
  const el = $("console");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  return line;
}
function setStatus(s) { $("status").textContent = s; }
function enable(id, on) { $(id).disabled = !on; }

const editor = createEditor($("editor"), EXAMPLES[0].code);
$("examples").replaceChildren(...EXAMPLES.map((ex, i) => {
  const o = document.createElement("option");
  o.value = i; o.textContent = ex.name;
  return o;
}));
$("examples").addEventListener("change", () => editor.setValue(EXAMPLES[$("examples").value].code));
toit.onProgress((label, loaded, total) => setStatus("loading " + label + "… " + progressText(loaded, total)));
const progressText = (loaded, total) => mb(loaded) + (total ? " / " + mb(total) : "") + " MB";

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
  enable("flash", false); enableSend(false); enable("connect", false);
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
    updateTarget();
    enable("flash", !!state.chip && $("envelope").options.length > 0);
  }
});

function showDevice(chip) {
  const el = $("devinfo");
  el.hidden = !chip;
  if (!chip) return;
  el.replaceChildren(...infoRows([
    ["Chip", chip.description],
    ["Features", chip.features.map((f) => f.trim()).join(", ")],
    ["Flash", chip.flashSize ? chip.flashSize + " MB" : "unknown"],
    ["MAC", chip.mac],
  ]));
}

function infoRows(rows) {
  return rows.map(([k, v]) => {
    const row = document.createElement("div");
    const kEl = document.createElement("span"); kEl.textContent = k;
    const vEl = document.createElement("span"); vEl.textContent = v;
    row.append(kEl, vEl);
    return row;
  });
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
    enable("flash", false); enableSend(false); enable("connect", false);
    setStatus("flashing…");
    await disconnectJag();
    const envName = $("envelope").value;
    log("Fetching firmware envelope '" + envName + "'…");
    const envelope = await getEnvelope(envName);
    log("Loading Jaguar* runtime…");
    const resp = await fetch(JAGUAR_SNAPSHOT);
    if (!resp.ok) throw new Error(JAGUAR_SNAPSHOT + ": HTTP " + resp.status);
    const jaguarSnapshot = new Uint8Array(await resp.arrayBuffer());
    const partitions = await getPartitionOverride(state.chip.chip);
    if (partitions) log("Using Jaguar's partition table for " + state.chip.chip + ".", "dim");
    state.deviceId = crypto.randomUUID();
    log("Building firmware image in-browser (name='" + name + "', id=" + state.deviceId + ")…");
    const flashBin = await toit.buildFlashImage(envelope, {
      name, id: state.deviceId, chip: state.chip.chip, wifiSsid: ssid, wifiPassword: pass,
      uartBaud: UART_BAUD, jaguarSnapshot, partitions, webbyUrl: APP_URL,
    });
    log("Flash image built: " + flashBin.length + " bytes. Writing over USB…");
    await flashImage(state.port, flashBin, {
      onProgress: (f) => setStatus("flashing… " + Math.round(f * 100) + "%"),
      onLog: (t) => { if (t && t.trim()) log(t.trim(), "dim"); },
    });
    log("Flash complete. Device is rebooting into Jaguar*.", "ok");
    setStatus("flashed");
    if (ssid) await waitForNetwork(name);
  } catch (e) {
    log("Flash failed: " + (e.stack || e.message), "err");
    setStatus("flash failed");
  } finally {
    enable("flash", !!state.chip); enableSend(true); enable("connect", true);
  }
});

// ---- Compile & Run / Install --------------------------------------------
// The target is the Wi-Fi device if one is connected and selected, else USB.
const useWifi = () => !!state.wifi && $("target").value === "wifi";

$("run").addEventListener("click", () => sendProgram(null));
$("install").addEventListener("click", () => {
  const name = $("cname").value.trim();
  if (!name) { log("Enter a container name to install.", "err"); $("cname").focus(); return; }
  sendProgram(name);
});

// Compiles the editor's program and runs it, or installs it as container
// `name` (persists across reboots) if given.
async function sendProgram(name) {
  const wifi = useWifi();
  if (!wifi && !state.port) { log("Connect a device over USB or Wi-Fi first.", "err"); return; }
  const what = name ? "install" : "run";
  try {
    enableSend(false); enable("flash", false);
    setStatus("compiling…");
    log("Compiling Toit source…");
    const snapshot = await toit.compile(editor.getValue());
    // Candidates for symbolizing stack traces; the decoder matches by uuid.
    state.snapshots.delete(name || "program");
    state.snapshots.set(name || "program", snapshot);
    if (state.snapshots.size > 8) state.snapshots.delete(state.snapshots.keys().next().value);
    const image = await toit.snapshotToImage(snapshot, { wordSize: wifi ? state.wifi.info.wordSize : 4 });
    log("Compiled to device image: " + image.length + " bytes.", "ok");

    setStatus(what + "ing…");
    if (wifi) {
      log("Sending program over Wi-Fi to " + state.wifi.info.name + "…");
      if (name) await state.wifi.install(name, image);
      else await state.wifi.run(image);
      refreshContainers();
    } else {
      await ensureConnected();
      log("Sending program over USB…");
      if (name) await state.jag.install(name, image);
      else await state.jag.run(image, {});
    }
    log((name ? "Installed '" + name + "' and started it." : "Program started on device.") + " Output:", "ok");
    setStatus(name ? "installed" : "running");
  } catch (e) {
    log(what + " failed: " + (e.stack || e.message), "err");
    setStatus(what + " failed");
  } finally {
    enableSend(true); enable("flash", !!state.chip);
  }
}

function enableSend(on) {
  const any = !!state.port || !!state.wifi;
  enable("run", on && any); enable("install", on && any);
}

function updateTarget() {
  const sel = $("target");
  const opts = [];
  if (state.wifi) opts.push(["wifi", "Wi-Fi: " + state.wifi.info.name]);
  if (state.port) opts.push(["usb", "USB" + (state.chip ? ": " + state.chip.name : "")]);
  const prev = sel.value;
  sel.replaceChildren(...opts.map(([v, t]) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    return o;
  }));
  if (opts.some(([v]) => v === prev)) sel.value = prev;
  sel.disabled = opts.length < 2;
  enableSend(true);
}

// ---- Wi-Fi -----------------------------------------------------------------
$("wifi-connect").addEventListener("click", () => connectWifi($("wifi-host").value.trim()));
$("wifi-host").addEventListener("keydown", (e) => { if (e.key === "Enter") $("wifi-connect").click(); });

async function connectWifi(host) {
  if (!host) { log("Enter the device's address, e.g. my-device.local.", "err"); return; }
  disconnectWifi();
  const dev = new JaguarHttp(host);
  enable("wifi-connect", false);
  setStatus("connecting to " + dev.host + "…");
  try {
    const info = await dev.identify();
    if (info.sdkVersion !== SDK_VERSION) {
      log("Device runs SDK " + info.sdkVersion + "; this app compiles for " + SDK_VERSION +
        ". Reflash it to run code from here.", "err");
    }
    try {
      await dev.containers();
    } catch (e) {
      throw new Error("device answers but isn't running Jaguar* (" + e.message + ")");
    }
    state.wifi = dev;
    try { localStorage.setItem("webby.wifiHost", host); } catch (_) {}
    // Output now comes over Wi-Fi; the USB console would duplicate it. It is
    // reopened if code is sent over USB.
    if (state.transport) {
      await disconnectJag();
      log("Closed the USB console; device output now comes over Wi-Fi.", "dim");
    }
    log("Connected over Wi-Fi to '" + info.name + "' (" + info.chip + ", " + dev.base + ").", "ok");
    setStatus("connected: " + info.name + " (Wi-Fi)");
    showWifiDevice(info);
    updateTarget();
    $("target").value = "wifi";
    followLog(dev);
    refreshContainers();
  } catch (e) {
    log("Wi-Fi connect to " + dev.base + " failed: " + e.message, "err");
    log("Needs a device flashed with Jaguar* from this page, on the same network. " +
      "Chrome may ask to allow access to devices on your local network.", "dim");
    setStatus("Wi-Fi connect failed");
  } finally {
    enable("wifi-connect", true);
  }
}

function disconnectWifi() {
  state.logAbort?.abort();
  state.logAbort = null;
  state.wifi = null;
  $("wifi-info").hidden = true;
  $("containers-section").hidden = true;
  updateTarget();
}

function showWifiDevice(info) {
  const el = $("wifi-info");
  el.hidden = false;
  el.replaceChildren(...infoRows([
    ["Name", info.name],
    ["Chip", info.chip],
    ["SDK", info.sdkVersion],
    ["Address", info.address + (info.hostname ? " (" + info.hostname + ")" : "")],
  ]));
}

function followLog(dev) {
  const abort = new AbortController();
  state.logAbort = abort;
  let failing = false;
  dev.followLog((entries, { dropped, history, rebooted }) => {
    failing = false;
    if (rebooted) { log("— device rebooted —", "dim"); return; }
    if (dropped) log("… (" + dropped + " lines of device output dropped)", "dim");
    if (history) {
      if (!entries.length) return;
      log("Recent device output:", "dim");
      for (const e of entries.slice(-10)) log("  " + entryText(e), "dim");
      return;
    }
    for (const e of entries) {
      if (e.type === "trace") logTrace(e.text);
      else log(entryText(e), entryClass(e));
    }
  }, {
    signal: abort.signal,
    onError: (e) => { if (!failing) log("Lost the device's output stream (" + e.message + "); retrying…", "dim"); failing = true; },
  });
}

// Toit's log levels (lib/log/level.toit).
const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
const entryText = (e) => e.type === "log" ? (LOG_LEVELS[e.level] ?? e.level) + " " + e.text : e.text;
// Prints are the program's output; logs are mostly Jaguar's own chatter.
const entryClass = (e) => e.type === "print" ? "device" : e.level >= 4 ? "err" : "dim";

// Decodes (in wasm) and shows a stack trace the device captured
// ("jag decode <base64>"), with symbols if we compiled the program.
async function logTrace(text) {
  const placeholder = log("decoding stack trace…", "dim");
  try {
    const decoded = await toit.decodeSystemMessage(text.replace(/^jag decode /, "").trim(), [...state.snapshots.values()]);
    placeholder.remove();
    for (const t of decoded.trimEnd().split("\n")) log(t, "err");
  } catch (e) {
    placeholder.textContent = "stack trace (couldn't decode: " + e.message + "): " + text;
  }
}

// ---- Containers ------------------------------------------------------------
$("containers-refresh").addEventListener("click", () => refreshContainers());

async function refreshContainers() {
  const dev = state.wifi;
  if (!dev) return;
  let info;
  try {
    info = await dev.containers();
  } catch (e) {
    log("Listing containers failed: " + e.message, "err");
    return;
  }
  if (dev !== state.wifi) return;
  $("containers-section").hidden = false;
  const running = new Map(info.running.map((r) => [r.id, r]));
  const rows = info.installed.map((c) => containerRow(c.name, c.id, running.has(c.id), true, c.defines));
  for (const r of info.running) {
    if (!info.installed.some((c) => c.id === r.id)) rows.push(containerRow(r.name || "(program)", r.id, true, false));
  }
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "hint"; p.textContent = "Nothing installed or running.";
    rows.push(p);
  }
  $("containers").replaceChildren(...rows);
}

function containerRow(name, id, isRunning, installed, defines = {}) {
  const row = document.createElement("div");
  row.className = "container";
  const label = document.createElement("div");
  const n = document.createElement("b"); n.textContent = name;
  const meta = document.createElement("span");
  meta.className = "hint";
  const d = Object.entries(defines).map(([k, v]) => k + "=" + v).join(" ");
  meta.textContent = (isRunning ? "running" : "stopped") + (installed ? ", installed" : "") + (d ? ", " + d : "");
  meta.title = id;
  label.append(n, document.createElement("br"), meta);
  row.append(label);
  if (isRunning) row.append(smallButton("stop", () => state.wifi.stop(id)));
  if (installed) row.append(smallButton("uninstall", () => state.wifi.uninstall(name)));
  return row;
}

function smallButton(text, action) {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = "small";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try { await action(); } catch (e) { log(text + " failed: " + e.message, "err"); }
    // Stopping is asynchronous on the device.
    setTimeout(refreshContainers, 300);
  });
  return b;
}
setInterval(() => { if (state.wifi && !document.hidden) refreshContainers(); }, 5000);

// ---- After flashing: wait for Wi-Fi -----------------------------------------
// Jaguar* logs "running Jaguar device '<name>' ... on 'http://<ip>:<port>'"
// over the UART once it is on the network; watch for it so we can hand the
// user a link instead of guessing.
async function waitForNetwork(name) {
  setStatus("waiting for Wi-Fi…");
  log("Waiting for the device to join Wi-Fi (watching its serial output)…");
  const t = new WebSerialTransport(state.port);
  await t.open(UART_BAUD);
  state.transport = t;
  state.jag = new JaguarUart(t, { onConsole: (txt) => appendConsole(txt), onLog: (m) => log("[uart] " + m, "dim") });
  const line = await waitForConsoleLine(/running Jaguar device .* on 'http:\/\/([^']+)'/, 60000);
  if (!line) {
    log("Device didn't report a network connection within 60 s. Check the Wi-Fi name/password " +
      "(2.4 GHz only) and its serial output above.", "err");
    setStatus("no Wi-Fi");
    return;
  }
  const ipHost = line[1];
  const port = ipHost.split(":")[1] || "9000";
  const mdnsHost = mdnsHostname(name) + ".local:" + port;
  log("Device is on Wi-Fi at http://" + ipHost + "/ (and http://" + mdnsHost + "/).", "ok");
  showNetworkBanner(mdnsHost, ipHost);
  $("wifi-host").value = mdnsHost;
  setStatus("on Wi-Fi");
}

const consoleWaiters = [];
function waitForConsoleLine(re, timeoutMs) {
  return new Promise((resolve) => {
    const w = { re, resolve };
    consoleWaiters.push(w);
    setTimeout(() => {
      const i = consoleWaiters.indexOf(w);
      if (i >= 0) { consoleWaiters.splice(i, 1); resolve(null); }
    }, timeoutMs);
  });
}

function showNetworkBanner(mdnsHost, ipHost) {
  const el = $("netbanner");
  el.hidden = false;
  const a = (host) => {
    const link = document.createElement("a");
    link.href = "http://" + host + "/";
    link.target = "_blank";
    link.textContent = "http://" + host + "/";
    return link;
  };
  const connect = document.createElement("button");
  connect.textContent = "Connect over Wi-Fi";
  connect.className = "primary";
  connect.addEventListener("click", () => connectWifi(mdnsHost));
  el.replaceChildren(
    document.createTextNode("Your device is online. Open "), a(mdnsHost),
    document.createTextNode(" (or "), a(ipHost),
    document.createTextNode(") from any computer on the same network, or connect from here:"),
    connect);
}

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
  for (const l of lines) {
    if (l.trim()) log(l, "device");
    for (const w of [...consoleWaiters]) {
      const m = l.match(w.re);
      if (m) { consoleWaiters.splice(consoleWaiters.indexOf(w), 1); w.resolve(m); }
    }
  }
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
      const gz = await fetchBytes(url, (l, t) => setStatus("loading envelope… " + progressText(l, t)));
      state.envelope = { name, data: toit.slimEnvelope(await gunzip(new Blob([gz]).stream())) };
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
  state.envelope = { name, data: toit.slimEnvelope(data) };
  return state.envelope.data;
}

// Like `jag flash`: some chips need a larger OTA partition than their
// envelope's default table provides (see fetch-assets.sh). Null if none.
async function getPartitionOverride(chip) {
  const resp = await fetch(`./assets/partitions-${chip}.csv`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`partitions-${chip}.csv: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
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

// ---- Memory footer ---------------------------------------------------------
// Browsers don't expose real memory use to pages. Show the page's JS heap
// (Chromium only) and, after each toolchain run, the worker's estimate of the
// wasm memory it used (see memoryStats in tool-worker.js).
function watchMemory() {
  if (!performance.memory) return;
  $("mem-page").textContent = "page JS heap: " + mb(performance.memory.usedJSHeapSize) + " MB";
  setTimeout(watchMemory, 1000);
}
watchMemory();
toit.onMemory((label, { size, touched }) => {
  $("mem-tool").textContent = "last toolchain run (" + label + "): ~" + mb(touched) +
    " MB wasm memory used (" + mb(size) + " MB reserved; freed after the run)";
});

// ---- Init ----------------------------------------------------------------
if (!isSupported()) {
  setStatus("Web Serial not supported");
  log("This browser doesn't support Web Serial (USB). Use Chrome, Edge, or Opera over HTTPS/localhost.", "err");
  enable("connect", false);
} else {
  setStatus(window.crossOriginIsolated ? "ready" : "ready (no cross-origin isolation — VM may fail)");
  if (!window.crossOriginIsolated) log("Not cross-origin isolated; the Toit VM needs it. The service worker should reload the page once.", "dim");
}
// A Jaguar* device's page sends the browser here with #device=<host:port>.
{
  const fromDevice = new URLSearchParams(location.hash.slice(1)).get("device");
  let saved = null;
  try { saved = localStorage.getItem("webby.wifiHost"); } catch (_) {}
  $("wifi-host").value = fromDevice || saved || "";
  // Without isolation the service worker is about to reload the page (keeping
  // the hash); connect after that.
  if (fromDevice && window.crossOriginIsolated) {
    history.replaceState(null, "", location.pathname + location.search);
    connectWifi(fromDevice);
  }
}
