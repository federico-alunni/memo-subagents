#!/usr/bin/env bash
# Static mockup of step 1: read-only mirror of a child running in a Herdr worktree space,
# plus delegated handoff (`subagent({ handoff: "wait" | "replace" })`) inside that space.
# Usage: bash scripts/preview/mirror-preview.sh            (total width 160, mirror 50%)
#        W=200 R=0.4 bash scripts/preview/mirror-preview.sh
#        ONLY=D bash scripts/preview/mirror-preview.sh     (one scenario: A..F)
# Mirror colors: pi cursor-dark theme tokens used by the issue #86 preview.
# Widget colors: the widget's own accents (index.ts ACTIVE/OPEN/ATTENTION_ACCENT).
# Mirror header: <slot name> │ <active agent> │ ⎇ <branch> ─── <active agent elapsed>.
# Widget row: slot elapsed, chain A › B, status of the slot.
# Nothing here talks to Herdr.
exec python3 - "${W:-160}" "${R:-0.5}" "${ONLY:-}" <<'PY'
import re, sys
W, RATIO, ONLY = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
def fg(h): h = h.lstrip('#'); return f"\x1b[38;2;{int(h[0:2],16)};{int(h[2:4],16)};{int(h[4:6],16)}m"
B, I, R0 = "\x1b[1m", "\x1b[3m", "\x1b[0m"
ACC, SUC, ERR, WRN, MUT, TXT = fg("ebcb8b"), fg("87bfd0"), fg("be616a"), fg("ebcb8b"), fg("4f4f4f"), fg("ffffff")
W_ACTIVE, W_OPEN, W_ATTN = fg("4da3ff"), fg("d69e2e"), fg("d65cd6")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
def vis(s): return len(ANSI.sub("", s))
def pad(s, n): return s + " " * max(0, n - vis(s))
def cut(s, n):  # autowrap off: truncate on the right, never wrap
    out, w = "", 0
    for tok in re.split(r"(\x1b\[[0-9;]*m)", s):
        if ANSI.fullmatch(tok or "x"): out += tok; continue
        for ch in tok:
            if w >= n: return out + R0
            out += ch; w += 1
    return out

MW = int(W * RATIO); LW = W - MW - 1
ROWS = 18

# ---------------------------------------------------------------- child screens (what `pane read` returns)
FOOTER = [f"{MUT}~/repo-memo-worktrees/fix-lock-1a2b3c4d (memo/fix-lock-1a2b3c4d){R0}",
          f"{MUT}↑12k ↓3.1k $0.042 18.4%/200k (auto)                     claude-sonnet · high{R0}"]
def chat(label):
    top = f"{MUT}── {ACC}⠴ {label}{MUT} " + "─" * 60 + R0
    return [top, "> ", "", f"{MUT}" + "─" * 72 + R0] + FOOTER
def screen_worker(): return [
    f"{MUT}› read pi-extension/subagents/runtime/pane-selector.ts{R0}",
    f"{MUT}› bash npm test -- test/pane-selector.test.mjs{R0}",
    f"  {SUC}✓{R0} 14 passed",
    "I moved the reservation check before the layout read and added a",
    "regression test for concurrent launches.", ""] + chat("Working")
def screen_question():
    bw = 52
    box = lambda s: f"{ACC}│{R0} {pad(s, bw - 4)} {ACC}│{R0}"
    return screen_worker()[:3] + [
        f"{ACC}╭─ question " + "─" * (bw - 13) + f"╮{R0}",
        box("Keep the old lock file format for one release?"),
        box(f" {B}▸ Yes, migrate lazily{R0}"),
        box("   No, rewrite at startup"),
        f"{ACC}╰" + "─" * (bw - 2) + f"╯{R0}"] + FOOTER
def screen_reviewer(): return [
    f"{MUT}› bash git diff main...HEAD --stat{R0}",
    " pane-selector.ts | 18 ++++++++++------",
    f"{MUT}› read test/pane-selector.test.mjs{R0}",
    "Reviewing: the reservation now happens before the layout read. One",
    "nit: the rollback path is not covered by a test.", ""] + chat("Working")

BORDER = re.compile(r"^─{10,}$|^── .* ─{10,}$")
def crop_chat(lines):
    """Bottom-up: the last two border lines; drop the input between them and the lower border."""
    plain = [ANSI.sub("", l).strip() for l in lines]
    idx = [i for i, l in enumerate(plain) if BORDER.match(l)]
    if len(idx) < 2: return lines, False           # dialog / question / selection: show everything
    top, bottom = idx[-2], idx[-1]
    return lines[:top + 1] + lines[bottom + 1:], True

# ---------------------------------------------------------------- mirror pane
STATUS = {"active": f"{ACC}●{R0}", "question": f"{B}{WRN}?{R0}", "done": f"{SUC}✓{R0}", "stalled": f"{ERR}●{R0}"}
def mirror_header(state, name, agent, branch, elapsed):
    right = f" {MUT}{elapsed}{R0} {ACC}─╮{R0}"
    for parts in ([name, agent, branch], [name, agent], [name]):  # drop branch first, then agent
        left = f"{ACC}╭─{R0} {STATUS[state]} {B}{TXT}{parts[0]}{R0} "
        if len(parts) > 1: left += f"{MUT}│{R0} {I}{parts[1]}{R0} "
        if len(parts) > 2: left += f"{MUT}│{R0} {ACC}⎇{R0} {parts[2]} "
        if MW - vis(left) - vis(right) >= 3: break
    return left + ACC + "─" * max(1, MW - vis(left) - vis(right)) + R0 + right

