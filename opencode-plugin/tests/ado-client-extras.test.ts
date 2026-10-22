import { AdoClient, formatComments } from "../src/ado-client.js";

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

describe("AdoClient.attachFileToWorkItem", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("uploads the raw bytes, then links the returned url as an AttachedFile", async () => {
    const uploaded = "https://dev.azure.com/testorg/_apis/wit/attachments/guid-9";
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: "guid-9", url: uploaded }))
      .mockResolvedValueOnce(jsonResponse({ id: 42 }));

    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const url = await makeClient().attachFileToWorkItem(42, "captura de pantalla.png", content, "repro");

    expect(url).toBe(uploaded);

    const [uploadUrl, uploadInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(String(uploadUrl));
    expect(uploadInit.method).toBe("POST");
    expect((uploadInit.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    // The file name survives the api-version query merge intact
    expect(parsed.searchParams.get("fileName")).toBe("captura de pantalla.png");
    expect(parsed.searchParams.get("api-version")).toBeTruthy();
    expect(new Uint8Array(uploadInit.body as Uint8Array)).toEqual(new Uint8Array(content));

    const patch = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(patch[0]).toEqual({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "AttachedFile",
        url: uploaded,
        attributes: { name: "captura de pantalla.png", comment: "repro" },
      },
    });
  });

  it("does not link anything when the upload itself fails", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("quota exceeded", { status: 413 }));

    await expect(
      makeClient().attachFileToWorkItem(42, "big.png", Buffer.from("x")),
    ).rejects.toThrow("ADO 413");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("AdoClient.listAttachments", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("returns only AttachedFile relations with their metadata", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      id: 42,
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/testorg/_apis/wit/workItems/7" },
        {
          rel: "AttachedFile",
          url: "https://dev.azure.com/testorg/_apis/wit/attachments/guid-1",
          attributes: { name: "screenshot.png", comment: "repro", resourceSize: 1234 },
        },
      ],
    }));

    const files = await makeClient().listAttachments(42);

    expect(files).toEqual([{
      name: "screenshot.png",
      url: "https://dev.azure.com/testorg/_apis/wit/attachments/guid-1",
      comment: "repro",
      size: 1234,
    }]);
  });

  it("includes images pasted inline in rich text fields", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      id: 42,
      fields: {
        "System.Description":
          '<div>broken<img src="https://dev.azure.com/testorg/_apis/wit/attachments/guid-2?fileName=paste.png&amp;api-version=7.0"></div>',
        "Microsoft.VSTS.TCM.ReproSteps":
          "<img src='https://dev.azure.com/testorg/_apis/wit/attachments/guid-3'>",
        "System.Title": "no images here",
      },
      relations: [{
        rel: "AttachedFile",
        url: "https://dev.azure.com/testorg/_apis/wit/attachments/guid-1",
        attributes: { name: "screenshot.png" },
      }],
    }));

    const files = await makeClient().listAttachments(42);

    expect(files.map((f) => f.name)).toEqual(["screenshot.png", "paste.png", "guid-3.png"]);
    expect(files[1].url).toContain("&api-version=7.0");
  });

  it("does not duplicate an inline image that is also a relation", async () => {
    const url = "https://dev.azure.com/testorg/_apis/wit/attachments/guid-1?fileName=shot.png";
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      id: 42,
      fields: { "System.Description": `<img src="${url}">` },
      relations: [{ rel: "AttachedFile", url, attributes: { name: "shot.png" } }],
    }));

    expect(await makeClient().listAttachments(42)).toHaveLength(1);
  });
});

describe("AdoClient.getPullRequestWorkItems", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("returns the linked work item ids as numbers", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      value: [{ id: "15497", url: "https://x/_apis/wit/workItems/15497" }, { id: "15498" }],
    }));

    const ids = await makeClient().getPullRequestWorkItems("repo", 5017);

    expect(ids).toEqual([15497, 15498]);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/pullRequests/5017/workitems");
  });
});

