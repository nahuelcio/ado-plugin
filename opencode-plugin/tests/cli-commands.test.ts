import type { AdoConfig } from "../src/shared.js";

vi.mock("../src/profile-store.js", () => ({
  getActiveProfile: vi.fn(() => null),
  setActiveProfile: vi.fn(),
  setSelectedPr: vi.fn(),
  getSelectedPr: vi.fn(() => null),
}));

import { getActiveProfile } from "../src/profile-store.js";
import { resolvePrArgsAuto } from "../src/ado-client.js";
import * as cmd from "../src/cli-commands.js";

const PAT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const config: AdoConfig = {
  defaultProfile: "work",
  profiles: {
    work: { org: "orgA", project: "ProjA", patEnvVar: "X", pat: PAT, repos: ["web"] },
    client: { org: "orgB", project: "ProjB", patEnvVar: "X", pat: PAT, repos: ["api", "shared"] },
    other: { org: "orgC", project: "ProjC", patEnvVar: "X", pat: PAT, repos: ["Shared"] },
  },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

type Route = [match: (url: string, init?: RequestInit) => boolean, body: unknown];

/** Route fetch by URL; unmatched calls answer `{}`. Returns the recorded calls. */
function stubFetch(routes: Route[] = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/connectionData")) return json({ authenticatedUser: { id: "me-1", displayName: "Me" } });
    const hit = routes.find(([m]) => m(u, init));
    return json(hit ? hit[1] : {});
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getActiveProfile).mockReturnValue(null);
});

describe("profile resolution from repo", () => {
  it("uses the profile whose repo list contains the repo", async () => {
    const r = await resolvePrArgsAuto(config, { repo: "api", prId: 1 });
    expect(r.profileName).toBe("client");
  });

  it("falls back to the active profile when no profile lists the repo", async () => {
    vi.mocked(getActiveProfile).mockReturnValue("client");
    const r = await resolvePrArgsAuto(config, { repo: "unknown-repo", prId: 1 });
    expect(r.profileName).toBe("client");
  });

  it("keeps an explicit --profile", async () => {
    const r = await resolvePrArgsAuto(config, { repo: "api", prId: 1, profile: "work" });
    expect(r.profileName).toBe("work");
  });

  it("errors clearly when several profiles list the repo and none is active", async () => {
    await expect(resolvePrArgsAuto(config, { repo: "shared", prId: 1 })).rejects.toThrow(/client, other.*--profile/);
  });

  it("prefers the active profile when it is one of several matches", async () => {
    vi.mocked(getActiveProfile).mockReturnValue("other");
    const r = await resolvePrArgsAuto(config, { repo: "shared", prId: 1 });
    expect(r.profileName).toBe("other");
  });

  it("pr create talks to the org of the repo's profile", async () => {
    const calls = stubFetch();
    await cmd.prCreate(config, { repo: "api", sourceBranch: "f", targetBranch: "main", title: "t" });
    expect(calls[0].url).toContain("dev.azure.com/orgB/");
  });
});

describe("pr reply", () => {
  it("posts the reply then sets the status", async () => {
    const calls = stubFetch();
    const out = await cmd.prReply(config, { repo: "web", prId: 5, threadId: 148, comment: "Done", status: "fixed" });
    const post = calls.find((c) => c.init?.method === "POST");
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(post?.url).toContain("/pullrequests/5/threads/148/comments");
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ content: "Done" });
    expect(patch?.url).toContain("/pullrequests/5/threads/148?");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ status: "fixed" });
    expect(out).toContain("thread 148");
    expect(out).toContain("fixed");
  });

  it("resolves a thread with --status alone (no comment posted)", async () => {
    const calls = stubFetch();
    await cmd.prReply(config, { repo: "web", prId: 5, threadId: 148, status: "closed" });
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true);
  });

  it("rejects an unknown status without calling ADO", async () => {
    const calls = stubFetch();
    await expect(cmd.prReply(config, { repo: "web", prId: 5, threadId: 148, status: "resolved" }))
      .rejects.toThrow(/active, fixed, wontFix, closed, byDesign, pending/);
    expect(calls).toHaveLength(0);
  });

  it("requires a comment or a status", async () => {
    await expect(cmd.prReply(config, { repo: "web", prId: 5, threadId: 148 })).rejects.toThrow(/--comment.*--status/);
  });
});

