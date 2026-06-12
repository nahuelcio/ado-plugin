/**
 * OpenCode ADO Plugin — V1 Module Entry Point.
 *
 *
 * Server module — PR workflow tools
 * TUI module — sidebar panel
 *
 * Config in opencode.json:
 * ```jsonc
 * {
 *   "ado": {
 *     "defaultProfile": "work",
 *     "profiles": {
 *       "work": {
 *         "org": "myorg",
 *         "project": "myproject",
 *         "patEnvVar": "ADO_PAT",
 *         "repos": ["backend", "frontend"]
 *       }
 *     }
 *   }
 * }
 * ```
 */

import type { Plugin, PluginInput, Hooks, PluginOptions, PluginModule } from "@opencode-ai/plugin";
import { z } from "zod/v4";
import type { AdoConfig, AdoProfile } from "./shared.js";
import {
  asAdoConfig,
  shortBranch,
  fmtPR,
  fmtPRDetail,
  fmtThread,
  fmtWorkItem,
  fmtWorkItemDetail,
  abbrevType,
} from "./shared.js";
import { getActiveProfile, setActiveProfile, setSelectedPr, setSelectedWi, clearSelectedWi } from "./profile-store.js";
import {
  AdoClient,
  guessLang,
  wiqlLiteral,
  assignedToCondition,
  filterLabel,
  isMatchingWorkItemType,
  chunkArray,
  formatComments,
  formatWorkItemFullDetail,
  createClientFromConfig,
  findPrAcrossProfiles,
  resolvePrArgsAuto,
  workItemIdFromUrl,
} from "./ado-client.js";
import { loadProjectConfig } from "./chain-config.js";
import { BranchNameSchema, type ChainResult, type ChainStep, type GitPullRequest } from "./chain-types.js";
import { slugify, deriveBranchName, buildChainContext, formatChainResult } from "./chain-helpers.js";
import { validateWorkItemCreation } from "./wi-create.js";

// All business logic (AdoClient + helpers) is now in ./ado-client.js
// This file only contains OpenCode-specific tool registration and config loading.

// ─── Server Plugin ────────────────────────────────────────────────────────

