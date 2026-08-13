/**
 * Shared command implementations — single source of truth for the 22 ADO
 * operations. Both the OpenCode plugin tools (index.ts) and the `ado` CLI
 * (bin/opencode-ado.ts) call these so their output stays identical.
 *
 * Each function takes a resolved AdoConfig plus typed args and returns the
 * formatted string the caller prints / returns to the LLM.
 */

import type { AdoConfig } from "./shared.js";
import { shortBranch, fmtPR, fmtPRDetail, fmtThread, fmtWorkItem, fmtWorkItemDetail } from "./shared.js";
import { getActiveProfile, setActiveProfile, setSelectedPr } from "./profile-store.js";
import {
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
import { loadProjectConfig } from "./chain-config.js";
import { validateWorkItemCreation } from "./wi-create.js";
import { runCreatePr, runChainPrs } from "./chain-runner.js";

// ─── PR commands ────────────────────────────────────────────────────────────

export async function prList(config: AdoConfig, args: { profile?: string }): Promise<string> {
  const { client: ado, profile: prof, name, userId } = await createClientFromConfig(config, args.profile);
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
}

export async function prGet(config: AdoConfig, args: { repo?: string; prId?: number; profile?: string }): Promise<string> {
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado, name } = await createClientFromConfig(config, resolved.profileName);
  const pr = await ado.getPullRequest(resolved.repo, resolved.prId);
  return `## PR #${resolved.prId} ${resolved.repo} (${name})\n${fmtPRDetail(pr)}`;
}

export async function prThreads(config: AdoConfig, args: { repo?: string; prId?: number; profile?: string }): Promise<string> {
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado } = await createClientFromConfig(config, resolved.profileName);
  const threads = await ado.getThreads(resolved.repo, resolved.prId);
  if (!threads.length) return `No threads for PR #${resolved.prId}`;
  return `## Threads #${resolved.prId} ${resolved.repo}\n${threads.map(fmtThread).join("\n")}`;
}

export async function prComment(
  config: AdoConfig,
  args: { repo?: string; prId?: number; comment: string; filePath?: string; line?: number; profile?: string },
): Promise<string> {
  if (args.line !== undefined && !args.filePath) return "Provide filePath when specifying line.";
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado } = await createClientFromConfig(config, resolved.profileName);
  await ado.createThread(resolved.repo, resolved.prId, args.comment, { filePath: args.filePath, line: args.line });
  const parts = [`PR #${resolved.prId}`, args.filePath && `file:${args.filePath}`, args.line !== undefined && `L${args.line}`].filter(Boolean);
  return `${parts.join(" ")}\ncomment: ${args.comment}`;
}

export async function prVote(
  config: AdoConfig,
  args: { repo?: string; prId?: number; vote: string; comment?: string; profile?: string },
): Promise<string> {
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado, userId } = await createClientFromConfig(config, resolved.profileName);
  const voteMap: Record<string, number> = { approve: 10, suggestions: 5, wait: -5, reject: -10 };
  const voteValue = voteMap[args.vote];
  if (voteValue === undefined) return `Invalid vote: ${args.vote}. Use: approve, reject, wait, suggestions`;

  await ado.voteReviewer(resolved.repo, resolved.prId, userId.id, voteValue);
  if (args.comment) await ado.createThread(resolved.repo, resolved.prId, args.comment);

  const labels: Record<number, string> = { 10: "✓ Approved", 5: "✓ Suggestions", "-5": "⏳ Waiting", "-10": "✗ Rejected" };
  return `PR #${resolved.prId} ${resolved.repo}: ${labels[voteValue]}${args.comment ? `\ncomment: ${args.comment}` : ""}`;
}

