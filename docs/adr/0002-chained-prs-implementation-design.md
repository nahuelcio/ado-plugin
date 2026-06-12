# ADR 0002: Chained PRs — Implementation Design

**Status**: Proposed  
**Date**: 2026-06-12  
**Supersedes**: ADR 0001 (concepts only — this document provides the full implementation spec)

## Context

ADR 0001 defined the conceptual design for chained branches and pull requests in the `@nahuelcio/opencode-ado` plugin. This document provides the **implementation-level specification**: every type, method signature, API endpoint, tool schema, helper function, and error handling path. A developer should be able to implement this feature end-to-end from this document alone.

**Key constraints** (from ADR 0001):
- 1 Work Item → 1 Branch → 1 PR mapping
- Two strategies: `feature-chain` (tracker branch + draft PR) and `stacked` (direct to main)
- Branches are empty refs (no initial commits)
- WI linking via WIT PATCH API with `ArtifactLink` relation
- Branch names are LLM-provided; plugin validates format if configured
- `ado_create_branch` is internal to `AdoClient` (not a public tool)
- `ado_create_pr` is a public tool with WI linking integrated
- `ado_chain_prs` is the orchestration tool
- OpenCode only (not Pi)

---

## 1. `.adoconfig.toml` Schema

The config file lives at the project root (`<repo>/.adoconfig.toml`). Parsed with `smol-toml`.

```toml
# .adoconfig.toml — Project-level configuration for chained PRs

[chain]
# Default strategy for chain creation.
# "feature-chain": tracker branch + draft PR, children target tracker.
# "stacked": each PR targets the base branch directly.
strategy = "feature-chain"          # "feature-chain" | "stacked"

# Base branch for the chain. All branches derive from this.
base_branch = "main"                # string

# Maximum number of PRs in a single chain (excluding tracker).
max_length = 10                     # 1..50

# Default branch prefix. LLM-provided names must start with this.
prefix = "feature"                  # string, e.g. "feature", "bugfix", "hotfix"

# Name for the tracker branch (feature-chain strategy only).
# Derived from first WI title if omitted.
tracker_name = ""                   # string (optional, auto-derived if empty)


[branch]
# Allowed branch type prefixes. LLM can only use prefixes from this list.
allowed_types = ["feature", "bugfix", "hotfix", "chore", "refactor"]

# Maximum slug length in branch name ({prefix}/{wi-id}-{slug}).
slug_max_length = 40                # 10..100

# Require work item ID in branch name.
require_wi_id = true                # boolean


[pr]
# Require at least one work item to be linked to every PR created by the plugin.
require_work_item = true            # boolean

# Append the Chain Context section to PR descriptions.
include_chain_context = true        # boolean

# Maximum changed lines per PR before recommending a split (from chained-pr skill).
# Plugin warns if a PR exceeds this budget after code is pushed.
review_budget = 400                 # positive integer, default 400

# Create PRs as draft by default.
default_draft = false               # boolean


[work_item]
# Auto-transition work items after PR creation.
# If true, moves WIs to target_state after linking.
auto_transition = false             # boolean

# Target state for auto-transition (only if auto_transition = true).
target_state = "In Dev"             # string
```

### Defaults Applied When `.adoconfig.toml` Is Missing

| Section | Field | Default |
|---------|-------|---------|
| chain | strategy | `"feature-chain"` |
| chain | base_branch | `"main"` |
| chain | max_length | `10` |
| chain | prefix | `"feature"` |
| chain | tracker_name | `""` (auto-derived) |
| branch | allowed_types | `["feature", "bugfix", "hotfix", "chore", "refactor"]` |
| branch | slug_max_length | `40` |
| branch | require_wi_id | `true` |
| pr | require_work_item | `true` |
| pr | include_chain_context | `true` |
| pr | review_budget | `400` |
| pr | default_draft | `false` |
| work_item | auto_transition | `false` |
| work_item | target_state | `"In Dev"` |

---

## 2. New TypeScript Types and Interfaces

### 2.1 ProjectConfig

