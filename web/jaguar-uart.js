// Jaguar UART protocol over an abstract byte transport.
// Ported from jaguar/cmd/jag/commands/proxy_device.go + proxy_multiplexed_reader.go
// and src/uart.toit. Transport-agnostic: works over Web Serial (browser) or
// node serialport, as long as it is given async read/write byte streams.
//
// Wire format (host <-> device), all little-endian:
//   host->device : [len_lo, len_hi] payload[len] '\n'   (raw bytes)
//   device->host : console text, with out-of-band frames inline as
//                  "Jag15261520" + base64(framedPayload) + "\n"
//   framedPayload: [len_lo, len_hi] payload[len] '\n'  (same framing, decoded)
//   payload[0] = command byte; payload[1..] = data

export const MAGIC_TOKEN = "Jag15261520";
export const SYNC_MAGIC = [27, 121, 55, 49, 253, 65, 123, 243];

export const CMD = {
  SYNC: 0, PING: 1, IDENTIFY: 2, LIST: 3, UNINSTALL: 4,
  FIRMWARE: 5, INSTALL: 6, RUN: 7,
};
const ACK = 255;

const te = new TextEncoder();
const td = new TextDecoder();

function u16le(v) { return [v & 0xff, (v >> 8) & 0xff]; }
function u32le(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

// CRC32 (IEEE, same as Go hash/crc32.ChecksumIEEE / zlib).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal UBJSON encoder (covers the define maps Jaguar needs: objects of
// strings, bools, ints). Empty map -> "{}".
export function ubjsonEncode(value) {
  const out = [];
  const enc = (v) => {
    if (v === true) { out.push(0x54); return; }       // 'T'
    if (v === false) { out.push(0x46); return; }      // 'F'
    if (v === null) { out.push(0x5A); return; }       // 'Z'
    if (typeof v === "number" && Number.isInteger(v)) {
      out.push(0x6C, ...u32be(v)); return;            // 'l' int32 (big-endian per ubjson)
    }
    if (typeof v === "string") {
      const b = te.encode(v);
      out.push(0x53); encLen(b.length); out.push(...b); return; // 'S'
    }
    if (typeof v === "object") {
      out.push(0x7B);                                  // '{'
      for (const k of Object.keys(v)) {
        const kb = te.encode(k);
        encLen(kb.length); out.push(...kb);            // key: len-prefixed string (no 'S')
        enc(v[k]);
      }
      out.push(0x7D);                                  // '}'
      return;
    }
    throw new Error("ubjson: unsupported value " + typeof v);
  };
  const encLen = (n) => { out.push(0x69, n & 0xff); }; // 'i' uint8 length (ok for short keys)
  const u32be = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  enc(value);
  return new Uint8Array(out);
}

// Decodes a subset of UBJSON (objects, strings, ints, bools) for identify.
export function ubjsonDecode(bytes) {
  let p = 0;
  const readLen = () => {
    const t = bytes[p++];
    if (t === 0x69) return bytes[p++];
    if (t === 0x55) return bytes[p++];
    if (t === 0x49) { const v = (bytes[p] << 8) | bytes[p + 1]; p += 2; return v; }
    throw new Error("ubjson len type " + t);
  };
  const readKey = () => { const n = readLen(); const k = td.decode(bytes.slice(p, p + n)); p += n; return k; };
  const valOfType = (t) => val(t);
  const val = (forced) => {
    const t = forced !== undefined ? forced : bytes[p++];
    if (t === 0x7B) {                 // '{'
      let type = undefined, count = undefined;
      if (bytes[p] === 0x24) { p++; type = bytes[p++]; }   // '$' typed
      if (bytes[p] === 0x23) { p++; count = readLen(); }   // '#' counted
      const o = {};
      if (count !== undefined) {
        for (let i = 0; i < count; i++) { const k = readKey(); o[k] = valOfType(type); }
      } else {
        while (bytes[p] !== 0x7D) { const k = readKey(); o[k] = val(); }
        p++;
      }
      return o;
    }
    if (t === 0x53) { const n = readLen(); const s = td.decode(bytes.slice(p, p + n)); p += n; return s; }
    if (t === 0x54) return true;
    if (t === 0x46) return false;
    if (t === 0x6C) { const v = (bytes[p] << 24) | (bytes[p+1] << 16) | (bytes[p+2] << 8) | bytes[p+3]; p += 4; return v >>> 0; }
    if (t === 0x69) return bytes[p++];
    throw new Error("ubjson val type " + t);
  };
  return val();
}

// Demultiplexes a raw device byte stream into console text (onConsole) and a
// queue of decoded out-of-band bytes (available via readOob).
export class Demux {
  constructor(onConsole) {
    this.onConsole = onConsole || (() => {});
    this.acc = [];            // pending raw bytes being scanned
    this.oob = [];            // decoded OOB bytes queue
    this._waiters = [];       // resolvers waiting for OOB bytes
  }
  push(chunk) {
    for (let i = 0; i < chunk.length; i++) this.acc.push(chunk[i]);
    this._scan();
  }
  _emitConsole(bytes) { if (bytes.length) this.onConsole(td.decode(new Uint8Array(bytes))); }
  _scan() {
    const M = MAGIC_TOKEN;
    for (;;) {
      if (this.acc.length === 0) return;
      // find first byte of token
      let idx = this.acc.indexOf(M.charCodeAt(0));
      if (idx === -1) { this._emitConsole(this.acc); this.acc = []; return; }
      if (idx > 0) { this._emitConsole(this.acc.slice(0, idx)); this.acc = this.acc.slice(idx); }
      // try to match full token
      let matched = true;
      for (let i = 0; i < M.length - 1; i++) {
        if (i >= this.acc.length) return; // need more data; keep acc (starts with token prefix)
        if (this.acc[i] !== M.charCodeAt(i)) { this._emitConsole(this.acc.slice(0, i + 1)); this.acc = this.acc.slice(i + 1); matched = false; break; }
      }
      if (!matched) continue;
      if (this.acc.length < M.length) return; // need more
      const after = this.acc.slice(M.length);
      const nl = after.indexOf(10); // '\n'
      if (nl === -1) return; // need more
      const b64 = td.decode(new Uint8Array(after.slice(0, nl)));
      try {
        const decoded = b64ToBytes(b64);
        for (let i = 0; i < decoded.length; i++) this.oob.push(decoded[i]);
        this._wake();
      } catch (e) { /* ignore malformed */ }
      this.acc = after.slice(nl + 1);
    }
  }
  _wake() { const w = this._waiters; this._waiters = []; w.forEach((r) => r()); }
  // Wait until predicate() returns true, or timeoutMs elapses. Never consumes.
  async _waitFor(predicate, timeoutMs) {
    if (predicate()) return true;
    const deadline = timeoutMs == null ? null : Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (deadline != null && Date.now() >= deadline) return false;
      await new Promise((res) => {
        this._waiters.push(res);
        if (deadline != null) setTimeout(res, Math.max(0, deadline - Date.now()));
      });
    }
  }
  // Read exactly n OOB bytes (consumes only when n are available).
  async readOob(n, timeoutMs) {
    const ok = await this._waitFor(() => this.oob.length >= n, timeoutMs);
    if (!ok) return null;
    return new Uint8Array(this.oob.splice(0, n));
  }
  _peekPacketLen() {
    if (this.oob.length < 2) return -1;
    const len = this.oob[0] | (this.oob[1] << 8);
    return this.oob.length >= 2 + len + 1 ? len : -1;
  }
  // Read one framed packet: [len_lo,len_hi] payload[len] '\n'. Consumes only a
  // complete packet; returns null on timeout without consuming.
  async readPacket(timeoutMs) {
    const ok = await this._waitFor(() => this._peekPacketLen() >= 0, timeoutMs);
    if (!ok) return null;
    const len = this.oob[0] | (this.oob[1] << 8);
    const frame = this.oob.splice(0, 2 + len + 1);
    if (frame[frame.length - 1] !== 10) throw new Error("bad packet terminator");
    return new Uint8Array(frame.slice(2, 2 + len));
  }
}

