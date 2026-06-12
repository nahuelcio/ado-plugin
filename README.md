# @cioffinahuel/opencode-ado

[![npm version](https://badge.fury.io/js/%40nahuelcio%2Fopencode-ado.svg)](https://www.npmjs.org/package/@cioffinahuel/opencode-ado)

Azure DevOps integration for AI coding assistants. Works with **OpenCode** and **Pi**.

## Features

- **PR Discovery**: List and search pull requests across your repositories
- **PR Details**: View full PR information including descriptions, commits, and work items
- **Review Management**: Approve or reject PRs with custom comments
- **Thread Comments**: Read and participate in code review discussions
- **Work Item Integration**: View linked work items and QA feedback
- **Multi-Profile Support**: Manage multiple organizations and projects
- **TUI Sidebar**: Visual panel showing PRs pending your review (OpenCode)

## Install

### OpenCode

```bash
npx @cioffinahuel/opencode-ado init
```

### Pi

```bash
pi install npm:@cioffinahuel/opencode-ado
```

Then configure (shared with OpenCode):

```bash
# Option A: use the built-in command inside pi
/ado:config

# Option B: create ~/.azure-devops-cli/config.json manually (see below)
```

## Configuration

### OpenCode (`~/.config/opencode/opencode.json`)

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

Config is **shared** — if you already set up the OpenCode plugin, Pi reads the same `~/.azure-devops-cli/` files automatically.

## Authentication

Requires an Azure DevOps PAT with scopes: **Code** (Read & Write), **Pull Request Contribute** (Read & Write), **Work Items** (Read).

```bash
export AZURE_DEVOPS_PAT="your-pat"
# or store in ~/.azure-devops-cli/pat (set by npx init)
```

## Tools (18)

Available to the LLM in both OpenCode and Pi:

| Tool | Description |
|------|-------------|
| `ado_prs` | List active PRs (pending reviews + yours) |
| `ado_pr` | PR details (auto-discovers by ID across profiles) |
| `ado_pr_threads` | Show PR comment threads |
| `ado_pr_comment` | Add PR comment (optional file/line) |
| `ado_review` | Vote on PR: approve, reject, wait, suggestions |
| `ado_pr_diff` | List changed files in PR |
| `ado_pr_file` | Get file content from PR branch |
| `ado_pr_review_context` | Full PR review bundle |
| `ado_select_pr` | Select a PR (persists across session) |
| `ado_profile` | Show active profile config |
| `ado_profiles` | List all profiles |
| `ado_profile_use` | Switch active profile |
| `ado_work_items` | List work items (filter by state, type, tag, assignee) |
| `ado_work_item` | Show work item details + comments |
| `ado_work_item_update` | Update work item state/priority + add comment |
| `ado_work_item_comment` | Add comment to work item |
| `ado_work_item_types` | List work item types |
| `ado_related_work_items` | List related work items with details |

### Pi Commands

| Command | Description |
|---------|-------------|
| `/ado:status` | Show connection status |
| `/ado:profiles` | List profiles |
| `/ado:switch` | Switch active profile |
| `/ado:config` | Create config template |

## CLI Commands (OpenCode)

```bash
npx @cioffinahuel/opencode-ado init          # Interactive setup
npx @cioffinahuel/opencode-ado sync          # Register existing config
npx @cioffinahuel/opencode-ado show          # Show current config
```

## Development

```bash
cd opencode-plugin
npm install
npm run build          # builds both OpenCode + Pi
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