```typescript
/** Parsed .adoconfig.toml — project-level chain configuration. */
export interface ProjectConfig {
  chain: {
    strategy: "feature-chain" | "stacked";
    base_branch: string;
    max_length: number;
    prefix: string;
    tracker_name: string;
  };
  branch: {
    allowed_types: string[];
    slug_max_length: number;
    require_wi_id: boolean;
  };
  pr: {
    require_work_item: boolean;
    include_chain_context: boolean;
    review_budget: number;
    default_draft: boolean;
  };
  work_item: {
    auto_transition: boolean;
    target_state: string;
  };
}
```

### 2.2 ChainStep

```typescript
/** One step in a chain: a branch, its PR, and its linked work item. */
export interface ChainStep {
  /** ADO work item ID. */
  workItemId: number;
  /** Work item title (fetched from ADO). */
  workItemTitle: string;
  /** Full branch name, e.g. "feature/123-auth-schema". */
  branchName: string;
  /** Ref name for ADO API, e.g. "refs/heads/feature/123-auth-schema". */
  refName: string;
  /** The branch this one was created from (ref name). */
  parentRefName: string;
  /** PR creation result (populated after createPullRequest). */
  pr?: {
    id: number;
    url: string;
  };
  /** Whether WI linking succeeded. */
  linked: boolean;
  /** Error message if any step failed. */
  error?: string;
}
```

### 2.3 ChainResult

```typescript
/** Result of an ado_chain_prs invocation. */
export interface ChainResult {
  /** Chain strategy used. */
  strategy: "feature-chain" | "stacked";
  /** Tracker PR (feature-chain only). */
  tracker?: {
    branchName: string;
    prId: number;
    prUrl: string;
  };
  /** Ordered list of chain steps. */
  steps: ChainStep[];
  /** Total PRs created successfully. */
  created: number;
  /** Total WIs linked successfully. */
  linked: number;
  /** Errors encountered (partial success possible). */
  errors: string[];
}
```

### 2.4 CreatePrOptions

```typescript
/** Options for AdoClient.createPullRequest(). */
export interface CreatePrOptions {
  /** Source ref name, e.g. "refs/heads/feature/123-auth-schema". */
  sourceRefName: string;
  /** Target ref name, e.g. "refs/heads/main" or tracker ref. */
  targetRefName: string;
  /** PR title. */
  title: string;
  /** PR description (Markdown). */
  description?: string;
  /** Create as draft. */
  isDraft?: boolean;
}
```

### 2.5 GitRefUpdateResult

```typescript
/** Response from ADO Git Refs API on branch creation. */
export interface GitRefUpdateResult {
  /** The ref that was created/updated. */
  name: string;
  /** The commit SHA the ref points to. */
  objectId: string;
  /** The old commit SHA (empty string for new refs). */
  oldObjectId: string;
  /** Whether the update succeeded. */
  success: boolean;
  /** Rejection reason if update failed. */
  updateStatus?: string;
}
```

### 2.6 Zod Schemas

```typescript
import { z } from "zod/v4";

/** Schema for validating branch name format. */
export const BranchNameSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[a-z][a-z0-9-]*\/\d+-[a-z0-9-]+$/,
    "Branch name must match: {prefix}/{wi-id}-{slug} (lowercase, hyphens only)"
  );

/** Schema for validating .adoconfig.toml structure. */
export const ProjectConfigSchema = z.object({
  chain: z.object({
    strategy: z.enum(["feature-chain", "stacked"]).default("feature-chain"),
    base_branch: z.string().default("main"),
    max_length: z.number().int().min(1).max(50).default(10),
    prefix: z.string().min(1).default("feature"),
    tracker_name: z.string().default(""),
  }).default({}),
  branch: z.object({
    allowed_types: z.array(z.string()).default(["feature", "bugfix", "hotfix", "chore", "refactor"]),
    slug_max_length: z.number().int().min(10).max(100).default(40),
    require_wi_id: z.boolean().default(true),
  }).default({}),
  pr: z.object({
    require_work_item: z.boolean().default(true),
    include_chain_context: z.boolean().default(true),
    review_budget: z.number().int().min(1).max(5000).default(400),
    default_draft: z.boolean().default(false),
  }).default({}),
  work_item: z.object({
    auto_transition: z.boolean().default(false),
    target_state: z.string().default("In Dev"),
  }).default({}),
});
```