describe("wi comment format", () => {
  it("defaults to markdown and passes html through when asked", async () => {
    const calls = stubFetch();
    await cmd.wiComment(config, { id: 3, comment: "**x**" });
    await cmd.wiComment(config, { id: 3, comment: "<b>x</b>", format: "html" });
    const posts = calls.filter((c) => c.init?.method === "POST").map((c) => new URL(c.url).searchParams.get("format"));
    expect(posts).toEqual(["markdown", "html"]);
  });
});

describe("wi create", () => {
  const picker: Route = [(u) => u.includes("/IdentityPicker/Identities"), {
    results: [{ queryToken: "alice", identities: [{ localId: "id-a", displayName: "Alice Smith", signInAddress: "alice@contoso.com", mail: "alice@contoso.com" }] }],
  }];
  const typeFields: Route = [(u) => u.includes("/workitemtypes/") && u.includes("/fields"), {
    value: [
      { referenceName: "System.Title", name: "Title", allowedValues: [] },
      { referenceName: "System.State", name: "State", allowedValues: ["New", "Active", "Closed"] },
      { referenceName: "System.AssignedTo", name: "Assigned To", allowedValues: [] },
      { referenceName: "Custom.Team", name: "Team", allowedValues: ["Core", "Web"] },
      { referenceName: "Microsoft.VSTS.Common.Priority", name: "Priority", allowedValues: [1, 2, 3, 4] },
    ],
  }];
  const created: Route = [(u, init) => init?.method === "POST" && u.includes("/wit/workitems/$"), { id: 77, fields: {} }];

  const patchOf = (calls: ReturnType<typeof stubFetch>) =>
    JSON.parse(String(calls.find((c) => c.init?.method === "POST" && c.url.includes("/wit/workitems/$"))?.init?.body));

  it("resolves --assigned through the identity picker before creating", async () => {
    const calls = stubFetch([picker, typeFields, created]);
    const out = await cmd.wiCreate(config, { type: "Bug", title: "t", assignedTo: "alice" });
    expect(out).toContain("#77");
    expect(patchOf(calls)).toContainEqual({ op: "add", path: "/fields/System.AssignedTo", value: "alice@contoso.com" });
  });

  it("refuses a value outside the field's allowed values and lists them, without POSTing", async () => {
    const calls = stubFetch([typeFields, created]);
    const out = await cmd.wiCreate(config, { type: "Bug", title: "t", state: "Doing" });
    expect(out).toMatch(/'Doing'.*System\.State.*New \| Active \| Closed/);
    expect(calls.some((c) => c.url.includes("/wit/workitems/$"))).toBe(false);
  });

  it("checks custom fields and numbers too, case-insensitively", async () => {
    const calls = stubFetch([typeFields, created]);
    const out = await cmd.wiCreate(config, { type: "Bug", title: "t", state: "active", priority: 2, customFields: { "/fields/Custom.Team": "core" } });
    expect(out).toContain("#77");
    expect(calls.some((c) => c.url.includes("/wit/workitems/$"))).toBe(true);
  });

  it("refuses a field the type does not define", async () => {
    stubFetch([typeFields, created]);
    const out = await cmd.wiCreate(config, { type: "Bug", title: "t", customFields: { "/fields/Custom.Tem": "Core" } });
    expect(out).toMatch(/Custom\.Tem.*not a field of 'Bug'/);
  });

  it("creates anyway when the field lookup fails", async () => {
    const calls = stubFetch([created]);
    vi.mocked(fetch).mockImplementationOnce(async () => json({ authenticatedUser: { id: "me-1", displayName: "Me" } }))
      .mockImplementationOnce(async () => new Response("nope", { status: 403 }));
    const out = await cmd.wiCreate(config, { type: "Bug", title: "t" });
    expect(out).toContain("Work Item Created");
    expect(calls).toBeDefined();
  });
});