function b64ToBytes(s) {
  if (typeof atob === "function") {
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(s, "base64"));
}

function buildRequest(command, data) {
  const payload = [command, ...data];
  return new Uint8Array([...u16le(payload.length), ...payload, 10]);
}
function buildSyncRequest(syncId) {
  const data = [...u16le(syncId & 0xffff), ...SYNC_MAGIC.map((b) => (b - 1) & 0xff)];
  return buildRequest(CMD.SYNC, data);
}
function expectedSyncResponse(syncId) {
  const payload = [CMD.SYNC, ...u16le(syncId & 0xffff)];
  return new Uint8Array([...u16le(payload.length), ...payload, 10]);
}

// Client drives the protocol. `transport` must provide:
//   write(Uint8Array): Promise  and  onData(cb) streaming device bytes.
export class JaguarUart {
  constructor(transport, { onConsole, onLog, debug = false } = {}) {
    this.t = transport;
    this.log = onLog || (() => {});
    this.debug = debug;
    this.demux = new Demux(onConsole);
    this.syncId = 0;
    this._lock = Promise.resolve();
    transport.onData((chunk) => this.demux.push(chunk));
  }
  _locked(fn) { const r = this._lock.then(fn, fn); this._lock = r.then(() => {}, () => {}); return r; }

  async sync(opts = {}) { return this._locked(() => this._doSync(opts)); }

