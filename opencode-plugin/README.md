# @cioffinahuel/opencode-ado

[![npm version](https://badge.fury.io/js/%40nahuelcio%2Fopencode-ado.svg)](https://www.npmjs.org/package/@cioffinahuel/opencode-ado)

Azure DevOps CLI — PRs, reviews, work items, pipelines and multi-project
profiles behind one `ado` binary. Pairs with the `ado` agent skill so AI coding
agents drive Azure DevOps by running commands.

## Install

```bash
npm i -g @cioffinahuel/opencode-ado     # provides the `ado` command
ado init                                # org + PAT + profiles
npx skills add nahuelcio/ado-plugin     # agent skill (Claude Code, OpenCode, Codex, …)
```

## Configuration

Profiles live in `~/.azure-devops-cli/config.json`:

```jsonc
{
  "ado": {
    "defaultProfile": "work",
    "profiles": {
      "work": {
        "org": "https://dev.azure.com/myorg",
        "project": "myproject",
        "patEnvVar": "AZURE_DEVOPS_PAT",
        "repos": ["backend", "frontend"]
      }
    }
  }
}
```

Lookup order: `[ado]` table in the project's `.adoconfig.toml` →
`~/.azure-devops-cli/config.json` → legacy OpenCode config (migrated on first use).

## Authentication

Requires an Azure DevOps PAT with scopes **Code** (R/W), **Pull Request
Contribute** (R/W) and **Work Items** (Read).

PAT resolution order:
1. The profile's `pat`
2. The env var named by the profile's `patEnvVar` (`AZURE_DEVOPS_PAT` by default)
3. `~/.azure-devops-cli/pat` (written by `ado init`)

## Usage

```bash
ado --help                  # all groups
ado <group> --help          # commands and flags of a group
```

Full documentation: [project README](https://github.com/nahuelcio/ado-plugin#readme).

## Upgrading from 0.x

1.0 removes the OpenCode/Pi plugin, its `ado_*` tools and the TUI sidebar. Remove
the package from the `plugin` arrays in `opencode.json` / `tui.json`; profiles
are migrated automatically.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