---

## 3. New AdoClient Methods

All methods below are added to the existing `AdoClient` class in `src/ado-client.ts`.

### 3.1 `getBranchTip`

```typescript
/**
 * Get the latest commit SHA for a branch.
 *
 * @param repo - Repository name
 * @param branch - Branch name WITHOUT refs/heads/ prefix (e.g. "main")
 * @returns The commit SHA (40-char hex string)
 * @throws If branch does not exist or API error
 */
async getBranchTip(repo: string, branch: string): Promise<string>
```

**ADO REST API**:
```
GET /_apis/git/repositories/{repo}/refs?filter=heads/{branch}&api-version=7.1
```

**Request**: No body. `repo` is URL-encoded. `branch` is the short name (e.g. `main`), the `filter` param adds the `heads/` prefix.

**Response** (relevant fields):
```json
{
  "value": [
    {
      "name": "refs/heads/main",
      "objectId": "a1b2c3d4e5f6..."
    }
  ]
}
```

**Implementation**:
```typescript
async getBranchTip(repo: string, branch: string): Promise<string> {
  const filter = `heads/${branch}`;
  const data = await this.request<{ value: Array<{ objectId: string }> }>(
    `/git/repositories/${encodeURIComponent(repo)}/refs?filter=${encodeURIComponent(filter)}`,
  );
  if (!data.value?.length) {
    throw new Error(`Branch "${branch}" not found in repo "${repo}"`);
  }
  return data.value[0].objectId;
}
```

**Error scenarios**:
- Branch not found: ADO returns empty `value` array → throw descriptive error
- Repo not found: ADO returns 404 → caught by `request()` → "ADO 404: ..."

---

### 3.2 `createBranch`

```typescript
/**
 * Create a new branch as a ref pointing to the given commit SHA.
 *
 * @param repo - Repository name
 * @param branchName - Full branch name WITHOUT refs/heads/ prefix (e.g. "feature/123-auth-schema")
 * @param commitSha - The commit SHA to point the branch at
 * @returns The created ref details
 * @throws If branch already exists or commit SHA is invalid
 */
async createBranch(repo: string, branchName: string, commitSha: string): Promise<GitRefUpdateResult>
```

**ADO REST API**:
```
POST /_apis/git/repositories/{repo}/refs?api-version=7.1
```

**Request body**:
```json
[
  {
    "name": "refs/heads/feature/123-auth-schema",
    "oldObjectId": "0000000000000000000000000000000000000000",
    "newObjectId": "a1b2c3d4e5f6..."
  }
]
```

> **Note**: `oldObjectId` must be all zeros for creation (not update). The API accepts an array but we send exactly one element.

**Response**:
```json
[
  {
    "name": "refs/heads/feature/123-auth-schema",
    "objectId": "a1b2c3d4e5f6...",
    "oldObjectId": "0000000000000000000000000000000000000000",
    "success": true,
    "updateStatus": "succeeded"
  }
]
```

**Implementation**:
```typescript
async createBranch(
  repo: string,
  branchName: string,
  commitSha: string,
): Promise<GitRefUpdateResult> {
  const refName = `refs/heads/${branchName}`;
  const body = [
    {
      name: refName,
      oldObjectId: "0000000000000000000000000000000000000000",
      newObjectId: commitSha,
    },
  ];
  const data = await this.request<GitRefUpdateResult[]>(
    `/git/repositories/${encodeURIComponent(repo)}/refs`,
    { method: "POST", body: JSON.stringify(body) },
  );
  const result = data[0];
  if (!result.success) {
    throw new Error(
      `Failed to create branch "${branchName}": ${result.updateStatus ?? "unknown error"}`,
    );
  }
  return result;
}
```

**Error scenarios**:
- Branch already exists: ADO returns `success: false, updateStatus: "failed"` → throw descriptive error
- Invalid commit SHA: ADO returns 400 → caught by `request()`
- Repo not found: ADO returns 404 → caught by `request()`

---

### 3.3 `createPullRequest`

