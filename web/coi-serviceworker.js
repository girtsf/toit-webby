// Cross-origin isolation shim: re-serves responses with COOP/COEP headers so
// SharedArrayBuffer (needed by the pthreaded Toit VM wasm) works on static
// hosts like GitHub Pages that can't set headers. Based on the well-known
// coi-serviceworker pattern (gzuidhof), MIT.
/*global self, caches*/
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    // Leave device requests (http://<name>.local, CORS) to the page: they need
    // its Local Network Access permission and don't need COEP rewriting.
    const sameOrigin = new URL(r.url).origin === self.location.origin;
    if (!sameOrigin && r.url.startsWith("http:") && r.mode === "cors") return;
    // Revalidate same-origin files (cheap 304s) so a deploy never mixes cached
    // old modules with new ones (GitHub Pages sends max-age=600).
    event.respondWith(
      fetch(sameOrigin ? new Request(r, { cache: "no-cache" }) : r)
        .then((response) => {
          if (response.status === 0) return response;
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    if (window.crossOriginIsolated !== false) return; // already isolated
    if (!window.isSecureContext) return;
    navigator.serviceWorker && navigator.serviceWorker.register(window.document.currentScript.src)
      .then((reg) => {
        reg.addEventListener("updatefound", () => window.location.reload());
        if (reg.active && !navigator.serviceWorker.controller) window.location.reload();
      })
      .catch((e) => console.error("COI SW registration failed:", e));
  })();
}
