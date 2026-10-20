# Multi-file projects and packages

## Why
The editor compiles a single source file (`/work/main.toit` in MEMFS). Real Toit
programs often span multiple files and pull in packages (`package.lock` /
`package.yaml`).

## Ideas
1. **Multiple local files.** Let the user add/rename files; write them all into
   the wasm MEMFS before compiling, with `main.toit` (or a chosen entrypoint) as
   the compile target. `web/toit-runtime.js#runTool` already takes a `files` map
   — extend the UI to manage several.
2. **Imports between files.** Relative imports work once the files are in MEMFS
   together. Mainly a UI/state problem (a little file tree + tabs).
3. **Packages.** Harder: `toit pkg` resolves/downloads dependencies from the
   registry over the network, into a package cache. In-browser this means
   fetching packages (CORS!) and wiring the cache dir the compiler reads
   (`TOIT_PACKAGE_CACHE_PATHS`, see `filesystem_local.cc#package_cache_paths`).
   Could pre-bundle common packages, or fetch same-origin/proxied. The `toit`
   wasm already contains the pkg tooling (`tools/pkg/`).
4. **Project import/export.** Load a folder (File System Access API in Chromium)
   or a zip; export the current project.

## Pointers
- MEMFS wiring + compile: `web/toit-runtime.js` (`runTool`, `compile`).
- Package manager internals: `third_party/toit/src/compiler/pkg.toit`,
  `tools/pkg/`, and cache path logic in
  `src/compiler/filesystem_local.cc`.

## Verdict
Multi-file (1–2) is cheap and high-value. Full package support is a larger,
network-bound effort — probably wants the local agent or a bundled package set.