```typescript
/**
 * Create a pull request.
 *
 * @param repo - Repository name
 * @param options - PR creation options
 * @returns The created PR object (ADO GitPullRequest)
 * @throws If source/target branches are invalid or PR creation fails
 */
async createPullRequest(repo: string, options: CreatePrOptions): Promise<any>
```

**ADO REST API**:
```
POST /_apis/git/repositories/{repo}/pullrequests?api-version=7.1
```

**Request body**:
```json
{
  "sourceRefName": "refs/heads/feature/123-auth-schema",
  "targetRefName": "refs/heads/feature/auth-tracker",
  "title": "Auth Schema — WI #123",
  "description": "## Chain Context\n...",
  "isDraft": true
}
```

**Response**: Standard ADO `GitPullRequest` object with `pullRequestId`, `url`, etc.

**Implementation**:
```typescript
async createPullRequest(repo: string, options: CreatePrOptions): Promise<any> {
  return this.request(
    `/git/repositories/${encodeURIComponent(repo)}/pullrequests`,
    {
      method: "POST",
      body: JSON.stringify({
        sourceRefName: options.sourceRefName,
        targetRefName: options.targetRefName,
        title: options.title,
        description: options.description ?? "",
        isDraft: options.isDraft ?? false,
      }),
    },
  );
}
```

**Error scenarios**:
- Source branch doesn't exist: ADO returns 400 with "source branch not found"
- Target branch doesn't exist: ADO returns 400 with "target branch not found"
- Duplicate PR (same source→target already exists): ADO returns 409 → caught by `request()`

---

### 3.4 `linkWorkItemToPr`

```typescript
/**
 * Link a work item to a pull request via ArtifactLink relation.
 *
 * Uses the WIT PATCH API to add a relation of type
 * "ArtifactLink" with the PR artifact URL format:
 * vstfs:///Git/PullRequestId/{projectId}%2f{repoId}%2f{prId}
 *
 * @param workItemId - ADO work item ID
 * @param prArtifactUrl - Full artifact URL for the PR
 * @param projectId - ADO project GUID or name
 * @param repoId - ADO repository GUID or name
 */
async linkWorkItemToPr(
  workItemId: number,
  prArtifactUrl: string,
  projectId: string,
  repoId: string,
): Promise<void>
```

**ADO REST API**:
```
PATCH /_apis/wit/workitems/{workItemId}?api-version=7.1
```

**Request body** (JSON Patch):
```json
[
  {
    "op": "add",
    "path": "/relations/-",
    "value": {
      "rel": "ArtifactLink",
      "url": "vstfs:///Git/PullRequestId/{projectId}%2f{repoId}%2f{prId}",
      "attributes": {
        "name": "Pull Request"
      }
    }
  }
]
```

**Implementation**:
```typescript
async linkWorkItemToPr(
  workItemId: number,
  prArtifactUrl: string,
): Promise<void> {
  // Fetch existing relations to check for duplicates
  const wi = await this.getWorkItem(workItemId, { expandRelations: true });
  const existing = (wi.relations ?? []).some(
    (r: any) => r.url === prArtifactUrl,
  );
  if (existing) return; // Already linked, skip

  await this.updateWorkItem(workItemId, [
    {
      op: "add",
      path: "/relations/-",
      value: {
        rel: "ArtifactLink",
        url: prArtifactUrl,
        attributes: { name: "Pull Request" },
      },
    },
  ]);
}
```

**Artifact URL format**:
```
vstfs:///Git/PullRequestId/{projectId}%2f{repoId}%2f{prId}
```

Where `{projectId}` and `{repoId}` can be GUIDs or project/repo names (ADO accepts both).

**How to get projectId and repoId**: Fetch the repo object via:
```
GET /_apis/git/repositories/{repo}?api-version=7.1
```
The response includes `id` (repo GUID) and `project.id` (project GUID). Cache these per session.

**Error scenarios**:
- WI not found: ADO returns 404 → caught by `request()`
- Duplicate link: Check existing relations before patching (skip if already linked)
- Invalid artifact URL format: ADO returns 400 → caught by `request()`

---

### 3.5 `getRepository` (helper, needed for repo/project IDs)

```typescript
/**
 * Get repository metadata including IDs needed for WI linking.
 *
 * @param repo - Repository name
 * @returns Object with repoId and projectId GUIDs
 */
async getRepository(repo: string): Promise<{ repoId: string; projectId: string }>
```