  // Unlocked sync (callable from within an already-locked op). Like jag: send a
  // sync request with a fresh id and wait for the response carrying THAT id,
  // which proves the device has drained everything up to now and its main loop
  // is aligned and ready for the next command. One request per interval (no
  // flooding / no backlog).
  async _doSync({ timeoutMs = 15000, intervalMs = 500 } = {}) {
    this.demux.oob = [];
    this.demux.acc = [];
    const deadline = Date.now() + timeoutMs;
    let stop = false, synced = false;
    // Steady background sender: one sync request per interval (no flooding).
    const sender = (async () => {
      while (!stop && Date.now() < deadline) {
        this.syncId = (this.syncId + 1) & 0xffff;
        try { await this.t.write(buildSyncRequest(this.syncId)); } catch (_) { return; }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    })();
    try {
      while (Date.now() < deadline) {
        const p = await this.demux.readPacket(deadline - Date.now());
        if (!p) break;
        // Any SYNC response proves the device's main loop is aligned.
        if (p.length >= 1 && p[0] === CMD.SYNC) { synced = true; this.log("synced"); return true; }
      }
    } finally {
      stop = true; await sender.catch(() => {});
      if (synced) {
        // Let the sender's in-flight sync requests be answered and drained, then
        // give the device a beat to clear its RX buffer, so the next command
        // isn't dropped and no stale sync responses pollute the stream.
        await new Promise((r) => setTimeout(r, intervalMs + 300));
        this.demux.oob = [];
        this.demux.acc = [];
      }
    }
    throw new Error("sync timeout");
  }

  // Single-shot, like jag: never resend a command. Every resend makes the device
  // queue a duplicate response whose late arrival pollutes the OOB stream for the
  // next command (and corrupts streaming ack accounting). Reliability comes from
  // a clean, aligned sync, not from retries.
  async _request(command, payload, { tryMs = 4000 } = {}) {
    this.demux.oob = [];                             // start from a clean stream
    await this.t.write(buildRequest(command, payload));
    const deadline = Date.now() + tryMs;
    while (Date.now() < deadline) {
      const resp = await this.demux.readPacket(deadline - Date.now());
      if (!resp) break;
      if (resp.length && resp[0] === command) return resp.slice(1);
      // skip a stray sync heartbeat / announce; keep reading
    }
    throw new Error("response timeout for command " + command);
  }

  async identify() {
    return this._locked(async () => ubjsonDecode(await this._request(CMD.IDENTIFY, [])));
  }
  async ping() { return this._locked(async () => { await this._request(CMD.PING, []); }); }

  // Streams an image to the device in stop-and-wait 512-byte chunks (jag's
  // protocol): write a chunk, wait for acks ([255, consumed_lo, consumed_hi])
  // totalling the chunk size, then send the next. The per-chunk ack timeout is
  // generous because the device can stall for seconds between acks.
  async _streamChunked(data) {
    const CHUNK = 512;
    let written = 0, chunkNo = 0;
    while (written < data.length) {
      const size = Math.min(CHUNK, data.length - written);
      await this.t.write(data.subarray(written, written + size));
      written += size;
      let consumed = 0;
      while (consumed < size) {
        const ack = await this.demux.readOob(3, 15000);
        if (!ack) throw new Error("ack timeout at byte " + written + " (chunk " + chunkNo + ")");
        if (ack[0] !== ACK) throw new Error("invalid ack " + ack[0] + " at chunk " + chunkNo);
        consumed += ack[1] | (ack[2] << 8);
        if (consumed > size) throw new Error("over-ack");
      }
      chunkNo++;
    }
  }

  // Compile->image happens elsewhere; this sends an already-built image.
  async run(image, defines = {}) {
    const payload = [...u32le(image.length), ...u32le(crc32(image)), ...ubjsonEncode(defines)];
    return this._sendStreaming(CMD.RUN, payload, image);
  }
  async install(name, image, defines = {}) {
    const nameB = te.encode(name);
    const payload = [...u32le(image.length), ...u32le(crc32(image)), ...u16le(nameB.length), ...nameB, ...ubjsonEncode(defines)];
    return this._sendStreaming(CMD.INSTALL, payload, image);
  }

  // Sends a streaming command (RUN/INSTALL) resiliently: each attempt starts
  // from a fresh sync so the stream is clean and aligned, then sends the
  // single-shot command and streams the image. A failed attempt (dropped
  // command, sync flake, ack desync) is retried from a new sync — safe because
  // a failed attempt never had its command accepted, so no partial flash.
  async _sendStreaming(command, payload, image, { attempts = 4 } = {}) {
    return this._locked(async () => {
      let lastErr;
      for (let a = 1; a <= attempts; a++) {
        try {
          await this._doSync({ timeoutMs: 8000 });
          await this._request(command, payload, { tryMs: 6000 });
          if (this.debug) this.log("command accepted; streaming " + image.length + " bytes");
          await this._streamChunked(image);
          this.log("image sent (" + image.length + " bytes)");
          return;
        } catch (e) {
          lastErr = e;
          this.log("attempt " + a + " failed (" + e.message + "); retrying…");
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      throw lastErr;
    });
  }
}

function bytesEq(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
