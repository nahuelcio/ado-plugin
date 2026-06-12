/**
 * Shared chain runner functions extracted from index.ts handlers.
 * These functions contain the real business logic for PR creation and
 * chained PR orchestration, decoupled from the OpenCode/Pi plugin closures.
 */

import type { AdoClient } from "./ado-client.js";
import type { ProjectConfig, ChainResult, ChainStep } from "./chain-types.js";
import { BranchNameSchema } from "./chain-types.js";
import { slugify, deriveBranchName, buildChainContext, formatChainResult } from "./chain-helpers.js";

// ─── runCreatePr ─────────────────────────────────────────────────────────────

export interface CreatePrOpts {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  workItemIds?: number[];
  isDraft?: boolean;
}

export async function runCreatePr(
  ado: AdoClient,
  config: ProjectConfig,
  opts: CreatePrOpts,
): Promise<string> {
  const { repo, sourceBranch, targetBranch, title, description, workItemIds, isDraft } = opts;

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
}

// ─── runChainPrs ─────────────────────────────────────────────────────────────

export interface ChainPrsOpts {
  repo: string;
  workItemIds: number[];
  baseBranch?: string;
  strategy?: "feature-chain" | "stacked";
  prefix?: string;
  branchNames?: string[];
}

export async function runChainPrs(
  ado: AdoClient,
  config: ProjectConfig,
  opts: ChainPrsOpts,
): Promise<string> {
  const { repo, workItemIds, baseBranch, strategy, prefix, branchNames } = opts;

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
    branchesCreated: 0,
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
      result.branchesCreated++;
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
}
