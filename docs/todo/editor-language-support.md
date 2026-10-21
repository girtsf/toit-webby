# Richer Toit editor support

## Why
The editor (`web/editor.js`) is CodeMirror 6 with a small hand-written Toit
stream tokenizer — keywords/strings/comments/numbers/types. It's enough to read
code but has no real language intelligence (no error squiggles, autocomplete,
go-to-def, hover types).

## Ideas
1. **Inline compile errors.** We already compile in-browser. Parse
   `toit.compile` diagnostics (it prints `file:line:col: error: …`) and surface
   them as CodeMirror diagnostics/gutters instead of dumping to the console.
   Compile-on-idle for live feedback.
2. **Toit LSP in wasm.** The SDK ships an LSP server
   (`third_party/toit/tools/lsp/`, and `toit` has an `lsp` subcommand). It's a
   Toit program, so it could run on the same wasm VM and drive CodeMirror's LSP
   client features (completion, hover, diagnostics, definitions). Bigger lift:
   LSP is long-running/stateful, which pushes on the single-shot VM model (and
   the VM is single-threaded, see docs/BUILD.md). Investigate feasibility.
3. **Better tokenizer.** If full LSP is too much, improve the StreamLanguage:
   string interpolation (`$x`, `$(expr)`), toitdoc comments, nested types,
   indentation-aware folding.
4. **Snippets / examples.** Ship a few starter programs (GPIO blink, Wi-Fi,
   HTTP, sensors) selectable from a dropdown.

## Pointers
- Editor: `web/editor.js` (`toitLang` StreamLanguage + `KEYWORDS`).
- Compiler diagnostics come out of `toit.compile` stderr
  (captured in `web/toit-runtime.js#runTool`).
