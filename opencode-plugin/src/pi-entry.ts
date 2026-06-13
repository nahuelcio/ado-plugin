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
 *   pi install npm:@cioffinahuel/opencode-ado
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
import { D } from "./tool-descriptions.js";
import { loadProjectConfig } from "./chain-config.js";
import { validateWorkItemCreation } from "./wi-create.js";
import { runCreatePr, runChainPrs } from "./chain-runner.js";

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

// ─── TypeBox Schemas (shared inline definitions) ──────────────────────────

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

  // ─── Tool: ado_pr_list ──────────────────────────────────────────────

  pi.registerTool({
    name: D.pr_list.name,
    label: "ADO PRs",
    description: D.pr_list.description,
    promptSnippet: "List Azure DevOps pull requests",
    parameters: Type.Object({
      profile: Type.Optional(Type.String({ description: D.pr_list.params.profile })),
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

  // ─── Tool: ado_pr_get ──────────────────────────────────────────────

  pi.registerTool({
    name: D.pr_get.name,
    label: "ADO PR Details",
    description: D.pr_get.description,
    promptSnippet: "Show Azure DevOps pull request details",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_get.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_get.params.prId })),
      profile: Type.Optional(Type.String({ description: D.pr_get.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado, name } = await createClient(resolved.profileName);
      const pr = await ado.getPullRequest(resolved.repo, resolved.prId);
      return { content: [{ type: "text", text: `## PR #${resolved.prId} ${resolved.repo} (${name})\n${fmtPRDetail(pr)}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_threads ──────────────────────────────────────

  pi.registerTool({
    name: D.pr_threads.name,
    label: "ADO PR Threads",
    description: D.pr_threads.description,
    promptSnippet: "Show Azure DevOps PR comment threads",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_threads.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_threads.params.prId })),
      profile: Type.Optional(Type.String({ description: D.pr_threads.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado } = await createClient(resolved.profileName);
      const threads = await ado.getThreads(resolved.repo, resolved.prId);
      if (!threads.length) return { content: [{ type: "text", text: `No threads for PR #${resolved.prId}` }], details: {} };
      return { content: [{ type: "text", text: `## Threads #${resolved.prId} ${resolved.repo}\n${threads.map(fmtThread).join("\n")}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_comment ──────────────────────────────────────

  pi.registerTool({
    name: D.pr_comment.name,
    label: "ADO PR Comment",
    description: D.pr_comment.description,
    promptSnippet: "Add comment to Azure DevOps PR",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_comment.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_comment.params.prId })),
      comment: Type.String(),
      filePath: Type.Optional(Type.String({ description: D.pr_comment.params.filePath })),
      line: Type.Optional(Type.Number({ description: D.pr_comment.params.line })),
      profile: Type.Optional(Type.String({ description: D.pr_comment.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.line !== undefined && !params.filePath) {
        return { content: [{ type: "text", text: "Provide filePath when specifying line." }], isError: true, details: {} };
      }
      const config = getConfig(ctx.cwd);
      const resolved = await resolvePrArgsAuto(config, params);
      const { client: ado } = await createClient(resolved.profileName);
      await ado.createThread(resolved.repo, resolved.prId, params.comment, { filePath: params.filePath, line: params.line });
      const parts = [`PR #${resolved.prId}`, params.filePath && `file:${params.filePath}`, params.line !== undefined && `L${params.line}`].filter(Boolean);
      return { content: [{ type: "text", text: `${parts.join(" ")}\ncomment: ${params.comment}` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_vote ──────────────────────────────────────────

  pi.registerTool({
    name: D.pr_vote.name,
    label: "ADO Review",
    description: D.pr_vote.description,
    promptSnippet: "Vote on Azure DevOps pull request",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_vote.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_vote.params.prId })),
      vote: StringEnum(["approve", "reject", "wait", "suggestions"]),
      comment: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String({ description: D.pr_vote.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
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

  // ─── Tool: ado_profile_get ──────────────────────────────────────────

  pi.registerTool({
    name: D.profile_get.name,
    label: "ADO Profile",
    description: D.profile_get.description,
    parameters: Type.Object({ profile: Type.Optional(Type.String({ description: D.profile_get.params.profile })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { profile: prof, name } = await createClient(params.profile);
      return { content: [{ type: "text", text: `## Profile: ${name}\n${prof.org}/${prof.project}\nrepos: ${prof.repos.join(", ")}\npat: ${prof.patEnvVar}` }], details: {} };
    },
  });

  // ─── Tool: ado_profile_list ──────────────────────────────────────────

  pi.registerTool({
    name: D.profile_list.name,
    label: "ADO Profiles",
    description: D.profile_list.description,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
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
    name: D.profile_use.name,
    label: "ADO Use Profile",
    description: D.profile_use.description,
    parameters: Type.Object({
      name: Type.String({ description: D.profile_use.params.name }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
      if (!config.profiles[params.name]) {
        return { content: [{ type: "text", text: `Profile "${params.name}" not found. Available: ${Object.keys(config.profiles).join(", ")}` }], isError: true, details: {} };
      }
      setActiveProfile(params.name);
      ctx.ui.setStatus("ado", `ADO: ${params.name} (${config.profiles[params.name].project})`);
      return { content: [{ type: "text", text: `Profile → ${params.name} (${config.profiles[params.name].org}/${config.profiles[params.name].project})` }], details: {} };
    },
  });

  // ─── Tool: ado_pr_select ────────────────────────────────────────

  pi.registerTool({
    name: D.pr_select.name,
    label: "ADO Select PR",
    description: D.pr_select.description,
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_select.params.repo })),
      prId: Type.Number({ description: D.pr_select.params.prId }),
      profile: Type.Optional(Type.String({ description: D.pr_select.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let resolvedRepo = params.repo;
      if (!resolvedRepo) {
        const config = getConfig(ctx.cwd);
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
    name: D.pr_diff.name,
    label: "ADO PR Diff",
    description: D.pr_diff.description,
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_diff.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_diff.params.prId })),
      profile: Type.Optional(Type.String({ description: D.pr_diff.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
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
    name: D.pr_file.name,
    label: "ADO PR File",
    description: D.pr_file.description,
    parameters: Type.Object({
      path: Type.String({ description: D.pr_file.params.path }),
      repo: Type.Optional(Type.String({ description: D.pr_file.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_file.params.prId })),
      startLine: Type.Optional(Type.Number({ description: D.pr_file.params.startLine })),
      endLine: Type.Optional(Type.Number({ description: D.pr_file.params.endLine })),
      profile: Type.Optional(Type.String({ description: D.pr_file.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
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

  // ─── Tool: ado_pr_context ────────────────────────────────

  pi.registerTool({
    name: D.pr_context.name,
    label: "ADO PR Review Context",
    description: D.pr_context.description,
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: D.pr_context.params.repo })),
      prId: Type.Optional(Type.Number({ description: D.pr_context.params.prId })),
      profile: Type.Optional(Type.String({ description: D.pr_context.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx.cwd);
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
        out = out.slice(0, MAX_TOTAL) + "\n⚠ Truncated. Use ado_pr_diff or ado_pr_context for details.";
      }

      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Tool: ado_wi_list ────────────────────────────────────────

  pi.registerTool({
    name: D.wi_list.name,
    label: "ADO Work Items",
    description: D.wi_list.description,
    promptSnippet: "List Azure DevOps work items",
    parameters: Type.Object({
      state: Type.Optional(Type.String({ description: D.wi_list.params.state })),
      assignedTo: Type.Optional(Type.String({ description: D.wi_list.params.assignedTo })),
      tag: Type.Optional(Type.String({ description: D.wi_list.params.tag })),
      workItemType: Type.Optional(Type.String({ description: D.wi_list.params.workItemType })),
      profile: Type.Optional(Type.String({ description: D.wi_list.params.profile })),
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

  // ─── Tool: ado_wi_get ──────────────────────────────────────────

  pi.registerTool({
    name: D.wi_get.name,
    label: "ADO Work Item",
    description: D.wi_get.description,
    parameters: Type.Object({
      id: Type.Number({ description: D.wi_get.params.id }),
      profile: Type.Optional(Type.String({ description: D.wi_get.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, name } = await createClient(params.profile);
      const wi = await ado.getWorkItem(params.id, { expandRelations: true });
      const text = await formatWorkItemFullDetail(ado, wi, `## Work Item #${params.id} (${name})`);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ─── Tool: ado_wi_update ──────────────────────────────────

  pi.registerTool({
    name: D.wi_update.name,
    label: "ADO Update Work Item",
    description: D.wi_update.description,
    parameters: Type.Object({
      id: Type.Number({ description: D.wi_update.params.id }),
      state: Type.Optional(Type.String({ description: D.wi_update.params.state })),
      priority: Type.Optional(Type.Number()),
      comment: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String({ description: D.wi_update.params.profile })),
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

  // ─── Tool: ado_wi_comment ──────────────────────────────────

  pi.registerTool({
    name: D.wi_comment.name,
    label: "ADO Work Item Comment",
    description: D.wi_comment.description,
    parameters: Type.Object({
      id: Type.Number({ description: D.wi_comment.params.id }),
      comment: Type.String(),
      profile: Type.Optional(Type.String({ description: D.wi_comment.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado } = await createClient(params.profile);
      await ado.addWorkItemComment(params.id, params.comment);
      return { content: [{ type: "text", text: `#${params.id}: comment added` }], details: {} };
    },
  });

  // ─── Tool: ado_wi_types ────────────────────────────────────

  pi.registerTool({
    name: D.wi_types.name,
    label: "ADO Work Item Types",
    description: D.wi_types.description,
    parameters: Type.Object({ profile: Type.Optional(Type.String({ description: D.wi_types.params.profile })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { client: ado, name } = await createClient(params.profile);
      const types = await ado.getWorkItemTypes();
      const out = types.map((t: any) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 60)}` : ""}`).join("\n");
      return { content: [{ type: "text", text: `## WI Types (${name})\n${out}\n${types.length} types` }], details: {} };
    },
  });

  // ─── Tool: ado_wi_related ────────────────────────────────

  pi.registerTool({
    name: D.wi_related.name,
    label: "ADO Related Work Items",
    description: D.wi_related.description,
    parameters: Type.Object({
      id: Type.Number({ description: D.wi_related.params.id }),
      state: Type.Optional(Type.String({ description: D.wi_related.params.state })),
      workItemType: Type.Optional(Type.String({ description: D.wi_related.params.workItemType })),
      profile: Type.Optional(Type.String({ description: D.wi_related.params.profile })),
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

  // ─── Tool: ado_wi_create ─────────────────────────────────────────

  pi.registerTool({
    name: D.wi_create.name,
    label: "ADO Create Work Item",
    description: D.wi_create.description,
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: D.wi_create.params.type })),
      title: Type.String(),
      description: Type.Optional(Type.String({ description: D.wi_create.params.description })),
      areaPath: Type.Optional(Type.String({ description: D.wi_create.params.areaPath })),
      iterationPath: Type.Optional(Type.String({ description: D.wi_create.params.iterationPath })),
      priority: Type.Optional(Type.Number({ description: D.wi_create.params.priority })),
      assignedTo: Type.Optional(Type.String({ description: D.wi_create.params.assignedTo })),
      state: Type.Optional(Type.String({ description: D.wi_create.params.state })),
      tags: Type.Optional(Type.String({ description: D.wi_create.params.tags })),
      parentId: Type.Optional(Type.Number({ description: D.wi_create.params.parentId })),
      customFields: Type.Optional(Type.Record(Type.String(), Type.String(), { description: D.wi_create.params.customFields })),
      profile: Type.Optional(Type.String({ description: D.wi_create.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adoConfig = getConfig(ctx.cwd);
      const { client: ado, userId } = await createClientFromConfig(adoConfig, params.profile);
      const config = await loadProjectConfig(ctx.cwd);

      const effectiveType = params.type ?? config.work_item.create.default_type;

      const fields: Record<string, unknown> = { title: params.title };
      if (params.description !== undefined) fields.description = params.description;
      if (params.areaPath !== undefined) fields.areaPath = params.areaPath;
      if (params.iterationPath !== undefined) fields.iterationPath = params.iterationPath;
      if (params.priority !== undefined) fields.priority = params.priority;
      if (params.assignedTo !== undefined) fields.assignedTo = params.assignedTo;
      if (params.state !== undefined) fields.state = params.state;
      if (params.tags !== undefined) fields.tags = params.tags;

      const validationError = validateWorkItemCreation(config, { type: effectiveType, fields, parentId: params.parentId });
      if (validationError) return { content: [{ type: "text", text: `Error: ${validationError}` }], isError: true, details: {} };

      if (!fields.state) fields.state = config.work_item.create.default_state;
      if (config.work_item.create.auto_assign && !fields.assignedTo) fields.assignedTo = userId.displayName;

      const parentRelation = params.parentId
        ? { parentId: params.parentId, relationType: "System.LinkTypes.Hierarchy-Reverse" }
        : undefined;

      let wi: any;
      try {
        wi = await ado.createWorkItem(effectiveType, fields, parentRelation, params.customFields);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error creating work item: ${msg}` }], isError: true, details: {} };
      }

      const wiId = wi.id;
      const wiFields = wi.fields ?? {};
      const lines: string[] = [
        `## Work Item Created: #${wiId}`,
        `- Type: ${wiFields["System.WorkItemType"] ?? effectiveType}`,
        `- Title: ${wiFields["System.Title"] ?? params.title}`,
        `- State: ${wiFields["System.State"] ?? fields.state}`,
      ];
      if (wiFields["Microsoft.VSTS.Common.Priority"] !== undefined) lines.push(`- Priority: ${wiFields["Microsoft.VSTS.Common.Priority"]}`);
      if (wiFields["System.AssignedTo"]?.displayName) lines.push(`- Assigned: ${wiFields["System.AssignedTo"].displayName}`);
      if (wiFields["System.AreaPath"]) lines.push(`- Area: ${wiFields["System.AreaPath"]}`);
      if (params.parentId) lines.push(`- Parent: #${params.parentId}`);

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ─── Tool: ado_wi_create_child ────────────────────────────────────

  pi.registerTool({
    name: D.wi_create_child.name,
    label: "ADO Create Child Work Item",
    description: D.wi_create_child.description,
    parameters: Type.Object({
      parentId: Type.Number({ description: D.wi_create_child.params.parentId }),
      type: Type.Optional(Type.String({ description: D.wi_create_child.params.type })),
      title: Type.String(),
      description: Type.Optional(Type.String({ description: D.wi_create_child.params.description })),
      areaPath: Type.Optional(Type.String({ description: D.wi_create_child.params.areaPath })),
      iterationPath: Type.Optional(Type.String({ description: D.wi_create_child.params.iterationPath })),
      priority: Type.Optional(Type.Number({ description: D.wi_create_child.params.priority })),
      assignedTo: Type.Optional(Type.String({ description: D.wi_create_child.params.assignedTo })),
      state: Type.Optional(Type.String({ description: D.wi_create_child.params.state })),
      tags: Type.Optional(Type.String({ description: D.wi_create_child.params.tags })),
      customFields: Type.Optional(Type.Record(Type.String(), Type.String(), { description: D.wi_create_child.params.customFields })),
      profile: Type.Optional(Type.String({ description: D.wi_create_child.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adoConfig = getConfig(ctx.cwd);
      const { client: ado, userId } = await createClientFromConfig(adoConfig, params.profile);
      const config = await loadProjectConfig(ctx.cwd);

      const effectiveType = params.type ?? config.work_item.create.default_type;

      const fields: Record<string, unknown> = { title: params.title };
      if (params.description !== undefined) fields.description = params.description;
      if (params.areaPath !== undefined) fields.areaPath = params.areaPath;
      if (params.iterationPath !== undefined) fields.iterationPath = params.iterationPath;
      if (params.priority !== undefined) fields.priority = params.priority;
      if (params.assignedTo !== undefined) fields.assignedTo = params.assignedTo;
      if (params.state !== undefined) fields.state = params.state;
      if (params.tags !== undefined) fields.tags = params.tags;

      const validationError = validateWorkItemCreation(config, { type: effectiveType, fields, parentId: params.parentId });
      if (validationError) return { content: [{ type: "text", text: `Error: ${validationError}` }], isError: true, details: {} };

      if (!fields.state) fields.state = config.work_item.create.default_state;
      if (config.work_item.create.auto_assign && !fields.assignedTo) fields.assignedTo = userId.displayName;

      const parentRelation = { parentId: params.parentId, relationType: "System.LinkTypes.Hierarchy-Reverse" };

      let wi: any;
      try {
        wi = await ado.createWorkItem(effectiveType, fields, parentRelation, params.customFields);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error creating child work item: ${msg}` }], isError: true, details: {} };
      }

      const wiId = wi.id;
      const wiFields = wi.fields ?? {};
      const lines: string[] = [
        `## Child Work Item Created: #${wiId}`,
        `- Type: ${wiFields["System.WorkItemType"] ?? effectiveType}`,
        `- Title: ${wiFields["System.Title"] ?? params.title}`,
        `- State: ${wiFields["System.State"] ?? fields.state}`,
        `- Parent: #${params.parentId}`,
      ];
      if (wiFields["Microsoft.VSTS.Common.Priority"] !== undefined) lines.push(`- Priority: ${wiFields["Microsoft.VSTS.Common.Priority"]}`);
      if (wiFields["System.AssignedTo"]?.displayName) lines.push(`- Assigned: ${wiFields["System.AssignedTo"].displayName}`);
      if (wiFields["System.AreaPath"]) lines.push(`- Area: ${wiFields["System.AreaPath"]}`);

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ─── Tool: ado_pr_create ─────────────────────────────────────────

  pi.registerTool({
    name: D.pr_create.name,
    label: "ADO Create PR",
    description: D.pr_create.description,
    parameters: Type.Object({
      repo: Type.String({ description: D.pr_create.params.repo }),
      sourceBranch: Type.String({ description: D.pr_create.params.sourceBranch }),
      targetBranch: Type.String({ description: D.pr_create.params.targetBranch }),
      title: Type.String(),
      description: Type.Optional(Type.String({ description: D.pr_create.params.description })),
      workItemIds: Type.Optional(Type.Array(Type.Number(), { description: D.pr_create.params.workItemIds })),
      isDraft: Type.Optional(Type.Boolean()),
      profile: Type.Optional(Type.String({ description: D.pr_create.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adoConfig = getConfig(ctx.cwd);
      const { client: ado } = await createClientFromConfig(adoConfig, params.profile);
      const config = await loadProjectConfig(ctx.cwd);
      const result = await runCreatePr(ado, config, {
        repo: params.repo,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        title: params.title,
        description: params.description,
        workItemIds: params.workItemIds,
        isDraft: params.isDraft,
      });
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ─── Tool: ado_pr_chain ──────────────────────────────────────────

  pi.registerTool({
    name: D.pr_chain.name,
    label: "ADO Chain PRs",
    description: D.pr_chain.description,
    parameters: Type.Object({
      repo: Type.String({ description: D.pr_chain.params.repo }),
      workItemIds: Type.Array(Type.Number(), { description: D.pr_chain.params.workItemIds, minItems: 1, maxItems: 50 }),
      baseBranch: Type.Optional(Type.String({ description: D.pr_chain.params.baseBranch })),
      strategy: Type.Optional(StringEnum(["feature-chain", "stacked"], { description: D.pr_chain.params.strategy })),
      prefix: Type.Optional(Type.String({ description: D.pr_chain.params.prefix })),
      branchNames: Type.Optional(Type.Array(Type.String(), { description: D.pr_chain.params.branchNames })),
      profile: Type.Optional(Type.String({ description: D.pr_chain.params.profile })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adoConfig = getConfig(ctx.cwd);
      const { client: ado } = await createClientFromConfig(adoConfig, params.profile);
      const config = await loadProjectConfig(ctx.cwd);
      const result = await runChainPrs(ado, config, {
        repo: params.repo,
        workItemIds: params.workItemIds,
        baseBranch: params.baseBranch,
        strategy: params.strategy as "feature-chain" | "stacked" | undefined,
        prefix: params.prefix,
        branchNames: params.branchNames,
      });
      return { content: [{ type: "text", text: result }], details: {} };
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
