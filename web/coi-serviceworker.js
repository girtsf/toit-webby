// Retired cross-origin isolation shim: the VM no longer needs
// SharedArrayBuffer. Browsers that registered the old worker fetch this on
// their next visit; it unregisters itself and reloads open pages without the
// COOP/COEP headers. Can be deleted once old registrations have died out.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  self.registration.unregister()
    .then(() => self.clients.matchAll({ type: "window" }))
    .then((clients) => clients.forEach((c) => c.navigate(c.url)))));
