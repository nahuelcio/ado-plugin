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
import { type GitPullRequest } from "./chain-types.js";
import { validateWorkItemCreation } from "./wi-create.js";
import { runCreatePr, runChainPrs } from "./chain-runner.js";
import { D } from "./tool-descriptions.js";

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

  return {
    tool: {
      [D.pr_list.name]: {
        description: D.pr_list.description,
        args: { profile: z.string().optional().describe(D.pr_list.params.profile) },
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

      [D.pr_get.name]: {
        description: D.pr_get.description,
        args: {
          repo: z.string().optional().describe(D.pr_get.params.repo),
          prId: z.number().optional().describe(D.pr_get.params.prId),
          profile: z.string().optional().describe(D.pr_get.params.profile),
        },
        async execute({ repo, prId, profile }: { repo?: string; prId?: number; profile?: string }) {
          const config = await loadConfig();
          const resolved = await resolvePrArgsAuto(config, { repo, prId, profile });
          const { client: ado, name } = await createClient(resolved.profileName);
          const pr = await ado.getPullRequest(resolved.repo, resolved.prId);
          return `## PR #${resolved.prId} ${resolved.repo} (${name})\n${fmtPRDetail(pr)}`;
        },
      },

      [D.pr_threads.name]: {
        description: D.pr_threads.description,
        args: {
          repo: z.string().optional().describe(D.pr_threads.params.repo),
          prId: z.number().optional().describe(D.pr_threads.params.prId),
          profile: z.string().optional().describe(D.pr_threads.params.profile),
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

      [D.pr_comment.name]: {
        description: D.pr_comment.description,
        args: {
          repo: z.string().optional().describe(D.pr_comment.params.repo),
          prId: z.number().optional().describe(D.pr_comment.params.prId),
          comment: z.string().describe(D.pr_comment.params.comment),
          filePath: z.string().optional().describe(D.pr_comment.params.filePath),
          line: z.number().optional().describe(D.pr_comment.params.line),
          profile: z.string().optional().describe(D.pr_comment.params.profile),
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

      [D.pr_vote.name]: {
        description: D.pr_vote.description,
        args: {
          repo: z.string().optional().describe(D.pr_vote.params.repo),
          prId: z.number().optional().describe(D.pr_vote.params.prId),
          vote: z.enum(["approve", "reject", "wait", "suggestions"]).describe(D.pr_vote.params.vote),
          comment: z.string().optional().describe(D.pr_vote.params.comment),
          profile: z.string().optional().describe(D.pr_vote.params.profile),
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

      [D.profile_get.name]: {
        description: D.profile_get.description,
        args: { profile: z.string().optional().describe(D.profile_get.params.profile) },
        async execute({ profile }: { profile?: string }) {
          const { profile: prof, name } = await createClient(profile);
          return `## Profile: ${name}\n${prof.org}/${prof.project}\nrepos: ${prof.repos.join(", ")}\npat: ${prof.patEnvVar}`;
        },
      },

      // ─── Profiles ────────────────────────────────────────────────

      [D.profile_list.name]: {
        description: D.profile_list.description,
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

      [D.profile_use.name]: {
        description: D.profile_use.description,
        args: { name: z.string().describe(D.profile_use.params.name) },
        async execute({ name }: { name: string }) {
          const config = await loadConfig();
          if (!config.profiles[name]) {
            return `Profile "${name}" not found. Available: ${Object.keys(config.profiles).join(", ")}`;
          }
          setActiveProfile(name);
          return `Profile → ${name} (${config.profiles[name].org}/${config.profiles[name].project})`;
        },
      },

      // ─── PR selection ─────────────────────────────────────────────

      [D.pr_select.name]: {
        description: D.pr_select.description,
        args: {
          repo: z.string().optional().describe(D.pr_select.params.repo),
          prId: z.number().describe(D.pr_select.params.prId),
          profile: z.string().optional().describe(D.pr_select.params.profile),
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

      // ─── PR diff & file content ───────────────────────────────────

      [D.pr_diff.name]: {
        description: D.pr_diff.description,
        args: {
          repo: z.string().optional().describe(D.pr_diff.params.repo),
          prId: z.number().optional().describe(D.pr_diff.params.prId),
          profile: z.string().optional().describe(D.pr_diff.params.profile),
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

      [D.pr_file.name]: {
        description: D.pr_file.description,
        args: {
          path: z.string().describe(D.pr_file.params.path),
          repo: z.string().optional().describe(D.pr_file.params.repo),
          prId: z.number().optional().describe(D.pr_file.params.prId),
          startLine: z.number().optional().describe(D.pr_file.params.startLine),
          endLine: z.number().optional().describe(D.pr_file.params.endLine),
          profile: z.string().optional().describe(D.pr_file.params.profile),
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

      [D.pr_context.name]: {
        description: D.pr_context.description,
        args: {
          repo: z.string().optional().describe(D.pr_context.params.repo),
          prId: z.number().optional().describe(D.pr_context.params.prId),
          profile: z.string().optional().describe(D.pr_context.params.profile),
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
            out = out.slice(0, MAX_TOTAL) + "\n⚠ Truncated. Use ado_pr_diff or ado_pr_context for details.";
          }

          return out;
        },
      },

      // ─── Work Item tools ──────────────────────────────────────────────

      [D.wi_list.name]: {
        description: D.wi_list.description,
        args: {
          state: z.string().optional().describe(D.wi_list.params.state),
          assignedTo: z.string().optional().describe(D.wi_list.params.assignedTo),
          tag: z.string().optional().describe(D.wi_list.params.tag),
          workItemType: z.string().optional().describe(D.wi_list.params.workItemType),
          profile: z.string().optional().describe(D.wi_list.params.profile),
        },
        async execute({ state, assignedTo, tag, workItemType, profile }: { state?: string; assignedTo?: string; tag?: string; workItemType?: string; profile?: string }) {
          const { client: ado, name } = await createClient(profile);

          const conditions = [`[System.State] <> 'Closed'`];
          conditions.push(assignedToCondition(assignedTo));
          if (state) conditions.push(`[System.State] = ${wiqlLiteral(state)}`);
          if (tag) conditions.push(`[System.Tags] CONTAINS ${wiqlLiteral(tag)}`);
          if (workItemType) {
            conditions.push(`[System.WorkItemType] CONTAINS ${wiqlLiteral(workItemType)}`);
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

      [D.wi_get.name]: {
        description: D.wi_get.description,
        args: {
          id: z.number().describe(D.wi_get.params.id),
          profile: z.string().optional().describe(D.wi_get.params.profile),
        },
        async execute({ id, profile }: { id: number; profile?: string }) {
          const { client: ado, name } = await createClient(profile);
          const wi = await ado.getWorkItem(id, { expandRelations: true });
          return formatWorkItemFullDetail(ado, wi, `## Work Item #${id} (${name})`);
        },
      },

      [D.wi_update.name]: {
        description: D.wi_update.description,
        args: {
          id: z.number().describe(D.wi_update.params.id),
          state: z.string().optional().describe(D.wi_update.params.state),
          priority: z.number().optional(),
          comment: z.string().optional().describe(D.wi_update.params.comment),
          profile: z.string().optional().describe(D.wi_update.params.profile),
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

      [D.wi_comment.name]: {
        description: D.wi_comment.description,
        args: {
          id: z.number().describe(D.wi_comment.params.id),
          comment: z.string().describe(D.wi_comment.params.comment),
          profile: z.string().optional().describe(D.wi_comment.params.profile),
        },
        async execute({ id, comment, profile }: { id: number; comment: string; profile?: string }) {
          const { client: ado } = await createClient(profile);
          await ado.addWorkItemComment(id, comment);
          return `#${id}: comment added`;
        },
      },

      [D.wi_types.name]: {
        description: D.wi_types.description,
        args: { profile: z.string().optional().describe(D.wi_types.params.profile) },
        async execute({ profile }: { profile?: string }) {
          const { client: ado, name } = await createClient(profile);
          const types = await ado.getWorkItemTypes();
          const out = types.map((t: any) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 60)}` : ""}`).join("\n");
          return `## WI Types (${name})\n${out}\n${types.length} types`;
        },
      },

      [D.wi_create.name]: {
        description: D.wi_create.description,
        args: {
          type: z.string().optional().describe(D.wi_create.params.type),
          title: z.string().describe(D.wi_create.params.title),
          description: z.string().optional().describe(D.wi_create.params.description),
          areaPath: z.string().optional().describe(D.wi_create.params.areaPath),
          iterationPath: z.string().optional().describe(D.wi_create.params.iterationPath),
          priority: z.number().optional(),
          assignedTo: z.string().optional().describe(D.wi_create.params.assignedTo),
          state: z.string().optional().describe(D.wi_create.params.state),
          tags: z.string().optional().describe(D.wi_create.params.tags),
          parentId: z.number().optional().describe(D.wi_create.params.parentId),
          customFields: z.record(z.string(), z.string()).optional().describe(D.wi_create.params.customFields),
          profile: z.string().optional().describe(D.wi_create.params.profile),
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
          customFields,
          profile,
        }: {
          type?: string;
          title: string;
          description?: string;
          areaPath?: string;
          iterationPath?: string;
          priority?: number;
          assignedTo?: string;
          state?: string;
          tags?: string;
          parentId?: number;
          customFields?: Record<string, string>;
          profile?: string;
        }) {
          const { client: ado, userId } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());

          // Resolve effective type: explicit arg > config default_type
          const effectiveType = type ?? config.work_item.create.default_type;

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
          const validationError = validateWorkItemCreation(config, { type: effectiveType, fields, parentId });
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
            wi = await ado.createWorkItem(effectiveType, fields, parentRelation, customFields);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error creating work item: ${msg}`;
          }

          const wiId = wi.id;
          const wiFields = wi.fields ?? {};
          const lines: string[] = [
            `## Work Item Created: #${wiId}`,
            `- Type: ${wiFields["System.WorkItemType"] ?? effectiveType}`,
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

      [D.wi_create_child.name]: {
        description: D.wi_create_child.description,
        args: {
          parentId: z.number().describe(D.wi_create_child.params.parentId),
          type: z.string().optional().describe(D.wi_create_child.params.type),
          title: z.string().describe(D.wi_create_child.params.title),
          description: z.string().optional().describe(D.wi_create_child.params.description),
          areaPath: z.string().optional().describe(D.wi_create_child.params.areaPath),
          iterationPath: z.string().optional().describe(D.wi_create_child.params.iterationPath),
          priority: z.number().optional(),
          assignedTo: z.string().optional().describe(D.wi_create_child.params.assignedTo),
          state: z.string().optional().describe(D.wi_create_child.params.state),
          tags: z.string().optional().describe(D.wi_create_child.params.tags),
          customFields: z.record(z.string(), z.string()).optional().describe(D.wi_create_child.params.customFields),
          profile: z.string().optional().describe(D.wi_create_child.params.profile),
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
          customFields,
          profile,
        }: {
          parentId: number;
          type?: string;
          title: string;
          description?: string;
          areaPath?: string;
          iterationPath?: string;
          priority?: number;
          assignedTo?: string;
          state?: string;
          tags?: string;
          customFields?: Record<string, string>;
          profile?: string;
        }) {
          const { client: ado, userId } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());

          // Resolve effective type: explicit arg > config default_type
          const effectiveType = type ?? config.work_item.create.default_type;

          const fields: Record<string, unknown> = { title };
          if (description !== undefined) fields.description = description;
          if (areaPath !== undefined) fields.areaPath = areaPath;
          if (iterationPath !== undefined) fields.iterationPath = iterationPath;
          if (priority !== undefined) fields.priority = priority;
          if (assignedTo !== undefined) fields.assignedTo = assignedTo;
          if (state !== undefined) fields.state = state;
          if (tags !== undefined) fields.tags = tags;

          // Validate — parentId always present, so require_parent is satisfied
          const validationError = validateWorkItemCreation(config, { type: effectiveType, fields, parentId });
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
            wi = await ado.createWorkItem(effectiveType, fields, parentRelation, customFields);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error creating child work item: ${msg}`;
          }

          const wiId = wi.id;
          const wiFields = wi.fields ?? {};
          const lines: string[] = [
            `## Child Work Item Created: #${wiId}`,
            `- Type: ${wiFields["System.WorkItemType"] ?? effectiveType}`,
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

      [D.wi_related.name]: {
        description: D.wi_related.description,
        args: {
          id: z.number().describe(D.wi_related.params.id),
          state: z.string().optional().describe(D.wi_related.params.state),
          workItemType: z.string().optional().describe(D.wi_related.params.workItemType),
          profile: z.string().optional().describe(D.wi_related.params.profile),
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

      [D.pr_create.name]: {
        description: D.pr_create.description,
        args: {
          repo: z.string().describe(D.pr_create.params.repo),
          sourceBranch: z.string().describe(D.pr_create.params.sourceBranch),
          targetBranch: z.string().describe(D.pr_create.params.targetBranch),
          title: z.string().describe(D.pr_create.params.title),
          description: z.string().optional().describe(D.pr_create.params.description),
          workItemIds: z.array(z.number()).optional().describe(D.pr_create.params.workItemIds),
          isDraft: z.boolean().optional(),
          profile: z.string().optional().describe(D.pr_create.params.profile),
        },
        async execute({ repo, sourceBranch, targetBranch, title, description, workItemIds, isDraft, profile }: { repo: string; sourceBranch: string; targetBranch: string; title: string; description?: string; workItemIds?: number[]; isDraft?: boolean; profile?: string }) {
          const { client: ado } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());
          return runCreatePr(ado, config, { repo, sourceBranch, targetBranch, title, description, workItemIds, isDraft });
        },
      },

      [D.pr_chain.name]: {
        description: D.pr_chain.description,
        args: {
          repo: z.string().describe(D.pr_chain.params.repo),
          workItemIds: z.array(z.number()).min(1).max(50).describe(D.pr_chain.params.workItemIds),
          baseBranch: z.string().optional().describe(D.pr_chain.params.baseBranch),
          strategy: z.enum(["feature-chain", "stacked"]).optional().describe(D.pr_chain.params.strategy),
          prefix: z.string().optional().describe(D.pr_chain.params.prefix),
          branchNames: z.array(z.string()).optional().describe(D.pr_chain.params.branchNames),
          profile: z.string().optional().describe(D.pr_chain.params.profile),
        },
        async execute({ repo, workItemIds, baseBranch, strategy, prefix, branchNames, profile }: { repo: string; workItemIds: number[]; baseBranch?: string; strategy?: "feature-chain" | "stacked"; prefix?: string; branchNames?: string[]; profile?: string }) {
          const { client: ado } = await createClient(profile);
          const config = await loadProjectConfig(process.cwd());
          return runChainPrs(ado, config, { repo, workItemIds, baseBranch, strategy, prefix, branchNames });
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