describe("AdoClient PR thread reply/status", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("replyToThread POSTs a text comment to the thread's comments endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 2 }));
    await makeClient().replyToThread("web", 5, 148, "Good idea");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/git/repositories/web/pullrequests/5/threads/148/comments?api-version=7.1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ content: "Good idea", commentType: "text" });
  });

  it("updateThreadStatus PATCHes only the thread status", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 148, status: "fixed" }));
    await makeClient().updateThreadStatus("web", 5, 148, "fixed");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/git/repositories/web/pullrequests/5/threads/148?api-version=7.1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ status: "fixed" });
  });
});

describe("AdoClient.addWorkItemComment format", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("sends format=markdown by default so Markdown renders", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await makeClient().addWorkItemComment(299, "# Report\n- a\n- b");
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toContain("/wit/workItems/299/comments");
    expect(url.searchParams.get("format")).toBe("markdown");
    expect(url.searchParams.get("api-version")).toBe("7.1-preview.4");
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ text: "# Report\n- a\n- b" });
  });

  it("honours an explicit html format", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await makeClient().addWorkItemComment(299, "<b>x</b>", "html");
    expect(new URL(String(fetchSpy.mock.calls[0][0])).searchParams.get("format")).toBe("html");
  });
});

describe("formatComments", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it("shows the full comment with its line breaks", async () => {
    const long = "Run report\n" + "x".repeat(400) + "\n| a | b |\n|---|---|";
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      comments: [{ text: long, createdBy: { displayName: "QA Bot" }, createdDate: "2026-10-01T00:00:00Z" }],
    }));
    const out = await formatComments(makeClient(), 1);
    expect(out).toContain("QA Bot 2026-10-01: Run report\n");
    expect(out).toContain("x".repeat(400));
    expect(out).toContain("| a | b |\n");
  });

  it("prints markdown comments verbatim (no tag stripping)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      comments: [{ text: "if a < b > c then `<br>`", format: "markdown", createdBy: { displayName: "A" } }],
    }));
    expect(await formatComments(makeClient(), 1)).toContain("A: if a < b > c then `<br>`");
  });

  it("turns html comments into readable text with line breaks", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      comments: [{ text: "<div>one</div><div>two &amp; three</div>", createdBy: { displayName: "A" } }],
    }));
    const out = await formatComments(makeClient(), 1);
    expect(out).toContain("A: one\n");
    expect(out).toContain("two & three");
  });
});

describe("AdoClient.findIdentityId", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  // Real IdentityPicker response shape: { results: [{ queryToken, identities: [...] }] }
  const pickerResponse = {
    results: [{
      queryToken: "alice",
      identities: [{
        entityId: "vss.ds.v1.aad.user.0f2c",
        entityType: "User",
        originDirectory: "aad",
        originId: "0f2c7f8e-aad-object-id",
        localDirectory: "vsd",
        localId: "6a7b3d4e-1111-2222-3333-444455556666",
        displayName: "Alice Smith",
        scopeName: "Contoso",
        samAccountName: "alice",
        active: null,
        subjectDescriptor: "aad.MGYyYzdmOGU",
        mail: "alice@contoso.com",
        mailNickname: "alice",
        signInAddress: "alice@contoso.com",
        surname: "Smith",
        guest: false,
        isMru: false,
      }],
      pagingToken: null,
    }],
  };

  it("reads identities from results[] (the picker's real response key)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(pickerResponse));
    const identity = await makeClient().findIdentityId("alice");
    expect(identity).toEqual({
      id: "6a7b3d4e-1111-2222-3333-444455556666",
      displayName: "Alice Smith",
      uniqueName: "alice@contoso.com",
    });
  });

  it("still accepts a legacy value[] shape", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ value: pickerResponse.results }));
    expect((await makeClient().findIdentityId("alice"))?.id).toBe("6a7b3d4e-1111-2222-3333-444455556666");
  });

  it("returns null when nothing matches", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ results: [{ queryToken: "zed", identities: [] }] }));
    expect(await makeClient().findIdentityId("zed")).toBeNull();
  });
});
