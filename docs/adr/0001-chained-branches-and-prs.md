# ADR 0001: Chained Branches and Pull Requests

> **Implementation spec**: See [ADR 0002](./0002-chained-prs-implementation-design.md) for the full implementation design.

**Status**: Proposed

**Date**: 2026-06-12

## Context

The `@nahuelcio/opencode-ado` plugin currently provides read and write tools for pull requests, reviews, work items, and diff inspection. However, it has **no branch creation or pull request creation capabilities**. This forces users to leave the AI-assisted workflow (OpenCode) and manually create branches and PRs through the Azure DevOps web UI or `git` CLI.

This gap becomes critical when working with **chained PRs** — a pattern where a large change is split into sequential, independently reviewable slices. The [chained-pr skill](/.config/opencode/skills/chained-pr) defines the strategy and conventions for splitting large PRs, but there is no tooling in the ADO plugin to actually create the branches and PRs that form the chain.

The plugin needs three new capabilities:

1. **Branch creation** — create remote branches in ADO repositories.
2. **PR creation** — create pull requests linking branches to work items.
3. **Chain orchestration** — create an ordered sequence of branches and PRs from a list of work items, following one of two chain strategies.

These capabilities are scoped to **OpenCode only** (not Pi). The Pi extension serves a different interaction model and does not need branch/PR creation at this time.

## Decision

### 1. One-to-one mapping: 1 Work Item → 1 Branch → 1 PR

Each branch and PR in the chain corresponds to exactly **one ADO work item**. This keeps the model simple and predictable:

- The work item title drives the branch slug.
- The PR title is derived from the work item title.
- ADO's native WI↔PR linking provides traceability.

If a work item is too large for a single PR, the correct action is to **split the work item in ADO first** (create child work items), then chain those children. The plugin does not attempt to infer sub-tasks from a single work item.

### 2. Two chain strategies

The plugin supports two strategies, matching the patterns defined in the chained-pr skill but adapted for Azure DevOps:

#### Feature Branch Chain

A tracker branch (with a draft PR) accumulates all changes. Child PRs target the tracker branch. Nothing lands on `main` until the entire chain completes and the tracker PR is merged.

```
main
 └── feature/auth-tracker          ← draft tracker PR → main
      ├── feature/123-auth-schema  ← PR #1 → feature/auth-tracker
      │    └── feature/124-auth-api ← PR #2 → feature/123-auth-schema
      │         └── feature/125-auth-ui ← PR #3 → feature/124-auth-api
```

**When to use**: The feature must integrate and be tested as a whole before shipping. Changes across slices are interdependent.

#### Stacked PRs to Main

Each PR targets `main` directly but builds on the previous branch's tip. Each slice can ship independently. After a parent merges, the next PR needs rebase or retargeting.

```
main ← PR #1: feature/123-auth-schema
 └── feature/124-auth-api     ← PR #2 → main (builds on /123)
      └── feature/125-auth-ui  ← PR #3 → main (builds on /124)
```

**When to use**: Each slice can land independently. Slices are additive and don't require cross-slice integration.

**Strategy comparison**:

| | Feature Branch Chain | Stacked PRs to Main |
|---|---|---|
| Merge target | Tracker branch | `main` directly |
| Shipping | All-at-once (tracker merge) | Incremental (one at a time) |
| Rollback | Revert/hold the whole feature | Revert individual PRs |
| Risk | Nothing lands until complete | Partial behavior may land |
| Post-merge cleanup | None (tracker absorbs) | Rebase/retarget next PR |

The default strategy is **feature-chain**.

### 3. Branch naming convention

```
{prefix}/{wi-id}-{slug}
```

- **prefix**: Defaults to `feature`. Can be overridden per chain (e.g. `bugfix`, `hotfix`).
- **wi-id**: The ADO work item ID (numeric).
- **slug**: Derived from the work item title — lowercased, non-alphanumeric characters replaced with hyphens, consecutive hyphens collapsed, trimmed to 40 characters.

Examples:

| WI ID | WI Title | Branch name |
|-------|----------|-------------|
| 123 | Add authentication schema | `feature/123-auth-schema` |
| 456 | Fix login redirect bug | `bugfix/456-login-redirect-bug` |
| 789 | Hotfix: null pointer in payment | `hotfix/789-null-pointer-in-payment` |

For the Feature Branch Chain strategy, a **tracker branch** is also created. Its name follows the pattern `{prefix}/{chain-name}` where `chain-name` is derived from the first work item's title area (e.g. `feature/auth`).

### 4. No initial commits

Branches are created as **empty refs** pointing to the parent branch's tip commit. PRs start with 0 changes and get populated as the developer or AI pushes real code.

Rationale:

- Empty commits and placeholder files pollute git history.
- The ADO Git API supports creating branches via ref updates without requiring a commit.
- PRs in ADO are valid with zero changes — they show as "No changes to display" until code is pushed.

This means the chain creation is a pure metadata operation — no file system changes, no git operations, just ADO API calls.

### 5. Chain Context in PR description

Each PR in a chain receives a structured **Chain Context** section appended to its description. This is inspired by the chained-pr skill's Chain Context template but adapted for **ADO Markdown** (which differs from GitHub Flavored Markdown in table rendering and code blocks).

The section includes:

- **Chain name**: Human-readable name for the chain.
- **Position**: Current position in the chain (e.g. "2 of 4").
- **Depends on**: Link to the parent PR (or "None" for the first).
- **Follow-up**: Link to the next PR (or "None" for the last).
- **Dependency diagram**: ASCII tree with 📍 marking the current PR.

