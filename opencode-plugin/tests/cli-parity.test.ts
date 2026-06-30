import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/bin/opencode-ado";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");

describe("opencode-ado CLI parity", () => {
  let configRoot: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalXdgConfigHome: string | undefined;
  let originalPat: string | undefined;

  beforeEach(async () => {
    configRoot = join(tmpdir(), `opencode-ado-test-${crypto.randomUUID()}`);
    await mkdir(join(configRoot, "opencode"), { recursive: true });

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalPat = process.env.AZURE_DEVOPS_PAT;
    process.env.XDG_CONFIG_HOME = configRoot;
    process.env.AZURE_DEVOPS_PAT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuv";

    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalPat === undefined) delete process.env.AZURE_DEVOPS_PAT;
    else process.env.AZURE_DEVOPS_PAT = originalPat;
    await rm(configRoot, { recursive: true, force: true });
  });

  async function writeAdoConfig() {
    await writeFile(
      join(configRoot, "opencode", "opencode.json"),
      JSON.stringify({
        ado: {
          defaultProfile: "work",
          profiles: {
            work: {
              organization: "org",
              project: "Project One",
              repos: ["web"],
            },
          },
        },
      }),
    );
  }

  it("prints the active ADO profile from opencode config", async () => {
    await writeAdoConfig();
    stubAdoFetch({});

    const code = await main(["profile"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("work");
    expect(logs.join("\n")).toContain("org");
    expect(logs.join("\n")).toContain("Project One");
    expect(logs.join("\n")).toContain("web");
  });

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  /** Route fetch by URL so commands that make several calls (identity, item, comments) work. */
  function stubAdoFetch(routes: { workItem?: unknown; comments?: unknown }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/connectionData")) return json({ authenticatedUser: { id: "user-1", displayName: "Me" } });
        if (u.includes("/comments")) return json(routes.comments ?? { comments: [] });
        if (u.includes("/wit/workitems/")) return json(routes.workItem ?? {});
        return json({});
      }),
    );
  }

  it("fetches and prints rich work item detail by id (plugin parity)", async () => {
    await writeAdoConfig();
    stubAdoFetch({
      workItem: {
        id: 123,
        fields: {
          "System.Title": "Fix login",
          "System.State": "Active",
          "System.WorkItemType": "Bug",
        },
      },
    });

    const code = await main(["wi", "get", "123"]);

    expect(code).toBe(0);
    // Full-parity output: rich detail block plus a Comments section.
    expect(logs.join("\n")).toContain("## Work Item #123");
    expect(logs.join("\n")).toContain("Fix login");
    expect(logs.join("\n")).toContain("Active");
    expect(logs.join("\n")).toContain("Comments");
    // Expanded relations are requested for parity with the plugin tool.
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    // `$` is percent-encoded to %24 when the URL is serialized, so match the bare key.
    expect(urls.some((u) => u.includes("/wit/workitems/123") && u.includes("expand=relations"))).toBe(true);
  });
});

describe("ADO skill artifact", () => {
  it("documents the profile and wi get CLI entry points", async () => {
    const skill = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(repoRoot, "skills", "ado", "SKILL.md"), "utf8"),
    );

    expect(skill).toContain("ado profile");
    expect(skill).toContain("ado wi get");
  });
});
