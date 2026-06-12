/**
 * TDD RED phase — tests for chain-helpers.ts
 *
 * These tests import from ../src/chain-helpers.js which DOES NOT EXIST yet.
 * They are supposed to fail at import resolution until the implementation is done.
 */
import { describe, expect, it } from "vitest";
import {
  slugify,
  deriveBranchName,
  buildDependencyDiagram,
  buildChainContext,
  formatChainResult,
} from "../src/chain-helpers.js";
import type { ChainResult } from "../src/chain-types.js";

// ─── slugify ────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("converts a basic title to a slug", () => {
    expect(slugify("Add authentication schema")).toBe("add-authentication-schema");
  });

  it("removes special characters and replaces them with hyphens", () => {
    expect(slugify("Fix login redirect bug!!!")).toBe("fix-login-redirect-bug");
  });

  it("truncates to maxLength without leaving trailing hyphens", () => {
    const longTitle = "Hotfix: null pointer in payment processing system";
    const result = slugify(longTitle, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toMatch(/-$/);
    // The slug is truncated at 40 chars after sanitizing — last char is "n" from "processin"
    expect(result).toBe("hotfix-null-pointer-in-payment-processin");
  });

  it("collapses consecutive hyphens into a single hyphen", () => {
    expect(slugify("foo   bar--baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("---leading-and-trailing---")).toBe("leading-and-trailing");
  });

  it("converts all whitespace to single hyphens", () => {
    expect(slugify("  spaces  everywhere  ")).toBe("spaces-everywhere");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("returns empty string for input that becomes only hyphens", () => {
    expect(slugify("!!!???")).toBe("");
  });

  it("preserves numbers in the slug", () => {
    expect(slugify("Fix issue #123 in v2.0")).toBe("fix-issue-123-in-v2-0");
  });

  it("uses default maxLength of 40 when not specified", () => {
    const longTitle = "A".repeat(100);
    const result = slugify(longTitle);
    expect(result.length).toBeLessThanOrEqual(40);
  });
});

// ─── deriveBranchName ───────────────────────────────────────────────────────

describe("deriveBranchName", () => {
  it("derives a full branch name from prefix, WI ID, and title", () => {
    expect(deriveBranchName("feature", 123, "Add auth schema")).toBe(
      "feature/123-add-auth-schema",
    );
  });

  it("uses a custom prefix", () => {
    expect(deriveBranchName("bugfix", 456, "Fix crash")).toBe(
      "bugfix/456-fix-crash",
    );
  });

  it("respects slugMaxLength parameter", () => {
    const longTitle = "A very long title that should definitely be truncated";
    const result = deriveBranchName("feature", 789, longTitle, 20);
    // Format: feature/789-{slug}  — slug part should be <= 20 chars
    const slugPart = result.split("-").slice(1).join("-");
    expect(slugPart.length).toBeLessThanOrEqual(20);
  });

  it("uses default slugMaxLength of 40", () => {
    const longTitle = "A".repeat(100);
    const result = deriveBranchName("feature", 100, longTitle);
    const slugPart = result.substring("feature/100-".length);
    expect(slugPart.length).toBeLessThanOrEqual(40);
  });
});

// ─── buildDependencyDiagram ─────────────────────────────────────────────────

describe("buildDependencyDiagram", () => {
  it("builds a linear diagram with 3 steps and no tracker (stacked strategy)", () => {
    const steps = [
      { prId: 101, title: "Auth schema" },
      { prId: 102, title: "Auth API" },
      { prId: 103, title: "Auth UI" },
    ];
    const result = buildDependencyDiagram(steps, 1);

    expect(result).toContain("main");
    expect(result).toContain("#101 Auth schema");
    expect(result).toContain("#102 Auth API");
    expect(result).toContain("#103 Auth UI");
    // No tracker → first entry directly under main
    const lines = result.split("\n");
    expect(lines[0]).toBe("main");
    expect(lines.length).toBe(4); // main + 3 steps
  });

  it("builds a linear diagram with 3 steps and a tracker (feature-chain strategy)", () => {
    const steps = [
      { prId: 101, title: "Auth schema" },
      { prId: 102, title: "Auth API" },
      { prId: 103, title: "Auth UI" },
    ];
    const tracker = { prId: 100, title: "Tracker" };
    const result = buildDependencyDiagram(steps, 1, tracker);

    expect(result).toContain("main");
    expect(result).toContain("#100 Tracker (draft)");
    expect(result).toContain("#101 Auth schema");
    const lines = result.split("\n");
    // main + tracker + 3 steps = 5 lines
    expect(lines.length).toBe(5);
  });

  it("marks the current step with 📍", () => {
    const steps = [
      { prId: 101, title: "Auth schema" },
      { prId: 102, title: "Auth API" },
      { prId: 103, title: "Auth UI" },
    ];
    const result = buildDependencyDiagram(steps, 1);
    // Step at index 1 (Auth API) should be marked
    expect(result).toContain("📍");
    // Other steps should NOT be marked
    const lines = result.split("\n");
    const currentLine = lines.find((l) => l.includes("📍"));
    expect(currentLine).toContain("#102 Auth API");
  });

  it("uses └── at every level for a linear chain", () => {
    const steps = [
      { prId: 101, title: "Step 1" },
      { prId: 102, title: "Step 2" },
    ];
    const result = buildDependencyDiagram(steps, 0);
    const lines = result.split("\n");
    // Every line after "main" should contain └──
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toContain("└──");
    }
  });

  it("indents each level deeper than the previous", () => {
    const steps = [
      { prId: 101, title: "Step 1" },
      { prId: 102, title: "Step 2" },
      { prId: 103, title: "Step 3" },
    ];
    const result = buildDependencyDiagram(steps, 0);
    const lines = result.split("\n");
    // Each line should have more leading spaces than the previous
    for (let i = 2; i < lines.length; i++) {
      const prevSpaces = lines[i - 1].match(/^(\s*)/)?.[1].length ?? 0;
      const currSpaces = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
      expect(currSpaces).toBeGreaterThan(prevSpaces);
    }
  });

  it("handles steps without prId (title only)", () => {
    const steps = [
      { title: "Step without PR" },
    ];
    const result = buildDependencyDiagram(steps, 0);
    expect(result).toContain("Step without PR");
    expect(result).not.toContain("#undefined");
  });
});

// ─── buildChainContext ───────────────────────────────────────────────────────

describe("buildChainContext", () => {
  const baseParams = {
    chainName: "auth",
    strategy: "feature-chain" as const,
    position: 2,
    total: 3,
    steps: [
      { prId: 101, title: "Auth schema", wiId: 123 },
      { prId: 102, title: "Auth API", wiId: 124 },
      { prId: 103, title: "Auth UI", wiId: 125 },
    ],
    currentIndex: 1,
  };

  it("produces markdown with Chain Context table", () => {
    const result = buildChainContext(baseParams);
    expect(result).toContain("## Chain Context");
    expect(result).toContain("| Field | Value |");
  });

  it("includes dependency diagram", () => {
    const result = buildChainContext(baseParams);
    expect(result).toContain("### Dependency Diagram");
    expect(result).toContain("main");
  });

  it("includes tracker row for feature-chain strategy", () => {
    const params = {
      ...baseParams,
      tracker: { prId: 100, branchName: "feature/auth-tracker" },
    };
    const result = buildChainContext(params);
    expect(result).toContain("Tracker");
  });

  it("omits tracker row for stacked strategy", () => {
    const params = {
      ...baseParams,
      strategy: "stacked" as const,
    };
    const result = buildChainContext(params);
    expect(result).not.toContain("Tracker");
  });

  it("includes position information", () => {
    const result = buildChainContext(baseParams);
    expect(result).toContain("Position");
    expect(result).toContain("2 of 3");
  });

  it("includes Depends on when previous step exists", () => {
    const params = {
      ...baseParams,
      dependsOn: { prId: 101, title: "Auth schema" },
    };
    const result = buildChainContext(params);
    expect(result).toContain("Depends on");
    expect(result).toContain("#101");
  });

  it("includes Follow-up when next step exists", () => {
    const params = {
      ...baseParams,
      followUp: { prId: 103, title: "Auth UI" },
    };
    const result = buildChainContext(params);
    expect(result).toContain("Follow-up");
    expect(result).toContain("#103");
  });

  it("includes chain name", () => {
    const result = buildChainContext(baseParams);
    expect(result).toContain("auth");
  });
});

// ─── formatChainResult ───────────────────────────────────────────────────────

describe("formatChainResult", () => {
  it("formats a happy path result with all steps successful", () => {
    const result: ChainResult = {
      strategy: "feature-chain",
      tracker: {
        branchName: "feature/auth-tracker",
        prId: 100,
        prUrl: "https://dev.azure.com/org/proj/_git/repo/pullrequest/100",
      },
      steps: [
        {
          workItemId: 123,
          workItemTitle: "Auth Schema",
          branchName: "feature/123-auth-schema",
          refName: "refs/heads/feature/123-auth-schema",
          parentRefName: "refs/heads/main",
          pr: { id: 101, url: "https://dev.azure.com/org/proj/_git/repo/pullrequest/101" },
          linked: true,
        },
        {
          workItemId: 124,
          workItemTitle: "Auth API",
          branchName: "feature/124-auth-api",
          refName: "refs/heads/feature/124-auth-api",
          parentRefName: "refs/heads/feature/123-auth-schema",
          pr: { id: 102, url: "https://dev.azure.com/org/proj/_git/repo/pullrequest/102" },
          linked: true,
        },
      ],
      created: 2,
      linked: 2,
      errors: [],
    };

    const output = formatChainResult(result);
    expect(output).toContain("## Chain Created: feature-chain (2 PRs)");
    expect(output).toContain("### Tracker");
    expect(output).toContain("feature/auth-tracker");
    expect(output).toContain("#100");
    expect(output).toContain("### Steps");
    expect(output).toContain("✅");
    expect(output).toContain("#123 Auth Schema");
    expect(output).toContain("PR #101");
    expect(output).toContain("(linked)");
    expect(output).toContain("### Summary");
    expect(output).not.toContain("### Errors");
  });

  it("formats partial success with errors", () => {
    const result: ChainResult = {
      strategy: "stacked",
      steps: [
        {
          workItemId: 123,
          workItemTitle: "Auth Schema",
          branchName: "feature/123-auth-schema",
          refName: "refs/heads/feature/123-auth-schema",
          parentRefName: "refs/heads/main",
          pr: { id: 101, url: "https://example.com/pr/101" },
          linked: true,
        },
        {
          workItemId: 124,
          workItemTitle: "Auth API",
          branchName: "feature/124-auth-api",
          refName: "refs/heads/feature/124-auth-api",
          parentRefName: "refs/heads/main",
          linked: false,
          error: "WI link failed: Work item not found",
        },
      ],
      created: 2,
      linked: 1,
      errors: ["WI #124 link failed: Work item not found"],
    };

    const output = formatChainResult(result);
    expect(output).toContain("⚠️");
    expect(output).toContain("### Errors");
    expect(output).toContain("WI #124 link failed");
    expect(output).toContain("1 errors");
  });

  it("formats stacked result without tracker section", () => {
    const result: ChainResult = {
      strategy: "stacked",
      steps: [
        {
          workItemId: 123,
          workItemTitle: "Auth Schema",
          branchName: "feature/123-auth-schema",
          refName: "refs/heads/feature/123-auth-schema",
          parentRefName: "refs/heads/main",
          pr: { id: 101, url: "https://example.com/pr/101" },
          linked: true,
        },
      ],
      created: 1,
      linked: 1,
      errors: [],
    };

    const output = formatChainResult(result);
    expect(output).toContain("## Chain Created: stacked (1 PRs)");
    expect(output).not.toContain("### Tracker");
  });

  it("formats feature-chain result with tracker section", () => {
    const result: ChainResult = {
      strategy: "feature-chain",
      tracker: {
        branchName: "feature/auth-tracker",
        prId: 100,
        prUrl: "https://example.com/pr/100",
      },
      steps: [],
      created: 0,
      linked: 0,
      errors: [],
    };

    const output = formatChainResult(result);
    expect(output).toContain("### Tracker");
    expect(output).toContain("feature/auth-tracker");
    expect(output).toContain("#100 (draft)");
  });

  it("shows 'no PR' for steps without a PR", () => {
    const result: ChainResult = {
      strategy: "stacked",
      steps: [
        {
          workItemId: 123,
          workItemTitle: "Auth Schema",
          branchName: "feature/123-auth-schema",
          refName: "refs/heads/feature/123-auth-schema",
          parentRefName: "refs/heads/main",
          linked: false,
          error: "Branch creation failed",
        },
      ],
      created: 0,
      linked: 0,
      errors: ["Branch creation failed"],
    };

    const output = formatChainResult(result);
    expect(output).toContain("no PR");
  });
});