**ADO REST API**:
```
GET /_apis/git/repositories/{repo}?api-version=7.1
```

**Implementation**:
```typescript
async getRepository(repo: string): Promise<{ repoId: string; projectId: string }> {
  const data = await this.request<{ id: string; project: { id: string } }>(
    `/git/repositories/${encodeURIComponent(repo)}`,
  );
  return { repoId: data.id, projectId: data.project.id };
}
```

---

## 4. Tool Definitions

### 4.1 `ado_chain_prs` — Orchestration Tool

**Input Schema (Zod)**:

```typescript
const chainPrsArgs = {
  repo: z.string().describe("Target repository name"),
  workItemIds: z
    .array(z.number())
    .min(1)
    .max(50)
    .describe(
      "Ordered list of work item IDs. workItemIds[0] is the first branch in the chain, " +
      "workItemIds[1] builds on top of it, etc."
    ),
  baseBranch: z.string().optional().describe("Base branch (default: from .adoconfig.toml or 'main')"),
  strategy: z
    .enum(["feature-chain", "stacked"])
    .optional()
    .describe("Chain strategy (default: from .adoconfig.toml or 'feature-chain')"),
  prefix: z.string().optional().describe("Branch prefix (default: from .adoconfig.toml or 'feature')"),
  branchNames: z
    .array(z.string())
    .optional()
    .describe(
      "LLM-provided branch names (must match {prefix}/{wi-id}-{slug} format). " +
      "If omitted, names are derived from WI titles."
    ),
  profile: z.string().optional().describe("Profile override"),
};
```

**Execute flow** (step by step):

```
1. Load config → createClient(profile)
2. Load ProjectConfig from .adoconfig.toml (or use defaults)
3. Validate: workItemIds.length <= config.chain.max_length
4. Validate: if branchNames provided, length must equal workItemIds.length
5. Fetch all work items via getWorkItemsByIds(workItemIds)
6. Validate: all WIs exist and are accessible
7. Derive branch names:
   - If branchNames provided: validate format via BranchNameSchema
   - If omitted: generate from WI titles using slugify()
8. Get base branch tip: getBranchTip(repo, baseBranch)
9. If strategy === "feature-chain":
   a. Derive tracker name from first WI title (or config.chain.tracker_name)
   b. Create tracker branch: createBranch(repo, trackerName, baseTip)
   c. Create tracker PR: createPullRequest(repo, { targetRefName: baseBranch, isDraft: true })
10. For each WI (i = 0..N-1):
    a. Create branch from baseTip: createBranch(repo, branchNames[i], baseTip)
       (All branches point to the same commit — the base branch tip)
    b. Determine PR target:
       - feature-chain, i==0: target is tracker ref (refs/heads/{trackerName})
       - feature-chain, i>0: target is previous step's branch ref (refs/heads/{branchNames[i-1]})
       - stacked, all: target is base branch ref (refs/heads/{baseBranch})
    c. Build PR description (with Chain Context if config.pr.include_chain_context)
    d. Create PR with determined target
    e. Link WI to PR: linkWorkItemToPr(wiId, prArtifactUrl)
    f. Auto-transition WI if config.work_item.auto_transition
    g. Record step result
11. Return ChainResult summary

> **Why branches start from the same commit but PRs target the previous branch:**
> All branches are created as empty refs pointing to `baseTip`. This means every PR starts with 0 changed files. When the developer pushes code to `branch-1`, PR #1 shows only `branch-1`'s changes (diff against tracker). When they push to `branch-2`, PR #2 shows only `branch-2`'s changes (diff against `branch-1`). This keeps each PR's diff clean and focused — the core benefit of chained PRs.
```

**Error handling at each step**:
- Step 5 (WI fetch fails): Abort entire chain. Return error with list of invalid IDs.
- Step 9b (tracker branch fails): Abort. No branches created yet.
- Step 9c (tracker PR fails): Abort. Tracker branch exists but is orphaned — report it.
- Step 10a (branch creation fails, e.g. name collision): Skip this WI, continue with remaining. Report in errors[].
- Step 10d (PR creation fails): Branch was created but PR failed. Report partial state.
- Step 10e (WI link fails): PR was created but not linked. Report. Continue.

