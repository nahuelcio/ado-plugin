#!/usr/bin/env node

/**
 * CLI entry point for @nahuelcio/opencode-ado
 *
 * Usage:
 *   npx @nahuelcio/opencode-ado init    — Interactive setup wizard
 *   npx @nahuelcio/opencode-ado sync    — Register existing config in OpenCode + TUI
 *   node dist/bin/opencode-ado.js sync-local — Register the local workspace build without publishing
 *   npx @nahuelcio/opencode-ado show    — Show current config
 *   npx @nahuelcio/opencode-ado --help
 */

import { realpathSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";

const PLUGIN_SPEC = "@nahuelcio/opencode-ado";
const SCHEMA_URL = "https://opencode.ai/config.json";
const TUI_SCHEMA_URL = "https://opencode.ai/tui.json";

// ─── Colors ───────────────────────────────────────────────────────────────

function cyan(t: string) { return `\x1b[36m${t}\x1b[0m`; }
function green(t: string) { return `\x1b[32m${t}\x1b[0m`; }
function yellow(t: string) { return `\x1b[33m${t}\x1b[0m`; }
function bold(t: string) { return `\x1b[1m${t}\x1b[0m`; }

// ─── Prompt helpers ───────────────────────────────────────────────────────

function ask(prompt: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const hint = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`  ${cyan("❯")} ${prompt}${hint}: `, (answer) => {
      rl.close();
      resolve((answer.trim() || (defaultValue ?? "")).trim());
    });
  });
}

function yesNo(prompt: string, def = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const hint = def ? "Y/n" : "y/N";
    rl.question(`  ${cyan("❯")} ${prompt} (${hint}): `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" ? def : a === "y" || a === "yes");
    });
  });
}

// ─── Config paths ─────────────────────────────────────────────────────────

function getOpenCodeConfigDir(): string {
  // 1. XDG_CONFIG_HOME
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "opencode");

  // 2. OpenCode uses ~/.config/opencode on Windows too.
  const homeConfig = join(homedir(), ".config", "opencode");
  if (existsSync(homeConfig)) return homeConfig;

  // 3. Legacy Windows fallback used by older versions of this CLI.
  if (platform() === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, "opencode");
  }

  // 4. ~/.config/opencode
  return homeConfig;
}

function getAdoCredentialsDir(): string {
  return join(homedir(), ".azure-devops-cli");
}

function getAdoCredentialsPath(): string {
  return join(getAdoCredentialsDir(), "pat");
}

// ─── Config read/write ────────────────────────────────────────────────────

function findConfigFile(dir: string): string | null {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function findTuiConfigFile(dir: string): string {
  return join(dir, "tui.json");
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, "")));
}

export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      stringQuote = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        out += input[i] === "\n" ? "\n" : " ";
        i++;
      }
      i++;
      continue;
    }

    out += char;
  }

  return out;
}

function writeConfig(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!data["$schema"]) data["$schema"] = SCHEMA_URL;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeTuiConfig(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!data["$schema"]) data["$schema"] = TUI_SCHEMA_URL;
  if (data["mouse"] === undefined) data["mouse"] = true;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ─── PAT storage ──────────────────────────────────────────────────────────

function storePAT(pat: string): void {
  const dir = getAdoCredentialsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const path = getAdoCredentialsPath();
  writeFileSync(path, pat.trim(), "utf-8");

  // Restrict permissions (Unix only — Windows uses ACL)
  if (platform() !== "win32") {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  // Do not persist the PAT into the user environment. The plugin reads this file
  // as a fallback when the configured env var is not present.
}

function loadStoredPAT(): string | null {
  try {
    const path = getAdoCredentialsPath();
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch { /* ignore */ }
  return null;
}

// ─── Init Command ─────────────────────────────────────────────────────────

interface ProfileConfig {
  org: string;
  project: string;
  patEnvVar: string;
  repos: string[];
  default?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isLocalAdoPluginSpec(spec: unknown): boolean {
  if (typeof spec !== "string" || !spec.startsWith("file:")) return false;
  try {
    const packageRoot = spec.slice("file:".length);
    const packageJsonPath = join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) return false;
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
    return pkg.name === PLUGIN_SPEC;
  } catch {
    return false;
  }
}

function isAdoPluginSpec(spec: unknown): boolean {
  return typeof spec === "string"
    && (spec === PLUGIN_SPEC || spec.startsWith(`${PLUGIN_SPEC}@`) || isLocalAdoPluginSpec(spec));
}

function getPackageVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const path of [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ]) {
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* ignore */ }
  return undefined;
}

