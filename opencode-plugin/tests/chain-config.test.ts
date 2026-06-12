/**
 * TDD RED phase — tests for chain-config.ts
 *
 * These tests import from ../src/chain-config.js which DOES NOT EXIST yet.
 * loadProjectConfig reads .adoconfig.toml using smol-toml.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectConfig } from "../src/chain-config.js";

describe("loadProjectConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ado-chain-config-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns default config when .adoconfig.toml does not exist", async () => {
    const config = await loadProjectConfig(tempDir);

    expect(config.chain.strategy).toBe("feature-chain");
    expect(config.chain.base_branch).toBe("main");
    expect(config.chain.max_length).toBe(10);
    expect(config.chain.prefix).toBe("feature");
    expect(config.chain.tracker_name).toBe("");
    expect(config.branch.allowed_types).toEqual([
      "feature", "bugfix", "hotfix", "chore", "refactor",
    ]);
    expect(config.branch.slug_max_length).toBe(40);
    expect(config.branch.require_wi_id).toBe(true);
    expect(config.pr.require_work_item).toBe(true);
    expect(config.pr.include_chain_context).toBe(true);
    expect(config.pr.review_budget).toBe(400);
    expect(config.pr.default_draft).toBe(false);
    expect(config.work_item.auto_transition).toBe(false);
    expect(config.work_item.target_state).toBe("In Dev");
  });

  it("parses a valid TOML config file", async () => {
    const toml = `
[chain]
strategy = "stacked"
base_branch = "develop"
max_length = 20
prefix = "bugfix"
tracker_name = "bugfix/tracker"

[branch]
allowed_types = ["feature", "bugfix"]
slug_max_length = 30
require_wi_id = false

[pr]
require_work_item = false
include_chain_context = false
review_budget = 800
default_draft = true

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
    expect(config.chain.tracker_name).toBe("bugfix/tracker");
    expect(config.branch.allowed_types).toEqual(["feature", "bugfix"]);
    expect(config.branch.slug_max_length).toBe(30);
    expect(config.branch.require_wi_id).toBe(false);
    expect(config.pr.require_work_item).toBe(false);
    expect(config.pr.include_chain_context).toBe(false);
    expect(config.pr.review_budget).toBe(800);
    expect(config.pr.default_draft).toBe(true);
    expect(config.work_item.auto_transition).toBe(true);
    expect(config.work_item.target_state).toBe("Active");
  });

  it("throws a descriptive error for invalid TOML syntax", async () => {
    const badToml = `
[chain
strategy = "broken
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), badToml);

    await expect(loadProjectConfig(tempDir)).rejects.toThrow(
      "Failed to parse .adoconfig.toml",
    );
  });

  it("applies defaults for missing fields in a partial config", async () => {
    const partial = `
[chain]
strategy = "stacked"
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), partial);

    const config = await loadProjectConfig(tempDir);

    // Explicitly set
    expect(config.chain.strategy).toBe("stacked");
    // Defaults for everything else
    expect(config.chain.base_branch).toBe("main");
    expect(config.chain.max_length).toBe(10);
    expect(config.chain.prefix).toBe("feature");
    expect(config.chain.tracker_name).toBe("");
    expect(config.branch.allowed_types).toEqual([
      "feature", "bugfix", "hotfix", "chore", "refactor",
    ]);
    expect(config.branch.slug_max_length).toBe(40);
    expect(config.branch.require_wi_id).toBe(true);
    expect(config.pr.require_work_item).toBe(true);
    expect(config.pr.include_chain_context).toBe(true);
    expect(config.pr.review_budget).toBe(400);
    expect(config.pr.default_draft).toBe(false);
    expect(config.work_item.auto_transition).toBe(false);
    expect(config.work_item.target_state).toBe("In Dev");
  });

  it("applies defaults when config file is an empty object", async () => {
    await writeFile(join(tempDir, ".adoconfig.toml"), "");

    const config = await loadProjectConfig(tempDir);

    expect(config.chain.strategy).toBe("feature-chain");
    expect(config.chain.base_branch).toBe("main");
    expect(config.pr.review_budget).toBe(400);
  });

  it("rejects an invalid strategy value", async () => {
    const invalid = `
[chain]
strategy = "invalid-strategy"
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), invalid);

    await expect(loadProjectConfig(tempDir)).rejects.toThrow();
  });

  it("rejects max_length outside valid range (too high)", async () => {
    const invalid = `
[chain]
max_length = 100
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), invalid);

    await expect(loadProjectConfig(tempDir)).rejects.toThrow();
  });

  it("rejects max_length outside valid range (too low)", async () => {
    const invalid = `
[chain]
max_length = 0
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), invalid);

    await expect(loadProjectConfig(tempDir)).rejects.toThrow();
  });

  it("rejects review_budget outside valid range", async () => {
    const invalid = `
[pr]
review_budget = 0
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), invalid);

    await expect(loadProjectConfig(tempDir)).rejects.toThrow();
  });

  it("accepts minimum valid max_length of 1", async () => {
    const valid = `
[chain]
max_length = 1
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), valid);

    const config = await loadProjectConfig(tempDir);
    expect(config.chain.max_length).toBe(1);
  });

  it("accepts maximum valid max_length of 50", async () => {
    const valid = `
[chain]
max_length = 50
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), valid);

    const config = await loadProjectConfig(tempDir);
    expect(config.chain.max_length).toBe(50);
  });

  it("preserves custom allowed_types", async () => {
    const valid = `
[branch]
allowed_types = ["feature", "hotfix"]
`;
    await writeFile(join(tempDir, ".adoconfig.toml"), valid);

    const config = await loadProjectConfig(tempDir);
    expect(config.branch.allowed_types).toEqual(["feature", "hotfix"]);
  });
});
