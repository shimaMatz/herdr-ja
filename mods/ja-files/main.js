// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, props, closeOverlay, layout, shared, terminals } from "herdr";

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
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
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
    this.saved = new Map();
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
    cx.timer.every(400, (cx) => { if (shown("files")) watchSelection(this, cx, (ref, cx) => this.jumpFile(ref, cx)); });
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
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "このファイルはもうありません"; return; }
        if (text.includes("\0")) { this.fileError = "バイナリファイルのためプレビューできません"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n…（以下省略）" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        if (target) { cx.notify(); await this.reveal(text, target, cx); }
      } catch { if (this.file === path && this.current(context)) this.fileError = "このファイルはプレビューできません（バイナリ・大きすぎる・読めない）"; }
      finally { cx.notify(); }
    });
  }

  // 行（と一致した文字列）を選択して、そこまでスクロールさせる。
  async reveal(text, target, cx) {
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
          .tooltip(path).on_click((_e, cx) => this.show(path, cx))
          .child(svg("mods/ja-files/file.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_none().max_w(240).truncate().child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)));
      }
      return out;
    }
    out.push(status(`${r.total} 件・${r.files.length} ファイル${r.total > 2000 ? "（先頭 2,000 件を表示）" : ""}${this.searching ? "・検索中…" : ""}`));
    for (const [path, hits] of r.files) {
      const i = path.lastIndexOf("/"), name = path.slice(i + 1), dir = i < 0 ? "" : path.slice(0, i);
      out.push(h_flex().id(`hitfile-${path}`).h(26).flex_none().px(8).gap(7).items_center().tooltip(path)
        .child(svg("mods/ja-files/file.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_none().max_w(220).truncate().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
        .child(div().flex_none().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(hits.length))));
      for (const h of hits) out.push(h_flex().id(`hit-${path}:${h.line}`).h(22).flex_none().pl(28).pr(8).gap(8).items_center().rounded(5).cursor_pointer()
        .when(this.file === path && this.target?.from === h.line, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.show(path, cx, { from: h.line, to: h.line, re: r.re }))
        .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(String(h.line)))
        .child(div().flex_1().min_w(0).overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).child(this.marked(h.text.trim(), r.re, t))));
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key || this.stale) this.refresh(cx);
    if (shown("files")) {
      watchSelection(this, cx, (ref, cx) => this.jumpFile(ref, cx));
      const j = shared("ja-jump");
      if (j?.at > this.jumpSeen) { this.jumpSeen = j.at; if (Date.now() - j.at < 5000) this.jumpFile(j, cx); }
    } else this.selKey = selectionKey();
    const t = theme();
    const overlay = props()?.overlay, modal = Boolean(overlay) || Boolean(props()?.wide);
    const searching = Boolean(this.query.trim());
    const tree = searching ? v_flex().id("files-found").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.resultRows(t)) : v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
      .when(!searching && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "ファイルを読み込み中…" : this.root ? "ファイルがありません" : "フォルダがありません"))))
      .when(!searching && this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("表示はフォルダごとに 500 件、合計 5,000 件までです")));
    const preview = () => this.code ? Editor.new(this.code).flex_1().min_h(0).min_w(0) : div().flex_1().p(12).text_color(t.dim).child(this.fileError || "ファイルを読み込み中…");
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(!modal && Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
      .child(div().font_semibold().child("ファイル"))
      .when(modal, el => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.root ?? "")))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ? this.file + (this.target ? `:${this.target.from}${this.target.to > this.target.from ? "-" + this.target.to : ""}` : "") : (modal ? "" : this.root?.split(/[\\/]/).pop() ?? "")))
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
