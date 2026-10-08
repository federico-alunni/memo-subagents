# Child host composition

A pi child runs in a new Herdr pane. It does **not** inherit the parent pi process environment, and it loads only what its own pi configuration provides. Hosts that start pi in a custom way — typically a profile launched with `pi -ne` (no packages from `settings.json`) plus explicit `-e` extensions — can declare what every pi child must also get:

| Variable | Format | Effect |
| --- | --- | --- |
| `PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS` | `:`-separated **absolute** paths | Each path is passed to the child as `-e <path>`, right after the runtime child extension. Relative or empty entries are ignored; duplicates are removed. |
| `PI_MEMO_SUBAGENTS_CHILD_ENV` | `,`-separated variable names | Each listed variable that is defined in the parent process is forwarded into the child command as `NAME=value` (shell-quoted). Invalid names, undefined variables and `PI_*` names (including `PI_MEMO_*`) are ignored. |

They apply to:

- fresh launches (`subagent`), and
- `subagent_resume` (the resumed child keeps the same host extensions and variables),

through the agent runtime (`hostCompositionFromEnv()`, see [runtime.md](runtime.md)).

Only these two variables are read; in particular the former `IR_CHILD_EXTENSIONS` / `IR_CHILD_ENV` of the vendored pi-issue-round copy are **ignored**.

Without the variables, children get no extra extension or variable.

## When you need it

- **Global profile** (`~/.pi/agent`, packages installed with `pi install`): not needed. Children are normal pi processes and load the same packages from `settings.json` (e.g. a custom provider package).
- **Profiles started with `-ne`**: needed for anything the children must load that is not a package of their profile, for example a model-provider extension and its configuration file:

  ```bash
  export PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS="/abs/path/provider-extension"
  export PI_MEMO_SUBAGENTS_CHILD_ENV="PROVIDER_CONFIG"
  exec pi -ne -e /abs/path/host-extension -e /abs/path/pi-memo-subagents "$@"
  ```

Do not put these in `config.json`: the package root (and therefore `config.json`) is shared by every profile that loads the package, and adding a provider that is already a package of the global profile would load it twice in global children.

## Reserved variables

Launch commands set, after the host variables (resume sets the applicable subset): `PI_DENY_TOOLS` (when frontmatter denies tools), `PI_SUBAGENT_NAME`, `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_AUTO_EXIT`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ACTIVITY_FILE`, `PI_SUBAGENT_SURFACE`. These cannot be overridden through `PI_MEMO_SUBAGENTS_CHILD_ENV`.