export async function prSelect(config: AdoConfig, args: { repo?: string; prId: number; profile?: string }): Promise<string> {
  let resolvedRepo = args.repo;
  if (!resolvedRepo) {
    const found = await findPrAcrossProfiles(config, args.prId, args.profile);
    if (!found) {
      const scope = args.profile ? `profile "${args.profile}"` : "any repo across all profiles";
      return `PR #${args.prId} not found in ${scope}. Provide a repo or check the PR ID.`;
    }
    resolvedRepo = found.repo;
    setActiveProfile(found.profileName);
  }
  setSelectedPr(resolvedRepo, args.prId);
  return `Selected: PR #${args.prId} in ${resolvedRepo}`;
}

export async function prDiff(config: AdoConfig, args: { repo?: string; prId?: number; profile?: string }): Promise<string> {
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado, name } = await createClientFromConfig(config, resolved.profileName);

  const iterations = await ado.getIterations(resolved.repo, resolved.prId);
  if (!iterations?.length) return `No iterations for PR #${resolved.prId}`;

  const latest = iterations[iterations.length - 1];
  const changes = await ado.getIterationChanges(resolved.repo, resolved.prId, latest.id);

  if (!changes?.length) return `No changes for PR #${resolved.prId}`;

  const files = changes
    .filter((c: any) => c.item && !c.item.isFolder)
    .map((c: any) => `[${c.changeType ?? "?"}] ${c.item.path ?? "?"}`);

  return `## PR #${resolved.prId} files (${name})\n${latest.id}:${latest.sourceRefCommit?.commitId?.slice(0, 8)} ${files.length} files\n${files.join("\n")}`;
}

export async function prFile(
  config: AdoConfig,
  args: { path: string; repo?: string; prId?: number; startLine?: number; endLine?: number; profile?: string },
): Promise<string> {
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado } = await createClientFromConfig(config, resolved.profileName);

  const branch = await ado.getPrSourceBranch(resolved.repo, resolved.prId);
  const content = await ado.getFileContent(resolved.repo, args.path, branch);

  const MAX_FILE_SIZE = 15000;
  let out = `## ${args.path} PR#${resolved.prId} ${branch}\n`;

  if (args.startLine || args.endLine) {
    const lines = content.split("\n");
    const start = (args.startLine ?? 1) - 1;
    const end = args.endLine ?? lines.length;
    const slice = lines.slice(start, end);
    out += `L${start + 1}-${Math.min(end, lines.length)}/${lines.length}\n`;
    out += "```" + guessLang(args.path) + "\n";
    for (let i = 0; i < slice.length; i++) {
      out += `${String(start + 1 + i).padStart(4)}|${slice[i]}\n`;
    }
    out += "```";
  } else {
    if (content.length > MAX_FILE_SIZE) {
      out += `⚠ truncated (${content.length}→${MAX_FILE_SIZE})\n`;
      out += "```" + guessLang(args.path) + "\n" + content.slice(0, MAX_FILE_SIZE) + "\n```";
    } else {
      out += "```" + guessLang(args.path) + "\n" + content + "\n```";
    }
  }

  return out;
}

export async function prContext(config: AdoConfig, args: { repo?: string; prId?: number; profile?: string }): Promise<string> {
  const resolved = await resolvePrArgsAuto(config, args);
  const { client: ado, name } = await createClientFromConfig(config, resolved.profileName);

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
}

export async function prCreate(
  config: AdoConfig,
  args: { repo: string; sourceBranch: string; targetBranch: string; title: string; description?: string; workItemIds?: number[]; isDraft?: boolean; profile?: string },
): Promise<string> {
  const { client: ado } = await createClientFromConfig(config, args.profile);
  const projectConfig = await loadProjectConfig(process.cwd());
  return runCreatePr(ado, projectConfig, {
    repo: args.repo,
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
    title: args.title,
    description: args.description,
    workItemIds: args.workItemIds,
    isDraft: args.isDraft,
  });
}

