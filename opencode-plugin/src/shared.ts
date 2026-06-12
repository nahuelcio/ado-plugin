/**
 * Shared types, config helpers, and formatting utilities for the ADO plugin.
 *
 * Used by both the server module (index.ts) and the TUI module (tui.tsx).
 * Import from here instead of duplicating definitions.
 *
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────

export interface AdoProfile {
  org: string;
  project: string;
  patEnvVar: string;
  repos: string[];
  default?: boolean;
  capabilities?: {
    workItems?: boolean;
  };
}

/** Default work item states to fetch in queries.*/
export const IMPORTANT_WORK_ITEM_STATES = [
  'New', 'In Dev', 'Ready for QA', 'Accepted in QA', 'In QA',
] as const;

export interface AdoConfig {
  defaultProfile?: string;
  profiles: Record<string, AdoProfile>;
}

export interface PRSummary {
  id: number;
  title: string;
  repo: string;
  source: string;
  target: string;
  author: string;
  isDraft: boolean;
  /** Vote status if the current user is a reviewer: 0=none, 10=approved, 5=suggestions, -5=waiting, -10=rejected. undefined if not a reviewer. */
  myVote?: number;
}

export interface WorkItemSummary {
  id: number;
  title: string;
  state: string;
  type: string;        // System.WorkItemType (Bug, Task, User Story, etc.)
  assignedTo: string;  // displayName
  priority: number;    // Microsoft.VSTS.Common.Priority
  changedDate?: string;
  /** Reproduction steps for QA-related work items (Microsoft.VSTS.TCM.ReproSteps). */
  reproSteps?: string;
}

// ─── Config helpers ───────────────────────────────────────────────────────

/** Coerce an unknown plugin config value into an AdoConfig, or return undefined. */
export function asAdoConfig(value: unknown): AdoConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as { ado?: unknown; profiles?: unknown };
  if (maybe.profiles && typeof maybe.profiles === "object") {
    // Validate that profiles is a non-empty object
    const profiles = maybe.profiles as Record<string, unknown>;
    if (Object.keys(profiles).length === 0) return undefined;
    return maybe as AdoConfig;
  }
  if (maybe.ado && typeof maybe.ado === "object") return asAdoConfig(maybe.ado);
  return undefined;
}

/** Resolve the active profile from config using defaultProfile > default:true > first. */
export function resolveActiveProfile(config: AdoConfig): { name: string; profile: AdoProfile } {
  // 1. Explicit defaultProfile name
  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return { name: config.defaultProfile, profile: config.profiles[config.defaultProfile] };
  }
  // 2. Profile marked default:true
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.default) return { name, profile };
  }
  // 3. First profile
  const entries = Object.entries(config.profiles);
  if (entries.length === 0) throw new Error("No ADO profiles configured in opencode.json under 'ado.profiles'");
  const [name, profile] = entries[0];
  return { name, profile };
}

/** Build the organisation URL from a short name or full URL. */
export function resolveOrgUrl(org: string): string {
  if (org.startsWith("http://") || org.startsWith("https://")) return org.replace(/\/$/, "");
  return `https://dev.azure.com/${org}`;
}

// ─── PAT helpers ──────────────────────────────────────────────────────────

/** Validate Azure DevOps PAT format and length. Azure DevOps PATs are typically 52 characters. */
export function validatePAT(pat: string): void {
  if (!pat || typeof pat !== 'string') {
    throw new Error("PAT cannot be empty or undefined");
  }

  if (pat.length < 10) {
    throw new Error("PAT is too short. Azure DevOps PATs should be at least 52 characters.");
  }

  if (pat.length > 100) {
    throw new Error("PAT is too long. Suspicious input.");
  }

  // Azure DevOps PATs are base64-like: alphanumeric with optional padding (=) at the end
  // They should not contain arbitrary numbers of equals signs
  const base64Pattern = /^[-_a-zA-Z0-9]+={0,2}$/;
  if (!base64Pattern.test(pat)) {
    throw new Error("Invalid PAT format. Azure DevOps PATs should contain only letters, numbers, underscores, hyphens, and at most 2 trailing equals signs.");
  }
}

/**
 * Get the PAT for the given env var name. Throws if not found or invalid.
 * Used by the server module which requires a PAT to function.
 */
export function getPAT(envVarName: string): string {
  // 1. Try env var
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    validatePAT(fromEnv);
    return fromEnv;
  }

  // 2. Fallback: ~/.azure-devops-cli/pat (set by npx init)
  try {
    const patPath = join(homedir(), ".azure-devops-cli", "pat");
    if (existsSync(patPath)) {
      const pat = readFileSync(patPath, "utf-8").trim();
      if (pat) {
        validatePAT(pat);
        return pat;
      }
    }
  } catch { /* ignore: file read failures are non-critical */ }

  throw new Error(
    `PAT not found or invalid. Either set env var ${envVarName} or run: npx @nahuelcio/opencode-ado init`,
  );
}

/**
 * Get the PAT for the given env var name. Returns undefined if not found or invalid.
 * Used by the TUI module which handles missing PATs gracefully.
 */
export function getPATOptional(envVarName: string): string | undefined {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    try {
      validatePAT(fromEnv);
      return fromEnv;
    } catch {
      // Invalid PAT, skip to fallback
    }
  }

  try {
    const patPath = join(homedir(), ".azure-devops-cli", "pat");
    if (existsSync(patPath)) {
      const pat = readFileSync(patPath, "utf-8").trim();
      if (pat) {
        validatePAT(pat);
        return pat;
      }
    }
  } catch { /* ignore: file read failures are non-critical */ }
  return undefined;
}

// ─── Formatting helpers ──────────────────────────────────────────────────

