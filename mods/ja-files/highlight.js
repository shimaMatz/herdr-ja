// 日本語版: コードの簡易な色付け（ja-files のプレビュー・検索結果と ja-changes の差分で共通）。
// 日本語版: 差分の簡易な色付け。言語は拡張子から大まかに分ける（完全な構文解析ではない）。
// VS Code の Dark+ / Light+ に近い色。赤・緑は追加・削除の背景と紛れるので、トークンには使わない。
export const DARK = { keyword: "#569cd6", string: "#ce9178", comment: "#6a9955", function: "#dcdcaa", type: "#4ec9b0", number: "#b5cea8", constant: "#569cd6",
  property: "#9cdcfe", variable: "#9cdcfe", operator: "#d4d4d4", tag: "#569cd6", attr: "#9cdcfe", text: "#d4d4d4" };
export const LIGHT = { keyword: "#0000ff", string: "#a31515", comment: "#008000", function: "#795e26", type: "#267f99", number: "#098658", constant: "#0000ff",
  property: "#001080", variable: "#001080", operator: "#000000", tag: "#800000", attr: "#e50000", text: "#1f1f1f" };
// 背景の明るさで濃い色・薄い色の組を選ぶ。
export function syntaxColor(k, t) {
  const hex = /^#([0-9a-f]{6})/i.exec(t.background ?? "")?.[1];
  const light = hex ? (parseInt(hex.slice(0, 2), 16) * 299 + parseInt(hex.slice(2, 4), 16) * 587 + parseInt(hex.slice(4, 6), 16) * 114) / 1000 > 140 : false;
  return (light ? LIGHT : DARK)[k || "text"] ?? (light ? LIGHT : DARK).text;
}
const KEYWORDS = new Set(("import export from as default const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super this async await yield try catch finally throw interface type enum implements public private protected readonly static declare namespace module keyof satisfies " +
  "def end module require require_relative include extend unless elsif then begin rescue ensure when lambda proc attr_accessor attr_reader attr_writer self yield and or not " +
  "func package go defer chan map struct range select fn pub use mut impl trait match where loop elif pass with lambda from global nonlocal is").split(" "));