export async function prChain(
  config: AdoConfig,
  args: { repo: string; workItemIds: number[]; baseBranch?: string; strategy?: "feature-chain" | "stacked"; prefix?: string; branchNames?: string[]; profile?: string },
): Promise<string> {
  const { client: ado } = await createClientFromConfig(config, args.profile);
  const projectConfig = await loadProjectConfig(process.cwd());
  return runChainPrs(ado, projectConfig, {
    repo: args.repo,
    workItemIds: args.workItemIds,
    baseBranch: args.baseBranch,
    strategy: args.strategy,
    prefix: args.prefix,
    branchNames: args.branchNames,
  });
}

// ─── Work item commands ─────────────────────────────────────────────────────

export async function wiList(
  config: AdoConfig,
  args: { state?: string; assignedTo?: string; tag?: string; workItemType?: string; profile?: string },
): Promise<string> {
  const { client: ado, name } = await createClientFromConfig(config, args.profile);

  const conditions = [`[System.State] <> 'Closed'`];
  conditions.push(assignedToCondition(args.assignedTo));
  if (args.state) conditions.push(`[System.State] = ${wiqlLiteral(args.state)}`);
  if (args.tag) conditions.push(`[System.Tags] CONTAINS ${wiqlLiteral(args.tag)}`);
  if (args.workItemType) {
    conditions.push(`[System.WorkItemType] CONTAINS ${wiqlLiteral(args.workItemType)}`);
  }

  const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
  const wiqlResult = await ado.queryWiql(wiql);
  const ids = (wiqlResult.workItems ?? []).map((wi: any) => wi.id);

  const filters = [filterLabel(args.assignedTo), args.state && `state:${args.state}`, args.tag && `#${args.tag}`, args.workItemType && `type:${args.workItemType}`].filter(Boolean).join(" ");
  if (ids.length === 0) return `## WI (${name}) ${filters}\nNone`;

  const workItems = await ado.getWorkItemsByIds(ids);
  return `## WI (${name}) ${filters}\n${workItems.map(fmtWorkItem).join("\n")}\n${workItems.length} total`;
}

export async function wiGet(config: AdoConfig, args: { id: number; profile?: string }): Promise<string> {
  const { client: ado, name } = await createClientFromConfig(config, args.profile);
  const wi = await ado.getWorkItem(args.id, { expandRelations: true });
  return formatWorkItemFullDetail(ado, wi, `## Work Item #${args.id} (${name})`);
}

export async function wiUpdate(
  config: AdoConfig,
  args: { id: number; state?: string; priority?: number; comment?: string; profile?: string },
): Promise<string> {
  const { client: ado } = await createClientFromConfig(config, args.profile);
  const patchOps: Array<{ op: string; path: string; value: any }> = [];
  if (args.state) patchOps.push({ op: "replace", path: "/fields/System.State", value: args.state });
  if (args.priority !== undefined) patchOps.push({ op: "replace", path: "/fields/Microsoft.VSTS.Common.Priority", value: args.priority });
  if (patchOps.length === 0 && !args.comment) return "No changes. Provide state, priority, or comment.";
  if (patchOps.length > 0) await ado.updateWorkItem(args.id, patchOps);
  if (args.comment) await ado.addWorkItemComment(args.id, args.comment);
  const parts = [args.state && `state→${args.state}`, args.priority !== undefined && `P→${args.priority}`, args.comment && "comment added"].filter(Boolean);
  return `#${args.id} updated: ${parts.join(", ")}`;
}

export async function wiComment(config: AdoConfig, args: { id: number; comment: string; profile?: string }): Promise<string> {
  const { client: ado } = await createClientFromConfig(config, args.profile);
  await ado.addWorkItemComment(args.id, args.comment);
  return `#${args.id}: comment added`;
}

export async function wiTypes(config: AdoConfig, args: { profile?: string }): Promise<string> {
  const { client: ado, name } = await createClientFromConfig(config, args.profile);
  const types = await ado.getWorkItemTypes();
  const out = types.map((t: any) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 60)}` : ""}`).join("\n");
  return `## WI Types (${name})\n${out}\n${types.length} types`;
}