function getVersionedPluginSpec(): string {
  const version = getPackageVersion();
  return version ? `${PLUGIN_SPEC}@${version}` : PLUGIN_SPEC;
}

function getLocalPluginSpec(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = realpathSync(join(here, "..", ".."));
  return `file:${packageRoot.replace(/\\/g, "/")}`;
}

function pluginMatches(entry: unknown): boolean {
  if (isAdoPluginSpec(entry)) return true;
  if (Array.isArray(entry)) return isAdoPluginSpec(entry[0]);
  return false;
}

function getPluginAdoConfig(plugins: unknown[]): Record<string, unknown> | undefined {
  const entry = plugins.find(pluginMatches);
  if (!Array.isArray(entry)) return undefined;
  const options = asRecord(entry[1]);
  if (!options) return undefined;
  const nested = asRecord(options["ado"]);
  return nested ?? options;
}

function upsertPluginConfig(
  plugins: unknown[],
  adoConfig: Record<string, unknown>,
  pluginSpec = getVersionedPluginSpec(),
): void {
  const entry = [pluginSpec, adoConfig];
  const index = plugins.findIndex(pluginMatches);
  if (index >= 0) plugins[index] = entry;
  else plugins.push(entry);
}

function readTuiConfig(path: string): Record<string, unknown> {
  return existsSync(path) ? readConfig(path) : {};
}

function syncTuiPluginConfig(configDir: string, adoConfig: Record<string, unknown>, pluginSpec = getVersionedPluginSpec()): string {
  const tuiPath = findTuiConfigFile(configDir);
  const tuiConfig = readTuiConfig(tuiPath);
  if (!Array.isArray(tuiConfig["plugin"])) tuiConfig["plugin"] = [];
  const tuiPlugins = tuiConfig["plugin"] as unknown[];
  upsertPluginConfig(tuiPlugins, adoConfig, pluginSpec);
  writeTuiConfig(tuiPath, tuiConfig);
  return tuiPath;
}

function findExistingAdoConfig(config: Record<string, unknown>, tuiConfig?: Record<string, unknown>) {
  const plugins = Array.isArray(config["plugin"]) ? config["plugin"] as unknown[] : [];
  const tuiPlugins = Array.isArray(tuiConfig?.["plugin"]) ? tuiConfig?.["plugin"] as unknown[] : [];
  return getPluginAdoConfig(plugins)
    ?? asRecord(config["ado"])
    ?? getPluginAdoConfig(tuiPlugins);
}

function normalizeAdoConfig(ado: Record<string, unknown>): Record<string, unknown> {
  if (!ado["profiles"] || typeof ado["profiles"] !== "object") {
    throw new Error("No ADO profiles found. Run `npx @nahuelcio/opencode-ado init` first.");
  }
  return ado;
}

function syncExistingConfig(pluginSpec = getVersionedPluginSpec()): { configPath: string; tuiPath: string; pluginSpec: string } {
  const configDir = getOpenCodeConfigDir();
  const configPath = findConfigFile(configDir) ?? join(configDir, "opencode.json");
  const tuiPath = findTuiConfigFile(configDir);
  const config = readConfig(configPath);
  const tuiConfig = readTuiConfig(tuiPath);

  const ado = normalizeAdoConfig(findExistingAdoConfig(config, tuiConfig) ?? {});

  if (!Array.isArray(config["plugin"])) config["plugin"] = [];
  const plugins = config["plugin"] as unknown[];
  delete config["ado"];
  upsertPluginConfig(plugins, ado, pluginSpec);

  const writtenTuiPath = syncTuiPluginConfig(configDir, ado, pluginSpec);
  writeConfig(configPath, config);

  return { configPath, tuiPath: writtenTuiPath, pluginSpec };
}

