# Status panel

A box above the editor that summarises running work. Two sources feed it:

- **This extension**, with `PI_SUBAGENT_SURFACE=panel`: its own subagents. Worktree slots become a grid of items, other agents one row each.
- **Any other extension**, in every surface: a panel it supplies through `pi.events`.

The renderer (`runtime/panel.ts`, `renderPanel(data, width, theme): string[]`) is pure: every line is exactly `width` columns and everything shown comes from the data.

## Supplying a panel

```ts
pi.events.emit("subagents:panel", { source: "my-tool", data });   // add or replace
pi.events.emit("subagents:panel", { source: "my-tool", data: null }); // remove
pi.events.on("subagents:ready", ({ agents }) => sendAgain());     // emitted at session start with snapshot
```

- `source` identifies the provider; each source has one panel and panels are shown in the order they first arrived.
- Send again whenever your state changes; the extension does not poll you. Malformed data is ignored.
- If your extension may load before this one, resend on `subagents:ready`. The event carries `{ agents: { id, name, agent, group }[] }` of currently running subagents.
- **Liveness rule**: A panel naming subagents (via `group` or `subagent: "<name>"`) is shown **only** while at least one of those subagents is alive, while `data.attention` is true (e.g. waiting for human answer), or within `data.linger` ms after the last subagent ends. A panel naming no subagents is static and shown as long as the provider keeps it.
- **One unified box**: Any running subagent that is not claimed by a panel item is automatically folded into the panel as a trailing item or group, so only a single box is displayed.
- Subagents named on items or rows take live state dots and flags (`?40s` waiting, `⚠12m` stalled) and get the `▸` marker when selected with `/subagent` or `Ctrl+Alt+X`.

## Data

```ts
interface PanelData {
  icon?: string; label?: string;   // top bar brand, default "⧉" "Subagents"
  title?: string; phase?: string;  // "│ <title> │ phase <phase>" segments, each optional
  done?: number; total?: number;   // progress ▰▱ done/total, only with total > 0
  group?: string;                  // claims all subagents started with this group
  attention?: boolean;             // keep visible without live subagents (e.g. human question)
  linger?: number;                 // ms to stay visible after last subagent ends
  rows?: PanelRow[];               // free rows; when present they are the whole body
  columns?: PanelColumn[];         // stage columns shared by every item
  legend?: { mark: string; color?: Color; label: string }[]; // after the column legend
  groups?: { name: string; status: "active" | "queued" | "completed"; note?: string; items: PanelItem[] }[];
  compact?: boolean; items?: PanelItem[]; // compact: items in pairs, no legend nor group headers
  detail?: { branch?: string; status?: string }; // row under the grid
  hint?: string;                   // right-aligned on the detail row
}
interface PanelRow { icon: string; iconColor: Color; label: string; text: string; extra?: string; subagent?: string;
  waitingText?: string } // shown instead of text while that subagent waits for the user
interface PanelColumn {
  key: string; header: string;     // header glyph, e.g. "B"
  legend?: string;                 // e.g. "build"; columns without it stay out of the legend
  width?: number;                  // default the header width
  glyphs?: { done?: string; active?: string; pending?: string }; // defaults ✓ ▶ ·
}
interface PanelItem {
  id: string; name: string;
  dot: "success" | "accent" | "error" | "warning" | "muted";
  marks?: Record<string, "done" | "active" | "pending" | { text: string; color?: Color }>; // missing = pending
  text?: string;                   // shown instead of marks when there are no columns
  flag?: string;                   // "?40s" bold warning (waits for an answer), anything else error ("⚠12m")
  selected?: boolean; subagent?: string;
}
// Color: "accent" | "success" | "error" | "warning" | "muted" | "text" | "dim"
```

Items are laid out two per line. Group notes default to `attiva`, `in coda`, `completata`.

## Example: a staged workflow

```ts
const data = {
  icon: "⛟", label: "Pipeline", title: "release-42", phase: "foundation", done: 2, total: 6,
  columns: [
    { key: "build", header: "B", legend: "build" },
    { key: "review", header: "R", legend: "review" },
    { key: "fix", header: "C", legend: "correction", width: 2 },
    { key: "gate", header: "☑", legend: "checkpoint", glyphs: { done: "☑", pending: "☐" } },
  ],
  legend: [{ mark: "●", color: "error", label: "stalled" }],
  groups: [{ name: "foundation", status: "active", items: [
    { id: "t1", name: "fix-core-lock", dot: "success", marks: { build: "done", review: "done", gate: "done" } },
    { id: "t2", name: "feat-run-control", dot: "warning", subagent: "feat-run-control",
      marks: { build: "done", review: "active", fix: { text: "↺2", color: "warning" } }, flag: "?40s" },
  ] }],
};
```

```text
╭─ ⛟  Pipeline │ release-42 │ phase foundation ───────────────────────────── ▰▰▱▱▱▱ 2/6 ─╮
│ B build · R review · C correction · ☑ checkpoint · ● stalled                           │
│ ▾ foundation ● attiva  B R C  ☑            │                      B R C  ☑             │
│   ● fix-core-lock      ✓ ✓ ·  ☑            │ ● feat-run-control   ✓ ▶ ↺2 ☐ ?40s        │
```
