// Minimal CodeMirror 6 editor with a hand-written Toit syntax highlighter.
// Falls back to a plain <textarea> if the CDN modules can't load (offline).
import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { StreamLanguage } from "https://esm.sh/@codemirror/language@6.10.2";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6.1.2";

const KEYWORDS = new Set((
  "import export as show class interface extends implements mixin with abstract " +
  "static constructor return if else for while do break continue try finally " +
  "assert throw and or not null true false this super it in is")
  .split(" "));

const toitLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    // line comment
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { // block comment
      while (!stream.eol()) { if (stream.match("*/")) break; stream.next(); }
      return "comment";
    }
    const ch = stream.peek();
    if (ch === '"') { // string (with simple interpolation passthrough)
      stream.next();
      while (!stream.eol()) { const c = stream.next(); if (c === '"') break; if (c === "\\") stream.next(); }
      return "string";
    }
    if (/[0-9]/.test(ch)) { stream.eatWhile(/[0-9_.xXa-fA-F]/); return "number"; }
    if (/[A-Za-z_]/.test(ch)) {
      stream.eatWhile(/[A-Za-z0-9_-]/);
      const w = stream.current();
      if (KEYWORDS.has(w)) return "keyword";
      if (/^[A-Z]/.test(w)) return "typeName";
      return "variableName";
    }
    if (/[:=<>+\-*/%.&|!?]/.test(ch)) { stream.eatWhile(/[:=<>+\-*/%.&|!?]/); return "operator"; }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//" } },
});

export function createEditor(parent, doc) {
  try {
    const view = new EditorView({
      parent,
      doc,
      extensions: [basicSetup, toitLang, oneDark, EditorView.lineWrapping],
    });
    return {
      getValue: () => view.state.doc.toString(),
      setValue: (v) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }),
    };
  } catch (e) {
    console.warn("CodeMirror unavailable, using textarea:", e);
    const ta = document.createElement("textarea");
    ta.className = "editor-fallback";
    ta.value = doc;
    parent.appendChild(ta);
    return { getValue: () => ta.value, setValue: (v) => { ta.value = v; } };
  }
}
