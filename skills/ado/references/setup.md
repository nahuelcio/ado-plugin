# ADO CLI — Setup & Configuration

Help the user configure the `ado` CLI. Two layers: **global auth/profiles**
(once per machine) and **per-project rules** in `.adoconfig.toml`.

## 1. Install

```sh
npm i -g @cioffinahuel/opencode-ado   # provides the `ado` binary
```

The short `ado` command requires the global install above. To configure without
installing, use `npx` **with the full package name** (a bare `npx ado` resolves a
different, unrelated npm package):

```sh
npx @cioffinahuel/opencode-ado init   # ✅ runs this package
# npx ado init                        # ❌ wrong package
```

## 2. Authenticate + profiles — `ado init`

Run `ado init` for an interactive wizard. It collects:

- **Organization** — name or URL (`myorg`, `https://dev.azure.com/myorg`).
- **PAT** — stored at `~/.azure-devops-cli/pat` (chmod 600), never in `opencode.json`.
  Alternatively set the `AZURE_DEVOPS_PAT` env var.
- **Profiles** — one per project: project name + repos to monitor. First profile
  becomes the default; mark others default on demand.

Profiles persist into `opencode.json` under the plugin options. Inspect/switch later:

| Command | Effect |
| --- | --- |
| `ado show` | Show configured profiles + whether a PAT is available. |
| `ado profile` | Show the active profile. |
| `ado profile use <name>` | Switch the active profile. |
| `ado sync` | Re-register the plugin in OpenCode + TUI after edits. |

PAT resolution order: a profile's direct `pat` → its `patEnvVar` → `AZURE_DEVOPS_PAT`
→ `~/.azure-devops-cli/pat`. If none validate, commands fail with an auth error.

## 3. Project rules — `.adoconfig.toml`

Generate or refresh with `ado config` (also offered at the end of `ado init`).
Lives at the project root and governs branch/PR/work-item conventions.

```toml
[chain]
strategy = "feature-chain"   # "feature-chain" | "stacked"
base_branch = "main"
max_length = 10
prefix = "feature"

[branch]
allowed_types = ["feature", "fix", "hotfix", "chore", "refactor"]
slug_max_length = 40
require_wi_id = true

[pr]
require_work_item = true
include_chain_context = true
review_budget = 400
default_draft = true

[work_item]
auto_transition = false
target_state = "In Dev"

[work_item.create]   # controls whether/how `ado wi create` works
enabled = true
allowed_types = []           # [] = any type allowed
required_fields = ["title"]
default_state = "New"
auto_assign = false
require_parent = false
default_type = "User Story"
```

### Work item creation rules (`[work_item.create]`)

`ado wi create` / `ado wi create-child` validate against this section **before**
any API call. The whole section is optional — omit it and these defaults apply:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` → all WI creation is rejected ("creation is disabled"). |
| `allowed_types` | `[]` | Non-empty restricts `--type`; `[]` allows any. |
| `required_fields` | `["title"]` | Each must be present or creation is rejected. |
| `default_state` | `"New"` | Applied when `--state` is omitted. |
| `auto_assign` | `false` | `true` → assign new WIs to the creator when `--assigned` is omitted. |
| `require_parent` | `false` | `true` → `ado wi create` needs `--parent`; use `create-child`. |
| `default_type` | `"User Story"` | Applied when `--type` is omitted. |

To **disable** WI creation for a project: set `enabled = false`.
To **lock** it to specific types: `allowed_types = ["Task", "Bug"]`.

## 4. Verify

```sh
ado show          # config + PAT status
ado profile       # active profile reachable
ado wi types      # confirms auth + project access
```

If `ado show` reports no PAT, re-run `ado init` or export `AZURE_DEVOPS_PAT`.