**Output format**:
```
## Chain Created: feature-chain (3 PRs)

### Tracker
- Branch: feature/auth-tracker
- PR: #100 (draft) → main

### Steps
1. ✅ #123 Auth Schema → PR #101 (linked)
2. ✅ #124 Auth API → PR #102 (linked)
3. ⚠️ #125 Auth UI → PR #103 (link failed: WI not found)

### Errors
- WI #125 link failed: Work item not found

### Summary
3 branches created, 3 PRs created, 2 WIs linked, 1 error
```

---

### 4.2 `ado_create_pr` — Single PR Tool

**Input Schema (Zod)**:

```typescript
const createPrArgs = {
  repo: z.string().describe("Repository name"),
  sourceBranch: z.string().describe("Source branch name (without refs/heads/ prefix)"),
  targetBranch: z.string().describe("Target branch name (without refs/heads/ prefix)"),
  title: z.string().describe("PR title"),
  description: z.string().optional().describe("PR description (Markdown)"),
  workItemIds: z
    .array(z.number())
    .optional()
    .describe("Work item IDs to link to this PR"),
  isDraft: z.boolean().optional().describe("Create as draft (default: from .adoconfig.toml or false)"),
  profile: z.string().optional().describe("Profile override"),
};
```

**Execute flow**:

```
1. Load config → createClient(profile)
2. Load ProjectConfig (for default_draft, require_work_item)
3. Validate: if require_work_item && !workItemIds → error
4. Create PR: createPullRequest(repo, { sourceRefName, targetRefName, title, description, isDraft })
5. If workItemIds provided:
   a. Get repo IDs: getRepository(repo)
   b. For each WI: linkWorkItemToPr(wiId, artifactUrl)
   c. Auto-transition WIs if configured
6. Return formatted summary
```

**Output format**:
```
## PR Created: #101
- Repo: my-repo
- Branch: feature/123-auth-schema → main
- Draft: yes
- Linked WIs: #123 ✅
```

---

## 5. Helper Functions

### 5.1 `buildChainContext`

```typescript
/**
 * Build the Chain Context markdown section for a PR description.
 *
 * @param params - Chain context parameters
 * @returns Markdown string to append to PR description
 */
export function buildChainContext(params: {
  chainName: string;
  strategy: "feature-chain" | "stacked";
  position: number;
  total: number;
  tracker?: { prId: number; branchName: string };
  dependsOn?: { prId: number; title: string };
  followUp?: { prId: number; title: string };
  steps: Array<{ prId?: number; title: string; wiId: number }>;
  currentIndex: number;
}): string
```

**Output**:
```markdown
## Chain Context

| Field | Value |
|-------|-------|
| Chain | auth |
| Strategy | feature-chain |
| Tracker | PR #100 (draft) |
| Position | 2 of 3 |
| Depends on | PR #101 — Auth schema |
| Follow-up | PR #103 — Auth UI |

### Dependency Diagram

main
 └── #100 Tracker (draft)
      └── #101 Auth schema
           └── 📍 #102 Auth API
                └── #103 Auth UI
```

### 5.2 `buildDependencyDiagram`

```typescript
/**
 * Build an ASCII dependency diagram with 📍 marking the current step.
 *
 * @param steps - Ordered list of chain steps
 * @param currentIndex - Index of the current step (0-based)
 * @param tracker - Optional tracker PR info (for feature-chain strategy)
 * @returns ASCII diagram string
 */
export function buildDependencyDiagram(
  steps: Array<{ prId?: number; title: string }>,
  currentIndex: number,
  tracker?: { prId: number; title: string },
): string
```

