# @cioffinahuel/opencode-ado

[![npm version](https://badge.fury.io/js/%40nahuelcio%2Fopencode-ado.svg)](https://www.npmjs.org/package/@cioffinahuel/opencode-ado)

Azure DevOps from the command line — and from your AI coding agent. Ships the
**`ado` CLI** plus an **agent skill** (`skills/ado`) so the model drives Azure
DevOps by running commands instead of loading 22 tools into its context.

PRs, reviews, work items, and multi-project profiles — all behind one binary.

## Install

```bash
npm i -g @cioffinahuel/opencode-ado     # provides the `ado` command
```

No install needed for one-off setup — `npx` runs it on the fly (use the full
package name, not a bare `ado`):

```bash
npx @cioffinahuel/opencode-ado init
```

## Configure — `ado init`

Interactive wizard. Collects your organization, a PAT, and one profile per
project (with the repos to monitor):

```bash
ado init        # org + PAT + profiles → writes opencode.json + optional .adoconfig.toml
ado show        # show configured profiles and PAT status
ado sync        # re-register the bundled OpenCode/Pi plugin after edits
```

- **PAT** is stored at `~/.azure-devops-cli/pat` (chmod 600), never in plain config.
  You can also set `AZURE_DEVOPS_PAT`. Required scopes: **Code** (R/W),
  **Pull Request Contribute** (R/W), **Work Items** (Read).
- **Project rules** live in `.adoconfig.toml` (generate/refresh with `ado config`) —
  branch/PR conventions and whether `ado wi create` is enabled, restricted, or off.

Full setup reference: [`skills/ado/references/setup.md`](skills/ado/references/setup.md).

## Usage

```bash
ado profile                       # active profile (or `list` / `use <name>`)

ado pr list                       # PRs pending your review + your own
ado pr context 12345              # full review bundle for a PR (auto-discovers repo)
ado pr vote 12345 approve --comment "LGTM"
ado pr create --repo web --source feature/login --target main --title "Login" --wi 6789

ado wi list --state Active        # your open work items
ado wi get 6789                   # detail + relations + comments
ado wi create --title "Refactor auth" --type Task --priority 2
```

`[repo]` is optional on PR commands (the PR is auto-discovered by ID).
`--profile <name>` overrides the active profile on any command.

Full command reference: [`skills/ado/references/commands.md`](skills/ado/references/commands.md).

## Using it from an AI agent

The repo ships a skill at [`skills/ado/SKILL.md`](skills/ado/SKILL.md). Point your
agent's skill loader at this directory; the agent then drives Azure DevOps through
the `ado` CLI — reading state before acting, with no plugin tools loaded into context.

## Command groups

| Group | Commands |
|-------|----------|
| `ado profile` | `list`, `use <name>` |
| `ado pr` | `list`, `get`, `threads`, `diff`, `context`, `file`, `comment`, `vote`, `select`, `create`, `chain` |
| `ado wi` | `list`, `get`, `types`, `related`, `update`, `comment`, `create`, `create-child` |
| setup | `init`, `config`, `show`, `sync` |

## Also available as a plugin

The same package still registers as an **OpenCode** and **Pi** plugin (exposing the
22 `ado_*` tools and a TUI sidebar) for setups that want in-process tools. The CLI
and the plugin share the same config and behavior. See `ado sync` and the plugin
options in `opencode.json`.

## Development

```bash
cd opencode-plugin
npm install
npm run build          # builds CLI + OpenCode + Pi
npm test
```

## License

MIT

## Author

Nahuel Cioffi

## Links

- [npm Package](https://www.npmjs.org/package/@cioffinahuel/opencode-ado)
- [GitHub Repository](https://github.com/nahuelcio/ado-plugin)
- [Azure DevOps Documentation](https://learn.microsoft.com/azure/devops/)