// ─── TOML helpers ──────────────────────────────────────────────────────────

function readExistingTomlValues(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^(\w+)\s*=\s*"?([^"]*)"?\s*(?:#.*)?$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

async function writeAdoConfig(configPath: string, defaults?: Record<string, string>): Promise<void> {
  console.log();
  console.log(`  ${bold("── Project Rules (.adoconfig.toml) ──")}`);
  console.log();

  const d = defaults ?? {};
  const strategy = await ask("Default chain strategy (feature-chain/stacked)", d["strategy"] ?? "feature-chain");
  const baseBranch = await ask("Base branch", d["base_branch"] ?? "main");
  const maxLengthStr = await ask("Max chain length", d["max_length"] ?? "10");
  const maxLength = parseInt(maxLengthStr, 10);
  const prefix = await ask("Branch prefix", d["prefix"] ?? "feature");
  const requireWorkItem = await yesNo("Require work items for PRs?", d["require_work_item"] !== "false");
  const defaultDraft = await yesNo("Create PRs as draft by default?", d["default_draft"] === "true");

  // Work item creation settings
  console.log();
  console.log(`  ${bold("── Work Item Creation ──")}`);
  console.log();
  const wiCreateEnabled = await yesNo("Allow work item creation from plugin?");
  const wiAllowedTypesStr = await ask("Allowed WI types (comma-separated, empty = all)", d["allowed_types"] ?? "");
  const wiAllowedTypes = wiAllowedTypesStr
    ? wiAllowedTypesStr.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const wiRequiredFieldsStr = await ask("Required fields for WI creation (comma-separated)", d["required_fields"] ?? "title");
  const wiRequiredFields = wiRequiredFieldsStr
    ? wiRequiredFieldsStr.split(",").map((s) => s.trim()).filter(Boolean)
    : ["title"];
  const wiDefaultState = await ask("Default WI state", d["default_state"] ?? "New");
  const wiAutoAssign = await yesNo("Auto-assign WI to creator?", false);
  const wiRequireParent = await yesNo("Require parent WI for creation?", false);

  const toml = `# .adoconfig.toml — Project-level ADO conventions

[chain]
strategy = "${strategy}"        # "feature-chain" | "stacked"
base_branch = "${baseBranch}"
max_length = ${isNaN(maxLength) ? 10 : maxLength}
prefix = "${prefix}"

[branch]
allowed_types = ["feature", "bugfix", "hotfix", "chore", "refactor"]
slug_max_length = 40
require_wi_id = true

[pr]
require_work_item = ${requireWorkItem}
include_chain_context = true
review_budget = 400
default_draft = ${defaultDraft}

[work_item]
auto_transition = false
target_state = "In Dev"

[work_item.create]
enabled = ${wiCreateEnabled}
allowed_types = [${wiAllowedTypes.map((t) => `"${t}"`).join(", ")}]
required_fields = [${wiRequiredFields.map((f) => `"${f}"`).join(", ")}]
default_state = "${wiDefaultState}"
auto_assign = ${wiAutoAssign}
require_parent = ${wiRequireParent}
`;

  writeFileSync(configPath, toml, "utf-8");
  console.log();
  console.log(`  ${green("✓")} Wrote ${configPath}`);
}

