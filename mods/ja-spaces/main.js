// スペース一覧（日本語版）。shipped の spaces を複製して改造したもの。
// - スペースは並べ替え・入れ子をせず、そのままの順で並べる。
// - フォーカス中のスペースの下にだけ、そのリポジトリの git worktree を階層で表示する。
//   各 worktree には未コミットの +追加/−削除 行数と新規ファイル数を出す。
//   クリックでその worktree のタブへ（なければ新しいタブを開く）、× で削除、末尾の行で追加。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, focused, run, openOverlay, exec as rawExec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

// git を同時にいくつも起こすと、配下にリポジトリが多いフォルダ（数十個）で
// アプリのファイル上限（GUI 起動だと 256）を超え "Too many open files" になる。
// このファイルの exec はすべてここを通し、同時に動くのを EXEC_LIMIT 個までにする。
const EXEC_LIMIT = 8;
let execRunning = 0;
const execWaiting = [];
const exec = (...args) => new Promise((ok) => { if (execRunning < EXEC_LIMIT) { execRunning++; ok(); } else execWaiting.push(ok); })
  .then(() => rawExec(...args))
  .finally(() => { const next = execWaiting.shift(); if (next) next(); else execRunning--; });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Reads that write nothing under .git (no index lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
// The checkout a folder is in (the deepest one wins: a worktree may sit inside the main checkout).
const ownerOf = (list, cwd) => cwd ? list.filter((c) => inside(cwd, c.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null : null;
// How often the shown space's worktrees are looked at again while the window is in front.
const TREE_EVERY = 3000;
// How often the space's folder is searched again for repos below it (3 levels deep).
const SCAN_EVERY = 30000;
// At most this many repos found below a space are listed.
const MAX_NESTED = 10;
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
const STATES = { asleep: "スリープ中", unreachable: "接続不可", needs_login: "要ログイン", connecting: "接続中", connected: "接続中" };
const stateJa = (state) => STATES[state ?? "asleep"] ?? String(state).replace(/_/g, " ");

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// 日本語版: スペース/ワークツリーを開いたら、ファイル/変更を左（メイン側）に出してチャットを右端へ寄せる。
function showWide() {
  run("layout.hide", { id: "panel" });
  run("layout.select", { stack: "wt-panel-body", child: "wt-files" });
  run("layout.show", { id: "wt-panel" });
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    this.trees = {}; // where() -> { groups: [{ common, name, mainPath, outer, list: [{ path, branch, main, add, del, untracked }] }], at }
    this.scans = {}; // where() -> { outer, nested: [common dirs], at }
    this.treeLoading = new Set();
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    this.refreshTrees(now, sp, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "接続できませんでした。");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          for (const tree of Object.values(this.trees)) if (tree.groups?.some((g) => g.common === repo)) tree.at = 0;
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "ja-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in the order they are (no nesting, no automatic moves).
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    return sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null, tree: null })).filter((r) => this.shown.has(r.w.id));
  }

  // フォーカス中のスペースのリポジトリ群: スペースの場所を含むリポジトリと、その配下（3階層まで）にあるリポジトリ。
  // たとえば「外側のフォルダ（コミットなしのリポジトリ）の中に本体リポジトリがある」構成に対応する。
  refreshTrees(now, sp, cx) {
    const active = sp.find((s) => s.active);
    if (!active) return;
    const ps = panes();
    const key = where(active, ps);
    if (!JSON.parse(key)[1] || this.treeLoading.has(key)) return;
    const known = this.trees[key];
    if (known && (now - known.at < TREE_EVERY || !window().active)) return;
    const cwd = ps.find((p) => p.focused)?.cwd ?? null;
    this.treeLoading.add(key);
    cx.spawn(async (cx) => {
      try { this.trees[key] = { groups: await this.repoGroups(key, cwd), at: Date.now() }; }
      catch (e) { this.trees[key] = { groups: known?.groups ?? [], at: Date.now(), error: String(e.message ?? e) }; }
      finally { this.treeLoading.delete(key); cx.notify(); }
    });
  }

  async repoGroups(key, cwd) {
    const [on, root] = JSON.parse(key);
    const commonOf = async (dir) => {
      const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, on }).catch(() => null);
      return r?.code === 0 ? r.stdout.replace(/\n$/, "") : null;
    };
    let scan = this.scans[key];
    if (!scan || Date.now() - scan.at > SCAN_EVERY) {
      const outer = await commonOf(root);
      // .git はフォルダ（本体）でもファイル（worktree）でも拾い、どちらも本体の common dir にまとめる。
      const found = await exec("find", [root, "-maxdepth", "3", "(", "-name", "node_modules", "-o", "-name", "Library", "-o", "-name", ".Trash", ")", "-prune", "-o", "-name", ".git", "-print"], { on, timeout: 5000 }).catch(() => null);
      const dirs = (found?.stdout ?? "").split("\n").filter(Boolean).map((p) => p.replace(/\/\.git$/, "")).filter((d) => d !== root);
      const nested = [...new Set((await Promise.all(dirs.map(commonOf))).filter(Boolean))].filter((c) => c !== outer);
      scan = this.scans[key] = { outer, nested, at: Date.now() };
    }
    // フォーカス中のペインがいるリポジトリは、worktree が無くても出す（そこに追加できるように）。
    const here = cwd && inside(cwd, root) ? await commonOf(cwd) : null;
    const commons = [...new Set([scan.outer, ...scan.nested, here].filter(Boolean))];
    const groups = await Promise.all(commons.map(async (common) => {
      const mainPath = common.endsWith("/.git") ? common.slice(0, -5) : common;
      const outer = common === scan.outer;
      const head = await exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: mainPath, on }).catch(() => null);
      if (head?.code !== 0) return null; // コミットの無いリポジトリは worktree を作れないので出さない
      const list = await this.checkouts(common, on);
      if (!outer && list.length < 2 && common !== here) return null; // 配下のリポジトリは worktree があるものだけ
      return { common, name: base(mainPath), mainPath, outer, list };
    }));
    const kept = groups.filter(Boolean);
    return [...kept.filter((g) => g.outer), ...kept.filter((g) => !g.outer).sort((a, b) => a.mainPath.localeCompare(b.mainPath)).slice(0, MAX_NESTED)];
  }

  async checkouts(common, on) {
    const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
    const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main, on });
    if (r.code !== 0) throw new Error(r.stderr || "git worktree list に失敗しました");
    const list = [];
    for (const block of r.stdout.split(/\n\n+/)) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path || lines.some((l) => l === "bare")) continue;
      const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
      list.push({ path, branch, main: list.length === 0, prunable: lines.some((l) => l.startsWith("prunable")), add: 0, del: 0, files: 0, untracked: 0 });
    }
    await Promise.all(list.filter((c) => !c.prunable).map(async (c) => {
      const [num, fresh] = await Promise.all([
        exec("git", [...READ, "diff", "HEAD", "--numstat", "-z", "--no-renames"], { cwd: c.path, on }),
        exec("git", [...READ, "ls-files", "--others", "--exclude-standard", "-z"], { cwd: c.path, on }),
      ]);
      if (num.code === 0) for (const entry of num.stdout.split("\0")) {
        const [a, d, ...rest] = entry.split("\t");
        if (!rest.length) continue;
        c.add += Number(a) || 0; c.del += Number(d) || 0; c.files++;
      }
      if (fresh.code === 0) c.untracked = fresh.stdout.split("\0").filter(Boolean).length;
    }));
    return list;
  }

  // Go to a checkout: the space's tab already working in it, else a new tab there.
  // あわせて右の「ファイル」の欄を出す。欄はフォーカス中のターミナルのフォルダ（この worktree）を見せる。
  openTree(w, c, list) {
    showWide();
    const ps = panes();
    const mine = (tab) => ps.some((p) => p.tab === tab.id && p.cwd && ownerOf(list, p.cwd)?.path === c.path);
    const tabs = w.tabs ?? [];
    const tab = tabs.find((tb) => tb.active && mine(tb)) ?? tabs.find(mine);
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { space: w.id, folder: c.path, ...(c.branch ? { name: c.branch } : {}) });
  }

  worktreeRows({ w }, t) {
    const key = where(w, panes());
    if (!JSON.parse(key)[1]) return [];
    const data = this.trees[key];
    if (!data) return [h_flex().h(24).flex_none().ml(14).pl(6).items_center().text_size(11.5).text_color(t.dim).child("ワークツリーを読み込み中…")];
    const all = data.groups.flatMap((g) => g.list);
    const cwd = panes().find((p) => p.focused)?.cwd ?? focused()?.cwd ?? null;
    const here = ownerOf(all, cwd);
    // リポジトリが 1 つでスペースの場所そのものなら見出しは省く。それ以外はリポジトリ名の見出しを付ける。
    const headed = data.groups.length > 1 || data.groups.some((g) => !g.outer);
    const indent = headed ? 26 : 14;
    const out = [];
    data.groups.forEach((g, gi) => {
      if (headed) out.push(h_flex().id(`wt-repo-${w.id}-${gi}`).h(22).flex_none().ml(14).pl(6).gap(6).items_center()
        .text_size(11).text_color(t.dim).tooltip(g.mainPath)
        .child(svg("mods/workspace-chrome/folder.svg").size(11).flex_none())
        .child(div().min_w(0).truncate().child(g.name)));
      for (const c of g.list) out.push(this.treeRow(w, c, here?.path === c.path, all, t, indent));
      out.push(h_flex().id(`wt-add-${w.id}-${gi}`).h(24).flex_none().ml(indent).pl(6).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
        .text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "ja-worktree", kind: "dialog", width: 460, height: 280, props: { space: w.id, folder: g.mainPath, action: "new" } }); })
        .child(div().w(10).flex_none().text_color(t.border).child("└"))
        .child(svg("mods/workspace-chrome/plus.svg").size(11).flex_none())
        .child("ワークツリーを追加"));
    });
    if (data.error) out.push(div().ml(20).text_size(11).text_color(t.blocked).truncate().child(data.error));
    return out;
  }

  treeRow(w, c, current, list, t, indent = 14) {
    const id = `wt-${w.id}-${c.path}`;
    const tip = [c.path, c.files || c.untracked ? `変更 ${c.files} ファイル（+${c.add} −${c.del}）・新規 ${c.untracked} ファイル` : "変更なし"].join("\n");
    return h_flex().id(id).h(26).flex_none().ml(indent).pl(6).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
      .when(current, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openTree(w, c, list); })
      .child(div().w(10).flex_none().text_color(t.border).child("├"))
      .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(current ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(current ? t.foreground : t.muted).child(c.branch ?? "(detached)"))
      .when(c.main, (el) => el.child(div().flex_none().px(4).rounded(3).border_1().border_color(t.border).text_size(9.5).text_color(t.dim).child("メイン")))
      .when(c.prunable, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child("見つかりません")))
      .when(c.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${c.add}`)))
      .when(c.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`\u2212${c.del}`)))
      .when(c.untracked > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`新${c.untracked}`)))
      .when(!c.main, (el) => el.child(div().id(`${id}-rm`).flex_none().size(18).rounded(4).flex().items_center().justify_center()
        .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.blocked)).tooltip("このワークツリーを削除")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "ja-worktree", kind: "dialog", width: 460, height: 280, props: { space: w.id, folder: c.path, action: "remove" } }); })
        .child(svg("mods/workspace-chrome/x.svg").size(11))));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : [this.row(r, t), ...(r.w.active ? this.worktreeRows(r, t) : [])]);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "読み込み中…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} はログインが必要です: ${login} を実行してください。クリックでコピー。` : m ? `${m} · ${connected ? "接続中" : stateJa(machine?.state)}` : "このコンピュータ"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "このコンピュータ"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child(stateJa(machine?.state))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "再構築済み ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "このマシンは再構築または置き換えられました。クリックで新しいマシンに接続します。")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "接続中…" : "接続"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`${m ?? "このコンピュータ"} に新しいスペース`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("ここに新しいスペース"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("ログインが必要です。実行:"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "コピーしました" : "コピー")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) { showWide(); run("space.select", { id: w.id }); }
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => { showWide(); run("space.select", { id: w.id }); })
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("スペース"))
        .child(div().id("space-new").tooltip("新しいスペース").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
