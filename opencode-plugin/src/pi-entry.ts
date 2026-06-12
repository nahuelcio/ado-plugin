/**
 * Pi Extension — Azure DevOps integration for pi.dev
 *
 * Provides the same ~20 ADO tools as the OpenCode plugin,
 * adapted to the Pi extension API:
 *   - pi.registerTool() with TypeBox schemas
 *   - pi.registerCommand() for /ado commands
 *   - pi.on("session_start") for config loading
 *   - ctx.ui.setWidget() for persistent status display
 *   - ctx.ui.custom() for interactive overlays (profile switch, etc.)
 *
 * Config lives in:
 *   ~/.azure-devops-cli/config.json  (shared with OpenCode plugin)
 *   OR .pi/settings.json under "ado" key (project-local)
 *   OR ~/.pi/agent/settings.json under "ado" key (global)
 *
 * Install:
 *   pi install npm:@nahuelcio/pi-ado
 *   OR copy to ~/.pi/agent/extensions/pi-ado/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { AdoConfig } from "./shared.js";
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
import {
  setActiveProfile,
  getActiveProfile,
  setSelectedPr,
  getSelectedPr,
  setSelectedWi,
  clearSelectedWi,
  getViewMode,
  setViewMode,
} from "./profile-store.js";
import {
  AdoClient,
  guessLang,
  wiqlLiteral,
  assignedToCondition,
  filterLabel,
  isMatchingWorkItemType,
  chunkArray,
  formatWorkItemFullDetail,
  createClientFromConfig,
  findPrAcrossProfiles,
  resolvePrArgsAuto,
  workItemIdFromUrl,
} from "./ado-client.js";

// ─── Config Loading (Pi-specific) ────────────────────────────────────────

const ADO_CONFIG_DIR = join(homedir(), ".azure-devops-cli");
const ADO_CONFIG_FILE = join(ADO_CONFIG_DIR, "config.json");

/** Read ADO config from Pi settings or ~/.azure-devops-cli/config.json */
function loadPiConfig(cwd?: string): AdoConfig {
  // 1. Try project-local .pi/settings.json
  if (cwd) {
    const projectSettings = join(cwd, ".pi", "settings.json");
    const config = tryReadAdoConfig(projectSettings);
    if (config) return config;
  }

  // 2. Try global ~/.pi/agent/settings.json
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const globalSettings = join(agentDir, "settings.json");
  const globalConfig = tryReadAdoConfig(globalSettings);
  if (globalConfig) return globalConfig;

  // 3. Try ~/.azure-devops-cli/config.json (shared with OpenCode plugin)
  if (existsSync(ADO_CONFIG_FILE)) {
    try {
      const raw = readFileSync(ADO_CONFIG_FILE, "utf-8");
      const data = JSON.parse(raw);
      const ado = asAdoConfig(data);
      if (ado?.profiles && Object.keys(ado.profiles).length > 0) return ado;
    } catch { /* ignore */ }
  }

  throw new Error(
    "No ADO config found. Create ~/.azure-devops-cli/config.json with profiles, " +
    "or add an 'ado' section to .pi/settings.json.\n" +
    "Example: { \"ado\": { \"profiles\": { \"work\": { \"org\": \"myorg\", \"project\": \"myproject\", \"patEnvVar\": \"AZURE_DEVOPS_PAT\", \"repos\": [\"backend\"] } } } }"
  );
}

function tryReadAdoConfig(settingsPath: string): AdoConfig | undefined {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const data = JSON.parse(raw);
    const ado = asAdoConfig(data["ado"] ?? data);
    if (ado?.profiles && Object.keys(ado.profiles).length > 0) return ado;
  } catch { /* ignore */ }
  return undefined;
}

// ─── TypeBox Schemas ──────────────────────────────────────────────────────

const S = {
  repo: Type.Optional(Type.String({ description: "Repo name (omit to auto-discover by PR ID)" })),
  prId: Type.Optional(Type.Number({ description: "PR ID (auto-discovers across profiles when repo is omitted)" })),
  profile: Type.Optional(Type.String({ description: "Profile override" })),
  filePath: Type.Optional(Type.String({ description: "File path e.g. /src/app.ts" })),
  line: Type.Optional(Type.Number({ description: "1-based line number" })),
  vote: StringEnum(["approve", "reject", "wait", "suggestions"], { description: "Vote" }),
  comment: Type.String({ description: "Comment text" }),
  wiId: Type.Number({ description: "Work item ID" }),
  wiState: Type.Optional(Type.String({ description: "State filter (e.g. Active, New)" })),
  wiAssignedTo: Type.Optional(Type.String({ description: "Assigned user (default: @Me)" })),
  wiTag: Type.Optional(Type.String({ description: "Tag filter" })),
  wiType: Type.Optional(Type.String({ description: "Type filter (partial match)" })),
};