async function runInit(_cwd: string): Promise<number> {
  console.log();
  console.log(bold("  Azure DevOps Plugin for OpenCode"));
  console.log("  ─────────────────────────────────────────");
  console.log();

  // ── Step 1: Organization ──────────────────────────────────────────
  console.log(`  ${bold("Organization")}`);
  console.log("  Your Azure DevOps org URL or name.");
  console.log("  Examples: myorg, https://dev.azure.com/myorg, https://myorg.visualstudio.com");
  const org = await ask("Organization URL or name");
  if (!org) { console.log(yellow("  ✗ Organization is required")); return 1; }

  // ── Step 2: PAT ───────────────────────────────────────────────────
  console.log();
  console.log(`  ${bold("Personal Access Token (PAT)")}`);

  const existingPAT = process.env.AZURE_DEVOPS_PAT ?? loadStoredPAT();
  if (existingPAT) {
    console.log(`  ${green("✓")} Found existing PAT — will reuse it`);
  } else {
    console.log("  Your PAT is stored securely in ~/.azure-devops-cli/pat (never in opencode.json)");
    const pat = await ask("Enter your PAT");
    if (!pat) { console.log(yellow("  ✗ PAT is required")); return 1; }
    storePAT(pat);
    console.log(`  ${green("✓")} PAT saved to ~/.azure-devops-cli/pat`);
  }

  const patEnvVar = "AZURE_DEVOPS_PAT";

  // ── Step 3: Profiles (loop) ───────────────────────────────────────
  const profiles: Record<string, ProfileConfig> = {};
  let isFirstProfile = true;
  let defaultProfileName = "";

  while (true) {
    console.log();
    if (isFirstProfile) {
      console.log(`  ${bold("── Profile ──")}`);
    } else {
      console.log(`  ${bold("── Add another profile ──")}`);
    }

    // Project
    const project = await ask("Project name");
    if (!project) {
      if (isFirstProfile) { console.log(yellow("  ✗ Project name is required")); return 1; }
      break; // No more profiles
    }

    // Repos
    console.log();
    console.log("  Comma-separated repos to monitor for PRs.");
    console.log("  Example: web-api,web-executor,frontend");
    const reposStr = await ask("Repositories");
    const repos = reposStr.split(",").map((s) => s.trim()).filter(Boolean);
    if (repos.length === 0) {
      console.log(yellow("  ✗ At least one repo is required"));
      continue;
    }

    // Validate repo names - only allow alphanumeric, dots, hyphens, and underscores
    const invalidRepo = repos.find(r => !r || r.length === 0 || !/^[a-zA-Z0-9._-]+$/.test(r));
    if (invalidRepo) {
      console.log(yellow(`  ✗ Invalid repository name: "${invalidRepo}"`));
      console.log("  Repository names can only contain letters, numbers, dots, hyphens, and underscores.");
      continue;
    }

    // Default?
    const isDefault = isFirstProfile || await yesNo("Set as default profile?", false);

    let profileName = project.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (profileName.length > 50) {
      console.log(yellow("  ✗ Profile name is too long. Truncating."));
      const truncated = profileName.slice(0, 50);
      console.log(yellow(`  Using: ${truncated}`));
      // Truncate at last word boundary
      const lastDash = truncated.lastIndexOf("-");
      const finalName = lastDash > 10 ? truncated.slice(0, lastDash) : truncated;
      profileName = finalName;
      // Ensure minimum length after truncation
      if (profileName.length < 3) {
        profileName = truncated.slice(0, 3);
        console.log(yellow(`  Truncated to minimum length: ${profileName}`));
      }
    }
    if (isDefault) {
      for (const existing of Object.values(profiles)) delete existing.default;
    }

    profiles[profileName] = {
      org,
      project,
      patEnvVar,
      repos,
      ...(isDefault ? { default: true } : {}),
    };

    if (isDefault) defaultProfileName = profileName;

    console.log(`  ${green("✓")} Profile "${profileName}" added (project: ${project}, repos: ${repos.join(", ")})`);

    // Ask if more
    const addMore = await yesNo("Add another project for this organization?", false);
    if (!addMore) break;
    isFirstProfile = false;
  }

  if (Object.keys(profiles).length === 0) {
    console.log(yellow("  No profiles configured. Exiting."));
    return 1;
  }

  // ── Step 4: Summary ──────────────────────────────────────────────
  console.log();
  console.log(bold("  ── Summary ──"));
  console.log(`  Organization: ${green(org)}`);
  console.log(`  PAT:          ${green("stored in ~/.azure-devops-cli/pat")}`);
  console.log();
  for (const [name, p] of Object.entries(profiles)) {
    const marker = p.default ? green(" (default)") : "";
    console.log(`  Profile: ${bold(name)}${marker}`);
    console.log(`    project: ${p.project}`);
    console.log(`    repos:   ${p.repos.join(", ")}`);
  }
  console.log();

  const ok = await yesNo("Apply this configuration?");
  if (!ok) { console.log(yellow("  Cancelled")); return 0; }

  // ── Step 5: Write config ──────────────────────────────────────────
  const configDir = getOpenCodeConfigDir();
  const configPath = findConfigFile(configDir) ?? join(configDir, "opencode.json");
  const config = readConfig(configPath);

  // Ensure plugin array
  if (!Array.isArray(config["plugin"])) config["plugin"] = [];
  const plugins = config["plugin"] as unknown[];

  // Build plugin options — merge with existing profiles. OpenCode 1.4 rejects
  // arbitrary top-level keys, so ADO config must live in plugin options.
  const ado = getPluginAdoConfig(plugins) ?? asRecord(config["ado"]) ?? {};

  if (!ado["profiles"] || typeof ado["profiles"] !== "object") ado["profiles"] = {};
  const existingProfiles = ado["profiles"] as Record<string, ProfileConfig>;

  for (const [name, p] of Object.entries(profiles)) {
    existingProfiles[name] = p;
  }

  if (defaultProfileName) ado["defaultProfile"] = defaultProfileName;
  delete config["ado"];
  upsertPluginConfig(plugins, ado);
  const tuiPath = syncTuiPluginConfig(configDir, ado);

  writeConfig(configPath, config);
  console.log();
  console.log(`  ${green("✓")} Server plugin added to config`);
  console.log(`  ${green("✓")} TUI sidebar plugin added to tui.json`);
  console.log(`  ${green("✓")} Wrote ${configPath}`);
  console.log(`  ${green("✓")} Wrote ${tuiPath}`);

  // ── Step 6: Next steps ────────────────────────────────────────────
  console.log();
  console.log(bold("  Done! Restart OpenCode to activate the plugin."));
  console.log();
  console.log(`  The LLM can now use: ${cyan("ado_pr_list")}, ${cyan("ado_pr_get <repo> <id>")}, ${cyan("ado_pr_vote <repo> <id> approve")}`);
  console.log(`  The sidebar will show PRs pending your review.`);
  if (platform() === "win32") {
    console.log();
    console.log(yellow("  ⚠ Restart your terminal for the AZURE_DEVOPS_PAT env var to take effect."));
  }
  console.log();

  // ── Step 7: Project Rules (.adoconfig.toml) ────────────────────────
  const adoConfigPath = join(_cwd, ".adoconfig.toml");

  const generateConfig = await yesNo("Generate .adoconfig.toml for this project?");
  if (generateConfig) {
    if (existsSync(adoConfigPath)) {
      const overwrite = await yesNo(".adoconfig.toml already exists. Overwrite?", false);
      if (!overwrite) {
        console.log(yellow("  Skipped .adoconfig.toml generation"));
      } else {
        const existing = readExistingTomlValues(adoConfigPath);
        await writeAdoConfig(adoConfigPath, existing);
      }
    } else {
      await writeAdoConfig(adoConfigPath);
    }
    console.log(`  ${cyan("Tip:")} Run ${bold("'ado config'")} to regenerate .adoconfig.toml without the full wizard`);
  }

  return 0;
}

