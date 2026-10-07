// Display only: the child's identity and tools above its editor (Ctrl+J expands the tool list).
// Adapted from the former subagent-done.ts widget (pi-herdr-subagents, MIT).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export function installIdentityWidget(
  pi: ExtensionAPI,
  identity: () => { label?: string; denied: string[] } | undefined,
): { show(ctx: { hasUI?: boolean; ui: { setWidget: Function } }): void } {
  let expanded = false;
  let lastCtx: { hasUI?: boolean; ui: { setWidget: Function } } | undefined;
  const render = () => {
    const ctx = lastCtx;
    const info = identity();
    if (!ctx?.hasUI || !info) return;
    const tools = pi.getActiveTools().slice().sort();
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
        const tag = info.label ? theme.bold(theme.fg("accent", `[${info.label}]`)) : "";
        const denied = info.denied;
        let content: string;
        if (expanded) {
          const list = tools.map((name) => theme.fg("dim", name)).join(theme.fg("muted", ", "));
          const deniedLine = denied.length
            ? "\n" + theme.fg("muted", "denied: ") + denied.map((name) => theme.fg("error", name)).join(theme.fg("muted", ", "))
            : "";
          content = `${tag}${theme.fg("dim", ` — ${tools.length} available`)}${theme.fg("muted", "  (Ctrl+J to collapse)")}\n${list}${deniedLine}`;
        } else {
          const deniedInfo = denied.length ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`) : "";
          content = `${tag}${theme.fg("dim", ` — ${tools.length} tools`)}${deniedInfo}${theme.fg("muted", "  (Ctrl+J to expand)")}`;
        }
        box.addChild(new Text(content, 0, 0));
        return box;
      },
      { placement: "aboveEditor" },
    );
  };
  pi.registerShortcut("ctrl+j", {
    description: "Toggle the agent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      lastCtx = ctx as any;
      render();
    },
  });
  return {
    show(ctx) {
      lastCtx = ctx;
      render();
    },
  };
}
