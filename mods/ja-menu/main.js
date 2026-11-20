// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, notify } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["右に分割", "pane.split", { direction: "right", pane: tg.pane }],
              ["下に分割", "pane.split", { direction: "down", pane: tg.pane }],
              ["ズーム", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Herdr の右クリックメニューを使う", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["右クリックをペインに送る", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`${parent.name || parent.address} の下に戻す`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["ペインを閉じる", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["名前を変更", "tab.rename", { id: tg.id }],
        ["新規タブ", "tab.new", { space: tg.space }],
        ["閉じる", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["名前を変更", "space.rename", { id: tg.id }],
        ...(git ? [["新規ワークツリー", "worktree", { space: tg.id, action: "new" }], ["ワークツリーを開く", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["ワークツリーを削除", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["閉じる", "space.close", { id: tg.id }],
      ];
    // 日本語版: ファイル・変更の行の右クリック。target { rel, abs, dir?, ops? }。ops はファイル操作の宛先（ja-files の uid ほか）。
    case "path": {
      const op = (label, kind) => [label, "fileop", { op: kind, rel: tg.rel, dir: Boolean(tg.dir), ...tg.ops }];
      return [
        ...(tg.rel ? [["相対パスをコピー", "copy", { text: tg.rel }]] : []),
        ["絶対パスをコピー", "copy", { text: tg.abs }],
        ...(tg.ops && tg.dir ? [op("新しいファイル", "newfile"), op("新しいフォルダ", "newdir")] : []),
        ...(tg.ops && tg.rel ? [op("名前を変更", "rename"), op("削除", "delete")] : []),
      ];
    }
    default:
      return [
        ["新規スペース", "space.new", {}],
        ["キー操作", "app.help", {}],
        ["テーマ: graphite", "app.theme", { name: "graphite" }],
        ["テーマ: ink", "app.theme", { name: "ink" }],
        ["テーマ: moss", "app.theme", { name: "moss" }],
        ["テーマ: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

// 日本語版: 名前変更・閉じる確認をアプリ標準（英語）のダイアログではなく ja-prompt / ja-confirm で出す。
// 自分で扱った場合は true。
function jaAsk(name, args = {}) {
  const all = spaces();
  const spaceOfTab = (id) => all.find((s) => (s.tabs ?? []).some((tb) => tb.id === id));
  const tabById = (id) => spaceOfTab(id)?.tabs.find((tb) => tb.id === id);
  const activeTab = () => all.find((s) => s.active)?.tabs?.find((tb) => tb.active);
  if (name === "space.rename" && args.name === undefined) {
    const sp = all.find((s) => s.id === args.id) ?? all.find((s) => s.active);
    if (!sp) return false;
    openOverlay({ mod: "ja-prompt", kind: "dialog", width: 380, props: { title: "スペース名を変更", hint: "空にすると、いる場所の名前に戻ります", value: sp.named ? sp.name : "", command: { name, args: { id: sp.id } } } });
    return true;
  }
  if (name === "tab.rename" && args.name === undefined) {
    const tb = args.id ? tabById(args.id) : activeTab();
    if (!tb) return false;
    openOverlay({ mod: "ja-prompt", kind: "dialog", width: 380, props: { title: "タブ名を変更", hint: "空にすると番号の名前に戻ります", value: tb.named ? tb.name : "", command: { name, args: { id: tb.id } } } });
    return true;
  }
  if (name === "space.close" && !args.confirmed) {
    const sp = all.find((s) => s.id === args.id) ?? all.find((s) => s.active);
    if (!sp) return false;
    openOverlay({ mod: "ja-confirm", kind: "dialog", width: 400, height: 180, props: { title: "スペースを閉じますか？", detail: `「${sp.name}」のターミナルとエージェントをすべて終了します。`, command: { name, args: { id: sp.id, confirmed: true } } } });
    return true;
  }
  if (name === "tab.close" && !args.confirmed) {
    const tb = args.id ? tabById(args.id) : activeTab();
    const sp = tb && spaceOfTab(tb.id);
    if (!sp || (sp.tabs ?? []).length > 1) return false;
    openOverlay({ mod: "ja-confirm", kind: "dialog", width: 400, height: 180, props: { title: "最後のタブを閉じますか？", detail: `スペース「${sp.name}」も閉じ、ターミナルを終了します。`, command: { name, args: { id: tb.id, confirmed: true } } } });
    return true;
  }
  return false;
}

// 日本語版: ファイル操作。名前の入力・削除の確認を出し、決まったら共有の値 ja-fileop で ja-files に渡す。
function fileOp(a) {
  const name = a.rel.split("/").pop(), shared = "ja-fileop";
  if (a.op === "delete") {
    openOverlay({ mod: "ja-confirm", kind: "dialog", width: 420, height: 190, props: { title: `${a.dir ? "フォルダ" : "ファイル"}を削除しますか？`, yes: a.on ? "削除" : "ゴミ箱に移動",
      detail: `${a.rel}${a.dir ? "（中身ごと）" : ""}を${a.on ? "削除します。元に戻せません。" : "ゴミ箱に移動します。"}`, command: { shared, args: a } } });
    return;
  }
  const title = { newfile: "新しいファイル", newdir: "新しいフォルダ", rename: "名前を変更" }[a.op];
  const where = a.op === "rename" ? (a.rel.includes("/") ? a.rel.slice(0, a.rel.lastIndexOf("/")) : "") : a.rel;
  openOverlay({ mod: "ja-prompt", kind: "dialog", width: 420, props: { title, ok: a.op === "rename" ? "変更" : "作成", value: a.op === "rename" ? name : "",
    hint: `場所: ${where || "（いちばん上）"}${a.op === "newfile" ? "　「a/b.txt」のようにフォルダごと作れます" : ""}`, command: { shared, args: a } } });
}

function menuIcon(command) {
  if (command === "copy") return "mods/workspace-chrome/files.svg";
  if (command === "fileop") return null;
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "fileop") { fileOp(it[2]); return; }
    if (it[1] === "copy") { cx.write_to_clipboard(it[2].text); notify({ title: "コピーしました", body: it[2].text, level: "success", timeout: 2500 }); return; }
    if (it[1] === "worktree") openOverlay({ mod: "ja-worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (!jaAsk(it[1], it[2])) run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && ((it[1] === "fileop" && list[i - 1][1] !== "fileop") || it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(menuIcon(it[1]) ? svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted) : div().w(14).flex_none())
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
