// Copyright (C) 2026 Girts Folkmanis.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

// Jaguar* additions for Toit Webby: lets the web app reach the device over
// Wi-Fi. Copied next to Jaguar's sources (see tools/build-snapshots.sh).
//
// - An mDNS responder, so the device answers to http://<name>.local:9000/.
// - CORS for the web app's origin (config "webby": {"url": ...}), so the
//   HTTPS-hosted app can call the device's HTTP API (Chrome exempts *.local
//   from mixed-content blocking, behind its Local Network Access prompt).
// - toit-logd's print/log/trace capture (github.com/girtsf/toit-logd):
//   output still goes to the UART, and is also kept in a ring buffer that the
//   app long-polls on /logd (it decodes stack traces in-browser).
// - /webby/* routes: containers (installed + running), stop.

import encoding.json
import encoding.url
import http
import logd
import net
import net.udp
import system
import uuid

import .jaguar
import .network

// ---- mDNS -------------------------------------------------------------------

MDNS-ADDRESS ::= net.IpAddress.parse "224.0.0.251"
MDNS-PORT ::= 5353
MDNS-TTL ::= 120

TYPE-A ::= 1
TYPE-ANY ::= 255
CLASS-IN ::= 1
CLASS-CACHE-FLUSH ::= 0x8000

/**
Converts a device name into a DNS label: lowercase letters, digits and '-'.
*/
mdns-hostname name/string -> string:
  bytes := name.to-ascii-lower.to-byte-array
  bytes.size.repeat: | i/int |
    c := bytes[i]
    if not ('a' <= c <= 'z' or '0' <= c <= '9' or c == '-'): bytes[i] = '-'
  result := bytes.to-string
  if result.size > 63: result = result[..63]
  return result.is-empty ? "jaguar" : result

