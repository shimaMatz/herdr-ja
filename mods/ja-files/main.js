// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { exists, mkdir, writeFile } from "fs/promises";
import { Buffer } from "buffer";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { tokenize, tokenizeLines, langOf, syntaxColor, untab, widthOf, splitHits, matchRanges } from "./highlight.js";
import { spaces, panes, focused, exec, readTextFile, home, openOverlay, notify, watchFolder, theme, settings, window, props, closeOverlay, layout, shared, terminals } from "herdr";

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

// 日本語版: 検索。ファイル名（部分一致・あいまい一致）と内容（ripgrep）。大文字小文字・単語単位・正規表現を切り替えられる。
// 日本語版: 右クリックで相対パス・絶対パスをコピーするメニュー（ja-menu の "path"）。
function pathMenu(rel, abs, dir, ops) {
  openOverlay({ mod: "ja-menu", kind: "popup", width: 200, height: 220, props: { tab: "path", target: { rel, abs, dir: Boolean(dir), ops } } });
}
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function matcher(q, opt) {
  const src = opt.regex ? q : escapeRe(q);
  return new RegExp(opt.word ? `\\b(?:${src})\\b` : src, opt.case ? "g" : "gi");
}
function fuzzy(q, s) {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}
async function listFiles(root, on) {
  const r = await exec("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules"], { cwd: root, on, timeout: 20000 }).catch(() => null);
  let out = r && r.code <= 1 ? r.stdout : null;
  if (out === null) {
    const g = await exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, on, timeout: 20000 }).catch(() => null);
    out = g?.code === 0 ? g.stdout : "";
  }
  return out.split("\n").filter(Boolean).slice(0, 100000).sort();
}
function lineRange(text, from, to) {
  const lines = text.split("\n");
  if (from > lines.length) return null;
  let start = 0;
  for (let i = 0; i < from - 1; i++) start += lines[i].length + 1;
  let end = start;
  for (let i = from - 1; i < Math.min(to, lines.length); i++) end += lines[i].length + 1;
  return { start, end: Math.max(start, end - 1) };
}

// 日本語版: ホームフォルダ自体のリポジトリ（dotfiles 管理など）。未追跡が膨大で git が数十秒かかるので、変更を調べない。
const isHome = (path) => /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\/?$/.test(path ?? "");
// 日本語版: 一覧と中身の境目をドラッグで動かす。幅はこのコピーの種類ごとに覚える。
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
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// 日本語版: プレビューの言語名（ハイライタの名前に合わせる）。
const LANG = { js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby", py: "python", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown", mdx: "markdown", html: "html", htm: "html", vue: "html", svelte: "svelte", erb: "erb",
  css: "css", scss: "css", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", php: "php", sql: "sql", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", lua: "lua", ex: "elixir", exs: "elixir", graphql: "graphql", gql: "graphql", proto: "proto", diff: "diff", patch: "diff", zig: "zig", scala: "scala" };
const LANG_FILE = { gemfile: "ruby", rakefile: "ruby", dockerfile: "bash", makefile: "make", ".zshrc": "bash", ".bashrc": "bash" };
function langFor(path) {
  const base = path.split("/").pop().toLowerCase();
  return LANG_FILE[base] ?? (base.startsWith(".env") ? "bash" : LANG[extOf(path)] ?? (extOf(path) || "text"));
}
// VS Code の Dark+ / Light+ に近い色（変更の差分表示と同じ）。
const DARK = { keyword: "#569cd6", string: "#ce9178", "string.escape": "#d7ba7d", comment: "#6a9955", function: "#dcdcaa", type: "#4ec9b0", number: "#b5cea8", boolean: "#569cd6", constant: "#4fc1ff",
  property: "#9cdcfe", variable: "#9cdcfe", operator: "#d4d4d4", punctuation: "#a0a0a0", tag: "#569cd6", attribute: "#9cdcfe", text: "#d4d4d4" };
const LIGHT = { keyword: "#0000ff", string: "#a31515", "string.escape": "#ee0000", comment: "#008000", function: "#795e26", type: "#267f99", number: "#098658", boolean: "#0000ff", constant: "#0070c1",
  property: "#001080", variable: "#001080", operator: "#000000", punctuation: "#404040", tag: "#800000", attribute: "#e50000", text: "#1f1f1f" };
