/**
 * Types and Zod schemas for the chained PRs feature.
 *
 * All chain-related interfaces live here to keep shared.ts focused
 * on existing ADO types.
 */

import { z } from "zod/v4";

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Parsed .adoconfig.toml — project-level chain configuration. */
export interface ProjectConfig {
  chain: {
    strategy: "feature-chain" | "stacked";
    base_branch: string;
    max_length: number;
    prefix: string;
    tracker_name: string;
  };
  branch: {
    allowed_types: string[];
    slug_max_length: number;
    require_wi_id: boolean;
  };
  pr: {
    require_work_item: boolean;
    include_chain_context: boolean;
    review_budget: number;
    default_draft: boolean;
  };
  work_item: {
    auto_transition: boolean;
    target_state: string;
    create: {
      enabled: boolean;
      allowed_types: string[];
      required_fields: string[];
      default_state: string;
      auto_assign: boolean;
      require_parent: boolean;
      default_type: string;
    };
  };
}

/** One step in a chain: a branch, its PR, and its linked work item. */
export interface ChainStep {
  workItemId: number;
  workItemTitle: string;
  branchName: string;
  refName: string;
  parentRefName: string;
  pr?: {
    id: number;
    url: string;
  };
  linked: boolean;
  error?: string;
}

/** Result of an ado_chain_prs invocation. */
export interface ChainResult {
  strategy: "feature-chain" | "stacked";
  tracker?: {
    branchName: string;
    prId: number;
    prUrl: string;
    targetBranch?: string;
  };
  steps: ChainStep[];
  /** Number of PRs successfully created. */
  created: number;
  /** Number of branches successfully created. */
  branchesCreated: number;
  linked: number;
  errors: string[];
}

/** Options for AdoClient.createPullRequest(). */
export interface CreatePrOptions {
  sourceRefName: string;
  targetRefName: string;
  title: string;
  description?: string;
  isDraft?: boolean;
}

/** Response from ADO Git Refs API on branch creation. */
export interface GitRefUpdateResult {
  name: string;
  objectId: string;
  oldObjectId: string;
  success: boolean;
  updateStatus?: string;
}

/** Minimal ADO GitPullRequest response. */
export interface GitPullRequest {
  pullRequestId: number;
  url?: string;
  title?: string;
  status?: string;
  sourceRefName?: string;
  targetRefName?: string;
  isDraft?: boolean;
  repository?: { id: string; name: string; project?: { id: string; name: string } };
  createdBy?: { id: string; displayName: string };
}

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

/** Schema for validating branch name format. */
export const BranchNameSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[a-z][a-z0-9-]*\/\d+-[a-z0-9-]+$/,
    "Branch name must match: {prefix}/{wi-id}-{slug} (lowercase, hyphens only)",
  );

/** Schema for validating .adoconfig.toml structure. */
export const ProjectConfigSchema = z.object({
  chain: z.preprocess(
    (val) => val ?? {},
    z.object({
      strategy: z.enum(["feature-chain", "stacked"]).default("feature-chain"),
      base_branch: z.string().default("main"),
      max_length: z.number().int().min(1).max(50).default(10),
      prefix: z.string().min(1).default("feature"),
      tracker_name: z.string().default(""),
    }),
  ),
  branch: z.preprocess(
    (val) => val ?? {},
    z.object({
      allowed_types: z.array(z.string()).default(["feature", "bugfix", "hotfix", "chore", "refactor"]),
      slug_max_length: z.number().int().min(10).max(100).default(40),
      require_wi_id: z.boolean().default(true),
    }),
  ),
  pr: z.preprocess(
    (val) => val ?? {},
    z.object({
      require_work_item: z.boolean().default(true),
      include_chain_context: z.boolean().default(true),
      review_budget: z.number().int().min(1).max(5000).default(400),
      default_draft: z.boolean().default(false),
    }),
  ),
  work_item: z.preprocess(
    (val) => val ?? {},
    z.object({
      auto_transition: z.boolean().default(false),
      target_state: z.string().default("In Dev"),
      create: z.preprocess(
        (val) => val ?? {},
        z.object({
          enabled: z.boolean().default(true),
          allowed_types: z.array(z.string()).default([]),
          required_fields: z.array(z.string()).default(["title"]),
          default_state: z.string().default("New"),
          auto_assign: z.boolean().default(false),
          require_parent: z.boolean().default(false),
          default_type: z.string().default("User Story"),
        }),
      ),
    }),
  ),
});
