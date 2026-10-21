// Minimal CodeMirror 6 editor with a hand-written Toit syntax highlighter.
// Starts as a plain <textarea> and upgrades once the CDN modules load, so a slow
// or offline CDN never blocks the app.

const KEYWORDS = new Set((
  "import export as show class interface extends implements mixin with abstract " +
  "static constructor return if else for while do break continue try finally " +
  "assert throw and or not null true false this super it in is")
  .split(" "));

const toitMode = {
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
};

export function createEditor(parent, doc) {
  const ta = document.createElement("textarea");
  ta.className = "editor-fallback";
  ta.spellcheck = false;
  ta.value = doc;
  parent.appendChild(ta);
  let view = null;
  upgrade().catch((e) => console.warn("CodeMirror unavailable, using textarea:", e));

  async function upgrade() {
    const [{ EditorView, basicSetup }, { StreamLanguage }, { oneDark }] = await Promise.all([
      import("https://esm.sh/codemirror@6.0.1"),
      import("https://esm.sh/@codemirror/language@6.10.2"),
      import("https://esm.sh/@codemirror/theme-one-dark@6.1.2"),
    ]);
    view = new EditorView({
      doc: ta.value,
      extensions: [basicSetup, StreamLanguage.define(toitMode), oneDark, EditorView.lineWrapping],
    });
    ta.replaceWith(view.dom);
  }

  return {
    getValue: () => (view ? view.state.doc.toString() : ta.value),
    setValue: (v) => {
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
      else ta.value = v;
    },
  };
}
