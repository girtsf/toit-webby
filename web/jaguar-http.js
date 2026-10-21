// Jaguar* HTTP client: talks to a device on the LAN at http://<host>:9000.
// Works from the HTTPS-hosted app because Chrome exempts *.local names and
// private IPs from mixed-content blocking (behind its Local Network Access
// permission prompt), and Jaguar* sends CORS headers for the app's origin.
// Plain upstream Jaguar has no CORS, so this only works with Jaguar*.

import { crc32, ubjsonDecode } from "./jaguar-uart.js";

const td = new TextDecoder();

export class JaguarHttp {
  // `host` is "name.local:9000" or "192.168.1.23:9000" (port defaults to 9000).
  constructor(host) {
    this.host = /:\d+$/.test(host) ? host : host + ":9000";
    this.base = "http://" + this.host;
    this.info = null;
  }

  async _fetch(path, init = {}) {
    const resp = await fetch(this.base + path, {
      ...init,
      // Chrome: lets an HTTPS page reach the local network (with permission).
      targetAddressSpace: "local",
      headers: { ...this._headers(), ...(init.headers || {}) },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`${path}: HTTP ${resp.status} ${resp.statusText} ${body}`.trim());
    }
    return resp;
  }

  _headers() {
    if (!this.info) return {};
    return { "X-Jaguar-Device-ID": this.info.id, "X-Jaguar-SDK-Version": this.info.sdkVersion };
  }

  // { name, id, chip, sdkVersion, address, hostname?, wordSize }
  async identify() {
    const resp = await this._fetch("/identify");
    this.info = JSON.parse(td.decode(await resp.arrayBuffer())).payload;
    return this.info;
  }

  async run(image, defines = {}) {
    await this._putImage("/run", image, defines);
  }

  async install(name, image, defines = {}) {
    await this._putImage("/install", image, defines, { "X-Jaguar-Container-Name": name });
  }

  async _putImage(path, image, defines, extra = {}) {
    await this._fetch(path, {
      method: "PUT",
      headers: { "X-Jaguar-CRC32": String(crc32(image)), ...defineHeaders(defines), ...extra },
      body: image,
    });
  }

  async uninstall(name) {
    await this._fetch("/uninstall", { method: "PUT", headers: { "X-Jaguar-Container-Name": name } });
  }

  // { installed: [{name, id, defines}], running: [{id, name}], uptimeMs }
  async containers() {
    return (await this._fetch("/webby/containers")).json();
  }

  async stop(id) {
    await this._fetch("/webby/stop?id=" + encodeURIComponent(id), { method: "PUT" });
  }

  // Follows the device's output through toit-logd's endpoint (GET
  // /logd?cursor=N, long-polling, ubjson; see github.com/girtsf/toit-logd).
  // Calls onEntries(entries, info) with entries {type: "print"|"log"|"trace",
  // level, text, timestamp} until `signal` aborts; `info` has `history` (lines
  // from before we connected), `dropped` (count evicted before we read them)
  // and `rebooted`. Retries forever on errors, like logd's monitor.
  async followLog(onEntries, { signal, onError } = {}) {
    let cursor = 0, boot = null, first = true, history = [];
    while (!signal?.aborted) {
      let r;
      try {
        const resp = await this._fetch("/logd?cursor=" + cursor, { signal });
        r = ubjsonDecode(new Uint8Array(await resp.arrayBuffer()));
        if (r.version !== LOGD_PROTOCOL) throw new Error("device speaks logd protocol " + r.version);
      } catch (e) {
        if (signal?.aborted) return;
        onError?.(e);
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      const rebooted = boot !== null && r.boot !== boot;
      boot = r.boot;
      if (rebooted) {
        // Seqs restarted; refetch this boot's buffer from the start.
        cursor = 0;
        onEntries([], { rebooted: true });
        continue;
      }
      const dropped = first ? 0 : Math.max(0, r.oldest - 1 - cursor);
      const entries = r.entries.map(([, timestamp, type, level, text]) => ({ timestamp, type, level, text }));
      // `next` may trail `head` when the device capped the batch.
      cursor = r.next;
      if (first) {
        // Page through the backlog, then hand it over in one go.
        history.push(...entries);
        if (r.next < r.head) continue;
        first = false;
        onEntries(history, { history: true, dropped: 0 });
        history = [];
      } else if (entries.length || dropped) {
        onEntries(entries, { history: false, dropped });
      }
    }
  }
}

const LOGD_PROTOCOL = 1;

// Jaguar's HTTP API takes defines as headers (see extract-defines in
// jaguar's network.toit).
function defineHeaders(defines) {
  const h = {};
  if (defines["jag.wifi"] === false) h["X-Jaguar-Wifi-Disabled"] = "true";
  if (defines["jag.timeout"]) h["X-Jaguar-Container-Timeout"] = String(defines["jag.timeout"]);
  if (defines["jag.interval"]) h["X-Jaguar-Container-Interval"] = defines["jag.interval"];
  return h;
}

// Same mapping as mdns-hostname in device/webby.toit.
// Works on UTF-8 bytes, so a non-ASCII character becomes several '-'.
export function mdnsHostname(name) {
  const h = Array.from(new TextEncoder().encode(name), (b) => {
    const c = String.fromCharCode(b).replace(/[A-Z]/, (u) => u.toLowerCase());
    return /[a-z0-9-]/.test(c) ? c : "-";
  }).join("").slice(0, 63);
  return h || "jaguar";
}
