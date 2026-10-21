// Minimal CodeMirror 6 editor with a hand-written Toit syntax highlighter.
// Starts as a plain <textarea> and upgrades once the CDN modules load, so a slow
// or offline CDN never blocks the app.

const KEYWORDS = new Set((
  "import export as show class interface extends implements mixin with abstract " +
  "static constructor operator return if else for while break continue try finally " +
  "assert and or not null true false this super it is")
  .split(" "));

function eatString(stream, state) {
  const end = state.inString;
  while (!stream.eol()) {
    if (stream.match(end)) { state.inString = null; return; }
    if (stream.next() === "\\") stream.next();
  }
  if (end === '"') state.inString = null;  // Single-quoted strings end at the line.
}

const toitMode = {
  startState: () => ({ inComment: false, inString: null }),
  token(stream, state) {
    if (state.inComment) {
      if (!stream.skipTo("*/")) { stream.skipToEnd(); return "comment"; }
      stream.match("*/");
      state.inComment = false;
      return "comment";
    }
    if (state.inString) { eatString(stream, state); return "string"; }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.inComment = true; return "comment"; }
    if (stream.match('"""')) { state.inString = '"""'; eatString(stream, state); return "string"; }
    if (stream.match('"')) { state.inString = '"'; eatString(stream, state); return "string"; }
    if (stream.match(/^'(\\.|[^'\\])'/)) return "string";
    if (stream.match(/^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?)/)) return "number";
    if (stream.match(/^--[A-Za-z_][A-Za-z0-9_-]*/)) return "attributeName";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*(-[A-Za-z0-9_]+)*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return "keyword";
      // Toit division needs spaces, so `x/int` and `-> int` are type annotations.
      if (/^[A-Z]/.test(w) || /(\/|->\s*)$/.test(stream.string.slice(0, stream.start))) return "typeName";
      // Definitions start at the beginning of a (possibly indented) line.
      if (stream.string.slice(0, stream.start).trim() === "" && /^(\s[^:]*)?:\s*(\/\/.*)?$/.test(stream.string.slice(stream.pos)))
        return "variableName.function.definition";
      return null;
    }
    if (stream.match(/^[:=<>+\-*/%.&|!?^~]+/)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
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
    // codemirror and theme-one-dark import @codemirror/language@^6.0.0; using the
    // same range yields the same module instance. A second copy (e.g. a pinned
    // version) makes the theme's highlight style ignore our tokens.
    const [{ EditorView, basicSetup }, { StreamLanguage }, { oneDark }] = await Promise.all([
      import("https://esm.sh/codemirror@6.0.1"),
      import("https://esm.sh/@codemirror/language@^6.0.0"),
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