/**
A minimal mDNS responder that answers A queries for "<hostname>.local".
*/
class MdnsResponder:
  hostname/string
  network_/net.Client
  logger_/any

  constructor .network_ .hostname --logger:
    logger_ = logger

  run -> none:
    socket := network_.udp-open-multicast MDNS-ADDRESS MDNS-PORT --if-addr=network_.address
    try:
      address := network_.address
      logger_.info "mDNS: answering for $(hostname).local ($address)"
      group := net.SocketAddress MDNS-ADDRESS MDNS-PORT
      // Unsolicited announcements, like RFC 6762 section 8.3 suggests.
      announcer := task::
        2.repeat:
          socket.send (udp.Datagram (response_ address --id=0 --question=null) group)
          sleep --ms=1000
      try:
        while true:
          datagram := socket.receive
          catch: answer_ socket datagram address group
      finally:
        announcer.cancel
    finally:
      socket.close

  answer_ socket/udp.Socket datagram/udp.Datagram address/net.IpAddress group/net.SocketAddress -> none:
    query := datagram.data
    if query.size < 12: return
    flags := (query[2] << 8) | query[3]
    if flags & 0x8000 != 0: return  // A response, not a query.
    qdcount := (query[4] << 8) | query[5]
    offset := 12
    qdcount.repeat:
      name-end := skip-name_ query offset
      if name-end + 4 > query.size: return
      qtype := (query[name-end] << 8) | query[name-end + 1]
      if (qtype == TYPE-A or qtype == TYPE-ANY) and (name-matches_ query offset):
        if datagram.address.port != MDNS-PORT:
          // Legacy unicast query (RFC 6762 section 6.7): reply directly,
          // echoing the id and question.
          id := (query[0] << 8) | query[1]
          socket.send (udp.Datagram (response_ address --id=id --question=query[offset..name-end + 4]) datagram.address)
        else:
          socket.send (udp.Datagram (response_ address --id=0 --question=null) group)
        return
      offset = name-end + 4

  /** Whether the (possibly compressed) name at $offset is "<hostname>.local". */
  name-matches_ packet/ByteArray offset/int -> bool:
    labels := []
    hops := 0
    while true:
      if offset >= packet.size: return false
      length := packet[offset]
      if length == 0: break
      if length & 0xc0 == 0xc0:
        if ++hops > 10 or offset + 1 >= packet.size: return false
        offset = ((length & 0x3f) << 8) | packet[offset + 1]
        continue
      if offset + 1 + length > packet.size: return false
      labels.add packet[offset + 1 .. offset + 1 + length].to-string-non-throwing.to-ascii-lower
      offset += 1 + length
    return labels.size == 2 and labels[0] == hostname and labels[1] == "local"

  /** Returns the offset just after the name at $offset. */
  static skip-name_ packet/ByteArray offset/int -> int:
    while offset < packet.size:
      length := packet[offset]
      if length == 0: return offset + 1
      if length & 0xc0 == 0xc0: return offset + 2
      offset += 1 + length
    return packet.size

  response_ address/net.IpAddress --id/int --question/ByteArray? -> ByteArray:
    name := #[]
    [hostname, "local"].do: | label/string |
      name += #[label.size] + label.to-byte-array
    name += #[0]
    legacy := question != null
    header := #[
      id >> 8, id & 0xff,
      0x84, 0x00,  // Response, authoritative.
      0, legacy ? 1 : 0,
      0, 1,
      0, 0,
      0, 0,
    ]
    // Legacy unicast responses must not set the cache-flush bit.
    klass := legacy ? CLASS-IN : (CLASS-IN | CLASS-CACHE-FLUSH)
    record := #[
      0, TYPE-A,
      klass >> 8, klass & 0xff,
      0, 0, MDNS-TTL >> 8, MDNS-TTL & 0xff,
      0, 4,
    ]
    return header + (question or #[]) + name + record + address.raw

// ---- Log capture --------------------------------------------------------------

log-handler_/logd.HttpHandler? := null

/**
Installs toit-logd's print/log/trace capture, serving its ring buffer on
  Jaguar's HTTP server (see $handle-log-request).

Must run before any container (including installed ones) is started: a
  container binds to the print/log services once, on first use.
*/
install-log-capture -> none:
  buffer := logd.LogBuffer
  (logd.Capture [buffer]).install
  // Retain from boot, not only once a client first connects.
  buffer.enable
  log-handler_ = logd.HttpHandler buffer

/**
Serves toit-logd's endpoints (GET /logd?cursor=N, ...). Like logd itself,
  they don't need Jaguar's device-id header, so logd's own host monitor works
  against port 9000 too.
*/
handle-log-request request/http.Request writer/http.ResponseWriter -> bool:
  return log-handler_ != null and (log-handler_.handle request writer)

// ---- HTTP -------------------------------------------------------------------

CORS-ALLOW-HEADERS ::= [
  "Content-Type",
  HEADER-DEVICE-ID,
  HEADER-SDK-VERSION,
  HEADER-WIFI-DISABLED,
  HEADER-CONTAINER-NAME,
  HEADER-CONTAINER-TIMEOUT,
  HEADER-CONTAINER-INTERVAL,
  HEADER-CRC32,
  HEADER-DISABLE-UDP,
].join ", "

/** The configured web app URL, or null. */
webby-url device/Device -> string?:
  webby := device.config.get "webby"
  return webby is Map ? webby.get "url" : null

/** The scheme://host[:port] part of a URL. */
url-origin url/string -> string:
  scheme-end := url.index-of "://"
  if scheme-end < 0: return url
  path-start := url.index-of "/" (scheme-end + 3)
  return path-start < 0 ? url : url[..path-start]

/**
Adds CORS headers if the request comes from the web app's origin.

Returns true if the request was a CORS preflight and has been answered.
*/
handle-cors device/Device request/http.Request writer/http.ResponseWriter -> bool:
  origin := request.headers.single "Origin"
  app-url := webby-url device
  if not origin or not app-url or origin != (url-origin app-url): return false
  writer.headers.set "Access-Control-Allow-Origin" origin
  writer.headers.set "Vary" "Origin"
  if request.method != "OPTIONS": return false
  writer.headers.set "Access-Control-Allow-Methods" "GET, PUT, POST, OPTIONS"
  writer.headers.set "Access-Control-Allow-Headers" CORS-ALLOW-HEADERS
  // Pre-LNA Chrome sends Private Network Access preflights.
  writer.headers.set "Access-Control-Allow-Private-Network" "true"
  writer.headers.set "Access-Control-Max-Age" "600"
  writer.write-headers http.STATUS-NO-CONTENT
  return true

/**
Serves the Jaguar* routes under /webby/. Returns false if the request isn't
  for one of them.
*/
handle-webby-request request/http.Request writer/http.ResponseWriter -> bool:
  query := url.QueryString.parse request.path
  path := query.resource
  if path == "/webby/containers" and request.method == http.GET:
    respond-json writer containers-info
  else if path == "/webby/stop" and request.method == http.PUT:
    id := uuid.Uuid.parse (query.parameters.get "id" --if-absent=: "") --if-error=: null
    container := id and started-containers_.get id
    if container:
      container.stop
      respond-json writer {"status": "OK"}
    else:
      writer.write-headers http.STATUS-NOT-FOUND --message="No running container $id"
  else:
    return false
  return true

containers-info -> Map:
  installed := []
  registry_.do: | name/string id/uuid.Uuid defines/Map? |
    installed.add {"name": name, "id": "$id", "defines": defines or {:}}
  running := []
  started-containers_.do: | id/uuid.Uuid container |
    entry := registry_.get-entry-by-id id
    running.add {"id": "$id", "name": entry ? entry[0] : null}
  return {
    "installed": installed,
    "running": running,
    "uptimeMs": Time.monotonic-us / 1000,
  }

respond-json writer/http.ResponseWriter value/any -> none:
  bytes := json.encode value
  writer.headers.set "Content-Type" "application/json"
  writer.headers.set "Content-Length" bytes.size.stringify
  writer.out.write bytes

/**
The page served at "/": sends the browser to the web app, pointed back at this
  device. The app runs on HTTPS (its compiler/VM needs cross-origin isolation,
  which plain-HTTP pages can't get) and talks to the device from there.
*/
bootstrap-page device/Device -> string:
  app-url := webby-url device
  uptime ::= Duration --s=(Time.monotonic-us --since-wakeup) / Duration.MICROSECONDS-PER-SECOND
  app-link := app-url
      ? """<p><a id="open" href="$app-url">Open in Toit Webby</a></p>
          <script>
            const a = document.getElementById("open");
            a.href = "$app-url#device=" + encodeURIComponent(location.host);
            if (!location.search.includes("stay")) location.replace(a.href);
          </script>"""
      : "<p>No Toit Webby URL configured.</p>"
  return """
      <!doctype html>
      <html><head><meta charset="utf-8"><title>$device.name (Jaguar*)</title>
      <style>body{font:15px system-ui,sans-serif;background:#0e1116;color:#e6edf3;
      display:grid;place-items:center;min-height:90vh}a{color:#4c8dff;font-size:18px}</style>
      </head><body><div>
      <h1>$device.name</h1>
      <p>Jaguar* device &middot; SDK $system.vm-sdk-version &middot; up $uptime</p>
      $app-link
      </div></body></html>
      """
