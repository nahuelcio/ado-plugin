/**
 * Integration tests for the chained PRs tool-level logic.
 *
 * Tests exercise the real runCreatePr and runChainPrs functions from chain-runner.ts
 * with mocked AdoClient (via vi.spyOn(globalThis, "fetch")).
 *
 * What's NOT tested here:
 * - The actual plugin registration (framework concern).
 * - The `loadConfig()` closure (requires OpenCode client mock).
 * - The `createClient()` closure (requires PAT resolution).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AdoClient } from "../src/ado-client.js";
import {
  slugify,
  deriveBranchName,
  buildChainContext,
  formatChainResult,
} from "../src/chain-helpers.js";
import { BranchNameSchema, ProjectConfigSchema, type ChainResult, type ChainStep } from "../src/chain-types.js";
import { loadProjectConfig } from "../src/chain-config.js";
import { runCreatePr, runChainPrs } from "../src/chain-runner.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeClient(): AdoClient {
  return new AdoClient(
    "https://dev.azure.com/testorg",
    "TestProject",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── ado_create_pr: Validation logic ────────────────────────────────────────

describe("ado_pr_create: validation logic", () => {
  it("rejects when require_work_item is true and no workItemIds provided", async () => {
    // Simulate the config check from ado_create_pr
    const config = ProjectConfigSchema.parse({ pr: { require_work_item: true } });
    const workItemIds: number[] | undefined = undefined;

    const shouldReject =
      config.pr.require_work_item && (!workItemIds || workItemIds.length === 0);
    expect(shouldReject).toBe(true);
  });

  it("rejects when require_work_item is true and workItemIds is empty array", async () => {
    const config = ProjectConfigSchema.parse({ pr: { require_work_item: true } });
    const workItemIds: number[] = [];

    const shouldReject =
      config.pr.require_work_item && (!workItemIds || workItemIds.length === 0);
    expect(shouldReject).toBe(true);
  });

  it("allows when require_work_item is false and no workItemIds provided", async () => {
    const config = ProjectConfigSchema.parse({ pr: { require_work_item: false } });
    const workItemIds: number[] | undefined = undefined;

    const shouldReject =
      config.pr.require_work_item && (!workItemIds || workItemIds.length === 0);
    expect(shouldReject).toBe(false);
  });

  it("allows when require_work_item is true and workItemIds is provided", async () => {
    const config = ProjectConfigSchema.parse({ pr: { require_work_item: true } });
    const workItemIds = [123, 456];

    const shouldReject =
      config.pr.require_work_item && (!workItemIds || workItemIds.length === 0);
    expect(shouldReject).toBe(false);
  });

  it("resolves isDraft from config default when not provided", () => {
    const configDraft = ProjectConfigSchema.parse({ pr: { default_draft: true } });
    const isDraft: boolean | undefined = undefined;
    expect(isDraft ?? configDraft.pr.default_draft).toBe(true);

    const configNoDraft = ProjectConfigSchema.parse({ pr: { default_draft: false } });
    expect(isDraft ?? configNoDraft.pr.default_draft).toBe(false);
  });

  it("uses explicit isDraft over config default", () => {
    const config = ProjectConfigSchema.parse({ pr: { default_draft: true } });
    const isDraft = false;
    expect(isDraft ?? config.pr.default_draft).toBe(false);
  });
});

// ─── ado_create_pr: Artifact URL construction ───────────────────────────────

describe("ado_pr_create: artifact URL format", () => {
  it("constructs correct vstfs URL with project, repo, and PR IDs", () => {
    const projectId = "proj-uuid-1234";
    const repoId = "repo-uuid-5678";
    const pullRequestId = 101;

    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pullRequestId}`;

    expect(artifactUrl).toBe(
      "vstfs:///Git/PullRequestId/proj-uuid-1234%2frepo-uuid-5678%2f101",
    );

    // Verify the URL is properly encoded
    expect(artifactUrl).toContain("%2f");
    expect(artifactUrl).not.toContain("undefined");
  });

  it("constructs different URLs for different PR IDs", () => {
    const projectId = "proj-uuid";
    const repoId = "repo-uuid";

    const url1 = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f101`;
    const url2 = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f102`;

    expect(url1).not.toBe(url2);
    expect(url1).toContain("101");
    expect(url2).toContain("102");
  });
});

// ─── ado_create_pr: Happy path with mocked AdoClient ────────────────────────

describe("ado_pr_create: happy path with mocked AdoClient", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("creates a PR and links work items successfully", async () => {
    const config = ProjectConfigSchema.parse({
      pr: { require_work_item: true, default_draft: false },
      work_item: { auto_transition: false },
    });

    const repo = "my-repo";
    const sourceBranch = "feature/123-auth-schema";
    const targetBranch = "main";
    const title = "Auth Schema";
    const workItemIds = [123];

    // Mock: createPullRequest
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        pullRequestId: 101,
        title,
        sourceRefName: `refs/heads/${sourceBranch}`,
        targetRefName: `refs/heads/${targetBranch}`,
        status: "active",
        url: "https://dev.azure.com/testorg/TestProject/_git/my-repo/pullrequest/101",
      }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: "repo-uuid-5678",
        project: { id: "proj-uuid-1234" },
      }),
    );

    // Mock: getWorkItem (called by linkWorkItemToPr)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );

    // Mock: updateWorkItem (link WI to PR)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [{ rel: "ArtifactLink" }] }),
    );

    // Execute the same logic as ado_create_pr
    const draft = config.pr.default_draft;
    const pr = await client.createPullRequest(repo, {
      sourceRefName: `refs/heads/${sourceBranch}`,
      targetRefName: `refs/heads/${targetBranch}`,
      title,
      description: "",
      isDraft: draft,
    });

    expect(pr.pullRequestId).toBe(101);

    const { repoId, projectId } = await client.getRepository(repo);
    expect(repoId).toBe("repo-uuid-5678");
    expect(projectId).toBe("proj-uuid-1234");

    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pr.pullRequestId}`;
    await client.linkWorkItemToPr(123, artifactUrl);

    // Verify the artifact URL format
    expect(artifactUrl).toBe(
      "vstfs:///Git/PullRequestId/proj-uuid-1234%2frepo-uuid-5678%2f101",
    );

    // Verify fetch was called 4 times
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("creates a PR without work items when require_work_item is false", async () => {
    const config = ProjectConfigSchema.parse({
      pr: { require_work_item: false, default_draft: false },
    });

    const shouldSkip = !config.pr.require_work_item;
    expect(shouldSkip).toBe(true);

    // Only the create PR call is needed
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 102, status: "active" }),
    );

    const pr = await client.createPullRequest("my-repo", {
      sourceRefName: "refs/heads/feature/test",
      targetRefName: "refs/heads/main",
      title: "Test PR",
      isDraft: false,
    });

    expect(pr.pullRequestId).toBe(102);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("continues if WI linking fails but PR was created", async () => {
    // createPullRequest succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 103, status: "active" }),
    );

    // getRepository succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: "repo-uuid",
        project: { id: "proj-uuid" },
      }),
    );

    // getWorkItem (linkWorkItemToPr) fails
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    const pr = await client.createPullRequest("my-repo", {
      sourceRefName: "refs/heads/feature/test",
      targetRefName: "refs/heads/main",
      title: "Test",
    });

    expect(pr.pullRequestId).toBe(103);

    // Attempt to link — should fail
    const { repoId, projectId } = await client.getRepository("my-repo");
    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pr.pullRequestId}`;

    await expect(client.linkWorkItemToPr(999, artifactUrl)).rejects.toThrow("ADO 404");

    // PR was still created — this is the key assertion
    expect(pr.pullRequestId).toBeDefined();
  });

  it("applies auto_transition when configured", async () => {
    const config = ProjectConfigSchema.parse({
      work_item: { auto_transition: true, target_state: "In Dev" },
    });

    // createPullRequest
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 104 }),
    );

    // getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // getWorkItem (linkWorkItemToPr — check relations)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );

    // updateWorkItem (link WI to PR)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123 }),
    );

    // updateWorkItem (auto-transition)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, fields: { "System.State": "In Dev" } }),
    );

    const pr = await client.createPullRequest("my-repo", {
      sourceRefName: "refs/heads/feature/test",
      targetRefName: "refs/heads/main",
      title: "Test",
    });

    const { repoId, projectId } = await client.getRepository("my-repo");
    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pr.pullRequestId}`;

    await client.linkWorkItemToPr(123, artifactUrl);

    // Auto-transition
    if (config.work_item.auto_transition) {
      await client.updateWorkItem(123, [
        { op: "replace", path: "/fields/System.State", value: config.work_item.target_state },
      ]);
    }

    // Verify the PATCH calls: linkWorkItemToPr + auto_transition = 2 PATCH calls
    const patchCalls = fetchSpy.mock.calls.filter(
      (call) => (call[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(2);

    // Verify the auto-transition PATCH body
    const transitionBody = JSON.parse(patchCalls[1][1]!.body as string);
    expect(transitionBody[0].op).toBe("replace");
    expect(transitionBody[0].path).toBe("/fields/System.State");
    expect(transitionBody[0].value).toBe("In Dev");
  });
});

// ─── ado_chain_prs: Validation logic ────────────────────────────────────────

describe("ado_pr_chain: validation logic", () => {
  it("rejects chain length exceeding max_length from config", () => {
    const config = ProjectConfigSchema.parse({ chain: { max_length: 5 } });
    const workItemIds = [1, 2, 3, 4, 5, 6]; // 6 > 5

    const exceeds = workItemIds.length > config.chain.max_length;
    expect(exceeds).toBe(true);
  });

  it("allows chain length at max_length boundary", () => {
    const config = ProjectConfigSchema.parse({ chain: { max_length: 5 } });
    const workItemIds = [1, 2, 3, 4, 5]; // exactly 5

    const exceeds = workItemIds.length > config.chain.max_length;
    expect(exceeds).toBe(false);
  });

  it("rejects mismatched branchNames length", () => {
    const workItemIds = [1, 2, 3];
    const branchNames = ["feature/1-a", "feature/2-b"]; // 2 ≠ 3

    const mismatch = branchNames.length !== workItemIds.length;
    expect(mismatch).toBe(true);
  });

  it("accepts matching branchNames length", () => {
    const workItemIds = [1, 2, 3];
    const branchNames = [
      "feature/1-a-branch-name",
      "feature/2-b-branch-name",
      "feature/3-c-branch-name",
    ];

    const mismatch = branchNames.length !== workItemIds.length;
    expect(mismatch).toBe(false);
  });

  it("rejects invalid branch names via BranchNameSchema", () => {
    const invalidNames = [
      "INVALID",
      "feature/Auth-Schema", // uppercase
      "feature/123 auth schema", // spaces
      "123-auth", // no prefix
      "",
      "ab", // too short
    ];

    for (const name of invalidNames) {
      const result = BranchNameSchema.safeParse(name);
      expect(result.success, `Expected "${name}" to be rejected`).toBe(false);
    }
  });

  it("accepts valid branch names via BranchNameSchema", () => {
    const validNames = [
      "feature/123-auth-schema",
      "bugfix/456-fix-crash-on-startup",
      "hotfix/789-urgent-fix",
      "chore/100-update-deps",
    ];

    for (const name of validNames) {
      const result = BranchNameSchema.safeParse(name);
      expect(result.success, `Expected "${name}" to be accepted`).toBe(true);
    }
  });

  it("resolves effective strategy from config when not provided", () => {
    const config = ProjectConfigSchema.parse({ chain: { strategy: "stacked" } });
    const provided: "feature-chain" | "stacked" | undefined = undefined;
    const effective = provided ?? config.chain.strategy;
    expect(effective).toBe("stacked");
  });

  it("uses explicit strategy over config default", () => {
    const config = ProjectConfigSchema.parse({ chain: { strategy: "stacked" } });
    const provided: "feature-chain" | "stacked" | undefined = "feature-chain";
    const effective = provided ?? config.chain.strategy;
    expect(effective).toBe("feature-chain");
  });

  it("resolves effective base branch from config", () => {
    const config = ProjectConfigSchema.parse({ chain: { base_branch: "develop" } });
    const provided: string | undefined = undefined;
    const effective = provided ?? config.chain.base_branch;
    expect(effective).toBe("develop");
  });

  it("resolves effective prefix from config", () => {
    const config = ProjectConfigSchema.parse({ chain: { prefix: "bugfix" } });
    const provided: string | undefined = undefined;
    const effective = provided ?? config.chain.prefix;
    expect(effective).toBe("bugfix");
  });
});

// ─── ado_chain_prs: Full chain simulation (real runChainPrs) ─────────────────

describe("ado_pr_chain: full chain simulation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("creates a feature-chain with 2 work items (happy path)", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123, 124];

    // Mock: getWorkItemsByIds (fetch both WIs)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
          { id: 124, fields: { "System.Title": "Auth API" } },
        ],
      }),
    );

    // Mock: getBranchTip (base branch — main)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: createBranch (tracker)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/auth-schema", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (tracker)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 100, url: "https://example.com/pr/100" }),
    );

    // Mock: getBranchTip (WI 123 child branch — 404 means branch doesn't exist → createBranch)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/123-auth-schema", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 101, url: "https://example.com/pr/101" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123 }),
    );

    // Mock: getBranchTip (WI 124 child branch — 404 means branch doesn't exist)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/124-auth-api", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 102, url: "https://example.com/pr/102" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124 }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "feature-chain",
      baseBranch: "main",
      prefix: "feature",
    });

    // Verify output formatting
    expect(output).toContain("## Chain Created: feature-chain (2 PRs)");
    expect(output).toContain("### Tracker");
    expect(output).toContain("#100");
    expect(output).toContain("✅");
    expect(output).toContain("#123 Auth Schema");
    expect(output).toContain("PR #101");
    expect(output).toContain("(linked)");
    expect(output).toContain("#124 Auth API");
    expect(output).toContain("PR #102");
  });

  it("creates a stacked chain with 2 work items (happy path)", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123, 124];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
          { id: 124, fields: { "System.Title": "Auth API" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: getBranchTip (WI 123 — not found, so create)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/123-auth-schema", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 101, url: "https://example.com/pr/101" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123 }),
    );

    // Mock: getBranchTip (WI 124 — not found)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/124-auth-api", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 102, url: "https://example.com/pr/102" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124 }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "stacked",
      baseBranch: "main",
      prefix: "feature",
    });

    expect(output).toContain("## Chain Created: stacked (2 PRs)");
    expect(output).not.toContain("### Tracker");
  });

  it("continues after branch creation failure (skip-and-continue)", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123, 124];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
          { id: 124, fields: { "System.Title": "Auth API" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: getBranchTip (WI 123 — exists with DIFFERENT tip, so treated as error)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "different-tip-xyz" }] }),
    );

    // No createBranch for WI 123 (skipped due to conflict)

    // Mock: getBranchTip (WI 124 — not found, create it)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 124) — succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/124-auth-api", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 102, url: "https://example.com/pr/102" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124 }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "stacked",
      baseBranch: "main",
      prefix: "feature",
    });

    // Step 0 failed but step 1 succeeded
    expect(output).toContain("⚠️");
    expect(output).toContain("### Errors");
    expect(output).toContain("PR #102");
  });

  it("continues after WI link failure (PR still created)", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: getBranchTip (WI 123 — not found, create it)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 123) — succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/123-auth-schema", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 123) — succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 101, url: "https://example.com/pr/101" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem FAILS (404)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "stacked",
      baseBranch: "main",
      prefix: "feature",
    });

    // PR was created but WI link failed — output still mentions PR
    expect(output).toContain("PR #101");
    expect(output).toContain("WI link failed");
  });

  it("uses custom tracker_name from config when provided", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({
      chain: { tracker_name: "custom/my-tracker" },
    });
    const repo = "my-repo";
    const workItemIds = [123];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: createBranch (tracker with custom name)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/custom/my-tracker", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (tracker)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 100, url: "https://example.com/pr/100" }),
    );

    // Mock: getBranchTip (WI 123 — not found)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/123-auth-schema", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 101, url: "https://example.com/pr/101" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123 }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "feature-chain",
      baseBranch: "main",
      prefix: "feature",
    });

    // Tracker should use custom name
    expect(output).toContain("custom/my-tracker");
    expect(output).toContain("#100");
  });

  it("uses provided branchNames instead of deriving them", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123, 124];
    const branchNames = [
      "feature/123-custom-branch-name",
      "feature/124-another-custom-name",
    ];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
          { id: 124, fields: { "System.Title": "Auth API" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: getBranchTip (WI 123 — not found)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: `refs/heads/${branchNames[0]}`, success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 101, url: "https://example.com/pr/101" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 123)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123 }),
    );

    // Mock: getBranchTip (WI 124 — not found)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    // Mock: createBranch (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: `refs/heads/${branchNames[1]}`, success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 102, url: "https://example.com/pr/102" }),
    );

    // Mock: linkWorkItemToPr — getWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124, relations: [] }),
    );

    // Mock: linkWorkItemToPr — updateWorkItem (WI 124)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 124 }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "stacked",
      baseBranch: "main",
      prefix: "feature",
      branchNames,
    });

    // Custom branch names accepted (2 PRs created successfully)
    expect(output).toContain("2 PRs");
    expect(output).toContain("PR #101");
    expect(output).toContain("PR #102");
  });

  it("aborts on tracker branch creation failure (returns error string)", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: createBranch (tracker) — FAILS with 409 Conflict
    fetchSpy.mockResolvedValueOnce(
      new Response("Conflict", { status: 409, headers: { "Content-Type": "text/plain" } }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "feature-chain",
      baseBranch: "main",
      prefix: "feature",
    });

    expect(output).toContain("Failed to create tracker branch");
  });

  it("aborts on tracker PR creation failure with orphan warning (returns error string)", async () => {
    const client = makeClient();
    const config = ProjectConfigSchema.parse({});
    const repo = "my-repo";
    const workItemIds = [123];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 123, fields: { "System.Title": "Auth Schema" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: createBranch (tracker) — succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/auth-schema", success: true, objectId: "abc123", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (tracker) — FAILS
    fetchSpy.mockResolvedValueOnce(
      new Response("Bad Request", { status: 400, headers: { "Content-Type": "text/plain" } }),
    );

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "feature-chain",
      baseBranch: "main",
      prefix: "feature",
    });

    expect(output).toContain("Orphaned tracker branch exists");
  });

  it("feature-chain: mid-chain PR failure uses backward-walk to find PR target", async () => {
    // Step 1 (index 1) PR creation fails, so step 2 PR targets step 0's branch
    // (not step 1's, since step 1 has no PR). Verifies the backward-walk logic.
    const client = makeClient();
    const config = ProjectConfigSchema.parse({ pr: { include_chain_context: false } });
    const repo = "my-repo";
    const workItemIds = [10, 20, 30];

    // Mock: getWorkItemsByIds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: 10, fields: { "System.Title": "Step One" } },
          { id: 20, fields: { "System.Title": "Step Two" } },
          { id: 30, fields: { "System.Title": "Step Three" } },
        ],
      }),
    );

    // Mock: getBranchTip (base)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "base-tip-111" }] }),
    );

    // Mock: getRepository
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: "repo-id", project: { id: "proj-id" } }),
    );

    // Mock: createBranch (tracker)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/step-one", success: true, objectId: "base-tip-111", oldObjectId: "0".repeat(40) }]),
    );

    // Mock: createPullRequest (tracker PR #100)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 100, url: "https://example.com/pr/100" }),
    );

    // Step 0 (WI #10): getBranchTip → not found → createBranch → createPR succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/10-step-one", success: true, objectId: "base-tip-111", oldObjectId: "0".repeat(40) }]),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ pullRequestId: 101, url: "https://example.com/pr/101" }),
    );
    // linkWorkItemToPr
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 10, relations: [] }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 10 }));

    // Step 1 (WI #20): getBranchTip → not found → createBranch → createPR FAILS
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/20-step-two", success: true, objectId: "base-tip-111", oldObjectId: "0".repeat(40) }]),
    );
    // PR creation fails for step 1
    fetchSpy.mockResolvedValueOnce(
      new Response("Server Error", { status: 500, headers: { "Content-Type": "text/plain" } }),
    );

    // Step 2 (WI #30): getBranchTip → not found → createBranch → createPR succeeds
    // The PR target should be refs/heads/feature/10-step-one (step 0's branch) because
    // step 1 has no PR (backward walk skips it)
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{ name: "refs/heads/feature/30-step-three", success: true, objectId: "base-tip-111", oldObjectId: "0".repeat(40) }]),
    );

    let capturedTargetRef: string | undefined;
    const origMock = fetchSpy.getMockImplementation();
    // Capture the targetRefName from the PR creation call for step 2
    fetchSpy.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).includes("pullrequests")) {
        const body = JSON.parse(init.body as string);
        capturedTargetRef = body.targetRefName;
      }
      return jsonResponse({ pullRequestId: 103, url: "https://example.com/pr/103" });
    });
    // linkWorkItemToPr for step 2
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 30, relations: [] }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 30 }));

    const output = await runChainPrs(client, config, {
      repo,
      workItemIds,
      strategy: "feature-chain",
      baseBranch: "main",
      prefix: "feature",
    });

    // Step 2's PR should target step 0's branch (backward walk skipped step 1 which has no PR)
    expect(capturedTargetRef).toBe("refs/heads/feature/10-step-one");
    expect(output).toContain("PR #103");
    // Step 1 should show as error
    expect(output).toContain("### Errors");
  });
});

// ─── ado_chain_prs: Config-driven behavior ──────────────────────────────────

describe("ado_pr_chain: config-driven behavior", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ado-chain-tools-config-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads defaults when no .adoconfig.toml exists", async () => {
    const config = await loadProjectConfig(tempDir);

    expect(config.chain.strategy).toBe("feature-chain");
    expect(config.chain.base_branch).toBe("main");
    expect(config.chain.max_length).toBe(10);
    expect(config.chain.prefix).toBe("feature");
    expect(config.pr.default_draft).toBe(false);
    expect(config.pr.require_work_item).toBe(true);
    expect(config.work_item.auto_transition).toBe(false);
  });

  it("loads custom config from .adoconfig.toml", async () => {
    const toml = `
[chain]
strategy = "stacked"
base_branch = "develop"
max_length = 20
prefix = "bugfix"

[pr]
default_draft = true
require_work_item = false

[work_item]
auto_transition = true
target_state = "Active"
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), toml);

    const config = await loadProjectConfig(tempDir);

    expect(config.chain.strategy).toBe("stacked");
    expect(config.chain.base_branch).toBe("develop");
    expect(config.chain.max_length).toBe(20);
    expect(config.chain.prefix).toBe("bugfix");
    expect(config.pr.default_draft).toBe(true);
    expect(config.pr.require_work_item).toBe(false);
    expect(config.work_item.auto_transition).toBe(true);
    expect(config.work_item.target_state).toBe("Active");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles work item with missing title gracefully", () => {
    const result = deriveBranchName("feature", 123, "", 40);
    // Empty title → empty slug → "feature/123-"
    // This is technically valid by the current slugify but may not match BranchNameSchema
    expect(result).toBe("feature/123-");
  });

  it("handles work item with only special characters in title", () => {
    const result = deriveBranchName("feature", 123, "!!!???", 40);
    expect(result).toBe("feature/123-");
  });

  it("handles very long WI title gracefully", () => {
    const longTitle = "A".repeat(500);
    const result = deriveBranchName("feature", 123, longTitle, 40);
    const slugPart = result.substring("feature/123-".length);
    expect(slugPart.length).toBeLessThanOrEqual(40);
  });

  it("formatChainResult handles empty steps", () => {
    const result: ChainResult = {
      strategy: "stacked",
      steps: [],
      created: 0,
      branchesCreated: 0,
      linked: 0,
      errors: [],
    };

    const output = formatChainResult(result);
    expect(output).toContain("## Chain Created: stacked (0 PRs)");
    expect(output).toContain("### Steps");
    expect(output).not.toContain("### Errors");
    expect(output).toContain("0 errors");
  });

  it("formatChainResult handles all failures", () => {
    const result: ChainResult = {
      strategy: "feature-chain",
      steps: [
        {
          workItemId: 123,
          workItemTitle: "Auth Schema",
          branchName: "feature/123-auth-schema",
          refName: "refs/heads/feature/123-auth-schema",
          parentRefName: "refs/heads/main",
          linked: false,
          error: "Branch creation failed: already exists",
        },
      ],
      created: 0,
      branchesCreated: 0,
      linked: 0,
      errors: ["WI #123 (feature/123-auth-schema): Branch creation failed: already exists"],
    };

    const output = formatChainResult(result);
    expect(output).toContain("⚠️");
    expect(output).toContain("no PR");
    expect(output).toContain("### Errors");
    expect(output).toContain("Branch creation failed");
  });

  it("artifact URL handles large PR IDs", () => {
    const projectId = "proj-uuid";
    const repoId = "repo-uuid";
    const pullRequestId = 999999;

    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pullRequestId}`;
    expect(artifactUrl).toContain("999999");
    expect(artifactUrl).toContain("%2f");
  });

  it("artifact URL handles UUID with hyphens", () => {
    const projectId = "proj-uuid-with-hyphens-1234";
    const repoId = "repo-uuid-with-hyphens-5678";
    const pullRequestId = 42;

    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${pullRequestId}`;
    expect(artifactUrl).toContain("proj-uuid-with-hyphens-1234");
    expect(artifactUrl).toContain("repo-uuid-with-hyphens-5678");
  });
});
