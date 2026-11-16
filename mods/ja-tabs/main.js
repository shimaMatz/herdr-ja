import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
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

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // keys.json の "ja-tabs.<command>" をここで受ける（F2 などを日本語ダイアログにするため）。
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "rename_tab") jaAsk("tab.rename");
        else if (c === "rename_space") jaAsk("space.rename");
        else if (c === "close_tab") { if (!jaAsk("tab.close")) run("tab.close"); }
        else if (c === "close_space") jaAsk("space.close");
      }
    });
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "ターミナル" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) jaAsk("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "ja-menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); if (!jaAsk("tab.close", { id: c.id })) run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // 日本語版: ファイル・変更パネルのボタンは常に表示する。
    const enabled = ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    // 日本語版: ワークツリー表示中（wt-panel が開いている）は、ボタンはそちらを切り替える。
    const wt = find(root, "wt-panel"), wtBody = find(root, "wt-panel-body"), wtOpen = Boolean(wt && !wt.hidden);
    const panelButton = (id, label, icon) => {
      const on = wtOpen ? wtBody?.active === `wt-${id}` : panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (wtOpen) {
            if (on) run("layout.hide", { id: "wt-panel" });
            else run("layout.select", { stack: "wt-panel-body", child: `wt-${id}` });
          } else if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+",  () => openOverlay({ mod: "ja-new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "ファイル", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "変更", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/ja-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/ja-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/ja-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