const CONSTANTS = new Set("true false null undefined nil None True False NaN Infinity".split(" "));
const HASH = new Set(["rb", "rake", "py", "sh", "bash", "zsh", "yml", "yaml", "toml", "env", "gemfile", "dockerfile", "conf", "ru", "gemspec"]);
const PLAIN = new Set(["md", "txt", "lock", "csv", "svg"]);
export function langOf(path) {
  const base = (path ?? "").split("/").pop().toLowerCase();
  if (base === "gemfile" || base === "dockerfile" || base.startsWith(".env")) return "hash";
  const ext = base.includes(".") ? base.split(".").pop() : "";
  if (PLAIN.has(ext)) return "plain";
  if (ext === "json") return "json";
  if (HASH.has(ext)) return "hash";
  if (["vue", "html", "htm", "xml", "erb"].includes(ext)) return "markup";
  return "c";
}
// 1行をトークンに分ける。state.block: /* */ の途中か。戻り値は [{k, s}]。
export function tokenize(text, lang, state) {
  const out = [], push = (k, s) => { if (s) out.push({ k, s }); };
  if (lang === "plain") return [{ k: "", s: text }];
  let i = 0;
  if (state.block) {
    const end = text.indexOf("*/");
    if (end < 0) return [{ k: "comment", s: text }];
    push("comment", text.slice(0, end + 2)); i = end + 2; state.block = false;
  }
  while (i < text.length) {
    const rest = text.slice(i), c = text[i];
    let m;
    if (lang !== "hash" && lang !== "json" && rest.startsWith("//") && !/:$/.test(text.slice(0, i))) { push("comment", rest); break; }
    if (lang === "hash" && c === "#" && (i === 0 || /\s/.test(text[i - 1]))) { push("comment", rest); break; }
    if (lang !== "hash" && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0) { push("comment", rest); state.block = true; break; }
      push("comment", rest.slice(0, end + 2)); i += end + 2; continue;
    }
    if (lang === "markup" && rest.startsWith("<!--")) { const end = rest.indexOf("-->"); const n = end < 0 ? rest.length : end + 3; push("comment", rest.slice(0, n)); i += n; continue; }
    if (lang === "markup" && /(^|[\s>(])$/.test(text.slice(0, i)) && (m = /^<\/?[A-Za-z][\w.:-]*/.exec(rest))) { push("punct", m[0].slice(0, m[0][1] === "/" ? 2 : 1)); push("tag", m[0].slice(m[0][1] === "/" ? 2 : 1)); i += m[0].length; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      const str = text.slice(i, Math.min(j + 1, text.length));
      push(lang === "json" && /^\s*:/.test(text.slice(j + 1)) ? "property" : "string", str); i += str.length; continue;
    }
    if ((m = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|^0x[\da-fA-F]+/.exec(rest))) { push("number", m[0]); i += m[0].length; continue; }
    if ((m = /^[@$]?[A-Za-z_][\w$]*[?!]?/.exec(rest))) {
      const w = m[0], after = text.slice(i + w.length);
      let k = "";
      if (lang === "markup" && /^\s*=/.test(after) && /<[^>]*$/.test(text.slice(0, i))) k = "attr";
      else if (KEYWORDS.has(w)) k = "keyword";
      else if (CONSTANTS.has(w)) k = "constant";
      else if (w[0] === "@" || w[0] === "$") k = "variable";
      else if (/^\s*\(/.test(after)) k = "function";
      else if (/^[A-Z]/.test(w)) k = "type";
      else if (!/<[^>]*$/.test(text.slice(0, i)) && /^\s*:(?!:)/.test(after) && /[{,]\s*$|^\s*$/.test(text.slice(0, i))) k = "property";
      push(k, w); i += w.length; continue;
    }
    if (lang === "hash" && c === ":" && (m = /^:[A-Za-z_]\w*/.exec(rest)) && !/\w$/.test(text.slice(0, i))) { push("constant", m[0]); i += m[0].length; continue; }
    if ((m = /^[=!<>+\-*/%&|^~?:]+|^=>/.exec(rest))) { push("operator", m[0]); i += m[0].length; continue; }
    if ((m = /^\s+/.exec(rest))) { push("", m[0]); i += m[0].length; continue; }
    push("punct", c); i += 1;
  }
  return out;
}

// テキスト全体を行ごとのトークンに分ける（/* */ をまたいで続ける）。
export function tokenizeLines(lines, path) {
  const lang = langOf(path), state = { block: false };
  return lines.map((line) => tokenize(line, lang, state));
}
// Text draws a tab as nothing: pad each to the next 4-column stop.
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
// 表示幅（全角は 2）。
export function widthOf(text) {
  let c = 0;
  for (const ch of text) c += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1;
  return c;
}
// トークンを、一致範囲 ranges [{start,end}] の境目で切る。戻り値 [{k, s, hit}]。
export function splitHits(tokens, ranges) {
  if (!ranges?.length) return tokens;
  const out = []; let pos = 0;
  for (const tk of tokens) {
    let i = 0;
    while (i < tk.s.length) {
      const at = pos + i, r = ranges.find((r) => at >= r.start && at < r.end), next = ranges.find((r) => r.start > at);
      const stop = r ? r.end : next ? next.start : Infinity;
      const n = Math.max(1, Math.min(tk.s.length - i, stop - at));
      out.push({ k: tk.k, s: tk.s.slice(i, i + n), hit: Boolean(r) });
      i += n;
    }
    pos += tk.s.length;
  }
  return out;
}
export function matchRanges(text, re) {
  if (!re) return [];
  const out = []; let m, n = 0;
  re.lastIndex = 0;
  while ((m = re.exec(text)) && n++ < 50) {
    if (!m[0]) { re.lastIndex++; if (!re.global) break; continue; }
    out.push({ start: m.index, end: m.index + m[0].length });
    if (!re.global) break;
  }
  return out;
}
