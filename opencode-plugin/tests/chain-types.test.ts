/**
 * TDD RED phase — tests for chain-types.ts (Zod schemas)
 *
 * These tests import from ../src/chain-types.js which DOES NOT EXIST yet.
 * They validate the BranchNameSchema and ProjectConfigSchema.
 */
import { describe, expect, it } from "vitest";
import { BranchNameSchema, ProjectConfigSchema } from "../src/chain-types.js";

// ─── BranchNameSchema ───────────────────────────────────────────────────────

describe("BranchNameSchema", () => {
  it("accepts a valid branch name with feature prefix", () => {
    const result = BranchNameSchema.safeParse("feature/123-auth-schema");
    expect(result.success).toBe(true);
  });

  it("accepts a valid branch name with bugfix prefix", () => {
    const result = BranchNameSchema.safeParse("bugfix/456-fix-crash-on-startup");
    expect(result.success).toBe(true);
  });

  it("accepts a valid branch name with hotfix prefix", () => {
    const result = BranchNameSchema.safeParse("hotfix/789-urgent-fix");
    expect(result.success).toBe(true);
  });

  it("rejects branch names with uppercase letters", () => {
    const result = BranchNameSchema.safeParse("feature/123-Auth-Schema");
    expect(result.success).toBe(false);
  });

  it("rejects branch names with spaces", () => {
    const result = BranchNameSchema.safeParse("feature/123 auth schema");
    expect(result.success).toBe(false);
  });

  it("rejects branch names without a work item ID", () => {
    const result = BranchNameSchema.safeParse("feature/auth-schema");
    expect(result.success).toBe(false);
  });

  it("rejects branch names that are too short (under 3 chars)", () => {
    const result = BranchNameSchema.safeParse("ab");
    expect(result.success).toBe(false);
  });

  it("rejects branch names that are too long (over 200 chars)", () => {
    const result = BranchNameSchema.safeParse("feature/123-" + "a".repeat(200));
    expect(result.success).toBe(false);
  });

  it("rejects branch names with underscores in slug", () => {
    const result = BranchNameSchema.safeParse("feature/123-auth_schema");
    expect(result.success).toBe(false);
  });

  it("rejects branch names starting with a number in the prefix", () => {
    const result = BranchNameSchema.safeParse("123feature/123-auth");
    expect(result.success).toBe(false);
  });

  it("rejects branch names with no prefix (just a slug)", () => {
    const result = BranchNameSchema.safeParse("123-auth-schema");
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = BranchNameSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("provides a descriptive error message on failure", () => {
    const result = BranchNameSchema.safeParse("INVALID");
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i: any) => i.message).join("; ");
      expect(message).toContain("prefix");
    }
  });
});

// ─── ProjectConfigSchema ────────────────────────────────────────────────────

describe("ProjectConfigSchema", () => {
  it("applies all defaults for an empty object", () => {
    const result = ProjectConfigSchema.parse({});

    expect(result.chain.strategy).toBe("feature-chain");
    expect(result.chain.base_branch).toBe("main");
    expect(result.chain.max_length).toBe(10);
    expect(result.chain.prefix).toBe("feature");
    expect(result.chain.tracker_name).toBe("");
    expect(result.branch.allowed_types).toEqual([
      "feature", "bugfix", "hotfix", "chore", "refactor",
    ]);
    expect(result.branch.slug_max_length).toBe(40);
    expect(result.branch.require_wi_id).toBe(true);
    expect(result.pr.require_work_item).toBe(true);
    expect(result.pr.include_chain_context).toBe(true);
    expect(result.pr.review_budget).toBe(400);
    expect(result.pr.default_draft).toBe(false);
    expect(result.work_item.auto_transition).toBe(false);
    expect(result.work_item.target_state).toBe("In Dev");
  });

  it("applies defaults for partial chain config", () => {
    const result = ProjectConfigSchema.parse({
      chain: { strategy: "stacked" },
    });

    expect(result.chain.strategy).toBe("stacked");
    expect(result.chain.base_branch).toBe("main");
    expect(result.chain.max_length).toBe(10);
  });

  it("applies defaults for partial branch config", () => {
    const result = ProjectConfigSchema.parse({
      branch: { slug_max_length: 25 },
    });

    expect(result.branch.slug_max_length).toBe(25);
    expect(result.branch.allowed_types).toEqual([
      "feature", "bugfix", "hotfix", "chore", "refactor",
    ]);
    expect(result.branch.require_wi_id).toBe(true);
  });

  it("applies defaults for partial pr config", () => {
    const result = ProjectConfigSchema.parse({
      pr: { default_draft: true },
    });

    expect(result.pr.default_draft).toBe(true);
    expect(result.pr.review_budget).toBe(400);
    expect(result.pr.require_work_item).toBe(true);
  });

  it("rejects an invalid strategy", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { strategy: "turbo-chain" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects max_length below 1", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { max_length: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects max_length above 50", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { max_length: 51 },
    });

    expect(result.success).toBe(false);
  });

  it("accepts max_length at boundary (1)", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { max_length: 1 },
    });

    expect(result.success).toBe(true);
  });

  it("accepts max_length at boundary (50)", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { max_length: 50 },
    });

    expect(result.success).toBe(true);
  });

  it("rejects slug_max_length below 10", () => {
    const result = ProjectConfigSchema.safeParse({
      branch: { slug_max_length: 5 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects slug_max_length above 100", () => {
    const result = ProjectConfigSchema.safeParse({
      branch: { slug_max_length: 101 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects review_budget of 0", () => {
    const result = ProjectConfigSchema.safeParse({
      pr: { review_budget: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects review_budget above 5000", () => {
    const result = ProjectConfigSchema.safeParse({
      pr: { review_budget: 5001 },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a fully specified valid config", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: {
        strategy: "feature-chain",
        base_branch: "develop",
        max_length: 25,
        prefix: "feature",
        tracker_name: "feature/tracker",
      },
      branch: {
        allowed_types: ["feature", "bugfix"],
        slug_max_length: 30,
        require_wi_id: true,
      },
      pr: {
        require_work_item: true,
        include_chain_context: true,
        review_budget: 500,
        default_draft: true,
      },
      work_item: {
        auto_transition: true,
        target_state: "Active",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chain.strategy).toBe("feature-chain");
      expect(result.data.chain.base_branch).toBe("develop");
      expect(result.data.chain.max_length).toBe(25);
      expect(result.data.branch.allowed_types).toEqual(["feature", "bugfix"]);
      expect(result.data.pr.review_budget).toBe(500);
      expect(result.data.work_item.auto_transition).toBe(true);
    }
  });

  it("handles non-integer max_length by rejecting it", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { max_length: 5.5 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-string base_branch", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { base_branch: 123 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty prefix", () => {
    const result = ProjectConfigSchema.safeParse({
      chain: { prefix: "" },
    });

    expect(result.success).toBe(false);
  });
});
