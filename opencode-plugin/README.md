# @cioffinahuel/opencode-ado

[![npm version](https://badge.fury.io/js/%40nahuelcio%2Fopencode-ado.svg)](https://www.npmjs.org/package/@cioffinahuel/opencode-ado)

Azure DevOps plugin for **OpenCode** + **Pi**.

## Install

### OpenCode

```bash
npx @cioffinahuel/opencode-ado init
```

This wizard:
- stores your PAT in `~/.azure-devops-cli/pat`
- registers the server plugin in `~/.config/opencode/opencode.json`
- registers the sidebar plugin in `~/.config/opencode/tui.json`

### Pi

```bash
pi install npm:@cioffinahuel/opencode-ado
```

Then create config with:

```bash
/ado:config
```

## CLI

```bash
npx @cioffinahuel/opencode-ado init       # interactive setup wizard
npx @cioffinahuel/opencode-ado sync       # register existing ADO config in OpenCode + TUI
npx @cioffinahuel/opencode-ado show       # show current config
npx @cioffinahuel/opencode-ado --help     # help
```

For local workspace testing (without publishing):

```bash
node dist/bin/opencode-ado.js sync-local
```

## Configuration

### OpenCode (`~/.config/opencode/opencode.json`)

The plugin config is stored in OpenCode as plugin options:

```jsonc
{
  "plugin": [
    [
      "@cioffinahuel/opencode-ado",
      {
        "defaultProfile": "work",
        "profiles": {
          "work": {
            "org": "https://dev.azure.com/myorg",
            "project": "myproject",
            "patEnvVar": "AZURE_DEVOPS_PAT",
            "repos": ["backend", "frontend"],
            "default": true
          }
        }
      }
    ]
  ]
}
```

### Pi (`~/.azure-devops-cli/config.json` or `.pi/settings.json`)

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

Pi config lookup order:
1. `.pi/settings.json` (project-local)
2. `~/.pi/agent/settings.json` (global)
3. `~/.azure-devops-cli/config.json` (shared fallback)

## Authentication

Requires an Azure DevOps PAT with scopes:
- Code (Read & Write)
- Pull Request Contribute (Read & Write)
- Work Items (Read)

PAT resolution order:
1. `AZURE_DEVOPS_PAT` environment variable
2. `~/.azure-devops-cli/pat`

## Available Tools

### Migration: renamed tools (v0.5.x → v0.6.0)

| Old name | New name |
|---|---|
| `ado_prs` | `ado_pr_list` |
| `ado_pr` | `ado_pr_get` |
| `ado_review` | `ado_pr_vote` |
| `ado_select_pr` | `ado_pr_select` |
| `ado_pr_review_context` | `ado_pr_context` |
| `ado_create_pr` | `ado_pr_create` |
| `ado_chain_prs` | `ado_pr_chain` |
| `ado_work_items` | `ado_wi_list` |
| `ado_work_item` | `ado_wi_get` |
| `ado_work_item_update` | `ado_wi_update` |
| `ado_work_item_comment` | `ado_wi_comment` |
| `ado_work_item_types` | `ado_wi_types` |
| `ado_create_work_item` | `ado_wi_create` |
| `ado_create_child_work_item` | `ado_wi_create_child` |
| `ado_related_work_items` | `ado_wi_related` |
| `ado_profile` | `ado_profile_get` |
| `ado_profiles` | `ado_profile_list` |

### Current tool names

- `ado_pr_list`
- `ado_pr_get`
- `ado_pr_threads`
- `ado_pr_comment`
- `ado_pr_vote`
- `ado_pr_diff`
- `ado_pr_file`
- `ado_pr_context`
- `ado_pr_select`
- `ado_pr_create`
- `ado_pr_chain`
- `ado_profile_get`
- `ado_profile_list`
- `ado_profile_use`
- `ado_wi_list`
- `ado_wi_get`
- `ado_wi_update`
- `ado_wi_comment`
- `ado_wi_types`
- `ado_wi_create`
- `ado_wi_create_child`
- `ado_wi_related`

## Pi Commands

- `/ado:status` — show ADO connection status
- `/ado:profiles` — list configured profiles
- `/ado:switch` — switch active profile
- `/ado:config` — write config template to `~/.azure-devops-cli/config.json`

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT

## Links

- [npm package](https://www.npmjs.org/package/@cioffinahuel/opencode-ado)
- [GitHub repository](https://github.com/nahuelcio/azure-devops-cli-go)
- [Azure DevOps docs](https://learn.microsoft.com/azure/devops/)