Example (for PR #2 in a 3-PR feature chain):

```markdown
## Chain Context

| Field | Value |
|-------|-------|
| Chain | auth |
| Strategy | feature-chain |
| Tracker | PR #100 (draft) |
| Position | 2 of 3 |
| Depends on | PR #101 |
| Follow-up | PR #103 |

### Dependency Diagram

main
 └── #100 Tracker (draft)
      └── #101 Auth schema
           └── 📍 #102 Auth API
                └── #103 Auth UI
```

The plugin **appends** this section. If the ADO project has a PR description template, the Chain Context is added after it — not replacing it.

### 6. Tool interface: `ado_chain_prs`

A single orchestration tool that creates the entire chain in one call:

```typescript
{
  repo: string,                                   // Required: target repository
  workItemIds: number[],                          // Required: ordered WI IDs (WI[0] = first child)
  baseBranch?: string,                            // Default: "main"
  strategy?: "feature-chain" | "stacked",         // Default: "feature-chain"
  prefix?: string,                                // Default: "feature"
  profile?: string                                // Profile override
}
```

**Ordering semantics**: `workItemIds[0]` is the first branch in the chain, `workItemIds[1]` builds on top of it, and so on. The caller is responsible for ordering work items in the desired dependency sequence.

**Output**: A structured summary listing all created branches, PRs, and their relationships.

Two additional lower-level tools are also provided for cases where a full chain is not needed:

- **`ado_create_branch`**: Create a single branch.
  ```typescript
  {
    repo: string,
    branchName: string,        // Full branch name (e.g. "feature/123-auth-schema")
    sourceBranch?: string,     // Default: "main"
    profile?: string
  }
  ```

- **`ado_create_pr`**: Create a single PR.
  ```typescript
  {
    repo: string,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    description?: string,
    workItemIds?: number[],    // WI IDs to link
    isDraft?: boolean,         // Default: false
    profile?: string
  }
  ```

### 7. New AdoClient methods

Three new methods on the existing `AdoClient` class in `src/ado-client.ts`:

```typescript
/** Get the latest commit SHA for a branch. */
async getBranchTip(repo: string, branch: string): Promise<string>

/** Create a new branch as a ref pointing to the given commit SHA. */
async createBranch(repo: string, branchName: string, commitSha: string): Promise<GitRefUpdateResult>

/** Create a pull request. */
async createPullRequest(repo: string, options: {
  sourceRefName: string,
  targetRefName: string,
  title: string,
  description?: string,
  workItemIds?: number[],
  isDraft?: boolean,
}): Promise<GitPullRequest>
```

These methods map directly to the [ADO Git REST API](https://learn.microsoft.com/en-us/rest/api/azure-devops/git):

- `getBranchTip` → `GET /git/repositories/{repo}/stats/branches?name={branch}` or `GET /git/repositories/{repo}/refs?filter=heads/{branch}`
- `createBranch` → `POST /git/repositories/{repo}/refs` with `UpdateRef` body
- `createPullRequest` → `POST /git/repositories/{repo}/pullrequests` — creates the PR without work item links
- `linkWorkItemToPr` → `PATCH /_apis/wit/workitems/{id}` — links a WI to a PR via `ArtifactLink` relation using `vstfs:///Git/PullRequestId/{projectId}%2f{repoId}%2f{prId}` format. This is required because the PR creation endpoint does not reliably accept `workItemRefs` as a writable field.

### 8. Platform scope: OpenCode only

These tools are registered in the **server plugin** (`src/index.ts`) only. The Pi entry point (`src/pi-entry.ts`) does not receive branch or PR creation tools.

Rationale:

- Pi's interaction model is conversational and does not need write operations on git infrastructure.
- Branch and PR creation requires careful orchestration (ordering, strategy selection) that fits OpenCode's tool-calling model better.
- Keeping Pi read-only reduces the blast radius of accidental operations.

## Consequences

### Benefits

- **End-to-end AI workflow**: The AI can plan, branch, create PRs, push code, and request reviews without leaving OpenCode.
- **Chained PR conventions enforced**: The structured Chain Context section ensures every PR in a chain carries its dependency information, reducing reviewer confusion.
- **Simple mental model**: One WI → one branch → one PR. No many-to-many mappings, no "sub-PRs" within a single WI.
- **Strategy flexibility**: Teams can choose feature-chain (safe, all-at-once) or stacked (agile, incremental) depending on the change's nature.
- **No git history pollution**: Empty branches avoid placeholder commits and dummy files.
- **Lower-level tools available**: `ado_create_branch` and `ado_create_pr` can be used independently for simple cases where a full chain isn't needed.

### Drawbacks

- **No WI splitting**: If a work item is too large, the user must manually create child WIs in ADO before chaining. The plugin does not automate WI decomposition.
- **Stacked PRs need manual rebase**: After a parent PR merges in the stacked strategy, the next PR's branch must be rebased or retargeted. The plugin creates the initial chain but does not auto-maintain it post-merge.
- **ADO API permissions required**: The PAT needs `Code (Read & Write)` scope. Users with read-only PATs cannot use these tools.
- **Tracker PR management**: In the feature-chain strategy, the tracker PR remains draft until all children merge. The plugin creates it as draft but does not auto-merge or auto-update it.
- **Single-repo chains only**: Cross-repository chains are not supported. All branches and PRs in a chain target the same repository.

### Risks

- **Accidental branch creation**: Users may invoke `ado_chain_prs` with wrong WI IDs, creating branches that need cleanup. Mitigation: the tool returns a summary with all created resources, and branches can be deleted via ADO UI.
- **Branch name collisions**: If a branch with the same name already exists, the ADO API will return an error. The tool should surface this clearly rather than silently failing.
- **Rate limiting**: Creating N branches + N PRs + 1 tracker PR in rapid succession may hit ADO API rate limits for large chains. Mitigation: sequential creation with reasonable batch sizes (the existing `chunkArray` helper can be reused).