const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const { client } = input;

  // ─── Config loader (OpenCode-specific) ────────────────────────────
  async function loadConfig(): Promise<AdoConfig> {
    const fromOptions = asAdoConfig(options);
    if (fromOptions) return fromOptions;

    const resp = await client.config.get().catch(() => ({ data: {} }));
    const data = (resp.data ?? {}) as Record<string, unknown>;
    const ado = asAdoConfig(data["ado"]);
    if (!ado || !ado.profiles || Object.keys(ado.profiles).length === 0) {
      throw new Error("No ADO config found. Add an 'ado' section to opencode.json with profiles.");
    }
    return ado;
  }

  async function createClient(profileOverride?: string) {
    const config = await loadConfig();
    return createClientFromConfig(config, profileOverride);
  }

  // ─── Tools ───────────────────────────────────────────────────────

  const adoSchemas = {
    repo: z.string().optional().describe("Repo (omit to auto-discover by PR ID)"),
    prId: z.number().optional().describe("PR ID (auto-discovers across profiles when repo is omitted)"),
    profile: z.string().optional().describe("Profile override"),
    filePath: z.string().optional().describe("File path e.g. /src/app.ts"),
    line: z.number().optional().describe("1-based line number"),
    vote: z.enum(["approve", "reject", "wait", "suggestions"]).describe("Vote"),
    comment: z.string().describe("Comment text"),
    wiId: z.number().describe("Work item ID"),
    wiState: z.string().optional().describe("State filter (e.g. Active, New)"),
    wiAssignedTo: z.string().optional().describe("Assigned user (default: @Me)"),
    wiTag: z.string().optional().describe("Tag filter"),
    wiType: z.string().optional().describe("Type filter (partial match, e.g. 'QA Feedback' matches 'QA Feedback · Bug')"),
  };

  return {
    tool: {
      ado_prs: {
        description: "List active PRs: pending reviews + your own",
        args: { profile: adoSchemas.profile },
        async execute({ profile }: { profile?: string }) {
          const { client: ado, profile: prof, name, userId } = await createClient(profile);
          const allPRs: any[] = [];
          for (const repo of prof.repos) {
            try {
              const prs = await ado.listPullRequests(repo, { status: "active" });
              allPRs.push(...prs);
            } catch (err) {
              console.error(`Error fetching PRs from repo "${repo}":`, err instanceof Error ? err.message : String(err));
            }
          }

          const pending = allPRs.filter(pr => pr.reviewers?.some((r: any) => r.id === userId.id && r.vote === 0));
          const mine = allPRs.filter(pr => pr.createdBy?.id === userId.id);

          if (!pending.length && !mine.length) return `## PRs (${name})\nNone`;
          let out = `## PRs (${name})\n`;
          if (pending.length) { out += `\n### Review (${pending.length})\n${pending.map(fmtPR).join("\n")}\n`; }
          if (mine.length) { out += `\n### Yours (${mine.length})\n${mine.map(fmtPR).join("\n")}\n`; }
          out += `\n${allPRs.length} total · ${prof.repos.length} repos`;
          return out;
        },
      },

      ado_pr: {
        description: "PR details. Auto-discovers by PR ID across profiles",
        args: {
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, profile }: { repo?: string; prId?: number; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado, name } = await createClient(resolved.profileName);
          const pr = await ado.getPullRequest(resolved.repo, resolved.prId);
          return `## PR #${resolved.prId} ${resolved.repo} (${name})\n${fmtPRDetail(pr)}`;
        },
      },

      ado_pr_threads: {
        description: "Show PR comment threads. Auto-discovers by PR ID across profiles",
        args: {
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, profile }: { repo?: string; prId?: number; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado } = await createClient(resolved.profileName);
          const threads = await ado.getThreads(resolved.repo, resolved.prId);
          if (!threads.length) return `No threads for PR #${resolved.prId}`;
          return `## Threads #${resolved.prId} ${resolved.repo}\n${threads.map(fmtThread).join("\n")}`;
        },
      },

      ado_pr_comment: {
        description: "Add PR comment. Optional file/line attachment",
        args: {
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          comment: adoSchemas.comment,
          filePath: adoSchemas.filePath,
          line: adoSchemas.line,
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, comment, filePath, line, profile }: { repo?: string; prId?: number; comment: string; filePath?: string; line?: number; profile?: string }) {
          if (line !== undefined && !filePath) return "Provide filePath when specifying line.";
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado } = await createClient(resolved.profileName);
          await ado.createThread(resolved.repo, resolved.prId, comment, { filePath, line });
          const parts = [`PR #${resolved.prId}`, filePath && `file:${filePath}`, line !== undefined && `L${line}`].filter(Boolean);
          return `${parts.join(" ")}\ncomment: ${comment}`;
        },
      },

      ado_review: {
        description: "Vote on PR: approve, reject, wait, or suggestions",
        args: {
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          vote: adoSchemas.vote,
          comment: adoSchemas.comment.optional(),
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, vote: voteStr, comment, profile }: { repo?: string; prId?: number; vote: string; comment?: string; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado, userId } = await createClient(resolved.profileName);
          const voteMap: Record<string, number> = { approve: 10, suggestions: 5, wait: -5, reject: -10 };
          const voteValue = voteMap[voteStr];
          if (voteValue === undefined) return `Invalid vote: ${voteStr}. Use: approve, reject, wait, suggestions`;

          await ado.voteReviewer(resolved.repo, resolved.prId, userId.id, voteValue);
          if (comment) await ado.createThread(resolved.repo, resolved.prId, comment);

          const labels: Record<number, string> = { 10: "✓ Approved", 5: "✓ Suggestions", "-5": "⏳ Waiting", "-10": "✗ Rejected" };
          return `PR #${resolved.prId} ${resolved.repo}: ${labels[voteValue]}${comment ? `\ncomment: ${comment}` : ""}`;
        },
      },

      ado_profile: {
        description: "Show active profile config",
        args: { profile: adoSchemas.profile },
        async execute({ profile }: { profile?: string }) {
          const { profile: prof, name } = await createClient(profile);
          return `## Profile: ${name}\n${prof.org}/${prof.project}\nrepos: ${prof.repos.join(", ")}\npat: ${prof.patEnvVar}`;
        },
      },

      // ─── New tools: profiles ────────────────────────────────────

      ado_profiles: {
        description: "List available profiles",
        args: {},
        async execute() {
          const config = await loadConfig();
          const active = getActiveProfile();
          const lines = ["## Profiles"];
          for (const [name, p] of Object.entries(config.profiles)) {
            const marker = name === active || (!active && name === config.defaultProfile) ? " ←" : "";
            lines.push(`${name}${marker}: ${p.org}/${p.project} repos:${p.repos.length}`);
          }
          return lines.join("\n");
        },
      },

      ado_profile_use: {
        description: "Switch active profile (persists)",
        args: { name: z.string().describe("Profile name") },
        async execute({ name }: { name: string }) {
          const config = await loadConfig();
          if (!config.profiles[name]) {
            return `Profile "${name}" not found. Available: ${Object.keys(config.profiles).join(", ")}`;
          }
          setActiveProfile(name);
          return `Profile → ${name} (${config.profiles[name].org}/${config.profiles[name].project})`;
        },
      },

      // ─── New tools: selection ──────────────────────────────────────

      ado_select_pr: {
        description: "Select PR in sidebar (persists). Auto-discovers repo when only prId is provided.",
        args: {
          repo: z.string().optional().describe("Repository name (omit to auto-discover)"),
          prId: z.number().describe("PR ID"),
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, profile }: { repo?: string; prId: number; profile?: string }) {
          let resolvedRepo = repo;
          let resolvedProfile = profile;
          if (!resolvedRepo) {
            const config = await loadConfig();
            const found = await findPrAcrossProfiles(config, prId, profile);
            if (!found) {
              const scope = profile ? `profile "${profile}"` : "any repo across all profiles";
              return `PR #${prId} not found in ${scope}. Provide a repo or check the PR ID.`;
            }
            resolvedRepo = found.repo;
            resolvedProfile = found.profileName;
            setActiveProfile(found.profileName);
          }
          setSelectedPr(resolvedRepo, prId);
          return `Selected: PR #${prId} in ${resolvedRepo}`;
        },
      },

      // ─── New tools: diff & review context ──────────────────────

      ado_pr_diff: {
        description: "List changed files in PR. Auto-discovers by PR ID across profiles",
        args: {
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, profile }: { repo?: string; prId?: number; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado, name } = await createClient(resolved.profileName);

          const iterations = await ado.getIterations(resolved.repo, resolved.prId);
          if (!iterations?.length) return `No iterations for PR #${resolved.prId}`;

          const latest = iterations[iterations.length - 1];
          const changes = await ado.getIterationChanges(resolved.repo, resolved.prId, latest.id);

          if (!changes?.length) return `No changes for PR #${resolved.prId}`;

          const files = changes
            .filter((c: any) => c.item && !c.item.isFolder)
            .map((c: any) => `[${c.changeType ?? "?"}] ${c.item.path ?? "?"}`);

          return `## PR #${resolved.prId} files (${name})\n${latest.id}:${latest.sourceRefCommit?.commitId?.slice(0, 8)} ${files.length} files\n${files.join("\n")}`;
        },
      },

      // ─── New tools: file content ───────────────────────────────────

      ado_pr_file: {
        description: "Get file content from PR branch. Optional line range",
        args: {
          path: z.string().describe("File path e.g. /src/app.ts"),
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          startLine: z.number().optional().describe("Start line (1-based)"),
          endLine: z.number().optional().describe("End line (1-based)"),
          profile: adoSchemas.profile,
        },
        async execute({ path, repo, prId, startLine, endLine, profile }: { path: string; repo?: string; prId?: number; startLine?: number; endLine?: number; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado, name } = await createClient(resolved.profileName);

          const branch = await ado.getPrSourceBranch(resolved.repo, resolved.prId);
          const content = await ado.getFileContent(resolved.repo, path, branch);

          const MAX_FILE_SIZE = 15000;
          let out = `## ${path} PR#${resolved.prId} ${branch}\n`;

          if (startLine || endLine) {
            const lines = content.split("\n");
            const start = (startLine ?? 1) - 1;
            const end = endLine ?? lines.length;
            const slice = lines.slice(start, end);
            out += `L${start + 1}-${Math.min(end, lines.length)}/${lines.length}\n`;
            out += "```" + guessLang(path) + "\n";
            for (let i = 0; i < slice.length; i++) {
              out += `${String(start + 1 + i).padStart(4)}|${slice[i]}\n`;
            }
            out += "```";
          } else {
            if (content.length > MAX_FILE_SIZE) {
              out += `⚠ truncated (${content.length}→${MAX_FILE_SIZE})\n`;
              out += "```" + guessLang(path) + "\n" + content.slice(0, MAX_FILE_SIZE) + "\n```";
            } else {
              out += "```" + guessLang(path) + "\n" + content + "\n```";
            }
          }

          return out;
        },
      },

      // ─── New tools: review context ─────────────────────────────────

      ado_pr_review_context: {
        description: "Full PR review bundle: metadata, threads, files, commits",
        args: {
          repo: adoSchemas.repo,
          prId: adoSchemas.prId,
          profile: adoSchemas.profile,
        },
        async execute({ repo, prId, profile }: { repo?: string; prId?: number; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado, name } = await createClient(resolved.profileName);

          const [pr, threads, iterations, commits] = await Promise.all([
            ado.getPullRequest(resolved.repo, resolved.prId),
            ado.getThreads(resolved.repo, resolved.prId).catch(() => []),
            ado.getIterations(resolved.repo, resolved.prId).catch(() => []),
            ado.getCommits(resolved.repo, resolved.prId).catch(() => []),
          ]);

          let changedFiles: string[] = [];
          if (iterations.length) {
            const latest = iterations[iterations.length - 1];
            const changes = await ado.getIterationChanges(resolved.repo, resolved.prId, latest.id).catch(() => []);
            const entries = Array.isArray(changes) ? changes : [];
            changedFiles = entries
              .filter((c: any) => c.item && !c.item.isFolder)
              .map((c: any) => `[${c.changeType ?? "?"}] ${c.item.path ?? "?"}`);
          }

          const MAX_TOTAL = 30000;
          const vote = (v: number) => v === 10 ? "✓" : v === -10 ? "✗" : v === -5 ? "⏳" : v === 5 ? "💬" : "—";

          let out = `## PR #${resolved.prId} ${resolved.repo} (${name})\n`;
          out += `${pr.title}${pr.isDraft ? " [D]" : ""}\n`;
          out += `${pr.status} | ${shortBranch(pr.sourceRefName)}→${shortBranch(pr.targetRefName)} @${pr.createdBy?.displayName || "?"} ${pr.creationDate?.slice(0, 10) || ""}\n`;

          if (pr.reviewers?.length) {
            out += `\nreviewers: ${pr.reviewers.map((r: any) => `${vote(r.vote)} ${r.votedBy?.displayName || r.displayName || "?"}`).join(" | ")}\n`;
          }

          if (commits.length) {
            out += `\n### commits (${commits.length})\n`;
            out += commits.slice(0, 15).map((c: any) => `- ${c.commitId?.slice(0, 8)} ${(c.comment ?? "").slice(0, 60)}`).join("\n") + "\n";
          }

          if (changedFiles.length) {
            out += `\n### files (${changedFiles.length})\n${changedFiles.join("\n")}\n`;
          }

          if (threads.length) {
            out += `\n### threads (${threads.length})\n`;
            out += threads.map((t: any) => fmtThread(t)).join("\n") + "\n";
          }

          if (out.length > MAX_TOTAL) {
            out = out.slice(0, MAX_TOTAL) + "\n⚠ Truncated. Use ado_pr_diff or ado_pr_threads for details.";
          }

          return out;
        },
      },

      // ─── Work Item tools ──────────────────────────────────────────────

      ado_work_items: {
        description: "List work items. Filter: state, assignedTo, tag, type. Type matching is partial (e.g. 'QA Feedback' matches 'QA Feedback · Bug')",
        args: {
          state: adoSchemas.wiState,
          assignedTo: adoSchemas.wiAssignedTo,
          tag: adoSchemas.wiTag,
          workItemType: adoSchemas.wiType,
          profile: adoSchemas.profile,
        },
        async execute({ state, assignedTo, tag, workItemType, profile }: { state?: string; assignedTo?: string; tag?: string; workItemType?: string; profile?: string }) {
          const { client: ado, name } = await createClient(profile);

          const conditions = [`[System.State] <> 'Closed'`];
          conditions.push(assignedToCondition(assignedTo));
          if (state) conditions.push(`[System.State] = ${wiqlLiteral(state)}`);
          if (tag) conditions.push(`[System.Tags] CONTAINS ${wiqlLiteral(tag)}`);
          if (workItemType) {
            const escaped = workItemType.replace(/'/g, "''");
            conditions.push(`[System.WorkItemType] LIKE '%${escaped}%'`);
          }

          const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
          const wiqlResult = await ado.queryWiql(wiql);
          const ids = (wiqlResult.workItems ?? []).map((wi: any) => wi.id);

          const filters = [filterLabel(assignedTo), state && `state:${state}`, tag && `#${tag}`, workItemType && `type:${workItemType}`].filter(Boolean).join(" ");
          if (ids.length === 0) return `## WI (${name}) ${filters}\nNone`;

          const workItems = await ado.getWorkItemsByIds(ids);
          let out = `## WI (${name}) ${filters}\n${workItems.map(fmtWorkItem).join("\n")}\n${workItems.length} total`;
          return out;
        },
      },

      ado_work_item: {
        description: "Show work item details and comments",
        args: {
          id: adoSchemas.wiId,
          profile: adoSchemas.profile,
        },
        async execute({ id, profile }: { id: number; profile?: string }) {
          const { client: ado, name } = await createClient(profile);
          const wi = await ado.getWorkItem(id, { expandRelations: true });
          return formatWorkItemFullDetail(ado, wi, `## Work Item #${id} (${name})`);
        },
      },

      ado_work_item_update: {
        description: "Update work item: state, priority, or add comment",
        args: {
          id: adoSchemas.wiId,
          state: z.string().optional().describe("New state (e.g. Active, Closed)"),
          priority: z.number().optional().describe("New priority"),
          comment: adoSchemas.comment.optional(),
          profile: adoSchemas.profile,
        },
        async execute({ id, state, priority, comment, profile }: { id: number; state?: string; priority?: number; comment?: string; profile?: string }) {
          const { client: ado } = await createClient(profile);
          const patchOps: Array<{ op: string; path: string; value: any }> = [];
          if (state) patchOps.push({ op: "replace", path: "/fields/System.State", value: state });
          if (priority !== undefined) patchOps.push({ op: "replace", path: "/fields/Microsoft.VSTS.Common.Priority", value: priority });
          if (patchOps.length === 0 && !comment) return "No changes. Provide state, priority, or comment.";
          if (patchOps.length > 0) await ado.updateWorkItem(id, patchOps);
          if (comment) await ado.addWorkItemComment(id, comment);
          const parts = [state && `state→${state}`, priority !== undefined && `P→${priority}`, comment && "comment added"].filter(Boolean);
          return `#${id} updated: ${parts.join(", ")}`;
        },
      },

      ado_work_item_comment: {
        description: "Add comment to work item",
        args: {
          id: adoSchemas.wiId,
          comment: adoSchemas.comment,
          profile: adoSchemas.profile,
        },
        async execute({ id, comment, profile }: { id: number; comment: string; profile?: string }) {
          const { client: ado } = await createClient(profile);
          await ado.addWorkItemComment(id, comment);
          return `#${id}: comment added`;
        },
      },

      ado_work_item_types: {
        description: "List work item types (discover custom types)",
        args: { profile: adoSchemas.profile },
        async execute({ profile }: { profile?: string }) {
          const { client: ado, name } = await createClient(profile);
          const types = await ado.getWorkItemTypes();
          const out = types.map((t: any) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 60)}` : ""}`).join("\n");
          return `## WI Types (${name})\n${out}\n${types.length} types`;
        },
      },

      ado_create_work_item: {
        description: "Create a work item. Validates against project config rules (allowed types, required fields, parent requirement).",
        args: {
          type: z.string().describe("Work item type (e.g. Task, User Story, Bug)"),
          title: z.string().describe("Work item title"),
          description: z.string().optional().describe("Work item description (Markdown)"),
          areaPath: z.string().optional().describe("Area path (e.g. 'Project\\Area')"),
          iterationPath: z.string().optional().describe("Iteration/sprint path"),
          priority: z.number().optional().describe("Priority (1-4)"),
          assignedTo: z.string().optional().describe("Assign to user (email or display name)"),
          state: z.string().optional().describe("Initial state (default: from config or 'New')"),
          tags: z.string().optional().describe("Tags (semicolon-separated)"),
          parentId: z.number().optional().describe("Parent work item ID (creates hierarchy link)"),
          profile: z.string().optional().describe("Profile override"),
        },
        async execute({
          type,
          title,
          description,
          areaPath,
          iterationPath,
          priority,
          assignedTo,
          state,
          tags,
          parentId,
          profile,
        }: {
          type: string;
          title: string;
          description?: string;
          areaPath?: string;
          iterationPath?: string;
          priority?: number;
          assignedTo?: string;
          state?: string;
          tags?: string;
          parentId?: number;
          profile?: string;
        }) {
          const { client: ado, userId } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());

          // Build fields object from args
          const fields: Record<string, unknown> = { title };
          if (description !== undefined) fields.description = description;
          if (areaPath !== undefined) fields.areaPath = areaPath;
          if (iterationPath !== undefined) fields.iterationPath = iterationPath;
          if (priority !== undefined) fields.priority = priority;
          if (assignedTo !== undefined) fields.assignedTo = assignedTo;
          if (state !== undefined) fields.state = state;
          if (tags !== undefined) fields.tags = tags;

          // Validate against project config rules
          const validationError = validateWorkItemCreation(config, { type, fields, parentId });
          if (validationError) return `Error: ${validationError}`;

          // Apply config defaults
          if (!fields.state) {
            fields.state = config.work_item.create.default_state;
          }
          if (config.work_item.create.auto_assign && !fields.assignedTo) {
            fields.assignedTo = userId.displayName;
          }

          // Create work item (parent relation handled by AdoClient)
          const parentRelation = parentId
            ? { parentId, relationType: "System.LinkTypes.Hierarchy-Reverse" }
            : undefined;

          let wi: any;
          try {
            wi = await ado.createWorkItem(type, fields, parentRelation);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error creating work item: ${msg}`;
          }

          const wiId = wi.id;
          const wiFields = wi.fields ?? {};
          const lines: string[] = [
            `## Work Item Created: #${wiId}`,
            `- Type: ${wiFields["System.WorkItemType"] ?? type}`,
            `- Title: ${wiFields["System.Title"] ?? title}`,
            `- State: ${wiFields["System.State"] ?? fields.state}`,
          ];
          if (wiFields["Microsoft.VSTS.Common.Priority"] !== undefined) {
            lines.push(`- Priority: ${wiFields["Microsoft.VSTS.Common.Priority"]}`);
          }
          if (wiFields["System.AssignedTo"]?.displayName) {
            lines.push(`- Assigned: ${wiFields["System.AssignedTo"].displayName}`);
          }
          if (wiFields["System.AreaPath"]) {
            lines.push(`- Area: ${wiFields["System.AreaPath"]}`);
          }
          if (parentId) {
            lines.push(`- Parent: #${parentId}`);
          }

          return lines.join("\n");
        },
      },

      ado_create_child_work_item: {
        description: "Create a child work item under a parent. Convenience wrapper for ado_create_work_item with parentId required.",
        args: {
          parentId: z.number().describe("Parent work item ID"),
          type: z.string().describe("Work item type (e.g. Task, Bug)"),
          title: z.string().describe("Work item title"),
          description: z.string().optional().describe("Description"),
          areaPath: z.string().optional().describe("Area path"),
          iterationPath: z.string().optional().describe("Iteration/sprint path"),
          priority: z.number().optional().describe("Priority (1-4)"),
          assignedTo: z.string().optional().describe("Assign to user"),
          state: z.string().optional().describe("Initial state"),
          tags: z.string().optional().describe("Tags (semicolon-separated)"),
          profile: z.string().optional().describe("Profile override"),
        },
        async execute({
          parentId,
          type,
          title,
          description,
          areaPath,
          iterationPath,
          priority,
          assignedTo,
          state,
          tags,
          profile,
        }: {
          parentId: number;
          type: string;
          title: string;
          description?: string;
          areaPath?: string;
          iterationPath?: string;
          priority?: number;
          assignedTo?: string;
          state?: string;
          tags?: string;
          profile?: string;
        }) {
          const { client: ado, userId } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());

          const fields: Record<string, unknown> = { title };
          if (description !== undefined) fields.description = description;
          if (areaPath !== undefined) fields.areaPath = areaPath;
          if (iterationPath !== undefined) fields.iterationPath = iterationPath;
          if (priority !== undefined) fields.priority = priority;
          if (assignedTo !== undefined) fields.assignedTo = assignedTo;
          if (state !== undefined) fields.state = state;
          if (tags !== undefined) fields.tags = tags;

          // Validate — parentId always present, so require_parent is satisfied
          const validationError = validateWorkItemCreation(config, { type, fields, parentId });
          if (validationError) return `Error: ${validationError}`;

          // Apply config defaults
          if (!fields.state) {
            fields.state = config.work_item.create.default_state;
          }
          if (config.work_item.create.auto_assign && !fields.assignedTo) {
            fields.assignedTo = userId.displayName;
          }

          const parentRelation = { parentId, relationType: "System.LinkTypes.Hierarchy-Reverse" };

          let wi: any;
          try {
            wi = await ado.createWorkItem(type, fields, parentRelation);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error creating child work item: ${msg}`;
          }

          const wiId = wi.id;
          const wiFields = wi.fields ?? {};
          const lines: string[] = [
            `## Child Work Item Created: #${wiId}`,
            `- Type: ${wiFields["System.WorkItemType"] ?? type}`,
            `- Title: ${wiFields["System.Title"] ?? title}`,
            `- State: ${wiFields["System.State"] ?? fields.state}`,
            `- Parent: #${parentId}`,
          ];
          if (wiFields["Microsoft.VSTS.Common.Priority"] !== undefined) {
            lines.push(`- Priority: ${wiFields["Microsoft.VSTS.Common.Priority"]}`);
          }
          if (wiFields["System.AssignedTo"]?.displayName) {
            lines.push(`- Assigned: ${wiFields["System.AssignedTo"].displayName}`);
          }
          if (wiFields["System.AreaPath"]) {
            lines.push(`- Area: ${wiFields["System.AreaPath"]}`);
          }

          return lines.join("\n");
        },
      },

      ado_related_work_items: {
        description: "List related work items with summary + details",
        args: {
          id: adoSchemas.wiId,
          state: adoSchemas.wiState,
          workItemType: adoSchemas.wiType,
          profile: adoSchemas.profile,
        },
        async execute({ id, state, workItemType, profile }: { id: number; state?: string; workItemType?: string; profile?: string }) {
          const { client: ado, name } = await createClient(profile);
          const parent = await ado.getWorkItem(id, { expandRelations: true });
          const relationIds = [
            ...new Set((parent.relations ?? [])
              .map((rel: any) => workItemIdFromUrl(rel.url))
              .filter((relatedId: number | undefined) => relatedId !== undefined)),
          ] as number[];

          const relatedItems = relationIds.length
            ? await ado.getWorkItemsByIds(relationIds, [
              "System.Id", "System.Title", "System.State", "System.WorkItemType",
              "System.AssignedTo", "Microsoft.VSTS.Common.Priority", "System.ChangedDate",
            ])
            : [];

          let filtered = relatedItems.filter((wi: any) => isMatchingWorkItemType(wi, workItemType));
          if (state) filtered = filtered.filter((wi: any) => wi.fields?.["System.State"] === state);

          let out = `## Related for #${id} (${name})\n`;
          out += fmtWorkItemDetail(parent) + "\n";
          const filters = [workItemType && `type:${workItemType}`, state && `state:${state}`].filter(Boolean).join(" ");
          if (filters) out += `filters: ${filters}\n`;
          out += `${filtered.length} related\n`;
          if (!filtered.length) return out + "None";

          out += "### Summary\n" + filtered.map((wi: any) => fmtWorkItem(wi)).join("\n") + "\n";
          out += "### Details\n";
          const detailBlocks: string[] = [];
          const DETAIL_BATCH_SIZE = 5;
          const batches = chunkArray(filtered, DETAIL_BATCH_SIZE);
          for (const batch of batches) {
            const fullBatch = await Promise.all(batch.map((wi: any) => ado.getWorkItem(wi.id, { expandRelations: true })));
            const formatted = await Promise.all(
              fullBatch.map(async (full: any) => {
                const detail = await formatWorkItemFullDetail(ado, full, `## #${full.id}`);
                return detail;
              }),
            );
            detailBlocks.push(...formatted);
          }
          out += detailBlocks.join("\n---\n");
          return out;
        },
      },

      // ─── Chained PRs tools ─────────────────────────────────────────────

      ado_create_pr: {
        description: "Create a single PR with optional work item linking and auto-transition",
        args: {
          repo: z.string().describe("Repository name"),
          sourceBranch: z.string().describe("Source branch name (without refs/heads/ prefix)"),
          targetBranch: z.string().describe("Target branch name (without refs/heads/ prefix)"),
          title: z.string().describe("PR title"),
          description: z.string().optional().describe("PR description (Markdown)"),
          workItemIds: z.array(z.number()).optional().describe("Work item IDs to link to this PR"),
          isDraft: z.boolean().optional().describe("Create as draft"),
          profile: z.string().optional().describe("Profile override"),
        },
        async execute({
          repo,
          sourceBranch,
          targetBranch,
          title,
          description,
          workItemIds,
          isDraft,
          profile,
        }: {
          repo: string;
          sourceBranch: string;
          targetBranch: string;
          title: string;
          description?: string;
          workItemIds?: number[];
          isDraft?: boolean;
          profile?: string;
        }) {
          const { client: ado } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());

          if (config.pr.require_work_item && (!workItemIds || workItemIds.length === 0)) {
            return "Error: .adoconfig.toml requires at least one work item. Provide workItemIds or disable pr.require_work_item.";
          }

          const draft = isDraft ?? config.pr.default_draft;

          const pr = await ado.createPullRequest(repo, {
            sourceRefName: `refs/heads/${sourceBranch}`,
            targetRefName: `refs/heads/${targetBranch}`,
            title,
            description: description ?? "",
            isDraft: draft,
          });

          const lines: string[] = [
            `## PR Created: #${pr.pullRequestId}`,
            `- Repo: ${repo}`,
            `- Branch: ${sourceBranch} → ${targetBranch}`,
            `- Draft: ${draft ? "yes" : "no"}`,
          ];

          if (workItemIds && workItemIds.length > 0) {
            const { repoId, projectId } = await ado.getRepository(repo);
            const linkResults: string[] = [];

            for (const wiId of workItemIds) {
              try {
                const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pr.pullRequestId}`;
                await ado.linkWorkItemToPr(wiId, artifactUrl);

                if (config.work_item.auto_transition) {
                  await ado.updateWorkItem(wiId, [
                    { op: "replace", path: "/fields/System.State", value: config.work_item.target_state },
                  ]);
                  linkResults.push(`#${wiId} ✅ (linked, → ${config.work_item.target_state})`);
                } else {
                  linkResults.push(`#${wiId} ✅`);
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                linkResults.push(`#${wiId} ❌ (${msg})`);
              }
            }

            lines.push(`- Linked WIs: ${linkResults.join(", ")}`);
          }

          return lines.join("\n");
        },
      },

      ado_chain_prs: {
        description: "Create a chain of PRs from ordered work items. Supports feature-chain (tracker branch + children) and stacked (each targets base) strategies.",
        args: {
          repo: z.string().describe("Target repository name"),
          workItemIds: z
            .array(z.number())
            .min(1)
            .max(50)
            .describe("Ordered list of work item IDs. WI[0] = first branch, WI[1] builds on it, etc."),
          baseBranch: z.string().optional().describe("Base branch (default: from .adoconfig.toml or 'main')"),
          strategy: z.enum(["feature-chain", "stacked"]).optional().describe("Chain strategy (default: from .adoconfig.toml or 'feature-chain')"),
          prefix: z.string().optional().describe("Branch prefix (default: from .adoconfig.toml or 'feature')"),
          branchNames: z.array(z.string()).optional().describe("LLM-provided branch names. If omitted, derived from WI titles."),
          profile: z.string().optional().describe("Profile override"),
        },
        async execute({
          repo,
          workItemIds,
          baseBranch,
          strategy,
          prefix,
          branchNames,
          profile,
        }: {
          repo: string;
          workItemIds: number[];
          baseBranch?: string;
          strategy?: "feature-chain" | "stacked";
          prefix?: string;
          branchNames?: string[];
          profile?: string;
        }) {
          const { client: ado } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());

          // Resolve effective values
          const effectiveStrategy = strategy ?? config.chain.strategy;
          const effectiveBase = baseBranch ?? config.chain.base_branch;
          const effectivePrefix = prefix ?? config.chain.prefix;

          // Validate chain length
          if (workItemIds.length > config.chain.max_length) {
            return `Error: Chain length ${workItemIds.length} exceeds max ${config.chain.max_length} (from .adoconfig.toml). Split into smaller chains.`;
          }

          // Validate branchNames length
          if (branchNames && branchNames.length !== workItemIds.length) {
            return `Error: branchNames length (${branchNames.length}) must match workItemIds length (${workItemIds.length}).`;
          }

          // Fetch all work items
          const workItems = await ado.getWorkItemsByIds(workItemIds);
          const fetchedById = new Map(workItems.map((wi: any) => [wi.id, wi]));
          const missingIds = workItemIds.filter((id) => !fetchedById.has(id));
          if (missingIds.length > 0) {
            return `Error: Work items not found or inaccessible: ${missingIds.join(", ")}`;
          }

          // Derive branch names
          const resolvedBranchNames: string[] = [];
          if (branchNames) {
            for (const name of branchNames) {
              const parsed = BranchNameSchema.safeParse(name);
              if (!parsed.success) {
                return `Error: Invalid branch name "${name}": ${parsed.error.issues.map((i) => i.message).join(", ")}`;
              }
              resolvedBranchNames.push(name);
            }
          } else {
            for (const wiId of workItemIds) {
              const wi = fetchedById.get(wiId);
              const wiTitle = wi?.fields?.["System.Title"] ?? `wi-${wiId}`;
              resolvedBranchNames.push(
                deriveBranchName(effectivePrefix, wiId, wiTitle, config.branch.slug_max_length),
              );
            }

            // Validate auto-derived branch names — slugify() returns "" for empty
            // or all-special-char titles, producing invalid names like "feature/123-".
            // Fallback to "{prefix}/{wiId}-wi-{wiId}" which always passes BranchNameSchema.
            for (let idx = 0; idx < resolvedBranchNames.length; idx++) {
              const parsed = BranchNameSchema.safeParse(resolvedBranchNames[idx]);
              if (!parsed.success) {
                resolvedBranchNames[idx] = `${effectivePrefix}/${workItemIds[idx]}-wi-${workItemIds[idx]}`;
              }
            }
          }

          // Get base branch tip
          const baseTip = await ado.getBranchTip(repo, effectiveBase);

          // Get repo metadata
          const { repoId, projectId } = await ado.getRepository(repo);

          // Build result structure
          const result: ChainResult = {
            strategy: effectiveStrategy,
            steps: [],
            created: 0,
            linked: 0,
            errors: [],
          };

          // Feature-chain: create tracker branch and PR
          if (effectiveStrategy === "feature-chain") {
            let trackerName: string;
            if (config.chain.tracker_name) {
              trackerName = config.chain.tracker_name;
            } else {
              const firstWi = fetchedById.get(workItemIds[0]);
              const firstTitle = firstWi?.fields?.["System.Title"] ?? "tracker";
              const trackerSlug = slugify(firstTitle, 40);
              trackerName = `${effectivePrefix}/${trackerSlug}`;
            }

            try {
              await ado.createBranch(repo, trackerName, baseTip);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return `Error: Failed to create tracker branch "${trackerName}": ${msg}`;
            }

            let trackerPr: any;
            try {
              trackerPr = await ado.createPullRequest(repo, {
                sourceRefName: `refs/heads/${trackerName}`,
                targetRefName: `refs/heads/${effectiveBase}`,
                title: `Tracker: ${trackerName}`,
                description: `Tracker branch for chained PRs (${workItemIds.length} work items)`,
                isDraft: true,
              });

              result.tracker = {
                branchName: trackerName,
                prId: trackerPr.pullRequestId,
                prUrl: trackerPr.url ?? "",
                targetBranch: effectiveBase,
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return `Error: Tracker branch "${trackerName}" created, but tracker PR failed: ${msg}. Orphaned tracker branch exists — delete manually if needed.`;
            }
          }

          // Create branches and PRs for each work item
          for (let i = 0; i < workItemIds.length; i++) {
            const wiId = workItemIds[i];
            const wi = fetchedById.get(wiId);
            const wiTitle = wi?.fields?.["System.Title"] ?? `WI #${wiId}`;
            const branchName = resolvedBranchNames[i];

            const step: ChainStep = {
              workItemId: wiId,
              workItemTitle: wiTitle,
              branchName,
              refName: `refs/heads/${branchName}`,
              parentRefName: `refs/heads/${effectiveBase}`,
              linked: false,
            };

            // Create branch (with duplicate detection — ADR 0002 §6.5)
            try {
              const existingTip = await ado.getBranchTip(repo, branchName);
              if (existingTip === baseTip) {
                // Branch exists and points to same commit — skip creation, proceed to PR
              } else {
                step.error = `Branch "${branchName}" already exists with different content`;
                result.steps.push(step);
                result.errors.push(`WI #${wiId} (${branchName}): ${step.error}`);
                continue;
              }
            } catch {
              // Branch doesn't exist — create it
              await ado.createBranch(repo, branchName, baseTip);
            }

            // Determine PR target — find last successful branch for feature-chain
            let prTargetRef: string;
            if (effectiveStrategy === "feature-chain") {
              if (i === 0 && result.tracker) {
                prTargetRef = `refs/heads/${result.tracker.branchName}`;
              } else if (i > 0) {
                // Walk backwards to find the last successful step's branch
                prTargetRef = `refs/heads/${result.tracker?.branchName ?? effectiveBase}`;
                for (let j = i - 1; j >= 0; j--) {
                  if (result.steps[j].pr) {
                    prTargetRef = result.steps[j].refName;
                    break;
                  }
                }
              } else {
                prTargetRef = `refs/heads/${effectiveBase}`;
              }
            } else {
              prTargetRef = `refs/heads/${effectiveBase}`;
            }
            step.parentRefName = prTargetRef;

            // Build PR title and description
            const prTitle = `${wiTitle} — WI #${wiId}`;
            let prDescription = "";

            if (config.pr.include_chain_context) {
              const stepsForContext = workItemIds.map((id, idx) => ({
                wiId: id,
                title: fetchedById.get(id)?.fields?.["System.Title"] ?? `WI #${id}`,
                prId: idx < result.steps.length ? result.steps[idx].pr?.id : undefined,
              }));

              const dependsOn = i > 0 && result.steps[i - 1]?.pr
                ? { prId: result.steps[i - 1].pr!.id, title: result.steps[i - 1].workItemTitle }
                : undefined;

              // Follow-up PR may not exist yet during forward creation, so omit it

              prDescription = buildChainContext({
                chainName: resolvedBranchNames[0],
                strategy: effectiveStrategy,
                position: i + 1,
                total: workItemIds.length,
                tracker: result.tracker
                  ? { prId: result.tracker.prId, branchName: result.tracker.branchName }
                  : undefined,
                dependsOn,
                followUp: undefined,
                steps: stepsForContext,
                currentIndex: i,
              });
            }

            // Create PR
            try {
              const pr = await ado.createPullRequest(repo, {
                sourceRefName: step.refName,
                targetRefName: prTargetRef,
                title: prTitle,
                description: prDescription,
                isDraft: config.pr.default_draft,
              });

              step.pr = {
                id: pr.pullRequestId,
                url: pr.url ?? "",
              };
              result.created++;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              step.error = `PR creation failed: ${msg}`;
              result.steps.push(step);
              result.errors.push(`WI #${wiId} (${branchName}): ${step.error}`);
              continue;
            }

            // Link WI to PR
            try {
              const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${step.pr!.id}`;
              await ado.linkWorkItemToPr(wiId, artifactUrl);
              step.linked = true;
              result.linked++;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              step.error = `WI link failed: ${msg}`;
              result.errors.push(`WI #${wiId}: ${step.error}`);
            }

            // Auto-transition work item if configured
            if (config.work_item.auto_transition) {
              try {
                await ado.updateWorkItem(wiId, [
                  { op: "replace", path: "/fields/System.State", value: config.work_item.target_state },
                ]);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result.errors.push(`WI #${wiId} auto-transition failed: ${msg}`);
              }
            }

            result.steps.push(step);
          }

          return formatChainResult(result);
        },
      },
    },
  };
};

const pluginModule: PluginModule & { id: string } = {
  id: "@nahuelcio/opencode-ado",
  server,
};

export default pluginModule;
export { server };
