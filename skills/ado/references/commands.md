# ADO Commands

The `ado` CLI mirrors the OpenCode plugin tools one-to-one — same output, same
behavior — so you can inspect and act on Azure DevOps without loading plugin
tools into context.

## Install

`npm i -g @cioffinahuel/opencode-ado`

## Conventions

- `[repo]` is optional. When omitted, the PR is auto-discovered by ID across all
  configured profiles (or the sidebar-selected PR is used).
- `--profile <name>` overrides the active profile on any command.
- PR IDs and work item IDs are positional; flags carry everything else.
- Work item commands accept either the numeric ID or the full work item URL.
- Output is the same Markdown the plugin returns to the LLM.

## Profiles

| Command | Purpose |
| --- | --- |
| `ado profile` | Show the active profile (org/project, repos, PAT env var). |
| `ado profile list` | List configured profiles; marks the active one. |
| `ado profile use <name>` | Switch the active profile (persists to disk). |

## Pull requests

| Command | Purpose |
| --- | --- |
| `ado pr list` | Active PRs: pending your review + your own. |
| `ado pr get [repo] <prId>` | PR details. |
| `ado pr threads [repo] <prId>` | PR comment threads. |
| `ado pr diff [repo] <prId>` | Changed files in the latest iteration. |
| `ado pr context [repo] <prId>` | Full review bundle: metadata, commits, files, threads. |
| `ado pr file --path <file> [repo] <prId> [--start <n>] [--end <n>]` | File content from the PR source branch. |
| `ado pr comment [repo] <prId> --comment <text> [--file <path>] [--line <n>]` | Add a comment, optionally anchored to a file/line. |
| `ado pr vote [repo] <prId> <approve\|reject\|wait\|suggestions> [--comment <text>]` | Vote on the PR. |
| `ado pr select [repo] <prId>` | Select a PR in the sidebar (persists). |
| `ado pr create --repo <r> --source <branch> --target <branch> --title <t> [--description <d>] [--wi 1,2] [--draft]` | Create a single PR with optional work item links. |
| `ado pr complete [repo] <prId> [--strategy squash\|rebase\|noFastForward\|rebaseMerge] [--delete-source] [--bypass]` | Complete (merge) the PR. Defaults to squash, keeps the source branch. |
| `ado pr abandon [repo] <prId>` | Abandon the PR. |
| `ado pr publish [repo] <prId>` | Turn a draft PR into a regular one. |
| `ado pr reviewers [repo] <prId> --add <user1,user2> [--required]` | Add reviewers, resolved by display name or email. |
| `ado pr chain --repo <r> --wi 1,2,3 [--base <branch>] [--strategy feature-chain\|stacked] [--prefix <p>] [--branches a,b,c]` | Create a chain of PRs from ordered work items. |

## Work items

| Command | Purpose |
| --- | --- |
| `ado wi list [--state <s>] [--assigned <user>] [--tag <t>] [--type <type>]` | List work items (defaults to assigned to you, non-Closed). |
| `ado wi get <id>` | Full work item detail, relations, and comments. |
| `ado wi types` | List work item types (discover custom types). |
| `ado wi related <id> [--state <s>] [--type <type>]` | Related work items with summary + details. |
| `ado wi update <id> [--title <t>] [--description <d>] [--state <s>] [--priority <n>] [--assigned <user>] [--area <p>] [--iteration <p>] [--tags <a;b>] [--field <Name>=<value>] [--comment <text>]` | Update any field, custom ones included, and/or add a comment. |
| `ado wi link <id> --parent\|--child\|--related\|--duplicate\|--successor\|--predecessor <targetId> [--comment <text>]` | Link two existing work items. Idempotent. |
| `ado wi attach <id> --file <path> [--comment <text>]` | Upload a file and attach it to the work item. |
| `ado wi query "SELECT [System.Id] FROM WorkItems WHERE ..."` | Run raw WIQL. Use it to filter by custom fields that `wi list` does not cover. |
| `ado wi comment <id> --comment <text>` | Add a comment. |
| `ado wi fields --type <type>` | List every field of a work item type in this project (custom ones included) with data type, required flag and allowed values. Run it before creating when the project has special fields. |
| `ado wi create --title <t> [--type <type>] [--description <d>] [--area <p>] [--iteration <p>] [--priority <n>] [--assigned <user>] [--state <s>] [--tags <a;b>] [--parent <id>] [--field <Name>=<value>]` | Create a work item (validated against `.adoconfig.toml`). Repeat `--field` for custom/special ADO fields, e.g. `--field Custom.Sponsors=ACME`. |
| `ado wi create-child --parent <id> --title <t> [--type <type>] ...` | Create a child work item under a parent. |

## Pipelines

| Command | Purpose |
| --- | --- |
| `ado pipeline list` | List pipelines with their ids. |
| `ado pipeline runs <pipelineId> [--limit <n>]` | Recent runs with state and result. |
| `ado pipeline run <pipelineId> [--branch <b>]` | Queue a new run. |

## Setup commands

| Command | Purpose |
| --- | --- |
| `ado init` | Interactive setup wizard (org, PAT, profiles, project rules). |
| `ado config` | Generate/refresh `.adoconfig.toml` for this project. |
| `ado sync` | Register existing config in OpenCode + TUI (`repair`/`install` are aliases). |
| `ado show` | Show the current OpenCode config and PAT status. |

## Common errors

- **Missing config**: no active profile or required fields absent. Run `ado profile` / `ado init`.
- **Auth**: PAT missing, expired, or rejected. Re-run `ado init` or set `AZURE_DEVOPS_PAT`.
- **Network**: Azure DevOps unreachable — check connectivity, VPN, proxy.
- **Not found**: the ID/URL does not resolve to a visible PR or work item.

## Examples

```sh
ado profile
ado pr list
ado pr get web 12345
ado pr vote 12345 approve --comment "LGTM"
ado wi get 6789
ado wi create --title "Refactor auth" --type Task --priority 2
ado pr create --repo web --source feature/login --target main --title "Login" --wi 6789
```

## Troubleshooting

Missing config: run `ado profile` and configure the active profile before querying.

Auth: refresh credentials or sign in again, then retry the same command.

Network: check connectivity, VPN, proxy, and Azure DevOps service availability.
