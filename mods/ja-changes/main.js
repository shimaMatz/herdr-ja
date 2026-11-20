import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, closeOverlay, layout, shared, setShared, run, terminals, openOverlay } from "herdr";

// 日本語版: このコピーが今見えているか。隠れているパネルは git を走らせない（ホームのような巨大なリポジトリで数十秒かかり、次の読み込みを止めていた）。
function findNode(n, id) { if (!n) return null; if (n.id === id) return n; for (const c of n.children ?? []) { const r = findNode(c, id); if (r) return r; } return null; }
function shown(name) {
  const p = props() ?? {};
  if (p.overlay) return true;
  const root = layout();
  const [col, stack, child] = p.wide ? ["wt-panel", "wt-panel-body", `wt-${name}`] : ["panel", "panel-body", name];
  const c = findNode(root, col), s = findNode(root, stack);
  if (!c || !s) return true;
  return !c.hidden && s.active === child;
}

// 日本語版: ターミナルで選んだ（ダブルクリック・ドラッグ）文字列から「ファイル:行」を読み取る。
// Herdr はリンクのクリックを mod に渡さないので、選択時に自動でコピーされたクリップボードを見る。
function parseRef(text, root) {
  if (!text || text.length > 400 || text.includes("://")) return null;
  const m = /(?:^|[\s(\[「『'"`])((?:[\w@.~+-]+\/)*[\w@~+-][\w@.~+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:[-–](\d+))?)?/.exec(text.trim().split("\n")[0]);
  if (!m) return null;
  let path = m[1].replace(/^\.\//, "");
  if (root && path.startsWith(root + "/")) path = path.slice(root.length + 1);
  const line = m[2] ? Number(m[2]) : null, end = m[3] ? Number(m[3]) : line;
  return { path, line, end: end && line && end >= line ? end : line };
}
function selectionKey() {
  const list = terminals().filter((t) => t.selection).map((t) => `${t.address}:${JSON.stringify(t.selection)}`);
  return list.length ? list.join("|") : null;
}
// 選択が止まってから（ドラッグ中は待つ）クリップボードを読み、ファイル参照なら onRef を呼ぶ。
function watchSelection(view, cx, onRef) {
  const k = selectionKey();
  if (k === view.selKey) return;
  const before = new Set((view.selKey ?? "").split("|"));
  view.selKey = k;
  // 選択が消えただけのとき（新しく選んだものがないとき）は何もしない。
  if (!k || k.split("|").every((e) => before.has(e))) return;
  cx.spawn(async (cx) => {
    await cx.sleep(350);
    if (view.selKey !== k) return;
    const ref = parseRef(cx.read_from_clipboard(), view.root);
    if (ref) await onRef(ref, cx);
  });
}

// 日本語版: ホームフォルダ自体のリポジトリ（dotfiles 管理など）。未追跡が膨大で git が数十秒かかるので、変更を調べない。
const isHome = (path) => /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\/?$/.test(path ?? "");
// 日本語版: 一覧と中身の境目をドラッグで動かす。幅はこのコピーの種類ごとに覚える。
const GUTTER = 64; // 行番号 36 + 間 8 + 記号 12 + 間 8
function splitter(view, storeKey, fallback, t) {
  if (view.splitW === undefined) { let w = null; try { w = Number(localStorage.getItem(storeKey)); } catch {} view.splitW = w > 0 ? w : fallback; }
  const handle = h_flex().id("split-handle").w(7).h_full().flex_none().justify_center().cursor_col_resize()
    .on_hover((on, cx) => { view.splitHover = on; cx.notify(); })
    .child(div().w(view.drag || view.splitHover ? 3 : 1).h_full().bg(view.drag || view.splitHover ? t.accent : t.border))
    .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); view.drag = { x: e.position.x, w: view.splitW }; cx.notify(); });
  const track = (el) => el
    .on_mouse_move((e, cx) => {
      if (!view.drag) return;
      const max = Math.max(200, (e.bounds?.size?.width ?? e.bounds?.width ?? 2000) - 260);
      view.splitW = Math.round(Math.min(max, Math.max(160, view.drag.w + e.position.x - view.drag.x)));
      cx.notify();
    })
    .on_mouse_up("left", (_e, cx) => {
      if (!view.drag) return;
      view.drag = null; try { localStorage.setItem(storeKey, String(view.splitW)); } catch {}
      cx.notify();
    });
  return { width: view.splitW, handle, track };
}
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// 新規（未追跡）ファイルの行数: wc -l をまとめて一度だけ（最大 300 件）。
async function lineCounts(root, paths, on) {
  const out = {};
  if (!paths.length) return out;
  const r = await exec("wc", ["-l", "--", ...paths.slice(0, 300)], { cwd: root, on }).catch(() => null);
  if (!r?.stdout) return out;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s(.+)$/.exec(line);
    if (m && m[2] !== "total" && m[2] !== "合計") out[m[2]] = Number(m[1]);
  }
  return out;
}
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// 日本語版: 差分の簡易な色付け。言語は拡張子から大まかに分ける（完全な構文解析ではない）。
// VS Code の Dark+ / Light+ に近い色。赤・緑は追加・削除の背景と紛れるので、トークンには使わない。
const DARK = { keyword: "#569cd6", string: "#ce9178", comment: "#6a9955", function: "#dcdcaa", type: "#4ec9b0", number: "#b5cea8", constant: "#569cd6",
  property: "#9cdcfe", variable: "#9cdcfe", operator: "#d4d4d4", tag: "#569cd6", attr: "#9cdcfe", text: "#d4d4d4" };
const LIGHT = { keyword: "#0000ff", string: "#a31515", comment: "#008000", function: "#795e26", type: "#267f99", number: "#098658", constant: "#0000ff",
  property: "#001080", variable: "#001080", operator: "#000000", tag: "#800000", attr: "#e50000", text: "#1f1f1f" };
// 背景の明るさで濃い色・薄い色の組を選ぶ。
function syntaxColor(k, t) {
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
function langOf(path) {
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
function tokenize(text, lang, state) {
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

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.dx = 0; this.message = ""; this.handle = cx.focus_handle();
    this.diffScroll = VirtualListScrollHandle.new(); this.selKey = selectionKey();
    this.input = InputState.new({ placeholder: "コミットメッセージ" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // 選択の変化では再描画されないことがあるので、見えている間は 0.4 秒ごとに確かめる。
    cx.timer.every(400, (cx) => { if (shown("changes")) watchSelection(this, cx, (ref, cx) => this.jumpTo(ref, cx)); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (!shown("changes")) { this.stale = true; return; }
    this.stale = false;
    const { cwd, on } = location(), context = key();
    // 場所が変わったら、前の場所の読み込みを待たずに始め直す（前の結果は key の比較で捨てられる）。
    if (context !== this.context) this.loading = false;
    if (this.loading || this.busy) return;
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "git リポジトリではありません"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        if (isHome(root)) { this.root = root; this.files = []; this.setLines([]); this.open = null; this.error = "ホームフォルダでは変更一覧を出しません"; return; }
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        // 日本語版: 新規ファイルも開く前から +行数 を出す。
        const counts = await lineCounts(root, files.filter((f) => f.fresh).map((f) => f.path), on);
        for (const f of files) if (f.fresh && counts[f.path] !== undefined) f.add = counts[f.path];
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["この差分は表示できません（大きすぎるか読めません）"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["このファイルは表示できません（バイナリ・大きすぎる・読めない）"];
      else if (text.includes("\0")) lines = ["バイナリファイルのため差分はありません"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "バイナリファイルが変更されました" : "テキストの差分はありません"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "…（行を省略）" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    { const lang = langOf(this.open), state = { block: false };
      for (const row of this.rows) { if (row.kind === "@") state.block = false; else if (row.number !== undefined) row.tokens = tokenize(row.text, lang, state); } }
    // 日本語版: 全角文字は半角2文字分で数える（文字数だけだと日本語の行が右で切れて横スクロールできなかった）。
    let cols = 0;
    for (const row of this.rows) { let c = 0; for (const ch of row.text) c += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1; if (c > cols) cols = c; }
    this.diffWidth = Math.max(240, (cols + 2) * 7.5 + 24);
  }

  // 日本語版: 横スクロール量（コード部分だけ）。行番号の列は GUTTER px で固定。
  maxDx() { return Math.max(0, Math.round(this.diffWidth - ((this.diffViewW ?? 600) - GUTTER))); }
  clampDx() { this.dx = Math.min(this.maxDx(), Math.max(0, Math.round(this.dx || 0))); }

  pick(path, cx) {
    this.hl = null; this.dx = 0;
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `この差分は表示できません（大きすぎるか読めません）: ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `コミットに失敗しました: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // 日本語版: フォルダごとにまとめ、フォルダ名の見出しの下にファイル名だけを並べる。
  groups() {
    const by = new Map();
    for (const f of this.files) {
      const i = f.path.lastIndexOf("/"), dir = i < 0 ? "" : f.path.slice(0, i);
      if (!by.has(dir)) by.set(dir, []);
      by.get(dir).push(f);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  listHeight() {
    const closed = this.collapsed ?? new Set();
    return this.groups().reduce((n, [dir, fs]) => n + (dir ? 24 : 0) + (dir && closed.has(dir) ? 0 : fs.length * 26), 0);
  }

  // 日本語版: 右クリックで相対パス（リポジトリのルートから）・絶対パスをコピーする。
  pathMenu(rel) {
    if (this.root) openOverlay({ mod: "ja-menu", kind: "popup", width: 200, height: 90, props: { tab: "path", target: { rel, abs: `${this.root}/${rel}` } } });
  }

  // 日本語版: フォルダ見出しを押すと、その中のファイルを畳む／開く。
  toggleDir(dir, cx) {
    this.collapsed ??= new Set();
    if (this.collapsed.has(dir)) this.collapsed.delete(dir); else this.collapsed.add(dir);
    cx.notify();
  }

  listRows(t) {
    const out = [], closed = this.collapsed ?? new Set();
    for (const [dir, fs] of this.groups()) {
      const shut = Boolean(dir) && closed.has(dir);
      const add = fs.reduce((n, f) => n + (f.add || 0), 0), del = fs.reduce((n, f) => n + (f.del || 0), 0);
      if (dir) out.push(h_flex().id(`changes-dir-${dir}`).h(24).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(dir)
        .on_click((_e, cx) => this.toggleDir(dir, cx)).on_mouse_down("right", () => this.pathMenu(dir))
        .child(svg(`mods/ja-files/chevron-${shut ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(svg("mods/ja-files/folder.svg").size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(dir))
        .when(shut, (e) => e.child(div().flex_none().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(fs.length)))
          .when(add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`)))
          .when(del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`)))));
      if (shut) continue;
      for (const f of fs) {
        const name = f.path.split("/").pop();
        out.push(h_flex().id(`change-${f.path}`).h(26).flex_none().pl(dir ? 31 : 8).pr(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx)).on_mouse_down("right", () => this.pathMenu(f.path)).tooltip(f.path)
          .child(div().w(14).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child({ A: "新", D: "削", U: "競", M: "変" }[f.status] ?? f.status))
          .child(div().flex_1().min_w(0).truncate().child(name))
          .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`))));
      }
    }
    return out;
  }

  diffRow(row, t) {
    const { kind, number, text } = row;
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const hl = this.hl && this.hl.path === this.open && kind !== "-" && number >= this.hl.from && number <= this.hl.to;
    // 日本語版: 行番号と +/− は左に固定し、コードだけを this.dx だけ左へずらして横スクロールする。
    const code = row.tokens ? h_flex().flex_none().children(row.tokens.map((tk) => div().flex_none().whitespace_nowrap().text_color(syntaxColor(tk.k === "punct" ? "operator" : tk.k, t)).child(tk.s)))
      : div().flex_none().whitespace_nowrap().child(text);
    return h_flex().w_full().h(20).flex_none().gap(8).when(kind === "+", (e) => e.bg(t.ansi2 + "26")).when(kind === "-", (e) => e.bg(t.ansi1 + "26"))
      .when(hl, (e) => e.bg(t.accent + "33").border_l(3).border_color(t.accent))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(12).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" ? "+" : kind === "-" ? "−" : ""))
      .child(div().flex_1().min_w(0).h_full().overflow_hidden().relative().child(h_flex().absolute().top(0).h_full().left(-this.dx).child(code)));
  }

  // 日本語版: ターミナルで選んだファイル参照へ移動する。変更一覧にない・差分に出ていない行はファイル表示に回す。
  async jumpTo(ref, cx) {
    const context = this.context;
    const hits = this.files.filter((f) => f.path === ref.path || f.path.endsWith("/" + ref.path) || ref.path.endsWith("/" + f.path));
    const file = hits.find((f) => f.path === ref.path) ?? hits.sort((a, b) => a.path.length - b.path.length)[0];
    if (!file) return this.handOff(ref);
    if (this.open !== file.path || !this.rows.length) {
      this.open = file.path; this.closed = false; this.note = null; this.dx = 0; this.setLines([]); cx.notify();
      try { await this.load(file.path, context); } catch { return; }
      if (key() !== context || this.open !== file.path) return;
    }
    this.hl = ref.line ? { path: file.path, from: ref.line, to: ref.end ?? ref.line } : null;
    if (ref.line) {
      const i = this.rows.findIndex((r) => r.kind !== "-" && r.number !== undefined && r.number >= ref.line);
      if (i < 0 || this.rows[i].number > (ref.end ?? ref.line)) { this.hl = null; cx.notify(); return this.handOff({ ...ref, path: file.path }); }
      this.diffScroll.scroll_to_item(Math.max(0, i - 3), "top");
    } else this.diffScroll.scroll_to_item(0, "top");
    cx.notify();
  }

  handOff(ref) {
    setShared("ja-jump", { ...ref, at: Date.now() });
    const wide = Boolean(props()?.wide);
    if (!props()?.overlay) run("layout.select", wide ? { stack: "wt-panel-body", child: "wt-files" } : { stack: "panel-body", child: "files" });
  }

  render(cx) {
    if (key() !== this.context || this.stale) this.refresh(cx);
    if (shown("changes")) watchSelection(this, cx, (ref, cx) => this.jumpTo(ref, cx)); else this.selKey = selectionKey();
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const overlay = props()?.overlay, modal = Boolean(overlay) || Boolean(props()?.wide);
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("変更"))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} ファイル`))
      .when(modal && Boolean(this.root), (e) => e.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.root ?? "")))
      .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
      .when(Boolean(overlay), (e) => e.child(div().id("changes-close").ml(6).px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("閉じる (Esc)").on_click(() => closeOverlay(overlay)).child("×")));
    // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
    const list = div().relative().border_color(t.border)
      .map((e) => modal ? e.w_full().flex_1().min_h(0) : e.flex_1().min_h(44).max_h(this.listHeight() + 12).border_b(1))
      .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.listRows(t)).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "変更を読み込み中…" : this.root ? "未コミットの変更はありません" : "フォルダがありません")))))
      .child(Scrollbar.vertical("changes-list").absolute().inset_0());
    const limited = div().px(12).py(4).text_size(11).text_color(t.dim).child("変更ファイルは先頭 1,000 件のみ表示しています");
    const diff = div().flex_1().min_h(0).min_w(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(modal ? 12 : 11)
      .id("changes-diff-x").on_size_change((size, cx) => { this.diffViewW = size.width; this.clampDx(); cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        let d = e.delta.x;
        if (!d && e.modifiers?.shift) d = e.delta.y;
        if (!d || Math.abs(d) < Math.abs(e.delta.y) && !e.modifiers?.shift) return;
        const before = this.dx; this.dx -= d; this.clampDx();
        if (this.dx !== before) cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.hdrag) return;
        const track = Math.max(1, (this.diffViewW ?? 600) - GUTTER);
        this.dx = this.hdrag.dx + (e.position.x - this.hdrag.x) * (this.diffWidth / track); this.clampDx(); cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.hdrag) { this.hdrag = null; cx.notify(); } })
      .child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
          (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).track_scroll(this.diffScroll).size_full())
      .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
      .when(this.maxDx() > 0, (e) => {
        const track = Math.max(1, (this.diffViewW ?? 600) - GUTTER - 12), view = (this.diffViewW ?? 600) - GUTTER;
        const thumb = Math.max(24, track * view / this.diffWidth), left = (track - thumb) * this.dx / this.maxDx();
        return e.child(div().absolute().bottom(2).left(GUTTER).right(12).h(6)
          .child(div().id("changes-hbar").absolute().top(0).h(6).left(left).w(thumb).rounded(3).bg(t.dim + (this.hdrag ? "cc" : "66"))
            .on_mouse_down("left", (ev, cx) => { cx.stop_propagation(); this.hdrag = { x: ev.position.x, dx: this.dx }; cx.notify(); })));
      })
      .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("ファイルを選ぶと変更内容を表示します")));
    const sp = splitter(this, "changes-split", 440, t);
    const body = modal
      ? sp.track(h_flex().id("changes-split").flex_1().min_h(0)).child(v_flex().w(sp.width).h_full().flex_none().child(list).when(this.limited, (el) => el.child(limited))).child(sp.handle).child(diff.h_full())
      : null;
    return v_flex().id("changes").size_full().min_h(0).when(!overlay, (e) => e.rounded(10).border_1()).overflow_hidden().bg(t.background).border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(header)
      .when(modal, (el) => el.child(body))
      .when(!modal, (el) => el.child(list).when(this.limited, (el) => el.child(limited)).child(diff))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "コミット中…" : "コミット")));
  }
}