// ─── Extension Factory ────────────────────────────────────────────────────

export default function adoExtension(pi: ExtensionAPI) {
  // Cache config per session
  let cachedConfig: AdoConfig | undefined;

  function getConfig(cwd?: string): AdoConfig {
    if (cachedConfig) return cachedConfig;
    cachedConfig = loadPiConfig(cwd);
    return cachedConfig;
  }

  async function createClient(profileOverride?: string) {
    const cwd = process.cwd();
    const config = getConfig(cwd);
    return createClientFromConfig(config, profileOverride);
  }

  // ─── Reload config on session start ──────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Reset cached config for new sessions
    cachedConfig = undefined;
    try {
      const config = getConfig(ctx.cwd);
      const activeProfile = getActiveProfile();
      const profileNames = Object.keys(config.profiles);
      if (activeProfile && config.profiles[activeProfile]) {
        ctx.ui.setStatus("ado", `ADO: ${activeProfile} (${config.profiles[activeProfile].project})`);
      } else if (profileNames.length > 0) {
        ctx.ui.setStatus("ado", `ADO: ${profileNames.length} profile(s)`);
      }
    } catch {
      ctx.ui.setStatus("ado", "ADO: no config");
    }
  });

  // ─── Tool: ado_prs ──────────────────────────────────────────────

  pi.registerTool({
    name: "ado_prs",
    label: "ADO PRs",
    description: "List active PRs: pending reviews + your own",
    promptSnippet: "List Azure DevOps pull requests",
    parameters: Type.Object({
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, profile: prof, name, userId } = await createClient(params.profile);
      const allPRs: any[] = [];
      for (const repo of prof.repos) {
        try {
          const prs = await ado.listPullRequests(repo, { status: "active" });
          allPRs.push(...prs);
        } catch { /* skip repo */ }
      }

      const pending = allPRs.filter(pr => pr.reviewers?.some((r: any) => r.id === userId.id && r.vote === 0));
      const mine = allPRs.filter(pr => pr.createdBy?.id === userId.id);

      if (!pending.length && !mine.length) return { content: [{ type: "text", text: `## PRs (${name})\nNone` }], details: {} };
      let out = `## PRs (${name})\n`;
      if (pending.length) { out += `\n### Review (${pending.length})\n${pending.map(fmtPR).join("\n")}\n`; }
      if (mine.length) { out += `\n### Yours (${mine.length})\n${mine.map(fmtPR).join("\n")}\n`; }
      out += `\n${allPRs.length} total · ${prof.repos.length} repos`;
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Tool: ado_pr ──────────────────────────────────────────────

  pi.registerTool({
    name: "ado_pr",
    label: "ADO PR Details",
    description: "PR details. Auto-discovers by PR ID across profiles",
    promptSnippet: "Show Azure DevOps pull request details",
    parameters: Type.Object({
      repo: S.repo,
      prId: S.prId,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado, name } = await createClient(resolved.profileName);
      const pr = await ado.getPullRequest(resolved.repo, resolved.prId);
      return { content: [{ type: "text", text: `## PR #${resolved.prId} ${resolved.repo} (${name})\n${fmtPRDetail(pr)}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_threads ──────────────────────────────────────

  pi.registerTool({
    name: "ado_pr_threads",
    label: "ADO PR Threads",
    description: "Show PR comment threads. Auto-discovers by PR ID",
    promptSnippet: "Show Azure DevOps PR comment threads",
    parameters: Type.Object({
      repo: S.repo,
      prId: S.prId,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado } = await createClient(resolved.profileName);
      const threads = await ado.getThreads(resolved.repo, resolved.prId);
      if (!threads.length) return { content: [{ type: "text", text: `No threads for PR #${resolved.prId}` }], details: {} };
      return { content: [{ type: "text", text: `## Threads #${resolved.prId} ${resolved.repo}\n${threads.map(fmtThread).join("\n")}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_comment ──────────────────────────────────────

  pi.registerTool({
    name: "ado_pr_comment",
    label: "ADO PR Comment",
    description: "Add PR comment. Optional file/line attachment",
    promptSnippet: "Add comment to Azure DevOps PR",
    parameters: Type.Object({
      repo: S.repo,
      prId: S.prId,
      comment: S.comment,
      filePath: S.filePath,
      line: S.line,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.line !== undefined && !params.filePath) {
        return { content: [{ type: "text", text: "Provide filePath when specifying line." }], isError: true, details: {} };
      }
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado } = await createClient(resolved.profileName);
      await ado.createThread(resolved.repo, resolved.prId, params.comment, { filePath: params.filePath, line: params.line });
      const parts = [`PR #${resolved.prId}`, params.filePath && `file:${params.filePath}`, params.line !== undefined && `L${params.line}`].filter(Boolean);
      return { content: [{ type: "text", text: `${parts.join(" ")}\ncomment: ${params.comment}` }], details: {} };
    },
  });

  // ─── Tool: ado_review ──────────────────────────────────────────

  pi.registerTool({
    name: "ado_review",
    label: "ADO Review",
    description: "Vote on PR: approve, reject, wait, or suggestions",
    promptSnippet: "Vote on Azure DevOps pull request",
    parameters: Type.Object({
      repo: S.repo,
      prId: S.prId,
      vote: S.vote,
      comment: Type.Optional(S.comment),
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado, userId } = await createClient(resolved.profileName);
      const voteMap: Record<string, number> = { approve: 10, suggestions: 5, wait: -5, reject: -10 };
      const voteValue = voteMap[params.vote];
      if (voteValue === undefined) {
        return { content: [{ type: "text", text: `Invalid vote: ${params.vote}. Use: approve, reject, wait, suggestions` }], isError: true, details: {} };
      }

      await ado.voteReviewer(resolved.repo, resolved.prId, userId.id, voteValue);
      if (params.comment) await ado.createThread(resolved.repo, resolved.prId, params.comment);

      const labels: Record<number, string> = { 10: "✓ Approved", 5: "✓ Suggestions", "-5": "⏳ Waiting", "-10": "✗ Rejected" };
      return { content: [{ type: "text", text: `PR #${resolved.prId} ${resolved.repo}: ${labels[voteValue]}${params.comment ? `\ncomment: ${params.comment}` : ""}` }], details: {} };
    },
  });

  // ─── Tool: ado_profile ──────────────────────────────────────────

  pi.registerTool({
    name: "ado_profile",
    label: "ADO Profile",
    description: "Show active profile config",
    parameters: Type.Object({ profile: S.profile }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { profile: prof, name } = await createClient(params.profile);
      return { content: [{ type: "text", text: `## Profile: ${name}\n${prof.org}/${prof.project}\nrepos: ${prof.repos.join(", ")}\npat: ${prof.patEnvVar}` }], details: {} };
    },
  });

  // ─── Tool: ado_profiles ──────────────────────────────────────────

  pi.registerTool({
    name: "ado_profiles",
    label: "ADO Profiles",
    description: "List available profiles",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const active = getActiveProfile();
      const lines = ["## Profiles"];
      for (const [name, p] of Object.entries(config.profiles)) {
        const marker = name === active || (!active && name === config.defaultProfile) ? " ←" : "";
        lines.push(`${name}${marker}: ${p.org}/${p.project} repos:${p.repos.length}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ─── Tool: ado_profile_use ──────────────────────────────────────

  pi.registerTool({
    name: "ado_profile_use",
    label: "ADO Use Profile",
    description: "Switch active profile (persists)",
    parameters: Type.Object({
      name: Type.String({ description: "Profile name" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig();
      if (!config.profiles[params.name]) {
        return { content: [{ type: "text", text: `Profile "${params.name}" not found. Available: ${Object.keys(config.profiles).join(", ")}` }], isError: true, details: {} };
      }
      setActiveProfile(params.name);
      ctx.ui.setStatus("ado", `ADO: ${params.name} (${config.profiles[params.name].project})`);
      return { content: [{ type: "text", text: `Profile → ${params.name} (${config.profiles[params.name].org}/${config.profiles[params.name].project})` }], details: {} };
    },
  });

  // ─── Tool: ado_select_pr ────────────────────────────────────────

  pi.registerTool({
    name: "ado_select_pr",
    label: "ADO Select PR",
    description: "Select PR (persists). Auto-discovers repo when only prId is provided.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repository name (omit to auto-discover)" })),
      prId: Type.Number({ description: "PR ID" }),
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let resolvedRepo = params.repo;
      if (!resolvedRepo) {
        const config = getConfig();
        const found = await findPrAcrossProfiles(config, params.prId, params.profile);
        if (!found) {
          return { content: [{ type: "text", text: `PR #${params.prId} not found. Provide a repo or check the PR ID.` }], isError: true, details: {} };
        }
        resolvedRepo = found.repo;
        setActiveProfile(found.profileName);
      }
      setSelectedPr(resolvedRepo, params.prId);
      return { content: [{ type: "text", text: `Selected: PR #${params.prId} in ${resolvedRepo}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_diff ──────────────────────────────────────────

  pi.registerTool({
    name: "ado_pr_diff",
    label: "ADO PR Diff",
    description: "List changed files in PR",
    parameters: Type.Object({
      repo: S.repo,
      prId: S.prId,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado, name } = await createClient(resolved.profileName);

      const iterations = await ado.getIterations(resolved.repo, resolved.prId);
      if (!iterations?.length) return { content: [{ type: "text", text: `No iterations for PR #${resolved.prId}` }], details: {} };

      const latest = iterations[iterations.length - 1];
      const changes = await ado.getIterationChanges(resolved.repo, resolved.prId, latest.id);
      if (!changes?.length) return { content: [{ type: "text", text: `No changes for PR #${resolved.prId}` }], details: {} };

      const files = changes
        .filter((c: any) => c.item && !c.item.isFolder)
        .map((c: any) => `[${c.changeType ?? "?"}] ${c.item.path ?? "?"}`);

      return { content: [{ type: "text", text: `## PR #${resolved.prId} files (${name})\n${latest.id}:${latest.sourceRefCommit?.commitId?.slice(0, 8)} ${files.length} files\n${files.join("\n")}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_file ──────────────────────────────────────────

  pi.registerTool({
    name: "ado_pr_file",
    label: "ADO PR File",
    description: "Get file content from PR branch. Optional line range",
    parameters: Type.Object({
      path: Type.String({ description: "File path e.g. /src/app.ts" }),
      repo: S.repo,
      prId: S.prId,
      startLine: Type.Optional(Type.Number({ description: "Start line (1-based)" })),
      endLine: Type.Optional(Type.Number({ description: "End line (1-based)" })),
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado } = await createClient(resolved.profileName);

      const branch = await ado.getPrSourceBranch(resolved.repo, resolved.prId);
      const content = await ado.getFileContent(resolved.repo, params.path, branch);

      const MAX_FILE_SIZE = 15000;
      let out = `## ${params.path} PR#${resolved.prId} ${branch}\n`;

      if (params.startLine || params.endLine) {
        const lines = content.split("\n");
        const start = (params.startLine ?? 1) - 1;
        const end = params.endLine ?? lines.length;
        const slice = lines.slice(start, end);
        out += `L${start + 1}-${Math.min(end, lines.length)}/${lines.length}\n`;
        out += "```" + guessLang(params.path) + "\n";
        for (let i = 0; i < slice.length; i++) {
          out += `${String(start + 1 + i).padStart(4)}|${slice[i]}\n`;
        }
        out += "```";
      } else {
        if (content.length > MAX_FILE_SIZE) {
          out += `⚠ truncated (${content.length}→${MAX_FILE_SIZE})\n`;
          out += "```" + guessLang(params.path) + "\n" + content.slice(0, MAX_FILE_SIZE) + "\n```";
        } else {
          out += "```" + guessLang(params.path) + "\n" + content + "\n```";
        }
      }

      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Tool: ado_pr_review_context ────────────────────────────────

  pi.registerTool({
    name: "ado_pr_review_context",
    label: "ADO PR Review Context",
    description: "Full PR review bundle: metadata, threads, files, commits",
    parameters: Type.Object({
      repo: S.repo,
      prId: S.prId,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const config = getConfig();
      const resolved = await resolvePrArgsAuto(config, params);
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

      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Tool: ado_work_items ────────────────────────────────────────

  pi.registerTool({
    name: "ado_work_items",
    label: "ADO Work Items",
    description: "List work items. Filter: state, assignedTo, tag, type",
    promptSnippet: "List Azure DevOps work items",
    parameters: Type.Object({
      state: S.wiState,
      assignedTo: S.wiAssignedTo,
      tag: S.wiTag,
      workItemType: S.wiType,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, name } = await createClient(params.profile);

      const conditions = [`[System.State] <> 'Closed'`];
      conditions.push(assignedToCondition(params.assignedTo));
      if (params.state) conditions.push(`[System.State] = ${wiqlLiteral(params.state)}`);
      if (params.tag) conditions.push(`[System.Tags] CONTAINS ${wiqlLiteral(params.tag)}`);
      if (params.workItemType) {
        conditions.push(`[System.WorkItemType] CONTAINS ${wiqlLiteral(params.workItemType)}`);
      }

      const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
      const wiqlResult = await ado.queryWiql(wiql);
      const ids = (wiqlResult.workItems ?? []).map((wi: any) => wi.id);

      const filters = [filterLabel(params.assignedTo), params.state && `state:${params.state}`, params.tag && `#${params.tag}`, params.workItemType && `type:${params.workItemType}`].filter(Boolean).join(" ");
      if (ids.length === 0) return { content: [{ type: "text", text: `## WI (${name}) ${filters}\nNone` }], details: {} };

      const workItems = await ado.getWorkItemsByIds(ids);
      let out = `## WI (${name}) ${filters}\n${workItems.map(fmtWorkItem).join("\n")}\n${workItems.length} total`;
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Tool: ado_work_item ──────────────────────────────────────────

  pi.registerTool({
    name: "ado_work_item",
    label: "ADO Work Item",
    description: "Show work item details and comments",
    parameters: Type.Object({
      id: S.wiId,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, name } = await createClient(params.profile);
      const wi = await ado.getWorkItem(params.id, { expandRelations: true });
      const text = await formatWorkItemFullDetail(ado, wi, `## Work Item #${params.id} (${name})`);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ─── Tool: ado_work_item_update ──────────────────────────────────

  pi.registerTool({
    name: "ado_work_item_update",
    label: "ADO Update Work Item",
    description: "Update work item: state, priority, or add comment",
    parameters: Type.Object({
      id: S.wiId,
      state: Type.Optional(Type.String({ description: "New state (e.g. Active, Closed)" })),
      priority: Type.Optional(Type.Number({ description: "New priority" })),
      comment: Type.Optional(S.comment),
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado } = await createClient(params.profile);
      const patchOps: Array<{ op: string; path: string; value: any }> = [];
      if (params.state) patchOps.push({ op: "replace", path: "/fields/System.State", value: params.state });
      if (params.priority !== undefined) patchOps.push({ op: "replace", path: "/fields/Microsoft.VSTS.Common.Priority", value: params.priority });
      if (patchOps.length === 0 && !params.comment) {
        return { content: [{ type: "text", text: "No changes. Provide state, priority, or comment." }], details: {} };
      }
      if (patchOps.length > 0) await ado.updateWorkItem(params.id, patchOps);
      if (params.comment) await ado.addWorkItemComment(params.id, params.comment);
      const parts = [params.state && `state→${params.state}`, params.priority !== undefined && `P→${params.priority}`, params.comment && "comment added"].filter(Boolean);
      return { content: [{ type: "text", text: `#${params.id} updated: ${parts.join(", ")}` }], details: {} };
    },
  });

  // ─── Tool: ado_work_item_comment ──────────────────────────────────

  pi.registerTool({
    name: "ado_work_item_comment",
    label: "ADO Work Item Comment",
    description: "Add comment to work item",
    parameters: Type.Object({
      id: S.wiId,
      comment: S.comment,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado } = await createClient(params.profile);
      await ado.addWorkItemComment(params.id, params.comment);
      return { content: [{ type: "text", text: `#${params.id}: comment added` }], details: {} };
    },
  });

  // ─── Tool: ado_work_item_types ────────────────────────────────────

  pi.registerTool({
    name: "ado_work_item_types",
    label: "ADO Work Item Types",
    description: "List work item types (discover custom types)",
    parameters: Type.Object({ profile: S.profile }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, name } = await createClient(params.profile);
      const types = await ado.getWorkItemTypes();
      const out = types.map((t: any) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 60)}` : ""}`).join("\n");
      return { content: [{ type: "text", text: `## WI Types (${name})\n${out}\n${types.length} types` }], details: {} };
    },
  });

  // ─── Tool: ado_related_work_items ────────────────────────────────

  pi.registerTool({
    name: "ado_related_work_items",
    label: "ADO Related Work Items",
    description: "List related work items with summary + details",
    parameters: Type.Object({
      id: S.wiId,
      state: S.wiState,
      workItemType: S.wiType,
      profile: S.profile,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, name } = await createClient(params.profile);
      const parent = await ado.getWorkItem(params.id, { expandRelations: true });
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

      let filtered = relatedItems.filter((wi: any) => isMatchingWorkItemType(wi, params.workItemType));
      if (params.state) filtered = filtered.filter((wi: any) => wi.fields?.["System.State"] === params.state);

      let out = `## Related for #${params.id} (${name})\n`;
      out += fmtWorkItemDetail(parent) + "\n";
      const filters = [params.workItemType && `type:${params.workItemType}`, params.state && `state:${params.state}`].filter(Boolean).join(" ");
      if (filters) out += `filters: ${filters}\n`;
      out += `${filtered.length} related\n`;
      if (!filtered.length) return { content: [{ type: "text", text: out + "None" }], details: {} };

      out += "### Summary\n" + filtered.map((wi: any) => fmtWorkItem(wi)).join("\n") + "\n";
      out += "### Details\n";
      const detailBlocks: string[] = [];
      const batches = chunkArray(filtered, 5);
      for (const batch of batches) {
        const fullBatch = await Promise.all(batch.map((wi: any) => ado.getWorkItem(wi.id, { expandRelations: true })));
        const formatted = await Promise.all(
          fullBatch.map(async (full: any) => {
            return await formatWorkItemFullDetail(ado, full, `## #${full.id}`);
          }),
        );
        detailBlocks.push(...formatted);
      }
      out += detailBlocks.join("\n---\n");
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Commands ──────────────────────────────────────────────────

  pi.registerCommand("ado", {
    description: "Azure DevOps commands (use /ado:status, /ado:profiles, /ado:switch)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Use /ado:status, /ado:profiles, or /ado:switch", "info");
    },
  });

  pi.registerCommand("ado:status", {
    description: "Show ADO connection status",
    handler: async (_args, ctx) => {
      try {
        const config = getConfig(ctx.cwd);
        const { name, profile } = await createClientFromConfig(config);
        ctx.ui.notify(`ADO: ${name} (${profile.org}/${profile.project}) — ${profile.repos.length} repos`, "info");
      } catch (err) {
        ctx.ui.notify(`ADO: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("ado:profiles", {
    description: "List ADO profiles",
    handler: async (_args, ctx) => {
      try {
        const config = getConfig(ctx.cwd);
        const active = getActiveProfile();
        const lines = Object.entries(config.profiles).map(([name, p]) => {
          const marker = name === active ? " ← active" : "";
          return `${name}: ${p.org}/${p.project} (${p.repos.length} repos)${marker}`;
        });
        ctx.ui.notify(`ADO Profiles:\n${lines.join("\n")}`, "info");
      } catch (err) {
        ctx.ui.notify(`ADO: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("ado:switch", {
    description: "Switch ADO profile",
    handler: async (_args, ctx) => {
      try {
        const config = getConfig(ctx.cwd);
        const names = Object.keys(config.profiles);
        if (names.length <= 1) {
          ctx.ui.notify("Only one profile configured.", "info");
          return;
        }

        const choice = await ctx.ui.select(
          "Switch ADO profile",
          names.map(n => n === getActiveProfile() ? `${n} (active)` : n),
        );

        if (choice) {
          const name = choice.replace(" (active)", "");
          setActiveProfile(name);
          ctx.ui.setStatus("ado", `ADO: ${name} (${config.profiles[name].project})`);
          ctx.ui.notify(`Switched to profile: ${name}`, "info");
        }
      } catch (err) {
        ctx.ui.notify(`ADO: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("ado:config", {
    description: "Write ADO config template to ~/.azure-devops-cli/config.json",
    handler: async (_args, ctx) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const configPath = ADO_CONFIG_FILE;

      if (existsSync(configPath)) {
        ctx.ui.notify(`Config already exists: ${configPath}`, "info");
        return;
      }

      const template = {
        defaultProfile: "work",
        profiles: {
          work: {
            org: "https://dev.azure.com/myorg",
            project: "myproject",
            patEnvVar: "AZURE_DEVOPS_PAT",
            repos: ["backend", "frontend"],
          },
        },
      };

      mkdirSync(ADO_CONFIG_DIR, { recursive: true });
      writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n", "utf-8");
      ctx.ui.notify(`Created config template: ${configPath}\nEdit it with your org, project, and repos.`, "info");
      // Reset cache so next call picks up new config
      cachedConfig = undefined;
    },
  });
}
