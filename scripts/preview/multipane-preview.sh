#!/usr/bin/env bash
# Static mockup of Step 2: a single right-side column with N stacked worker mirrors.
# Usage: bash scripts/preview/multipane-preview.sh            (total width 160, mirror 50%)
#        W=200 bash scripts/preview/multipane-preview.sh
# Colors: pi cursor-dark theme tokens.
exec python3 - "${W:-160}" "${R:-0.5}" <<'PY'
import re, sys
W, RATIO = int(sys.argv[1]), float(sys.argv[2])
def fg(h): h = h.lstrip('#'); return f"\x1b[38;2;{int(h[0:2],16)};{int(h[2:4],16)};{int(h[4:6],16)}m"
B, I, R0 = "\x1b[1m", "\x1b[3m", "\x1b[0m"
ACC, SUC, ERR, WRN, MUT, TXT = fg("ebcb8b"), fg("87bfd0"), fg("be616a"), fg("ebcb8b"), fg("4f4f4f"), fg("ffffff")
W_ACTIVE, W_OPEN, W_ATTN = fg("4da3ff"), fg("d69e2e"), fg("d65cd6")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
def vis(s): return len(ANSI.sub("", s))
def pad(s, n): return s + " " * max(0, n - vis(s))
def cut(s, n):
    out, w = "", 0
    for tok in re.split(r"(\x1b\[[0-9;]*m)", s):
        if ANSI.fullmatch(tok or "x"): out += tok; continue
        for ch in tok:
            if w >= n: return out + R0
            out += ch; w += 1
    return out

MW = int(W * RATIO); LW = W - MW - 1
ROWS = 24

STATUS = {"active": f"{ACC}●{R0}", "question": f"{B}{WRN}?{R0}", "done": f"{SUC}✓{R0}", "stalled": f"{ERR}●{R0}"}

def mirror_header(state, name, agent, branch, elapsed, has_attention=False):
    right = f" {MUT}{elapsed}{R0} {ACC}─╮{R0}"
    hint = f" {B}{WRN}[rispondi qui]{R0}" if has_attention else ""
    for parts in ([name + hint, agent, branch], [name + hint, agent], [name + hint]):
        left = f"{ACC}╭─{R0} {STATUS[state]} {B}{TXT}{parts[0]}{R0} "
        if len(parts) > 1: left += f"{MUT}│{R0} {I}{parts[1]}{R0} "
        if len(parts) > 2: left += f"{MUT}│{R0} {ACC}⎇{R0} {parts[2]} "
        if MW - vis(left) - vis(right) >= 3: break
    return left + ACC + "─" * max(1, MW - vis(left) - vis(right)) + R0 + right

def render_box(m, box_rows):
    header = mirror_header(m["state"], m["name"], m["agent"], m["branch"], m["elapsed"], m.get("attention", False))
    lines = [header]
    inner = MW - 2
    body = m["lines"][-(box_rows - 1):] if box_rows > 1 else []
    side = f"{ACC}│{R0}"
    for l in body:
        lines.append(f"{side}{pad(cut(l, inner), inner)}{side}")
    while len(lines) < box_rows:
        lines.append(f"{side}{' ' * inner}{side}")
    return lines

def render_stacked_mirrors(workers, total_rows):
    n = len(workers)
    if n == 0:
        return [" " * MW] * total_rows
    # Distribute total rows among workers (each box gets equal share)
    base_rows = total_rows // n
    rem = total_rows % n
    out = []
    for i, w in enumerate(workers):
        h = base_rows + (1 if i < rem else 0)
        out.extend(render_box(w, h))
    return out

def wtop(title, info, w, acc):
    inner = w - 2; t, i = f"─ {title} ", f" {info} ─"
    return f"{acc}╭{t}{'─' * max(0, inner - len(t) - len(i))}{i}╮{R0}"
def wline(left, right, w, acc):
    inner = w - 2
    return f"{acc}│{R0}{cut(left, inner - vis(right))}{' ' * max(0, inner - vis(left) - vis(right))}{right}{acc}│{R0}"
def wbottom(w, acc): return f"{acc}╰{'─' * (w - 2)}╯{R0}"

def main_pane(rows_widget, info, acc, notes, total_rows):
    lines = [f"{B}pi{R0} {MUT}· main session{R0}", ""] + [f"{MUT}{n}{R0}" for n in notes]
    widget = [wtop("Subagents", info, LW, acc)]
    for r in rows_widget:
        widget.append(wline(*r, LW, acc))
    widget.append(wline(" /subagent · Ctrl+Alt+X: next agent ", "", LW, acc))
    widget.append(wbottom(LW, acc))
    editor = [f"{MUT}" + "─" * LW + R0, "> ", f"{MUT}" + "─" * LW + R0]
    lines += [""] * max(0, total_rows - len(lines) - len(widget) - len(editor))
    return lines + widget + editor

