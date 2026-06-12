/**
 * TDD RED phase — tests for new AdoClient methods needed by chained PRs.
 *
 * The AdoClient class EXISTS in src/ado-client.ts but the methods
 * getBranchTip, createBranch, createPullRequest, linkWorkItemToPr,
 * and getRepository DO NOT EXIST yet.
 *
 * We mock globalThis.fetch to return controlled responses.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AdoClient } from "../src/ado-client.js";

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

// ─── getBranchTip ───────────────────────────────────────────────────────────

describe("AdoClient.getBranchTip", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns the commit SHA when branch exists", async () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [{ name: "refs/heads/main", objectId: sha }],
      }),
    );

    const result = await client.getBranchTip("my-repo", "main");
    expect(result).toBe(sha);

    // Verify correct API endpoint was called
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/git/repositories/my-repo/refs");
    expect(calledUrl).toContain("filter=heads%2Fmain");
  });

  it("throws when branch is not found (empty value array)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ value: [] }));

    await expect(client.getBranchTip("my-repo", "nonexistent")).rejects.toThrow(
      'Branch "nonexistent" not found in repo "my-repo"',
    );
  });

  it("propagates API errors (404)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(client.getBranchTip("my-repo", "main")).rejects.toThrow("ADO 404");
  });

  it("URL-encodes the repo name", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: [{ objectId: "abc123" }] }),
    );

    await client.getBranchTip("my repo", "main");
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("my%20repo");
  });
});

// ─── createBranch ───────────────────────────────────────────────────────────

describe("AdoClient.createBranch", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("creates a branch and returns GitRefUpdateResult on success", async () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const expectedResult = {
      name: "refs/heads/feature/123-auth-schema",
      objectId: sha,
      oldObjectId: "0000000000000000000000000000000000000000",
      success: true,
      updateStatus: "succeeded",
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse([expectedResult]));

    const result = await client.createBranch("my-repo", "feature/123-auth-schema", sha);

    expect(result.success).toBe(true);
    expect(result.name).toBe("refs/heads/feature/123-auth-schema");
    expect(result.objectId).toBe(sha);

    // Verify request body
    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callInit.body as string) as Array<{ name: string; oldObjectId: string; newObjectId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("refs/heads/feature/123-auth-schema");
    expect(body[0].oldObjectId).toBe("0000000000000000000000000000000000000000");
    expect(body[0].newObjectId).toBe(sha);
  });

  it("throws when branch already exists (success: false)", async () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([
        {
          name: "refs/heads/feature/123-auth-schema",
          objectId: "",
          oldObjectId: "",
          success: false,
          updateStatus: "failed",
        },
      ]),
    );

    await expect(
      client.createBranch("my-repo", "feature/123-auth-schema", sha),
    ).rejects.toThrow('Failed to create branch "feature/123-auth-schema"');
  });

  it("propagates API errors (400 bad commit SHA)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Bad Request", { status: 400, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(
      client.createBranch("my-repo", "feature/123-auth-schema", "invalid-sha"),
    ).rejects.toThrow("ADO 400");
  });

  it("uses POST method", async () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([{
        name: "refs/heads/test",
        objectId: sha,
        oldObjectId: "0".repeat(40),
        success: true,
      }]),
    );

    await client.createBranch("my-repo", "test", sha);
    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callInit.method).toBe("POST");
  });
});

// ─── createPullRequest ──────────────────────────────────────────────────────

describe("AdoClient.createPullRequest", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("creates a PR and returns the PR object with pullRequestId", async () => {
    const prResponse = {
      pullRequestId: 101,
      title: "Auth Schema — WI #123",
      sourceRefName: "refs/heads/feature/123-auth-schema",
      targetRefName: "refs/heads/main",
      status: "active",
      url: "https://dev.azure.com/testorg/TestProject/_git/my-repo/pullrequest/101",
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(prResponse));

    const result = await client.createPullRequest("my-repo", {
      sourceRefName: "refs/heads/feature/123-auth-schema",
      targetRefName: "refs/heads/main",
      title: "Auth Schema — WI #123",
      description: "## Changes\n- Add auth schema",
      isDraft: false,
    });

    expect(result.pullRequestId).toBe(101);

    // Verify endpoint
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/git/repositories/my-repo/pullrequests");

    // Verify request body
    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callInit.method).toBe("POST");
    const body = JSON.parse(callInit.body as string);
    expect(body.sourceRefName).toBe("refs/heads/feature/123-auth-schema");
    expect(body.targetRefName).toBe("refs/heads/main");
    expect(body.title).toBe("Auth Schema — WI #123");
    expect(body.isDraft).toBe(false);
  });

  it("propagates API errors (400 source branch not found)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Source branch not found", { status: 400, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(
      client.createPullRequest("my-repo", {
        sourceRefName: "refs/heads/nonexistent",
        targetRefName: "refs/heads/main",
        title: "Test PR",
      }),
    ).rejects.toThrow("ADO 400");
  });

  it("propagates API errors (409 duplicate PR)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Conflict", { status: 409, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(
      client.createPullRequest("my-repo", {
        sourceRefName: "refs/heads/feature/123-auth",
        targetRefName: "refs/heads/main",
        title: "Duplicate PR",
      }),
    ).rejects.toThrow("ADO 409");
  });

  it("defaults description to empty string when omitted", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ pullRequestId: 102 }));

    await client.createPullRequest("my-repo", {
      sourceRefName: "refs/heads/feature/test",
      targetRefName: "refs/heads/main",
      title: "Test",
    });

    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callInit.body as string);
    expect(body.description).toBe("");
  });

  it("defaults isDraft to false when omitted", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ pullRequestId: 103 }));

    await client.createPullRequest("my-repo", {
      sourceRefName: "refs/heads/feature/test",
      targetRefName: "refs/heads/main",
      title: "Test",
    });

    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callInit.body as string);
    expect(body.isDraft).toBe(false);
  });
});

// ─── linkWorkItemToPr ───────────────────────────────────────────────────────

describe("AdoClient.linkWorkItemToPr", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const artifactUrl = "vstfs:///Git/PullRequestId/proj-id%2frepo-id%2f101";

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("links a work item when no existing relation", async () => {
    // First call: getWorkItem (to check existing relations)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: 123,
        relations: [],
      }),
    );
    // Second call: updateWorkItem (PATCH to add relation)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [{ rel: "ArtifactLink", url: artifactUrl }] }),
    );

    await client.linkWorkItemToPr(123, artifactUrl);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Second call should be PATCH
    const secondCallInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(secondCallInit.method).toBe("PATCH");
    const body = JSON.parse(secondCallInit.body as string) as Array<{ op: string; path: string; value: any }>;
    expect(body[0].op).toBe("add");
    expect(body[0].path).toBe("/relations/-");
    expect(body[0].value.rel).toBe("ArtifactLink");
    expect(body[0].value.url).toBe(artifactUrl);
    expect(body[0].value.attributes.name).toBe("Pull Request");
  });

  it("skips linking when relation already exists (idempotent)", async () => {
    // getWorkItem returns existing relation
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: 123,
        relations: [{ rel: "ArtifactLink", url: artifactUrl }],
      }),
    );

    await client.linkWorkItemToPr(123, artifactUrl);

    // Only one call (getWorkItem), no PATCH call
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates API errors from getWorkItem", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(client.linkWorkItemToPr(999, artifactUrl)).rejects.toThrow("ADO 404");
  });

  it("propagates API errors from updateWorkItem", async () => {
    // getWorkItem succeeds
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 123, relations: [] }),
    );
    // updateWorkItem fails
    fetchSpy.mockResolvedValueOnce(
      new Response("Bad Request", { status: 400, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(client.linkWorkItemToPr(123, artifactUrl)).rejects.toThrow();
  });
});

// ─── getRepository ──────────────────────────────────────────────────────────

describe("AdoClient.getRepository", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns repoId and projectId from the response", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: "repo-uuid-1234",
        name: "my-repo",
        project: { id: "project-uuid-5678", name: "TestProject" },
      }),
    );

    const result = await client.getRepository("my-repo");

    expect(result.repoId).toBe("repo-uuid-1234");
    expect(result.projectId).toBe("project-uuid-5678");

    // Verify endpoint
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/git/repositories/my-repo");
  });

  it("propagates API errors (404 repo not found)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(client.getRepository("nonexistent")).rejects.toThrow("ADO 404");
  });

  it("URL-encodes the repo name with special characters", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: "repo-id",
        project: { id: "proj-id" },
      }),
    );

    await client.getRepository("my repo");
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("my%20repo");
  });
});

// ─── getWorkItemsByIds batching ──────────────────────────────────────────────

describe("AdoClient.getWorkItemsByIds batching", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns empty array for empty input without making any requests", async () => {
    const result = await client.getWorkItemsByIds([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes a single request when ids <= 200", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ value: ids.map((id) => ({ id, fields: {} })) }),
    );

    const result = await client.getWorkItemsByIds(ids);
    expect(result).toHaveLength(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("workitems?ids=");
  });

  it("splits ids > 200 into two parallel requests and concatenates results", async () => {
    // 201 ids — should produce chunk of 200 + chunk of 1
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ value: ids.slice(0, 200).map((id) => ({ id, fields: {} })) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: [{ id: 201, fields: {} }] }),
      );

    const result = await client.getWorkItemsByIds(ids);
    expect(result).toHaveLength(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // First chunk should start at 1 and not include 201 (URL may be percent-encoded)
    const url1 = fetchSpy.mock.calls[0][0] as string;
    const decoded1 = decodeURIComponent(url1);
    expect(decoded1).toContain("ids=1,2,3");
    expect(decoded1).not.toContain(",201");

    // Second chunk should have only id 201
    const url2 = fetchSpy.mock.calls[1][0] as string;
    const decoded2 = decodeURIComponent(url2);
    expect(decoded2).toContain("ids=201");
  });
});
