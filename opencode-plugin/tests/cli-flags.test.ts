import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/profile-store.js", () => ({
  getActiveProfile: vi.fn(() => null),
  setActiveProfile: vi.fn(),
  setSelectedPr: vi.fn(),
  getSelectedPr: vi.fn(() => null),
}));

import { main } from "../src/bin/opencode-ado";

let root: string;
let logs: string[];
let calls: Array<{ url: string; init?: RequestInit }>;
let originalXdg: string | undefined;
let originalHome: string | undefined;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  root = join(tmpdir(), `ado-flags-${crypto.randomUUID()}`);
  await mkdir(join(root, "opencode"), { recursive: true });
  await writeFile(join(root, "opencode", "opencode.json"), JSON.stringify({
    ado: { defaultProfile: "work", profiles: { work: { organization: "org", project: "P", repos: ["web"], pat: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" } } },
  }));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  originalHome = process.env.HOME;
  process.env.HOME = root;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m = "") => { logs.push(String(m)); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/connectionData")) return json({ authenticatedUser: { id: "me", displayName: "Me" } });
    return json({ value: [], comments: [] });
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  process.env.HOME = originalHome;
  await rm(root, { recursive: true, force: true });
});

const out = () => logs.join("\n");

describe("unknown flags", () => {
  it.each([
    [["wi", "create", "--title", "x", "--assignedTo", "bob"], "--assignedTo", "--assigned"],
    [["pr", "threads", "5", "--full"], "--full", undefined],
    [["pr", "list", "--json"], "--json", undefined],
    [["wi", "create", "--title", "x", "--dry-run"], "--dry-run", undefined],
    [["wi", "update", "1", "--desc", "x"], "--desc", "--description"],
    [["pr", "comment", "5", "--coment", "x"], "--coment", "--comment"],
  ])("ado %j fails before calling ADO", async (argv, bad, suggestion) => {
    const code = await main(argv as string[]);
    expect(code).toBe(1);
    expect(out()).toContain(`Unknown flag ${bad}`);
    if (suggestion) expect(out()).toContain(`Did you mean ${suggestion}?`);
    expect(out()).toContain("Usage: ado");
    expect(calls).toHaveLength(0);
  });
});

describe("every documented flag is accepted", () => {
  // One invocation per command, passing every flag the command reads.
  const valid: string[][] = [
    ["profile"], ["profile", "get", "--profile", "work"], ["profile", "list"], ["profile", "use", "work"],
    ["pipeline"], ["pipeline", "list", "--profile", "work"],
    ["pipeline", "runs", "--id", "3", "--limit", "2"], ["pipeline", "run", "--id", "3", "--branch", "main"],
    ["pr", "list"], ["pr", "get", "web", "5"], ["pr", "threads", "5"], ["pr", "diff", "5", "--hunks"],
    ["pr", "context", "5"],
    ["pr", "comment", "web", "5", "--comment", "x", "--file", "/a.ts", "--line", "3"],
    ["pr", "reply", "web", "5", "7", "--comment", "x", "--status", "fixed"],
    ["pr", "reply", "web", "5", "--thread", "7", "--status", "closed"],
    ["pr", "vote", "web", "5", "approve", "--comment", "ok"],
    ["pr", "select", "web", "5"],
    ["pr", "file", "web", "5", "--path", "/a.ts", "--start", "1", "--end", "2"],
    ["pr", "create", "--repo", "web", "--source", "f", "--target", "main", "--title", "t", "--description", "d", "--wi", "1,2", "--draft"],
    ["pr", "complete", "web", "5", "--strategy", "squash", "--delete-source", "--bypass"],
    ["pr", "abandon", "web", "5"], ["pr", "publish", "web", "5"],
    ["pr", "reviewers", "web", "5", "--add", "a,b", "--required"],
    ["pr", "chain", "--repo", "web", "--wi", "1,2", "--base", "dev", "--strategy", "stacked", "--prefix", "feature", "--branches", "a,b"],
    ["wi", "list", "--state", "Active", "--assigned", "me", "--tag", "t", "--type", "Bug"],
    ["wi", "get", "1"], ["wi", "types"], ["wi", "fields", "--type", "Bug"],
    ["wi", "update", "1", "--title", "t", "--description", "d", "--state", "s", "--priority", "2", "--assigned", "a",
      "--area", "A", "--iteration", "I", "--tags", "x", "--field", "Custom.X=1", "--comment", "c", "--format", "html"],
    ["wi", "link", "1", "--parent", "2", "--comment", "c"], ["wi", "link", "1", "--child", "2"],
    ["wi", "link", "1", "--related", "2"], ["wi", "link", "1", "--duplicate", "2"],
    ["wi", "link", "1", "--successor", "2"], ["wi", "link", "1", "--predecessor", "2"],
    ["wi", "attach", "1", "--file", "/nonexistent", "--comment", "c"], ["wi", "attachments", "1", "--dest", "/tmp/x-none"],
    ["wi", "query", "--wiql", "SELECT [System.Id] FROM WorkItems"],
    ["wi", "comment", "1", "--comment", "c", "--format", "markdown"],
    ["wi", "related", "1", "--state", "s", "--type", "Bug"],
    ["wi", "create", "--title", "t", "--type", "Bug", "--description", "d", "--area", "A", "--iteration", "I",
      "--priority", "2", "--assigned", "a", "--state", "New", "--tags", "x", "--field", "Custom.X=1", "--parent", "3"],
    ["wi", "create-child", "--parent", "3", "--title", "t", "--type", "Task", "--description", "d", "--area", "A",
      "--iteration", "I", "--priority", "2", "--assigned", "a", "--state", "New", "--tags", "x", "--field", "Custom.X=1"],
  ];

  it.each(valid.map((v) => [v.join(" "), v]))("ado %s", async (_label, argv) => {
    await main(argv as string[]);
    expect(out()).not.toContain("Unknown flag");
    expect(out()).not.toMatch(/Unknown \w+ command/);
  });
});

describe("--help", () => {
  it("ado wi --help lists the group's commands and exits 0", async () => {
    expect(await main(["wi", "--help"])).toBe(0);
    expect(out()).toContain("ado wi create");
    expect(out()).toContain("ado wi comment");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [["pr", "comment", "--help"], "Usage: ado pr comment"],
    [["pr", "reply", "-h"], "Usage: ado pr reply"],
    [["wi", "create", "--help"], "Usage: ado wi create"],
    [["pipeline", "runs", "--help"], "Usage: ado pipeline runs"],
    [["profile", "--help"], "ado profile use"],
    [["pr", "--help"], "ado pr threads"],
  ])("ado %j prints usage", async (argv, expected) => {
    expect(await main(argv as string[])).toBe(0);
    expect(out()).toContain(expected);
    expect(calls).toHaveLength(0);
  });

  it("an unknown subcommand prints the group usage and exits 1", async () => {
    expect(await main(["wi", "frobnicate"])).toBe(1);
    expect(out()).toContain("Unknown wi command: frobnicate");
    expect(out()).toContain("ado wi get");
  });
});

describe("--comment-file", () => {
  const body = "## Review\n\n- first point\n- second point\n";
  let file: string;
  beforeEach(async () => { file = join(root, "c.md"); await writeFile(file, body, "utf-8"); });

  const posted = () => calls.filter((c) => c.init?.method === "POST");

  it("pr comment reads the body from the file", async () => {
    expect(await main(["pr", "comment", "web", "5", "--comment-file", file])).toBe(0);
    expect(JSON.parse(String(posted()[0].init?.body)).comments[0].content).toBe(body.trimEnd());
  });

  it("pr reply reads the body from the file", async () => {
    expect(await main(["pr", "reply", "web", "5", "7", "--comment-file", file])).toBe(0);
    expect(posted()[0].url).toContain("/threads/7/comments");
    expect(JSON.parse(String(posted()[0].init?.body)).content).toBe(body.trimEnd());
  });

  it("wi comment reads the body from the file and posts markdown", async () => {
    expect(await main(["wi", "comment", "3", "--comment-file", file])).toBe(0);
    expect(new URL(posted()[0].url).searchParams.get("format")).toBe("markdown");
    expect(JSON.parse(String(posted()[0].init?.body)).text).toBe(body.trimEnd());
  });

  it("refuses --comment together with --comment-file", async () => {
    expect(await main(["wi", "comment", "3", "--comment", "x", "--comment-file", file])).toBe(1);
    expect(out()).toContain("not both");
    expect(posted()).toHaveLength(0);
  });

  it("refuses an unknown --format", async () => {
    expect(await main(["wi", "comment", "3", "--comment", "x", "--format", "rtf"])).toBe(1);
    expect(out()).toContain("markdown|html");
    expect(posted()).toHaveLength(0);
  });
});
