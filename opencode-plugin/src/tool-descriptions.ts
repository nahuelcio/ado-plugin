/**
 * Single source of truth for all tool names, descriptions, and parameter descriptions.
 * Shared between index.ts (OpenCode plugin) and pi-entry.ts (Pi extension).
 */

export const D = {
  pr_list: {
    name: "ado_pr_list",
    description: "List active PRs: pending reviews + your own",
    params: {
      profile: "Profile override",
    },
  },
  pr_get: {
    name: "ado_pr_get",
    description: "PR details",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_threads: {
    name: "ado_pr_threads",
    description: "Show PR comment threads",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_comment: {
    name: "ado_pr_comment",
    description: "Add PR comment. Optional file/line attachment",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      filePath: "File path e.g. /src/app.ts",
      line: "1-based line number",
      profile: "Profile override",
    },
  },
  pr_vote: {
    name: "ado_pr_vote",
    description: "Vote on PR: approve, reject, wait, or suggestions",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_select: {
    name: "ado_pr_select",
    description: "Select PR in sidebar (persists)",
    params: {
      repo: "Repository name (omit to auto-discover)",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_diff: {
    name: "ado_pr_diff",
    description: "List changed files in PR",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_file: {
    name: "ado_pr_file",
    description: "Get file content from PR branch. Optional line range",
    params: {
      path: "File path e.g. /src/app.ts",
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      startLine: "Start line (1-based)",
      endLine: "End line (1-based)",
      profile: "Profile override",
    },
  },
  pr_context: {
    name: "ado_pr_context",
    description: "Full PR review bundle: metadata, threads, files, commits",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_create: {
    name: "ado_pr_create",
    description: "Create a single PR with optional work item linking and auto-transition",
    params: {
      repo: "Repository name",
      sourceBranch: "Source branch name (without refs/heads/ prefix)",
      targetBranch: "Target branch name (without refs/heads/ prefix)",
      description: "PR description (Markdown)",
      workItemIds: "Work item IDs to link to this PR",
      isDraft: "Create as draft",
      profile: "Profile override",
    },
  },
  pr_chain: {
    name: "ado_pr_chain",
    description: "Create a chain of PRs from ordered work items (feature-chain or stacked strategy)",
    params: {
      repo: "Target repository name",
      workItemIds: "Ordered list of work item IDs. WI[0] = first branch, WI[1] builds on it, etc.",
      baseBranch: "Base branch (default: from .adoconfig.toml or 'main')",
      strategy: "Chain strategy (default: from .adoconfig.toml or 'feature-chain')",
      prefix: "Branch prefix (default: from .adoconfig.toml or 'feature')",
      branchNames: "LLM-provided branch names. If omitted, derived from WI titles.",
      profile: "Profile override",
    },
  },
  wi_list: {
    name: "ado_wi_list",
    description: "List work items. Filter: state, assignedTo, tag, type",
    params: {
      state: "State filter (e.g. Active, New)",
      assignedTo: "Assigned user (default: @Me)",
      tag: "Tag filter",
      workItemType: "Type filter (partial match)",
      profile: "Profile override",
    },
  },
  wi_get: {
    name: "ado_wi_get",
    description: "Show work item details and comments",
    params: {
      id: "Work item ID",
      profile: "Profile override",
    },
  },
  wi_update: {
    name: "ado_wi_update",
    description: "Update work item: state, priority, or add comment",
    params: {
      id: "Work item ID",
      state: "New state (e.g. Active, Closed)",
      profile: "Profile override",
    },
  },
  wi_comment: {
    name: "ado_wi_comment",
    description: "Add comment to work item",
    params: {
      id: "Work item ID",
      profile: "Profile override",
    },
  },
  wi_types: {
    name: "ado_wi_types",
    description: "List work item types (discover custom types)",
    params: {
      profile: "Profile override",
    },
  },
  wi_create: {
    name: "ado_wi_create",
    description: "Create work item (validated against .adoconfig.toml rules)",
    params: {
      type: "Work item type (e.g. Task, User Story, Bug). Defaults to config default_type.",
      description: "Work item description (Markdown)",
      areaPath: "Area path (e.g. 'Project\\Area')",
      iterationPath: "Iteration/sprint path",
      priority: "Priority (1-4)",
      assignedTo: "Assign to user (email or display name)",
      state: "Initial state (default: from config or 'New')",
      tags: "Tags (semicolon-separated)",
      parentId: "Parent work item ID (creates hierarchy link)",
      customFields: "Extra fields, keys as full ADO paths (e.g. /fields/Custom.Sponsors)",
      profile: "Profile override",
    },
  },
  wi_create_child: {
    name: "ado_wi_create_child",
    description: "Create a child work item under a parent",
    params: {
      parentId: "Parent work item ID",
      type: "Work item type (e.g. Task, Bug). Defaults to config default_type.",
      description: "Description (Markdown)",
      areaPath: "Area path",
      iterationPath: "Iteration/sprint path",
      priority: "Priority (1-4)",
      assignedTo: "Assign to user",
      state: "Initial state",
      tags: "Tags (semicolon-separated)",
      customFields: "Extra fields, keys as full ADO paths (e.g. /fields/Custom.Sponsors)",
      profile: "Profile override",
    },
  },
  wi_related: {
    name: "ado_wi_related",
    description: "List related work items with summary + details",
    params: {
      id: "Work item ID",
      state: "State filter (e.g. Active, New)",
      workItemType: "Type filter (partial match)",
      profile: "Profile override",
    },
  },
  profile_get: {
    name: "ado_profile_get",
    description: "Show active profile config",
    params: {
      profile: "Profile override",
    },
  },
  profile_list: {
    name: "ado_profile_list",
    description: "List available profiles",
    params: {},
  },
  profile_use: {
    name: "ado_profile_use",
    description: "Switch active profile (persists)",
    params: {
      name: "Profile name",
    },
  },
} as const;
