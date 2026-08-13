import { AdoClient } from "../src/ado-client.js";

function makeClient(): AdoClient {
  return new AdoClient(
    "https://dev.azure.com/testorg",
    "TestProject",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AdoClient.completePullRequest", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("sends the PR's current merge source commit so a moved branch is rejected", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ lastMergeSourceCommit: { commitId: "abc123" } }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }));

    await makeClient().completePullRequest("repo", 7, { mergeStrategy: "rebase", deleteSourceBranch: true });

    const init = fetchSpy.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(init.method).toBe("PATCH");
    expect(body.status).toBe("completed");
    expect(body.lastMergeSourceCommit).toEqual({ commitId: "abc123" });
    expect(body.completionOptions).toMatchObject({ mergeStrategy: "rebase", deleteSourceBranch: true });
  });

  it("defaults to a squash merge that keeps the source branch", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ lastMergeSourceCommit: { commitId: "d" } }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }));

    await makeClient().completePullRequest("repo", 8);

    const body = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(body.completionOptions).toMatchObject({
      mergeStrategy: "squash",
      deleteSourceBranch: false,
      bypassPolicy: false,
    });
  });
});

describe("AdoClient.linkWorkItems", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("adds a relation pointing at the target work item", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 1, relations: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));

    const created = await makeClient().linkWorkItems(1, 42, "System.LinkTypes.Related", "see also");

    expect(created).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(body[0]).toMatchObject({ op: "add", path: "/relations/-" });
    expect(body[0].value.rel).toBe("System.LinkTypes.Related");
    expect(body[0].value.url).toContain("/wit/workItems/42");
    expect(body[0].value.attributes).toEqual({ comment: "see also" });
  });

  it("is a no-op when the same link already exists", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      id: 1,
      relations: [{ rel: "System.LinkTypes.Related", url: "https://dev.azure.com/testorg/_apis/wit/workItems/42" }],
    }));

    const created = await makeClient().linkWorkItems(1, 42, "System.LinkTypes.Related");

    expect(created).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not confuse work item 42 with work item 142", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({
        id: 1,
        relations: [{ rel: "System.LinkTypes.Related", url: "https://dev.azure.com/testorg/_apis/wit/workItems/142" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));

    expect(await makeClient().linkWorkItems(1, 42, "System.LinkTypes.Related")).toBe(true);
  });
});