**Implementation sketch**:
```typescript
export function buildDependencyDiagram(
  steps: Array<{ prId?: number; title: string }>,
  currentIndex: number,
  tracker?: { prId: number; title: string },
): string {
  const lines: string[] = ["main"];
  
  // Build ordered list of all entries (tracker + steps)
  const entries: Array<{ label: string; isCurrent: boolean }> = [];
  
  if (tracker) {
    entries.push({
      label: `#${tracker.prId} ${tracker.title} (draft)`,
      isCurrent: false,
    });
  }
  
  for (let i = 0; i < steps.length; i++) {
    entries.push({
      label: steps[i].prId ? `#${steps[i].prId} ${steps[i].title}` : steps[i].title,
      isCurrent: i === currentIndex,
    });
  }
  
  // Each entry is indented one level deeper than the previous (linear chain)
  for (let i = 0; i < entries.length; i++) {
    const marker = entries[i].isCurrent ? "📍 " : "";
    const indent = " ".repeat(i + 1);
    lines.push(`${indent}└── ${marker}${entries[i].label}`);
  }
  
  return lines.join("\n");
}
```

### 5.3 `slugify`

```typescript
/**
 * Generate a URL-safe slug from a work item title.
 *
 * Rules:
 * 1. Lowercase
 * 2. Replace non-alphanumeric (except hyphens) with hyphens
 * 3. Collapse consecutive hyphens
 * 4. Trim leading/trailing hyphens
 * 5. Truncate to maxLength
 * 6. If truncated, trim trailing hyphen
 *
 * @param title - Work item title
 * @param maxLength - Maximum slug length (default: 40)
 * @returns URL-safe slug
 */
export function slugify(title: string, maxLength: number = 40): string
```

**Implementation**:
```typescript
export function slugify(title: string, maxLength: number = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")      // Replace non-alphanumeric with hyphens
    .replace(/-{2,}/g, "-")            // Collapse consecutive hyphens
    .replace(/^-+|-+$/g, "")           // Trim leading/trailing hyphens
    .slice(0, maxLength)               // Truncate
    .replace(/-+$/, "");               // Clean trailing hyphen after truncation
}
```

**Examples**:
| Input | Output |
|-------|--------|
| `"Add authentication schema"` | `"add-authentication-schema"` |
| `"Fix login redirect bug!!!"` | `"fix-login-redirect-bug"` |
| `"Hotfix: null pointer in payment processing system"` | `"hotfix-null-pointer-in-payment-processi"` (truncated at 40) |
| `"  spaces  everywhere  "` | `"spaces-everywhere"` |

### 5.4 `deriveBranchName`

```typescript
/**
 * Derive a full branch name from a work item.
 *
 * Format: {prefix}/{wi-id}-{slug}
 *
 * @param prefix - Branch prefix (e.g. "feature")
 * @param wiId - Work item ID
 * @param title - Work item title
 * @param slugMaxLength - Max slug length from config
 * @returns Full branch name
 */
export function deriveBranchName(
  prefix: string,
  wiId: number,
  title: string,
  slugMaxLength: number = 40,
): string {
  const slug = slugify(title, slugMaxLength);
  return `${prefix}/${wiId}-${slug}`;
}
```

### 5.5 `loadProjectConfig`

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { ProjectConfigSchema, type ProjectConfig } from "./chain-types.js";

/**
 * Load and parse .adoconfig.toml from the project root.
 * Returns default config if file doesn't exist.
 *
 * @param projectRoot - Path to the project root directory
 * @returns Validated ProjectConfig
 */
export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = join(projectRoot, ".adoconfig.toml");

  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = parse(content);
    return ProjectConfigSchema.parse(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist — return defaults
      return ProjectConfigSchema.parse({});
    }
    throw new Error(`Failed to parse .adoconfig.toml: ${(err as Error).message}`);
  }
}
```

### 5.6 `formatChainResult`

