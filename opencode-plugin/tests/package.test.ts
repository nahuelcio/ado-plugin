import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  const cliSource = readFileSync(new URL("../src/bin/opencode-ado.ts", import.meta.url), "utf-8");
  const sharedSource = readFileSync(new URL("../src/shared.ts", import.meta.url), "utf-8");
  const adoClientSource = readFileSync(new URL("../src/ado-client.ts", import.meta.url), "utf-8");
  // Command orchestration moved out of index.ts into the shared cli-commands module.
  const cliCommandsSource = readFileSync(new URL("../src/cli-commands.ts", import.meta.url), "utf-8");

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

  it("stripJsonComments only treats double quotes as string delimiters (not apostrophes)", () => {
    // Must not open a string context on single-quote characters
    expect(cliSource).not.toContain(`char === "'" ||`);
    expect(cliSource).not.toContain(`=== "'" || char === '"'`);
    // Must open string context only on double-quote
    expect(cliSource).toContain(`if (char === '"') {`);
  });

});