/** Strip refs/heads/ or refs/tags/ prefix from a ref string. */
export function shortBranch(ref?: string): string {
  if (!ref) return "?";
  return ref.replace("refs/heads/", "").replace("refs/tags/", "");
}

/** Check if a reviewer object matches the given user ID. Handles undefined userId gracefully. */
export function reviewerMatchesUser(reviewer: any, userId: string | undefined): boolean {
  if (!userId) return false;
  if (!reviewer) return false;
  return reviewer?.id === userId
    || reviewer?.votedBy?.id === userId
    || reviewer?.uniqueName === userId;
}

/** Format a PR as a single-line list entry. */
export function fmtPR(pr: any): string {
  if (!pr) return "Invalid PR data";
  const repo = pr.repository?.name || "?";
  const src = shortBranch(pr.sourceRefName);
  const tgt = shortBranch(pr.targetRefName);
  const author = pr.createdBy?.displayName || "?";
  const draft = pr.isDraft ? " [D]" : "";
  const created = pr.creationDate?.slice(0, 10) || "?";
  return `#${pr.pullRequestId}${draft} ${pr.title} | ${repo} ${src}→${tgt} @${author} ${created}`;
}

/** Format a PR as a detailed multi-line block. */
export function fmtPRDetail(pr: any): string {
  const vote = (v: number) => v === 10 ? "✓" : v === -10 ? "✗" : v === -5 ? "⏳" : v === 5 ? "💬" : "—";
  const reviewers = pr.reviewers?.length
    ? pr.reviewers.map((r: any) => `${vote(r.vote)} ${r.votedBy?.displayName || r.displayName || "?"}`).join(" | ")
    : "";
  const lines = [
    `#${pr.pullRequestId} ${pr.title}${pr.isDraft ? " [D]" : ""}`,
    `${pr.status} | ${shortBranch(pr.sourceRefName)}→${shortBranch(pr.targetRefName)} @${pr.createdBy?.displayName || "?"}`,
    pr.creationDate?.slice(0, 10),
    reviewers && `reviewers: ${reviewers}`,
    pr.description && `desc: ${pr.description.slice(0, 300)}${pr.description.length > 300 ? "..." : ""}`,
  ].filter(Boolean);
  return lines.join("\n");
}

/** Format a thread as a concise summary line. */
export function fmtThread(t: any): string {
  const file = t.threadContext?.filePath?.split("/").pop() ?? "";
  const status = t.status ?? "?";
  const firstComment = (t.comments?.[0]?.content ?? "").slice(0, 80);
  return `[${status}] ${file ? file + ": " : ""}${firstComment} (${t.comments?.length ?? 0}c)`;
}

// ─── Work Item formatting helpers ────────────────────────────────────────

/** Extract assigned-to display name from the ADO API identity field. */
function wiAssignedTo(fields: any): string {
  return fields?.["System.AssignedTo"]?.displayName ?? "Unassigned";
}

function plainText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Abbreviate work item type. */
export function abbrevType(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("bug")) return "Bug";
  if (t.includes("user story")) return "US";
  if (t.includes("task")) return "Task";
  if (t.includes("feature")) return "Feat";
  if (t.includes("qa feedback")) return "QA Feed";
  return type.slice(0, 8);
}

/** Format date as MM-DD. */
export function shortDate(iso: string): string {
  return iso?.slice(5, 10) || "?";
}

/** Format a work item as a single-line list entry. */
export function fmtWorkItem(wi: any): string {
  const id = wi.id || "?";
  const title = wi.fields?.["System.Title"] || "?";
  const type = abbrevType(wi.fields?.["System.WorkItemType"] || "?");
  const state = (wi.fields?.["System.State"] || "?").replace(/\s+/g, "");
  const priority = wi.fields?.["Microsoft.VSTS.Common.Priority"] || "?";
  const assigned = wiAssignedTo(wi.fields).split(" ")[0];
  const changed = shortDate(wi.fields?.["System.ChangedDate"]);
  return `#${id} ${title} [${type}] ${state} P${priority} @${assigned} ${changed}`;
}

/** Format a work item as a detailed multi-line block. */
export function fmtWorkItemDetail(wi: any): string {
  const f = wi.fields || {};
  const lines = [
    `#${wi.id} ${f["System.Title"] || "?"}`,
    `${abbrevType(f["System.WorkItemType"] || "?")} | ${f["System.State"] || "?"} | P${f["Microsoft.VSTS.Common.Priority"] || "?"} | @${wiAssignedTo(f).split(" ")[0]}`,
    f["System.ChangedDate"] && `changed: ${shortDate(f["System.ChangedDate"])}`,
    formatDescription(f["System.Description"]),
    formatReproSteps(f["Microsoft.VSTS.TCM.ReproSteps"]),
  ].filter(Boolean);
  return lines.join("\n");
}

function formatDescription(desc: any): string | null {
  if (!desc) return null;
  const text = plainText(desc);
  if (!text) return null;
  const compact = text.replace(/\n+/g, " ").slice(0, 300);
  return compact ? `\ndesc: ${compact}${text.length > 300 ? "..." : ""}` : null;
}

function formatReproSteps(repro: any): string | null {
  if (!repro) return null;
  const text = plainText(repro);
  if (!text) return null;
  const compact = text.replace(/\n+/g, " ").slice(0, 300);
  return compact ? `\nrepro: ${compact}${text.length > 300 ? "..." : ""}` : null;
}

// ─── Reusable Zod schemas for MCP tools ────────────────────────────────────────

import { z } from "zod/v4";

/** Shared Zod schemas to avoid repeating descriptions across tools. */
export const adoSchemas = {
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