export async function wiFields(config: AdoConfig, args: { type: string; profile?: string }): Promise<string> {
  const { client: ado, name } = await createClientFromConfig(config, args.profile);
  const fields = await ado.getWorkItemTypeFields(args.type);
  const out = fields.map((f: any) => {
    const flags = [f.alwaysRequired ? "required" : "", f.type].filter(Boolean).join(", ");
    const allowed = Array.isArray(f.allowedValues) && f.allowedValues.length > 0
      ? ` — values: ${f.allowedValues.slice(0, 20).join(" | ")}${f.allowedValues.length > 20 ? " | ..." : ""}`
      : "";
    return `- ${f.referenceName} (${f.name}) [${flags}]${allowed}`;
  }).join("\n");
  return `## Fields for '${args.type}' (${name})\n${out}\n${fields.length} fields`;
}

interface WiCreateArgs {
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
}

function buildWiFields(args: WiCreateArgs): Record<string, unknown> {
  const fields: Record<string, unknown> = { title: args.title };
  if (args.description !== undefined) fields.description = args.description;
  if (args.areaPath !== undefined) fields.areaPath = args.areaPath;
  if (args.iterationPath !== undefined) fields.iterationPath = args.iterationPath;
  if (args.priority !== undefined) fields.priority = args.priority;
  if (args.assignedTo !== undefined) fields.assignedTo = args.assignedTo;
  if (args.state !== undefined) fields.state = args.state;
  if (args.tags !== undefined) fields.tags = args.tags;
  return fields;
}

export async function wiCreate(config: AdoConfig, args: WiCreateArgs): Promise<string> {
  const { client: ado, userId } = await createClientFromConfig(config, args.profile);
  const projectConfig = await loadProjectConfig(process.cwd());

  const effectiveType = args.type ?? projectConfig.work_item.create.default_type;
  const fields = buildWiFields(args);

  const validationError = validateWorkItemCreation(projectConfig, { type: effectiveType, fields, parentId: args.parentId });
  if (validationError) return `Error: ${validationError}`;

  if (!fields.state) fields.state = projectConfig.work_item.create.default_state;
  if (projectConfig.work_item.create.auto_assign && !fields.assignedTo) fields.assignedTo = userId.displayName;

  const parentRelation = args.parentId
    ? { parentId: args.parentId, relationType: "System.LinkTypes.Hierarchy-Reverse" }
    : undefined;

  let wi: any;
  try {
    wi = await ado.createWorkItem(effectiveType, fields, parentRelation, args.customFields);
  } catch (err) {
    return `Error creating work item: ${err instanceof Error ? err.message : String(err)}`;
  }

  const wiFields = wi.fields ?? {};
  const lines: string[] = [
    `## Work Item Created: #${wi.id}`,
    `- Type: ${wiFields["System.WorkItemType"] ?? effectiveType}`,
    `- Title: ${wiFields["System.Title"] ?? args.title}`,
    `- State: ${wiFields["System.State"] ?? fields.state}`,
  ];
  if (wiFields["Microsoft.VSTS.Common.Priority"] !== undefined) lines.push(`- Priority: ${wiFields["Microsoft.VSTS.Common.Priority"]}`);
  if (wiFields["System.AssignedTo"]?.displayName) lines.push(`- Assigned: ${wiFields["System.AssignedTo"].displayName}`);
  if (wiFields["System.AreaPath"]) lines.push(`- Area: ${wiFields["System.AreaPath"]}`);
  if (args.parentId) lines.push(`- Parent: #${args.parentId}`);

  return lines.join("\n");
}