// ─── Config Command ────────────────────────────────────────────────────────

async function runConfig(cwd: string): Promise<number> {
  console.log();
  console.log(bold("  Project Rules Configuration"));
  console.log();

  const adoConfigPath = join(cwd, ".adoconfig.toml");

  if (existsSync(adoConfigPath)) {
    const existing = readExistingTomlValues(adoConfigPath);
    const overwrite = await yesNo("Overwrite existing .adoconfig.toml?", false);
    if (!overwrite) {
      console.log(yellow("  Cancelled"));
      return 0;
    }
    await writeAdoConfig(adoConfigPath, existing);
  } else {
    await writeAdoConfig(adoConfigPath);
  }

  return 0;
}

// ─── Show Command ─────────────────────────────────────────────────────────

async function runShow(): Promise<number> {
  const configDir = getOpenCodeConfigDir();
  const configPath = findConfigFile(configDir);
  if (!configPath) {
    console.log(yellow("  No opencode.json found in " + configDir));
    return 1;
  }

  const config = readConfig(configPath);
  const plugins = Array.isArray(config["plugin"]) ? config["plugin"] as unknown[] : [];
  const ado = getPluginAdoConfig(plugins) ?? asRecord(config["ado"]);
  if (!ado?.["profiles"]) {
    console.log(yellow("  No ado.profiles configured"));
    return 1;
  }

  const profiles = ado["profiles"] as Record<string, ProfileConfig>;
  const defaultName = ado["defaultProfile"] as string | undefined;

  console.log();
  console.log(`  Config: ${configPath}`);
  console.log();
  for (const [name, p] of Object.entries(profiles)) {
    const marker = (name === defaultName || p.default) ? green(" (default)") : "";
    console.log(`  ${bold(name)}${marker}`);
    console.log(`    org:     ${p.org}`);
    console.log(`    project: ${p.project}`);
    console.log(`    repos:   ${p.repos.join(", ")}`);
    console.log();
  }

  // Check PAT
  const pat = process.env.AZURE_DEVOPS_PAT ?? loadStoredPAT();
  if (pat) {
    console.log(green("  ✓ PAT available"));
  } else {
    console.log(yellow("  ⚠ No PAT found"));
    console.log("    Run: npx @nahuelcio/opencode-ado init");
  }
  console.log();

  return 0;
}