def mirror(m):
    content, cropped = crop_chat(m["screen"]())
    out = [mirror_header(m["state"], m["name"], m["agent"], "memo/fix-lock-1a2b3c4d", m["elapsed"])]
    body = content[-(ROWS - 1):]                    # anchored at the bottom
    for l in body: out.append(f"{ACC}│{R0}" + pad(cut(l, MW - 2), MW - 2) + f"{ACC}│{R0}")
    while len(out) < ROWS: out.append(f"{ACC}│{R0}" + " " * (MW - 2) + f"{ACC}│{R0}")
    return out, cropped

# ---------------------------------------------------------------- main pane with the existing widget
def wtop(title, info, w, acc):
    inner = w - 2; t, i = f"─ {title} ", f" {info} ─"
    return f"{acc}╭{t}{'─' * max(0, inner - len(t) - len(i))}{i}╮{R0}"
def wline(left, right, w, acc):
    inner = w - 2
    return f"{acc}│{R0}{cut(left, inner - vis(right))}{' ' * max(0, inner - vis(left) - vis(right))}{right}{acc}│{R0}"
def wbottom(w, acc): return f"{acc}╰{'─' * (w - 2)}╯{R0}"

def main_pane(row, info, acc, notes):
    lines = [f"{B}pi{R0} {MUT}· main session{R0}", ""] + [f"{MUT}{n}{R0}" for n in notes]
    widget = []
    if row:
        widget = [wtop("Subagents", info, LW, acc), wline(*row, LW, acc),
                  wline(" /subagent · Ctrl+Alt+X: next agent ", "", LW, acc), wbottom(LW, acc)]
    editor = [f"{MUT}" + "─" * LW + R0, "> ", f"{MUT}" + "─" * LW + R0]
    lines += [""] * (ROWS - len(lines) - len(widget) - len(editor))
    return lines + widget + editor

def scene(key, title, m, row, info, acc, notes):
    if ONLY and ONLY.upper() != key: return
    print(f"\n{B}=== {key}) {title} ==={R0}\n")
    left = main_pane(row, info, acc, notes)
    if m is None:
        for l in left: print(cut(l, W))
        return
    right, cropped = mirror(m)
    for a, b in zip(left, right): print(pad(cut(a, LW), LW) + f"{MUT}┊{R0}" + b)
    print(f"{MUT}  mirror: chat bar {'cropped' if cropped else 'kept (borders not found: full screen)'}{R0}")

BR = f" ⎇ memo/fix-lock-1a2b3c4d"
MODEL = "claude-sonnet|high · "
scene("A", "worktree child working; mirror on the right, chat bar cropped",
      dict(screen=screen_worker, state="active", name="fix-lock", agent="worker", elapsed="03:12"),
      (f" ▶ 03:12  ⧉ fix-lock (worker){BR} ", f" {MODEL}active · bash 00:04 "), "1 active", W_ACTIVE,
      ["The child lives in its own Herdr worktree space;", "the right pane is a read-only mirror (⧉)."])
scene("B", "child asks a question: borders not found, whole screen shown",
      dict(screen=screen_question, state="question", name="fix-lock", agent="worker", elapsed="03:40"),
      (f" ▶ 03:40  ⧉ fix-lock (worker){BR} ", f" {MODEL}❓ question 00:12 "), "1 question", W_ATTN,
      ["Promote: /subagent or Ctrl+Alt+X → herdr agent focus", "moves the view to the child's workspace."])
scene("C", "handoff \"wait\": A waits, B (reviewer) in a new tab of the same space; mirror follows B",
      dict(screen=screen_reviewer, state="active", name="fix-lock", agent="reviewer", elapsed="00:48"),
      (f" ▶ 04:30  ⧉ fix-lock (worker) › reviewer{BR} ", f" {MODEL}waiting › reviewer 00:48 "), "1 active", W_ACTIVE,
      ["A called subagent({ handoff: \"wait\", agent: \"reviewer\" })", "and ended its turn. B's result goes to A only."])
scene("D", "wait finished: B closed, mirror back on A, A resumes with B's result",
      dict(screen=screen_worker, state="active", name="fix-lock", agent="worker", elapsed="06:02"),
      (f" ▶ 06:02  ⧉ fix-lock (worker){BR} ", f" {MODEL}active · read 00:01 "), "1 active", W_ACTIVE,
      ["The main was not woken up."])
scene("E", "handoff \"replace\": A ended, B took the slot; the main gets only B's final result",
      dict(screen=screen_reviewer, state="active", name="fix-lock", agent="reviewer", elapsed="01:15"),
      (f" ▶ 07:20  ⧉ fix-lock › reviewer (reviewer){BR} ", f" {MODEL}active · read 00:02 "), "1 active", W_ACTIVE,
      ["A's end is a handoff (no wake-up). The slot keeps", "its name and start time; the chain is in details."])
scene("F", "slot finished: mirror closed, split gone; the Herdr worktree space stays open",
      None, None, "", W_ACTIVE,
      ["subagent_result (fix-lock › reviewer) delivered to the main.", "Worktree space and git worktree are kept."])
PY
