/**
 * Pure helper functions for the chained PRs feature.
 *
 * No external dependencies — only chain-types imports.
 */

import type { ChainResult } from "./chain-types.js";

// ─── slugify ─────────────────────────────────────────────────────────────────

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
 */
export function slugify(title: string, maxLength: number = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

// ─── deriveBranchName ────────────────────────────────────────────────────────

/**
 * Derive a full branch name from a work item.
 *
 * Format: {prefix}/{wi-id}-{slug}
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

// ─── buildDependencyDiagram ──────────────────────────────────────────────────

/**
 * Build an ASCII dependency diagram with 📍 marking the current step.
 */
export function buildDependencyDiagram(
  steps: Array<{ prId?: number; title: string }>,
  currentIndex: number,
  tracker?: { prId: number; title: string },
): string {
  const lines: string[] = ["main"];

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

  for (let i = 0; i < entries.length; i++) {
    const marker = entries[i].isCurrent ? "📍 " : "";
    const indent = " ".repeat(i + 1);
    lines.push(`${indent}└── ${marker}${entries[i].label}`);
  }

  return lines.join("\n");
}

// ─── buildChainContext ───────────────────────────────────────────────────────

/**
 * Build the Chain Context markdown section for a PR description.
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
}): string {
  const lines: string[] = ["## Chain Context", ""];

  // Table header
  lines.push("| Field | Value |");
  lines.push("|-------|-------|");
  lines.push(`| Chain | ${params.chainName} |`);
  lines.push(`| Strategy | ${params.strategy} |`);

  if (params.tracker) {
    lines.push(`| Tracker | PR #${params.tracker.prId} (draft) |`);
  }

  lines.push(`| Position | ${params.position} of ${params.total} |`);

  if (params.dependsOn) {
    lines.push(`| Depends on | PR #${params.dependsOn.prId} — ${params.dependsOn.title} |`);
  }

  if (params.followUp) {
    lines.push(`| Follow-up | PR #${params.followUp.prId} — ${params.followUp.title} |`);
  }

  // Dependency diagram
  lines.push("");
  lines.push("### Dependency Diagram");
  lines.push("");

  const diagramTracker = params.tracker
    ? { prId: params.tracker.prId, title: "Tracker" }
    : undefined;

  lines.push(buildDependencyDiagram(params.steps, params.currentIndex, diagramTracker));

  return lines.join("\n");
}

// ─── formatChainResult ───────────────────────────────────────────────────────

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
    lines.push(`- PR: #${result.tracker.prId} (draft)${result.tracker.targetBranch ? ` → ${result.tracker.targetBranch}` : ""}`);
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
  lines.push(`${result.branchesCreated} branches created, ${result.created} PRs created, ${result.linked} WIs linked, ${result.errors.length} errors`);

  return lines.join("\n");
}