export async function wiCreateChild(config: AdoConfig, args: WiCreateArgs & { parentId: number }): Promise<string> {
  const { client: ado, userId } = await createClientFromConfig(config, args.profile);
  const projectConfig = await loadProjectConfig(process.cwd());

  const effectiveType = args.type ?? projectConfig.work_item.create.default_type;
  const fields = buildWiFields(args);

  const validationError = validateWorkItemCreation(projectConfig, { type: effectiveType, fields, parentId: args.parentId });
  if (validationError) return `Error: ${validationError}`;

  if (!fields.state) fields.state = projectConfig.work_item.create.default_state;
  if (projectConfig.work_item.create.auto_assign && !fields.assignedTo) fields.assignedTo = userId.displayName;

  const parentRelation = { parentId: args.parentId, relationType: "System.LinkTypes.Hierarchy-Reverse" };

  let wi: any;
  try {
    wi = await ado.createWorkItem(effectiveType, fields, parentRelation, args.customFields);
  } catch (err) {
    return `Error creating child work item: ${err instanceof Error ? err.message : String(err)}`;
  }

  const wiFields = wi.fields ?? {};
  const lines: string[] = [
    `## Child Work Item Created: #${wi.id}`,
    `- Type: ${wiFields["System.WorkItemType"] ?? effectiveType}`,
    `- Title: ${wiFields["System.Title"] ?? args.title}`,
    `- State: ${wiFields["System.State"] ?? fields.state}`,
    `- Parent: #${args.parentId}`,
  ];
  if (wiFields["Microsoft.VSTS.Common.Priority"] !== undefined) lines.push(`- Priority: ${wiFields["Microsoft.VSTS.Common.Priority"]}`);
  if (wiFields["System.AssignedTo"]?.displayName) lines.push(`- Assigned: ${wiFields["System.AssignedTo"].displayName}`);
  if (wiFields["System.AreaPath"]) lines.push(`- Area: ${wiFields["System.AreaPath"]}`);

  return lines.join("\n");
}

export async function wiRelated(
  config: AdoConfig,
  args: { id: number; state?: string; workItemType?: string; profile?: string },
): Promise<string> {
  const { client: ado, name } = await createClientFromConfig(config, args.profile);
  const parent = await ado.getWorkItem(args.id, { expandRelations: true });
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

  let filtered = relatedItems.filter((wi: any) => isMatchingWorkItemType(wi, args.workItemType));
  if (args.state) filtered = filtered.filter((wi: any) => wi.fields?.["System.State"] === args.state);

  let out = `## Related for #${args.id} (${name})\n`;
  out += fmtWorkItemDetail(parent) + "\n";
  const filters = [args.workItemType && `type:${args.workItemType}`, args.state && `state:${args.state}`].filter(Boolean).join(" ");
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
      fullBatch.map((full: any) => formatWorkItemFullDetail(ado, full, `## #${full.id}`)),
    );
    detailBlocks.push(...formatted);
  }
  out += detailBlocks.join("\n---\n");
  return out;
}

// ─── Profile commands ───────────────────────────────────────────────────────

export async function profileGet(config: AdoConfig, args: { profile?: string }): Promise<string> {
  const { profile: prof, name } = await createClientFromConfig(config, args.profile);
  return `## Profile: ${name}\n${prof.org}/${prof.project}\nrepos: ${prof.repos.join(", ")}\npat: ${prof.patEnvVar}`;
}

export function profileList(config: AdoConfig): string {
  const active = getActiveProfile();
  const lines = ["## Profiles"];
  for (const [name, p] of Object.entries(config.profiles)) {
    const marker = name === active || (!active && name === config.defaultProfile) ? " ←" : "";
    lines.push(`${name}${marker}: ${p.org}/${p.project} repos:${p.repos.length}`);
  }
  return lines.join("\n");
}

export function profileUse(config: AdoConfig, args: { name: string }): string {
  if (!config.profiles[args.name]) {
    return `Profile "${args.name}" not found. Available: ${Object.keys(config.profiles).join(", ")}`;
  }
  setActiveProfile(args.name);
  return `Profile → ${args.name} (${config.profiles[args.name].org}/${config.profiles[args.name].project})`;
}