// ─── Sync Command ─────────────────────────────────────────────────────────

async function runSync(): Promise<number> {
  try {
    const { configPath, tuiPath, pluginSpec } = syncExistingConfig();
    console.log();
    console.log(`  ${green("✓")} Server plugin registered in ${configPath}`);
    console.log(`  ${green("✓")} TUI sidebar plugin registered in ${tuiPath}`);
    console.log(`  ${green("✓")} Plugin spec: ${pluginSpec}`);
    console.log();
    console.log("  Restart OpenCode to reload plugins.");
    console.log();
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(yellow(`  ${message}`));
    return 1;
  }
}

async function runSyncLocal(): Promise<number> {
  try {
    const { configPath, tuiPath, pluginSpec } = syncExistingConfig(getLocalPluginSpec());
    console.log();
    console.log(`  ${green("✓")} Server plugin registered in ${configPath}`);
    console.log(`  ${green("✓")} TUI sidebar plugin registered in ${tuiPath}`);
    console.log(`  ${green("✓")} Local plugin spec: ${pluginSpec}`);
    console.log();
    console.log("  Restart OpenCode to load the local workspace build.");
    console.log();
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(yellow(`  ${message}`));
    return 1;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

const USAGE = [
  "",
  bold("  @nahuelcio/opencode-ado"),
  "  Azure DevOps plugin for OpenCode",
  "",
  "  Usage:",
  `    ${cyan("npx @nahuelcio/opencode-ado init")}    Interactive setup wizard`,
  `    ${cyan("npx @nahuelcio/opencode-ado config")}  Generate .adoconfig.toml for this project`,
  `    ${cyan("npx @nahuelcio/opencode-ado sync")}    Register existing config in OpenCode + TUI`,
  `    ${cyan("node dist/bin/opencode-ado.js sync-local")}  Register local workspace build without publishing`,
  `    ${cyan("npx @nahuelcio/opencode-ado show")}    Show current config`,
  `    ${cyan("npx @nahuelcio/opencode-ado --help")}  Show this help`,
  "",
].join("\n");

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "init") return runInit(process.cwd());
  if (command === "config") return runConfig(process.cwd());
  if (command === "sync" || command === "repair" || command === "install") return runSync();
  if (command === "sync-local") return runSyncLocal();
  if (command === "show") return runShow();
  console.log(`Unknown command: ${command}`);
  console.log(USAGE);
  return 1;
}

const __filename = fileURLToPath(import.meta.url);
const __argv1 = process.argv[1];
try {
  if (__argv1 && realpathSync.native(__filename) === realpathSync.native(__argv1)) {
    void main().then((code) => { process.exitCode = code; });
  }
} catch { /* not executed directly */ }
