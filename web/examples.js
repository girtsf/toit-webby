// Example programs for the editor's dropdown. The first is the default.
export const EXAMPLES = [
  {
    name: "Hello",
    code: `// Edit, then "Compile & Run". Output shows up below.
main:
  print "Hello from Toit Webby!"
  count := 0
  5.repeat:
    print "tick $count"
    count++
    sleep --ms=500
  print "done"
`,
  },
  {
    name: "Blink an LED",
    code: `// Blinks an LED. Set PIN to your board's LED (often 2; some boards use others).
import gpio

PIN ::= 2

main:
  led := gpio.Pin PIN --output
  10.repeat:
    led.set 1
    sleep --ms=250
    led.set 0
    sleep --ms=250
  led.close
`,
  },
  {
    name: "Web server (install me)",
    code: `// A tiny web server on the device. Install it (give it a name, click
// Install) so it keeps running, then open http://<device>.local:8080/.
import net
import net.tcp

PORT ::= 8080

main:
  network := net.open
  server := network.tcp-listen PORT
  print "serving on http://$network.address:$PORT/"
  hits := 0
  while true:
    socket := server.accept
    if not socket: continue
    hits++
    exception := catch:
      socket.in.read  // The request; we answer every request the same way.
      body := "<h1>Hello from Toit!</h1><p>Visit number $hits.</p>"
      socket.out.write "HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: $body.size\\r\\nConnection: close\\r\\n\\r\\n$body"
    if exception: print "request failed: $exception"
    socket.close
    print "served request $hits"
`,
  },
  {
    name: "Memory stats (runs forever)",
    code: `// Runs until stopped: prints memory stats every 2 s. Stop it from the
// Containers panel (Wi-Fi) or by running something else.
import system

main:
  while true:
    stats := system.process-stats
    print "uptime $(Time.monotonic-us / 1_000_000)s, heap used $(stats[system.STATS-INDEX-ALLOCATED-MEMORY]) bytes, gcs $(stats[system.STATS-INDEX-GC-COUNT])"
    sleep --ms=2000
`,
  },
  {
    name: "Crash (stack trace)",
    code: `// Throws an exception. Over Wi-Fi, the stack trace is captured on the
// device and decoded right here in the browser.
main:
  print "about to fail"
  divide 1 0

divide a/int b/int -> int:
  if b == 0: throw "division by zero ($a / $b)"
  return a / b
`,
  },
];