def scene(title, workers, widget_rows, info, acc, notes):
    print(f"\n{B}=== {title} ==={R0}\n")
    left = main_pane(widget_rows, info, acc, notes, ROWS)
    right = render_stacked_mirrors(workers, ROWS)
    for a, b in zip(left, right):
        print(pad(cut(a, LW), LW) + f"{MUT}┊{R0}" + b)

# ---------------------------------------------------------------- Scenario 1: Two parallel workers
w1 = {
    "name": "worker-1", "agent": "builder", "branch": "memo/feat-auth-1a2b", "elapsed": "01:24", "state": "active",
    "lines": [
        f"{MUT}› read src/auth/provider.ts{R0}",
        f"{MUT}› bash npm test -- test/auth.test.ts{R0}",
        f"  {SUC}✓{R0} 8 passed",
        "Implementing JWT validation refresh loop...",
        f"{MUT}── ⠴ Working ──────────────────────────────────────────{R0}",
        f"{MUT}~/repo-memo-worktrees/feat-auth-1a2b (memo/feat-auth-1a2b){R0}",
    ]
}
w2 = {
    "name": "worker-2", "agent": "tester", "branch": "memo/feat-api-9f8e", "elapsed": "00:45", "state": "active",
    "lines": [
        f"{MUT}› bash git diff main...HEAD --stat{R0}",
        " routes/api.ts | 42 +++++++++++++++++++++",
        f"{MUT}› bash curl -s http://localhost:3000/health{R0}",
        ' {"status": "ok", "uptime": 120}',
        f"{MUT}── ⠴ Working ──────────────────────────────────────────{R0}",
        f"{MUT}~/repo-memo-worktrees/feat-api-9f8e (memo/feat-api-9f8e){R0}",
    ]
}

scene("Scenario 1: Due worker in parallelo (colonna divisa a metà: 12 righe ciascuno)",
      [w1, w2],
      [(f" ▶ 01:24  ⧉ worker-1 (builder) ⎇ memo/feat-auth-1a2b ", f" active · test 00:15 "),
       (f"   00:45  ⧉ worker-2 (tester) ⎇ memo/feat-api-9f8e ", f" active · bash 00:03 ")],
      "2 active", W_ACTIVE,
      ["Un unico pane split a destra, gestito da un solo processo.", "Le altezze dei box sono bilanciate automaticamente."])

# ---------------------------------------------------------------- Scenario 2: Tre worker, uno chiede una risposta
w2_q = {
    "name": "worker-2", "agent": "tester", "branch": "memo/feat-api-9f8e", "elapsed": "01:10", "state": "question", "attention": True,
    "lines": [
        f"{ACC}╭─ question ─────────────────────────────────────────╮{R0}",
        f"{ACC}│{R0} Rigenerare il mock token prima del test di carico?   {ACC}│{R0}",
        f"{ACC}│{R0}  {B}▸ Sì, rigenera (Recommended){R0}                       {ACC}│{R0}",
        f"{ACC}│{R0}    No, usa token cache                              {ACC}│{R0}",
        f"{ACC}╰────────────────────────────────────────────────────╯{R0}",
    ]
}
w3 = {
    "name": "worker-3", "agent": "reviewer", "branch": "memo/chore-docs-3c1d", "elapsed": "00:18", "state": "active",
    "lines": [
        f"{MUT}› read README.md{R0}",
        "Checking documentation coverage against latest API changes...",
        f"{MUT}── ⠴ Working ──────────────────────────────────────────{R0}",
    ]
}

scene("Scenario 2: Tre worker: worker-2 fa una domanda (input abilitato e testata [rispondi qui])",
      [w1, w2_q, w3],
      [(f" ▶ 01:45  ⧉ worker-1 (builder) ⎇ memo/feat-auth-1a2b ", f" active · edit 00:02 "),
       (f"   01:10  ⧉ worker-2 (tester) ⎇ memo/feat-api-9f8e ", f" ❓ question 00:08 "),
       (f"   00:18  ⧉ worker-3 (reviewer) ⎇ memo/chore-docs ", f" active · read 00:01 ")],
      "2 active · 1 question", W_ATTN,
      ["La colonna si divide in 3 riquadri (8 righe ciascuno).", "worker-2 ha [rispondi qui]: digitando nel mirror rispondi a lui!"])
PY
