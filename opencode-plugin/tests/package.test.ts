import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  const cliSource = readFileSync(new URL("../src/bin/opencode-ado.ts", import.meta.url), "utf-8");
  const tuiSource = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf-8");
  const serverSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  const piSource = readFileSync(new URL("../src/pi-entry.ts", import.meta.url), "utf-8");
  const sharedSource = readFileSync(new URL("../src/shared.ts", import.meta.url), "utf-8");
  const adoClientSource = readFileSync(new URL("../src/ado-client.ts", import.meta.url), "utf-8");

  it("publishes the TUI source expected by OpenCode", () => {
    expect(pkg.exports["./tui"].default).toBe("./dist/tui.tsx");
    expect(pkg.files).toContain("dist");
  });

  it("build copies the TUI TSX file into dist", () => {
    expect(pkg.scripts.build).toContain("scripts/prepare-tui-dist.mjs");
  });

  it("init registers both server and TUI plugin configs", () => {
    expect(cliSource).toContain("syncTuiPluginConfig");
    expect(cliSource).toContain("tui.json");
    expect(cliSource).toContain("TUI sidebar plugin added to tui.json");
  });

  it("provides a non-interactive sync command for existing profiles", () => {
    expect(cliSource).toContain("function syncExistingConfig");
    expect(cliSource).toContain("npx @nahuelcio/opencode-ado sync");
    expect(cliSource).toContain('command === "sync-local"');
    expect(cliSource).toContain("getLocalPluginSpec");
    expect(cliSource).toContain('command === "sync"');
    expect(pkg.scripts["sync:local"]).toContain("sync-local");
  });

  it("pins OpenCode config to the running package version to avoid stale latest cache", () => {
    expect(cliSource).toContain("getVersionedPluginSpec");
    expect(cliSource).toContain("pkg.version");
    expect(cliSource).toContain("startsWith(`${PLUGIN_SPEC}@`)");
  });

  it("renders sidebar state reactively after PR loading completes", () => {
    expect(tuiSource).toContain("function SidebarContentView");
    expect(tuiSource).toContain("<SidebarContentView api={api} data={data} setData={setData} />");
    expect(tuiSource).toContain("Switch");
    expect(tuiSource).toContain("Match");
    expect(tuiSource).not.toContain('if (d().status === "loading") return');
  });

  it("stringifies numeric values before rendering them inside text nodes", () => {
    expect(tuiSource).toContain("String(d().assignedToMe.length)");
    expect(tuiSource).toContain("String(d().myPRs.length)");
    expect(tuiSource).toContain("String(pr.id)");
    expect(tuiSource).toContain('<span style={{ fg: "gray" }}>{`${pr.author} — ${pr.title}`}</span>');
    expect(tuiSource).toContain('{pr.isDraft ? <span style={{ fg: "gray" }}>{" [DRAFT]"}</span> : ""}');
    expect(tuiSource).not.toContain('<text fg="gray">{pr.author} — {pr.title}</text>');
  });

  it("uses preview connectionData API and request timeout to avoid infinite loading", () => {
    expect(tuiSource).toContain('CONNECTION_DATA_API_VERSION = "7.1-preview.1"');
    expect(tuiSource).toContain("REQUEST_TIMEOUT_MS");
    expect(tuiSource).toContain("SIDEBAR_LOAD_TIMEOUT_MS");
    expect(tuiSource).toContain("Sidebar load timed out");
    expect(tuiSource).toContain("AbortController");
  });

  it("keeps sidebar state at plugin scope so slot rerenders do not reset loading", () => {
    expect(tuiSource).toContain("api.lifecycle.onDispose");
    expect(tuiSource).toContain("let inFlight: Promise<void> | undefined");
    expect(tuiSource).toContain("const [data, setData] = createSignal<SidebarData>");
  });

  it("keeps WI/QA list focus and collapse controls usable from mouse and keyboard", () => {
    expect(tuiSource).toContain("handleMouseAction");
    expect(tuiSource).toContain("toggleStateGroup");
    expect(tuiSource).toContain("click headers: expand/collapse");
    expect(tuiSource).toContain('if (name === "j" || name === "down" || name === "arrowdown")');
    expect(tuiSource).toContain('keybind: "alt+a"');
    expect(tuiSource).toContain('keybind: "alt+w"');
    expect(tuiSource).toContain("ado:focus-list-legacy-alt-w");
    expect(tuiSource).not.toContain("renderBefore={refreshListFocused}");
  });

  it("supports standalone PR comments including optional file/line context", () => {
    expect(serverSource).toContain("ado_pr_comment");
    expect(serverSource).toContain("filePath");
    expect(adoClientSource).toContain("rightFileStart");
    expect(serverSource).toContain("Provide filePath when specifying line.");
  });

  it("pi-entry tool executors pass ctx.cwd to getConfig (no bare getConfig() calls)", () => {
    // The commands section (registerCommand) legitimately calls getConfig(ctx.cwd) — that's fine.
    // What must NOT exist is a bare getConfig() call inside a registerTool execute block.
    // We verify by checking the whole file has no standalone getConfig() without an argument.
    expect(piSource).not.toContain("getConfig()");
  });

  it("supports generic work item tools with explicit workItemType filtering", () => {
    expect(serverSource).toContain("ado_work_items");
    expect(serverSource).toContain("workItemType");
    expect(serverSource).toContain("[System.WorkItemType] CONTAINS");
    expect(serverSource).not.toContain("[System.WorkItemType] LIKE");
    // pi-entry must also use CONTAINS (not LIKE with manual wildcard injection)
    expect(piSource).toContain("[System.WorkItemType] CONTAINS");
    expect(piSource).not.toContain("[System.WorkItemType] LIKE");
    // escapeWiqlValue was dead code — it must not exist in shared.ts
    expect(sharedSource).not.toContain("escapeWiqlValue");
  });

  it("uses the documented WIT comments endpoint/version for QA feedback comments", () => {
    expect(adoClientSource).toContain('WIT_COMMENTS_API_VERSION = "7.1-preview.4"');
    expect(adoClientSource).toContain("`/_apis/wit/workItems/${id}/comments`");
    expect(adoClientSource).not.toContain("`/_apis/wit/workitems/${id}/comments`");
  });

  it("maps assignedTo=me to @Me and includes related work items in WI/QA details", () => {
    expect(adoClientSource).toContain("function assignedToCondition");
    expect(adoClientSource).toContain('normalized.toLowerCase() === "me"');
    expect(adoClientSource).toContain("[System.AssignedTo] = @Me");
    expect(adoClientSource).toContain("expandRelations");
    expect(adoClientSource).toContain("formatWorkItemRelations");
    expect(adoClientSource).toContain("## Related");
  });

  it("supports full related work item bundles for a parent work item", () => {
    expect(serverSource).toContain("ado_related_work_items");
    expect(serverSource).toContain("## Related for #");
    expect(adoClientSource).toContain("formatWorkItemFullDetail");
    expect(adoClientSource).toContain("formatComments");
    expect(sharedSource).toContain("System.Description");
  });

  it("stripJsonComments only treats double quotes as string delimiters (not apostrophes)", () => {
    // Must not open a string context on single-quote characters
    expect(cliSource).not.toContain(`char === "'" ||`);
    expect(cliSource).not.toContain(`=== "'" || char === '"'`);
    // Must open string context only on double-quote
    expect(cliSource).toContain(`if (char === '"') {`);
  });
});
