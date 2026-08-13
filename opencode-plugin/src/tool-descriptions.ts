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
    description: "Update any work item field, custom ones included, and/or add a comment",
    params: {
      id: "Work item ID",
      title: "New title",
      description: "New description (Markdown)",
      state: "New state (e.g. Active, Closed)",
      priority: "Priority (1-4)",
      assignedTo: "Assign to user (email or display name)",
      areaPath: "Area path",
      iterationPath: "Iteration/sprint path",
      tags: "Tags (semicolon-separated, replaces existing)",
      comment: "Comment to add",
      customFields: "Extra fields, keys as full ADO paths (e.g. /fields/Custom.Sponsors). Discover them with ado_wi_fields",
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
  pr_complete: {
    name: "ado_pr_complete",
    description: "Complete (merge) a PR. Fails if the source branch moved after the last review",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      mergeStrategy: "squash (default), rebase, rebaseMerge or noFastForward",
      deleteSourceBranch: "Delete the source branch after merging (default false)",
      bypassPolicy: "Bypass branch policies (requires permission)",
      profile: "Profile override",
    },
  },
  pr_abandon: {
    name: "ado_pr_abandon",
    description: "Abandon a PR",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_publish: {
    name: "ado_pr_publish",
    description: "Turn a draft PR into a regular PR",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      profile: "Profile override",
    },
  },
  pr_reviewers: {
    name: "ado_pr_reviewers",
    description: "Add reviewers to a PR, resolved by display name or email",
    params: {
      repo: "Omit to auto-discover by PR ID",
      prId: "PR ID",
      add: "Users to add (display name or email)",
      required: "Mark them as required reviewers",
      profile: "Profile override",
    },
  },
  wi_fields: {
    name: "ado_wi_fields",
    description: "List every field of a work item type in this project, custom ones included, with data type, required flag and allowed values. Call this before creating or updating when the project has special fields",
    params: {
      type: "Work item type (e.g. User Story, Bug)",
      profile: "Profile override",
    },
  },
  wi_link: {
    name: "ado_wi_link",
    description: "Link two existing work items. Idempotent",
    params: {
      id: "Source work item ID",
      targetId: "Target work item ID",
      linkType: "parent, child, related, duplicate, successor or predecessor",
      comment: "Optional link comment",
      profile: "Profile override",
    },
  },
  wi_attach: {
    name: "ado_wi_attach",
    description: "Upload a local file and attach it to a work item",
    params: {
      id: "Work item ID",
      filePath: "Path to the local file",
      comment: "Optional attachment comment",
      profile: "Profile override",
    },
  },
  wi_query: {
    name: "ado_wi_query",
    description: "Run raw WIQL. Use it to filter by custom fields that ado_wi_list does not cover",
    params: {
      wiql: "WIQL query, e.g. SELECT [System.Id] FROM WorkItems WHERE [Custom.Classification] = 'Vulnerability'",
      profile: "Profile override",
    },
  },
  pipeline_list: {
    name: "ado_pipeline_list",
    description: "List pipelines with their IDs",
    params: {
      profile: "Profile override",
    },
  },
  pipeline_runs: {
    name: "ado_pipeline_runs",
    description: "Recent runs of a pipeline with state and result",
    params: {
      pipelineId: "Pipeline ID",
      limit: "Max runs to show (default 10)",
      profile: "Profile override",
    },
  },
  pipeline_run: {
    name: "ado_pipeline_run",
    description: "Queue a new pipeline run",
    params: {
      pipelineId: "Pipeline ID",
      branch: "Branch to run against (default: pipeline default)",
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