function palette(t) {
  const hex = /^#([0-9a-f]{6})/i.exec(t.background ?? "")?.[1];
  const light = hex ? (parseInt(hex.slice(0, 2), 16) * 299 + parseInt(hex.slice(2, 4), 16) * 587 + parseInt(hex.slice(4, 6), 16) * 114) / 1000 > 140 : false;
  return light ? LIGHT : DARK;
}
const PER_FOLDER = 500, TOTAL = 5000;
// 日本語版: マークダウンはレンダリングして、画像はそのまま表示する。
const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif"]);
const MD = new Set(["md", "markdown", "mdx"]);
const extOf = (path) => (/\.([^./]+)$/.exec(path ?? "")?.[1] ?? "").toLowerCase();
// フォルダ相対のパスを、.. と . を畳んで解決する（root 相対の結果。外に出たら null）。
function joinRel(dir, rel) {
  const out = dir ? dir.split("/") : [];
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.join("/");
}
// マークダウンを「文章」と「1 行だけの画像」に分ける。画像は image() で出す（TextView はローカル画像を読めない）。
function mdBlocks(text, dir) {
  const blocks = []; let buf = [], fence = null;
  const flush = () => { if (buf.join("").trim()) blocks.push({ kind: "md", text: buf.join("\n") }); buf = []; };
  for (const line of text.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1]; buf.push(line); continue; }
    const m = !fence && (/^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/.exec(line) || /^\s*<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*$/i.exec(line));
    if (m) {
      const src = m.length > 2 ? m[2] : m[1], alt = m.length > 2 ? m[1] : (/\balt=["']([^"']*)["']/i.exec(line)?.[1] ?? "");
      if (!/^[a-z]+:/i.test(src)) { flush(); blocks.push({ kind: "img", src: src.startsWith("/") ? null : joinRel(dir, decodeURI(src.split(/[?#]/)[0])), raw: src, alt }); continue; }
    }
    buf.push(line);
  }
  flush();
  return blocks;
}
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

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "このフォルダを一覧できません");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "このフォルダを一覧できません");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.uid = `${Date.now()}-${Math.random()}`; this.opSeen = shared("ja-fileop")?.at ?? 0;
    this.saved = new Map(); this.imgs = new Map(); this.hitClosed = new Set(); this.dx = 0; this.codeScroll = VirtualListScrollHandle.new();
    // 日本語版: 写したプレビュー画像のうち、1 日より古いものを片付ける（ほかのパネルが表示中のものは消さない）。
    exec("find", [`${home()}/.config/herdr-app/data/ja-files/preview`, "-type", "f", "-mtime", "+1", "-delete"]).catch(() => {});
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.stats = {};
    this.selKey = selectionKey(); this.jumpSeen = shared("ja-jump")?.at ?? 0;
    this.query = ""; this.mode = "name"; this.opt = { case: false, word: false, regex: false }; this.results = null; this.searchSeq = 0;
    this.search = InputState.new({ placeholder: "ファイル名・文字列で検索" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.runSearch(cx); });
    this.search.on("submit", (_e, cx) => this.runSearch(cx, true));
    this.search.on("focus", (_e, cx) => { this.searchFocus = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searchFocus = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // 選択の変化では再描画されないことがあるので、見えている間は 0.4 秒ごとに確かめる。
    cx.timer.every(400, (cx) => { this.takeOp(cx); if (shown("files")) watchSelection(this, cx, (ref, cx) => this.jumpFile(ref, cx)); });
  }

  async fileList(force) {
    const root = this.root, on = this.on;
    if (!root) return [];
    if (!force && this.list?.root === root && Date.now() - this.list.at < 30000) return this.list.files;
    const files = await listFiles(root, on);
    this.list = { root, at: Date.now(), files };
    return files;
  }

  runSearch(cx, now) {
    const seq = ++this.searchSeq, q = this.query.trim(), mode = this.mode, opt = { ...this.opt }, root = this.root, on = this.on;
    if (!q) { this.results = null; this.searchError = null; this.searching = false; cx.notify(); return; }
    let re;
    try { re = matcher(q, opt); } catch (e) { this.searchError = "正規表現が正しくありません"; this.results = null; cx.notify(); return; }
    this.searching = true; this.searchError = null; cx.notify();
    cx.spawn(async (cx) => {
      if (!now) await cx.sleep(mode === "text" ? 300 : 120);
      if (seq !== this.searchSeq) return;
      try {
        if (mode === "name") {
          const files = await this.fileList(), hits = [], lower = q.toLowerCase();
          for (const f of files) {
            const name = f.slice(f.lastIndexOf("/") + 1);
            re.lastIndex = 0; const inName = re.test(name); re.lastIndex = 0;
            let score = inName ? (name.toLowerCase().startsWith(lower) ? 0 : 1) : re.test(f) ? 2 : -1;
            if (score < 0 && !opt.regex && !opt.word && !q.includes(" ") && fuzzy(opt.case ? q : lower, opt.case ? f : f.toLowerCase())) score = 3;
            if (score >= 0) hits.push({ path: f, score });
          }
          hits.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
          if (seq !== this.searchSeq) return;
          this.results = { mode, total: hits.length, items: hits.slice(0, 300) };
        } else {
          const args = ["--null", "--line-number", "--no-heading", "--color", "never", "--max-columns", "400", "--max-columns-preview", "--max-count", "50",
            "--hidden", "-g", "!.git", "-g", "!node_modules", opt.case ? "-s" : "-i", ...(opt.word ? ["-w"] : []), ...(opt.regex ? [] : ["-F"]), "-e", q];
          const r = await exec("rg", args, { cwd: root, on, timeout: 30000 });
          if (seq !== this.searchSeq) return;
          if (r.code > 1) throw new Error(r.stderr.trim() || "検索に失敗しました");
          const groups = new Map(); let total = 0;
          for (const line of r.stdout.split("\n")) {
            const z = line.indexOf("\0"); if (z < 0) continue;
            const path = line.slice(0, z), m = /^(\d+):(.*)$/.exec(line.slice(z + 1)); if (!m) continue;
            total++;
            if (total > 2000) continue;
            if (!groups.has(path)) groups.set(path, []);
            groups.get(path).push({ line: Number(m[1]), text: m[2] });
          }
          this.results = { mode, total, files: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)), re };
        }
      } catch (e) { if (seq === this.searchSeq) { this.searchError = String(e?.message ?? e); this.results = null; } }
      finally { if (seq === this.searchSeq) this.searching = false; cx.notify(); }
    });
  }

  // 日本語版: ファイル操作（追加・名前変更・削除）。ja-menu → ja-prompt / ja-confirm → 共有の値 ja-fileop で戻ってくる。
  ops() { return { uid: this.uid, root: this.root, on: this.on ?? null }; }

  takeOp(cx) {
    const o = shared("ja-fileop");
    if (!o || o.at <= this.opSeen) return;
    this.opSeen = o.at;
    if (o.uid !== this.uid || Date.now() - o.at > 10000) return;
    const { root, on } = o, rel = o.rel, abs = rel ? `${root}/${rel}` : root;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const name = (o.name ?? "").trim().replace(/^\/+|\/+$/g, "");
    const fail = (msg) => notify({ title: "ファイル操作に失敗しました", body: msg, level: "error", timeout: 5000 });
    if (o.op !== "delete" && (!name || name.split("/").some((p) => p === ".." || p === "."))) return fail("名前が正しくありません");
    if (o.op === "rename" && name.includes("/")) return fail("名前に / は使えません");
    let script, done, target;
    if (o.op === "newfile") { target = rel ? `${rel}/${name}` : name; script = `t=${shq(`${abs}/${name}`)}; [ -e "$t" ] && { echo "同じ名前がもうあります" >&2; exit 1; }; mkdir -p "$(dirname "$t")" && : > "$t"`; done = "作成しました"; }
    else if (o.op === "newdir") { target = rel ? `${rel}/${name}` : name; script = `t=${shq(`${abs}/${name}`)}; [ -e "$t" ] && { echo "同じ名前がもうあります" >&2; exit 1; }; mkdir -p "$t"`; done = "作成しました"; }
    else if (o.op === "rename") { target = parent ? `${parent}/${name}` : name; script = `t=${shq(`${root}/${target}`)}; [ -e "$t" ] && { echo "同じ名前がもうあります" >&2; exit 1; }; mv ${shq(abs)} "$t"`; done = "名前を変更しました"; }
    else if (o.op === "delete") {
      if (!rel) return;
      // ローカルの macOS はゴミ箱へ。別マシンなどゴミ箱のない所は削除する。
      script = on ? `rm -rf -- ${shq(abs)}` : `if command -v trash >/dev/null 2>&1; then trash ${shq(abs)}; else rm -rf -- ${shq(abs)}; fi`;
      done = on ? "削除しました" : "ゴミ箱に移動しました";
    } else return;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", script], { on, timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) { fail((r.stderr || "").trim() || "失敗しました"); return; }
      notify({ title: done, body: o.op === "delete" ? rel : target, level: "success", timeout: 2500 });
      if (this.root !== root) return;
      // 開いているフォルダ・表示中のファイルを合わせる。
      const moved = (p) => o.op === "rename" && (p === rel || p.startsWith(rel + "/")) ? target + p.slice(rel.length) : p;
      const gone = (p) => o.op === "delete" && (p === rel || p.startsWith(rel + "/"));
      this.folders = new Set([...this.folders].filter((p) => !gone(p)).map(moved));
      for (const k of [...this.entries.keys()]) if (gone(k) || moved(k) !== k) this.entries.delete(k);
      if (o.op !== "delete" && o.op !== "rename" && rel) this.folders.add(rel);
      if (o.op === "newdir") this.folders.add(target);
      if (o.op === "newdir" && target.includes("/")) { let p = target; while (p.includes("/")) { p = p.slice(0, p.lastIndexOf("/")); this.folders.add(p); } }
      if (o.op === "newfile" && target.includes("/")) { let p = target; while (p.includes("/")) { p = p.slice(0, p.lastIndexOf("/")); this.folders.add(p); } }
      if (this.file && gone(this.file)) this.show(null);
      else if (this.file && moved(this.file) !== this.file) this.show(moved(this.file), cx);
      if (o.op === "newfile") this.show(target, cx);
      this.list = null; this.loading = false; this.refresh(cx); cx.notify();
    });
  }

  // 日本語版: ターミナルで選んだ「ファイル:行」（または変更タブから回ってきたもの）を開く。
  async jumpFile(ref, cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    let path = ref.path;
    const files = await this.fileList().catch(() => []);
    if (!files.includes(path)) {
      const hits = files.filter((f) => f.endsWith("/" + path) || path.endsWith("/" + f));
      if (!hits.length) return;
      path = hits.sort((a, b) => a.length - b.length)[0];
    }
    this.show(path, cx, ref.line ? { from: ref.line, to: ref.end ?? ref.line } : null);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (!shown("files")) { this.stale = true; return; }
    this.stale = false;
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.stats = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, stats = {};
        if (top?.code === 0 && !isHome(top.stdout.trim())) {
          const gitRoot = top.stdout.trim();
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
          // 日本語版: ファイルごとの +追加 / −削除 行数（HEAD との差分。新規ファイルは行数を数える）。
          const num = await exec("git", [...READ, "diff", "HEAD", "--numstat", "-z", "--no-renames"], { cwd: gitRoot, on }).catch(() => null);
          if (num?.code === 0) for (const entry of num.stdout.split("\0")) {
            const [a, d, ...rest] = entry.split("\t");
            if (!rest.length) continue;
            stats[`${gitRoot}/${rest.join("\t")}`] = { add: Number(a) || 0, del: Number(d) || 0 };
          }
          const fresh = Object.entries(marks).filter(([path, m]) => m === "A" && !stats[path]).map(([path]) => path.slice(gitRoot.length + 1));
          const counts = await lineCounts(gitRoot, fresh, on);
          for (const [rel, n] of Object.entries(counts)) stats[`${gitRoot}/${rel}`] = { add: n, del: 0 };
        }
        if (!this.current(context)) return;
        this.marks = marks; this.stats = stats; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, target) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.target = target ?? null;
    this.md = null; this.img = null; this.lines = null; this.text = null; this.dx = 0;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    this.imgs = new Map();
    if (IMG.has(extOf(path))) { this.img = { path }; return; }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "このファイルはもうありません"; return; }
        if (text.includes("\0")) { this.fileError = "バイナリファイルのためプレビューできません"; return; }
        if (MD.has(extOf(path))) {
          const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          this.md = { path, dir, blocks: mdBlocks(text.length > 400000 ? text.slice(0, 400000) : text, dir) };
        }
        // 日本語版: 色付きのコード表示（自前の簡易ハイライト）。文字を選択したいときだけ Editor に切り替える。
        this.text = text.length > 400000 ? text.slice(0, 400000) + "\n…（以下省略）" : text;
        const lines = this.text.replace(/\n$/, "").split("\n").map(untab);
        const toks = lines.length <= 30000 ? tokenizeLines(lines, path) : lines.map((s) => [{ k: "", s }]);
        let cols = 0; for (const l of lines) { if (l.length > cols / 2) cols = Math.max(cols, widthOf(l)); }
        this.lines = { path, text: lines, toks, width: Math.max(240, (cols + 2) * 7.3 + 24) };
        if (this.viewMode === "select") this.makeEditor(path);
        if (target) { cx.notify(); await this.reveal(text, target, cx); }
      } catch { if (this.file === path && this.current(context)) this.fileError = "このファイルはプレビューできません（バイナリ・大きすぎる・読めない）"; }
      finally { cx.notify(); }
    });
  }

  makeEditor(path) {
    if (this.code || !this.text) return;
    const t = theme(), pal = palette(t);
    this.code = EditorState.new({ language: langFor(path), readonly: true, value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: Object.fromEntries(Object.entries(pal).filter(([k]) => k !== "text")) });
  }

  // 行（と一致した文字列）を選択して、そこまでスクロールさせる。
  async reveal(text, target, cx) {
    if (!this.code) { this.codeScroll.scroll_to_item(Math.max(0, target.from - 6), "top"); cx.notify(); return; }
    const r = lineRange(text, target.from, target.to);
    if (!r || !this.code) return;
    let { start, end } = r;
    if (target.re) {
      target.re.lastIndex = 0;
      const m = target.re.exec(text.slice(start, end));
      if (m && m[0]) { start += m.index; end = start + m[0].length; }
    }
    // 先に少し下の行へカーソルを置いてから戻し、目的の行が画面の端に張りつかないようにする。
    const below = lineRange(text, target.to + 12, target.to + 12) ?? { start: text.length, end: text.length };
    const code = this.code;
    code.set_selected_range({ start: below.start, end: below.start });
    cx.notify(); await cx.sleep(80);
    if (this.code === code) code.set_selected_range({ start, end });
  }

  // 画像の表示元。image() はアプリのフォルダ内しか読めないので、data/ja-files/preview/ に写してから出す。
  // 名前は中身のチェックサムなので、上書きされた画像も新しく読み直す。別マシンの画像は base64 で受け取る。
  imageFor(path, cx) {
    const k = `${this.on ?? ""}|${this.root}/${path}`;
    let e = this.imgs.get(k);
    if (e) return e;
    e = { loading: true }; this.imgs.set(k, e);
    const root = this.root, on = this.on, abs = `${root}/${path}`;
    cx.spawn(async (cx) => {
      try {
        const ck = await exec("cksum", [abs], { on, timeout: 20000 });
        const m = ck.code === 0 && /^(\d+)\s+(\d+)/.exec(ck.stdout);
        if (!m) throw new Error("画像が見つかりません");
        if (Number(m[2]) > 30 * 1024 * 1024) throw new Error("画像が大きすぎます（30MB まで）");
        const rel = `data/ja-files/preview/${m[1]}-${m[2]}.${extOf(path) || "img"}`, dir = `${home()}/.config/herdr-app/data/ja-files/preview`, dest = `${home()}/.config/herdr-app/${rel}`;
        if (!(await exists(dest).catch(() => false))) {
          await mkdir(dir, { recursive: true });
          if (on) {
            const b = await exec("base64", [abs], { on, timeout: 60000 });
            if (b.code !== 0) throw new Error("画像を読めません");
            await writeFile(dest, Buffer.from(b.stdout.replace(/\s+/g, ""), "base64"));
          } else {
            const c = await exec("cp", [abs, dest]);
            if (c.code !== 0) throw new Error("画像を読めません");
          }
        }
        e.src = rel;
      } catch (err) { e.error = String(err?.message ?? err); }
      finally { e.loading = false; cx.notify(); }
    });
    return e;
  }

  imageView(e, alt, t, big) {
    const note = (text) => div().p(8).rounded(6).bg(t.raised).text_size(12).text_color(t.dim).child(text);
    if (!e) return note(`🖼 ${alt || "画像"}（このファイルの外の画像は表示できません）`);
    if (e.loading) return note(`🖼 ${alt || "画像"} を読み込み中…`);
    if (e.error) return note(`🖼 ${alt || "画像"}: ${e.error}`);
    return v_flex().gap(4).max_w_full().when(big, el => el.w_full().items_center()).when(!big, el => el.items_start())
      .child(image(e.src).max_w_full().flex_none())
      .when(Boolean(alt), el => el.child(div().text_size(11).text_color(t.dim).child(alt)));
  }

  // マークダウン内のリンク: 相対パスのファイルはこのビューアで開く。URL は既定どおりブラウザで開く。
  mdLink(url, cx) {
    if (/^[a-z]+:/i.test(url) || url.startsWith("#")) { cx.open_url?.(url); return; }
    const rel = joinRel(this.md?.dir ?? "", decodeURI(url.split("#")[0]));
    if (rel) { this.show(rel, cx); cx.notify(); }
  }

  mdPreview(t, cx) {
    const md = this.md;
    return v_flex().id(`md-${md.path}`).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().px(24).py(16).gap(10).text_size(14)
      .children(md.blocks.map((b, i) => b.kind === "md"
        ? TextView.markdown(`md-${md.path}-${i}`, b.text).selectable(true).on_link_click((url, cx) => this.mdLink(url, cx))
        : this.imageView(b.src ? this.imageFor(b.src, cx) : null, b.alt || b.raw, t)));
  }

  // 色付きトークン（一致部分は背景色）を並べる。
  paint(tokens, t, ranges) {
    return splitHits(tokens, ranges).map((tk) => div().flex_none().whitespace_nowrap().text_color(syntaxColor(tk.k === "punct" ? "operator" : tk.k, t))
      .when(Boolean(tk.hit), (e) => e.rounded(2).bg(t.ansi3 + "55")).child(tk.s));
  }

  maxDx() { return Math.max(0, Math.round((this.lines?.width ?? 0) - ((this.codeViewW ?? 600) - 52))); }
  clampDx() { this.dx = Math.min(this.maxDx(), Math.max(0, Math.round(this.dx || 0))); }

  codeRow(i, t) {
    const L = this.lines, n = i + 1, tg = this.target;
    const hl = tg && n >= tg.from && n <= tg.to;
    const ranges = hl && tg.re ? matchRanges(L.text[i], tg.re) : null;
    return h_flex().w_full().h(20).flex_none().gap(10).when(hl, (e) => e.bg(t.accent + "26"))
      .child(div().w(42).flex_none().text_right().text_color(hl ? t.foreground : t.dim).child(String(n)))
      .child(div().flex_1().min_w(0).h_full().overflow_hidden().relative()
        .child(h_flex().absolute().top(0).h_full().items_center().left(-this.dx).children(this.paint(L.toks[i], t, ranges))));
  }

  codeView(t) {
    const L = this.lines;
    return div().flex_1().min_h(0).min_w(0).relative().pt(6).font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .id("files-code-x").on_size_change((size, cx) => { this.codeViewW = size.width; this.clampDx(); cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        let d = e.delta.x;
        if (!d && e.modifiers?.shift) d = e.delta.y;
        if (!d || Math.abs(d) < Math.abs(e.delta.y) && !e.modifiers?.shift) return;
        const before = this.dx; this.dx -= d; this.clampDx();
        if (this.dx !== before) cx.notify();
      })
      .child(v_virtual_list(`files-code-${L.path}`, L.text.length, 20, (i) => String(i),
        (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(this.codeRow(i, t)); return out; }).track_scroll(this.codeScroll).size_full())
      .child(Scrollbar.vertical(`files-code-${L.path}`).viewport_from_layout().absolute().inset_0());
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), abs = `${this.root}/${path}`;
      const mark = entry.dir ? null : this.marks[abs];
      // フォルダは中の変更をまとめて表示する。
      let add = 0, del = 0, changed = false;
      if (entry.dir) {
        for (const k of Object.keys(this.marks)) if (k.startsWith(abs + "/")) { changed = true; add += this.stats[k]?.add ?? 0; del += this.stats[k]?.del ?? 0; }
      } else if (mark) { changed = true; add = this.stats[abs]?.add ?? 0; del = this.stats[abs]?.del ?? 0; }
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); pathMenu(path, abs, entry.dir, this.ops()); })
        .child(entry.dir ? svg(`mods/ja-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/ja-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(changed, el => el.text_color(mark === "A" ? t.ansi2 : mark === "D" ? t.ansi1 : t.foreground)).child(entry.name))
        .when(add > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi2).when(entry.dir, e => e.opacity(0.75)).child(`+${add}`)))
        .when(del > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi1).when(entry.dir, e => e.opacity(0.75)).child(`\u2212${del}`)))
        .when(entry.dir && changed && !add && !del, el => el.child(div().size(6).rounded(3).flex_none().bg(t.blocked)))
        .when(Boolean(mark), el => el.child(div().w(12).flex_none().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child({ A: "新", D: "削", U: "競", M: "変" }[mark] ?? mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // 一致部分を強調した 1 行。
  marked(text, re, t) {
    const out = []; let last = 0, m, n = 0;
    re.lastIndex = 0;
    while ((m = re.exec(text)) && n++ < 20) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) out.push(div().flex_none().whitespace_nowrap().child(text.slice(last, m.index)));
      out.push(div().flex_none().whitespace_nowrap().rounded(2).bg(t.ansi3 + "55").text_color(t.foreground).child(m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(div().flex_none().whitespace_nowrap().child(text.slice(last)));
    return h_flex().flex_1().min_w(0).overflow_hidden().children(out);
  }

  searchBar(t) {
    const toggle = (id, label, on, tip, click) => div().id(id).h(24).px(7).flex().items_center().flex_none().rounded(5).cursor_pointer().text_size(11)
      .bg(on ? t.accent + "33" : t.background).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.accent : t.border)
      .hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => { click(); this.runSearch(cx, true); }).child(label);
    return v_flex().flex_none().px(8).pt(8).pb(6).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(4)
        .child(div().id("files-search").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(this.searchFocus ? t.accent : t.border)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.query), (el) => el.child(div().id("files-search-clear").w(22).h(28).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("検索をやめる")
          .on_click((_e, cx) => { this.search.set_value(""); this.query = ""; this.runSearch(cx, true); }).child("×"))))
      .child(h_flex().gap(4).items_center()
        .child(toggle("files-mode-name", "ファイル名", this.mode === "name", "ファイル名とパスで探す（あいまい一致）", () => { this.mode = "name"; }))
        .child(toggle("files-mode-text", "内容", this.mode === "text", "ファイルの中の文字列を探す", () => { this.mode = "text"; }))
        .child(div().flex_1())
        .child(toggle("files-opt-case", "Aa", this.opt.case, "大文字と小文字を区別する", () => { this.opt.case = !this.opt.case; }))
        .child(toggle("files-opt-word", "ab", this.opt.word, "単語単位で一致", () => { this.opt.word = !this.opt.word; }))
        .child(toggle("files-opt-regex", ".*", this.opt.regex, "正規表現を使う", () => { this.opt.regex = !this.opt.regex; })));
  }

  resultRows(t) {
    const r = this.results, out = [];
    const status = (text) => div().px(8).py(6).text_size(11).text_color(t.dim).child(text);
    if (this.searchError) return [status(this.searchError)];
    if (!r) return [status(this.searching ? "検索中…" : "")];
    if (r.mode === "name") {
      out.push(status(`${r.total} 件${r.total > r.items.length ? `（先頭 ${r.items.length} 件を表示）` : ""}${this.searching ? "・検索中…" : ""}`));
      for (const { path } of r.items) {
        const i = path.lastIndexOf("/"), name = path.slice(i + 1), dir = i < 0 ? "" : path.slice(0, i);
        out.push(h_flex().id(`found-${path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer().when(this.file === path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .tooltip(path).on_click((_e, cx) => this.show(path, cx)).on_mouse_down("right", () => pathMenu(path, `${this.root}/${path}`, false, this.ops()))
          .child(svg("mods/ja-files/file.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_none().max_w(240).truncate().child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)));
      }
      return out;
    }
    // 日本語版: ファイルごとに畳める。全部まとめて開閉もできる。
    const allClosed = r.files.length > 0 && r.files.every(([p]) => this.hitClosed.has(p));
    out.push(h_flex().items_center().child(div().flex_1().child(status(`${r.total} 件・${r.files.length} ファイル${r.total > 2000 ? "（先頭 2,000 件を表示）" : ""}${this.searching ? "・検索中…" : ""}`)))
      .when(r.files.length > 1, (e) => e.child(div().id("hits-toggle-all").px(6).py(1).mr(4).rounded(5).cursor_pointer().text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (allClosed) this.hitClosed.clear(); else for (const [p] of r.files) this.hitClosed.add(p); cx.notify(); })
        .child(allClosed ? "すべて開く" : "すべて閉じる"))));
    for (const [path, hits] of r.files) {
      const i = path.lastIndexOf("/"), name = path.slice(i + 1), dir = i < 0 ? "" : path.slice(0, i), shut = this.hitClosed.has(path);
      out.push(h_flex().id(`hitfile-${path}`).h(26).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(path).on_mouse_down("right", () => pathMenu(path, `${this.root}/${path}`, false, this.ops()))
        .on_click((_e, cx) => { if (shut) this.hitClosed.delete(path); else this.hitClosed.add(path); cx.notify(); })
        .child(svg(`mods/ja-files/chevron-${shut ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(svg("mods/ja-files/file.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_none().max_w(220).truncate().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
        .child(div().flex_none().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(hits.length))));
      if (shut) continue;
      const lang = langOf(path);
      for (const h of hits) out.push(h_flex().id(`hit-${path}:${h.line}`).h(22).flex_none().pl(28).pr(8).gap(8).items_center().rounded(5).cursor_pointer()
        .when(this.file === path && this.target?.from === h.line, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.show(path, cx, { from: h.line, to: h.line, re: r.re }))
        .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(String(h.line)))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .children((() => { const s = untab(h.text).trim(); return this.paint(tokenize(s, lang, { block: false }), t, matchRanges(s, r.re)); })())));
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key || this.stale) this.refresh(cx);
    this.takeOp(cx);
    if (shown("files")) {
      watchSelection(this, cx, (ref, cx) => this.jumpFile(ref, cx));
      const j = shared("ja-jump");
      if (j?.at > this.jumpSeen) { this.jumpSeen = j.at; if (Date.now() - j.at < 5000) this.jumpFile(j, cx); }
    } else this.selKey = selectionKey();
    const t = theme();
    const overlay = props()?.overlay, modal = Boolean(overlay) || Boolean(props()?.wide);
    const searching = Boolean(this.query.trim());
    const tree = searching ? v_flex().id("files-found").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.resultRows(t)) : v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).on_mouse_down("right", () => { if (this.root) pathMenu("", this.root, true, this.ops()); }).children(this.rows("", 0, [], t))
      .when(!searching && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "ファイルを読み込み中…" : this.root ? "ファイルがありません" : "フォルダがありません"))))
      .when(!searching && this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("表示はフォルダごとに 500 件、合計 5,000 件までです")));
    // 日本語版: 表示の切り替え。マークダウンは「プレビュー」、ほかは色付きの「コード」が既定。「選択」は文字を選んでコピーできる表示。
    const select = this.viewMode === "select", rendered = Boolean(this.md) && this.mdView !== "source" && !this.target && !select;
    const preview = () => this.img ? v_flex().id(`img-${this.img.path}`).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(16).items_center().child(this.imageView(this.imageFor(this.img.path, cx), null, t, true))
      : rendered ? this.mdPreview(t, cx)
      : select && this.code ? Editor.new(this.code).flex_1().min_h(0).min_w(0)
      : this.lines ? this.codeView(t) : div().flex_1().p(12).text_color(t.dim).child(this.fileError || "ファイルを読み込み中…");
    const modes = [...(this.md ? [["preview", "プレビュー"]] : []), ["source", "コード"], ["select", "選択"]];
    const current = select ? "select" : rendered ? "preview" : "source";
    const viewToggle = h_flex().flex_none().gap(2).p(2).rounded(6).bg(t.raised).text_size(11)
      .children(modes.map(([id, label]) => {
        const on = id === current;
        return div().id(`view-mode-${id}`).px(7).py(2).rounded(4).cursor_pointer().bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover))
          .tooltip(id === "select" ? "文字を選択してコピーできる表示（色は付きません）" : id === "source" ? "色付きのコード" : "整形して表示")
          .on_click((_e, cx) => {
            this.viewMode = id === "select" ? "select" : "color";
            if (id === "select" && this.lines) this.makeEditor(this.lines.path);
            if (id !== "select") this.mdView = id;
            if (id === "preview") this.target = null;
            cx.notify();
          }).child(label);
      }));
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(!modal && Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
      .child(div().font_semibold().child("ファイル"))
      .when(modal, el => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.root ?? "")))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ? this.file + (this.target ? `:${this.target.from}${this.target.to > this.target.from ? "-" + this.target.to : ""}` : "") : (modal ? "" : this.root?.split(/[\\/]/).pop() ?? "")))
      .when(Boolean(this.lines), el => el.child(viewToggle))
      .when(Boolean(overlay), el => el.child(div().id("files-close").ml(6).px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover)).tooltip("閉じる (Esc)").on_click(() => closeOverlay(overlay)).child("×")));
    const sp = splitter(this, "files-split", 380, t);
    return v_flex().id("files").size_full().min_h(0).when(!overlay, el => el.rounded(10).border_1()).overflow_hidden().bg(t.background).border_color(t.border).text_color(t.foreground).text_size(13)
      .child(header)
      .when(modal, el => el.child(sp.track(h_flex().id("files-split").flex_1().min_h(0))
        .child(v_flex().w(sp.width).h_full().flex_none().child(this.searchBar(t)).child(tree)).child(sp.handle)
        .child(this.file ? v_flex().flex_1().min_w(0).h_full().child(preview()) : div().flex_1().p(12).text_color(t.dim).child("ファイルを選ぶと中身を表示します"))))
      .when(!modal && !this.file, el => el.child(this.searchBar(t)).child(tree))
      .when(!modal && Boolean(this.file), el => el.child(preview()));
  }
}