```typescript
/**
 * Format a ChainResult as a human-readable Markdown summary.
 */
export function formatChainResult(result: ChainResult): string {
  const lines: string[] = [
    `## Chain Created: ${result.strategy} (${result.created} PRs)`,
  ];

  if (result.tracker) {
    lines.push("");
    lines.push("### Tracker");
    lines.push(`- Branch: ${result.tracker.branchName}`);
    lines.push(`- PR: #${result.tracker.prId} (draft)`);
  }

  lines.push("");
  lines.push("### Steps");
  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i];
    const icon = step.error ? "⚠️" : "✅";
    const prInfo = step.pr ? `PR #${step.pr.id}` : "no PR";
    const linkInfo = step.linked ? "(linked)" : step.error ? `(${step.error})` : "(link pending)";
    lines.push(`${i + 1}. ${icon} #${step.workItemId} ${step.workItemTitle} → ${prInfo} ${linkInfo}`);
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("### Errors");
    for (const err of result.errors) {
      lines.push(`- ${err}`);
    }
  }

  lines.push("");
  lines.push("### Summary");
  lines.push(`${result.created} branches created, ${result.created} PRs created, ${result.linked} WIs linked, ${result.errors.length} errors`);

  return lines.join("\n");
}
```

---

## 6. Error Handling Strategy

### 6.1 Branch Creation Fails Mid-Chain

**Scenario**: Branch N fails (e.g. name collision) but branches 0..N-1 succeeded.

**Strategy**: **Skip and continue**. Record the error in `ChainStep.error`. Continue creating remaining branches and PRs. The caller decides whether to retry or clean up.

**Rationale**: Branches are cheap (empty refs). It's better to create what we can and report partial success than to abort and leave the user with nothing.

### 6.2 PR Creation Fails After Branch Was Created

**Scenario**: Branch exists but PR creation returns 400/409.

**Strategy**: Record the error. The branch is orphaned but harmless (it points to an existing commit). Include the branch name in the error message so the user can clean it up or retry manually.

**Cleanup**: Not automatic. Orphaned branches are listed in the result's `errors[]` array.

### 6.3 WI Linking Fails After PR Was Created

**Scenario**: PR was created successfully but `linkWorkItemToPr` fails (e.g. WI doesn't exist, permissions issue).

**Strategy**: Record the error. The PR is still valid and usable. Mark `ChainStep.linked = false` and `ChainStep.error = "WI link failed: ..."`. Continue with remaining steps.

**User action**: Manually link the WI via ADO UI, or re-run `ado_create_pr` with the `workItemIds` parameter.

### 6.4 Reporting Partial Success

The `ChainResult` object tracks:
- `steps[]` with per-step `linked` and `error` fields
- `errors[]` aggregate list
- `created` count (PRs that succeeded)
- `linked` count (WIs that were linked)

The formatted output uses ✅/⚠️ icons to make partial success visually clear.

### 6.5 Duplicate Detection

Before creating a branch, check if it already exists via `getBranchTip()`. If it does:
- If it points to the same commit as intended → skip creation, proceed to PR
- If it points to a different commit → error (branch exists with different content)

Before linking a WI, check existing relations (already in `linkWorkItemToPr` implementation).

---

## 7. File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/chain-types.ts` | All chain-related TypeScript types and Zod schemas (`ProjectConfig`, `ChainStep`, `ChainResult`, `CreatePrOptions`, `GitRefUpdateResult`, `BranchNameSchema`, `ProjectConfigSchema`) |
| `src/chain-config.ts` | `loadProjectConfig()` — parses `.adoconfig.toml` with `smol-toml` |
| `src/chain-helpers.ts` | `buildChainContext()`, `buildDependencyDiagram()`, `slugify()`, `deriveBranchName()`, `formatChainResult()` |
| `tests/chain-helpers.test.ts` | Unit tests for all helper functions |
| `tests/chain-config.test.ts` | Unit tests for config loading and validation |

### Modified Files

| File | Changes |
|------|---------|
| `src/ado-client.ts` | Add 5 new methods: `getBranchTip()`, `createBranch()`, `createPullRequest()`, `linkWorkItemToPr()`, `getRepository()`. Add `GitRefUpdateResult` import. |
| `src/index.ts` | Register 2 new tools: `ado_chain_prs` and `ado_create_pr`. Import chain helpers and types. |
| `src/shared.ts` | No changes needed — chain types live in `chain-types.ts` to keep shared.ts focused on existing ADO types. |
| `package.json` | Add `smol-toml` dependency. |
| `tsconfig.json` | No changes needed — existing config handles new `.ts` files. |

### Dependency Addition

```json
{
  "dependencies": {
    "smol-toml": "^1.3.0"
  }
}
```

`smol-toml` is chosen because:
- Tiny (~5KB), zero dependencies
- Synchronous and async parsing
- Full TOML v1.0 spec support
- Works with ESM
