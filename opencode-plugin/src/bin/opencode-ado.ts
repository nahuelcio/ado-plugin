#!/usr/bin/env node

/**
 * CLI entry point for @cioffinahuel/opencode-ado
 *
 * Usage:
 *   npx @cioffinahuel/opencode-ado init    — Interactive setup wizard
 *   npx @cioffinahuel/opencode-ado show    — Show current config
 *   npx @cioffinahuel/opencode-ado --help
 */

import { realpathSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";
import { AdoClient } from "../ado-client.js";
import { loadProjectConfig } from "../chain-config.js";
import type { AdoConfig, AdoProfile } from "../shared.js";
import * as cmd from "../cli-commands.js";

const PLUGIN_SPEC = "@cioffinahuel/opencode-ado";

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

/** Legacy location: profiles used to live in the OpenCode config. Read only for migration. */
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

function getAdoConfigPath(): string {
  return join(getAdoCredentialsDir(), "config.json");
}

// ─── Config read/write ────────────────────────────────────────────────────

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
  organization?: string;
  project: string;
  patEnvVar?: string;
  pat?: string;
  repos?: string[];
  default?: boolean;
}

interface LoadedAdoConfig {
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

async function loadAdoConfig(): Promise<LoadedAdoConfig | undefined> {
  const projectConfig = await loadProjectConfig(process.cwd());
  const projectAdo = asRecord(asRecord(projectConfig)?.ado);
  if (projectAdo) {
    const ado = normalizeAdoConfig(projectAdo) as unknown as LoadedAdoConfig;
    if (Object.keys(ado.profiles ?? {}).length > 0) return ado;
  }

  const ado = readCliAdo() ?? migrateLegacyAdo();
  const profiles = asRecord(ado?.["profiles"]);
  if (!ado || !profiles) return undefined;
  return {
    defaultProfile: typeof ado["defaultProfile"] === "string" ? ado["defaultProfile"] : undefined,
    profiles: profiles as Record<string, ProfileConfig>,
  };
}

function readCliAdo(): Record<string, unknown> | undefined {
  const ado = asRecord(readConfig(getAdoConfigPath())["ado"]);
  return asRecord(ado?.["profiles"]) ? ado : undefined;
}

function writeCliAdo(ado: Record<string, unknown>): string {
  const path = getAdoConfigPath();
  const config = readConfig(path);
  config["ado"] = ado;
  writeConfig(path, config);
  return path;
}

/** One-time copy of profiles from the old OpenCode config into the CLI config. */
function migrateLegacyAdo(): Record<string, unknown> | undefined {
  const configDir = getOpenCodeConfigDir();
  const candidates: Array<Record<string, unknown> | undefined> = [];
  const adoJsonPath = join(configDir, "ado.json");
  if (existsSync(adoJsonPath)) candidates.push(readConfig(adoJsonPath));
  for (const name of ["opencode.jsonc", "opencode.json", "tui.json"]) {
    const path = join(configDir, name);
    if (!existsSync(path)) continue;
    const config = readConfig(path);
    const plugins = Array.isArray(config["plugin"]) ? config["plugin"] as unknown[] : [];
    candidates.push(asRecord(config["ado"]), getPluginAdoConfig(plugins));
  }
  const ado = candidates.find((c) => asRecord(c?.["profiles"]) && Object.keys(c!["profiles"] as object).length > 0);
  if (!ado) return undefined;
  const path = writeCliAdo(ado);
  console.error(`Migrated ADO profiles to ${path}`);
  return ado;
}

function profileOrg(profile: ProfileConfig): string {
  return profile.org ?? profile.organization ?? "";
}

function parseWorkItemId(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const idText = input.match(/(?:^|[/?=&])(?:workItems?|workitems|id=)?(\d+)(?:$|[/?&#])/i)?.[1] ?? input;
  const id = Number(idText);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

// ─── Shared config + arg parsing for ADO operation commands ─────────────────

/** Convert the CLI's loosely-typed loaded config into the shared AdoConfig. */
function toSharedConfig(loaded: LoadedAdoConfig): AdoConfig {
  const profiles: Record<string, AdoProfile> = {};
  for (const [name, p] of Object.entries(loaded.profiles)) {
    profiles[name] = {
      org: profileOrg(p),
      project: p.project,
      patEnvVar: p.patEnvVar ?? "AZURE_DEVOPS_PAT",
      ...(p.pat ? { pat: p.pat } : {}),
      repos: p.repos ?? [],
      ...(p.default ? { default: true } : {}),
    };
  }
  return { defaultProfile: loaded.defaultProfile, profiles };
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal flag parser: positionals + `--key value` / `--flag` booleans. */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagStr(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function flagNum(flags: ParsedArgs["flags"], key: string): number | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function flagBool(flags: ParsedArgs["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function flagNumList(flags: ParsedArgs["flags"], key: string): number[] | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  return v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
}

/**
 * Collect repeatable `--field <Name>=<value>` flags into ADO field paths.
 * `Name` may be bare (`Custom.Sponsors`) or a full path (`/fields/Custom.Sponsors`).
 * Read straight from argv because parseArgs keeps only the last value of a flag.
 */
export function parseFieldFlags(argv: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--field") continue;
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith("--")) continue;
    i++;
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --field '${raw}'. Expected <FieldName>=<value>.`);
    const name = raw.slice(0, eq).trim();
    out[name.startsWith("/fields/") ? name : `/fields/${name}`] = raw.slice(eq + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function flagStrList(flags: ParsedArgs["flags"], key: string): string[] | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Resolve repo (non-numeric) and prId (numeric) from positionals, in any order. */
function parsePrTarget(positional: string[]): { repo?: string; prId?: number } {
  let repo: string | undefined;
  let prId: number | undefined;
  for (const p of positional) {
    if (/^\d+$/.test(p)) prId = Number(p);
    else repo = p;
  }
  return { repo, prId };
}

async function loadSharedConfig(): Promise<AdoConfig | undefined> {
  const loaded = await loadAdoConfig();
  if (!loaded || Object.keys(loaded.profiles ?? {}).length === 0) return undefined;
  return toSharedConfig(loaded);
}

/** Load config, run a command that returns text, print it. Maps errors to exit code 1. */
async function runCmd(fn: (config: AdoConfig) => Promise<string> | string): Promise<number> {
  const config = await loadSharedConfig();
  if (!config) {
    console.log(yellow("No ADO profile configured. Run: ado init"));
    return 1;
  }
  try {
    console.log(await fn(config));
    return 0;
  } catch (err) {
    console.log(yellow(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

// ─── Command spec: usage + accepted flags ────────────────────────────────────

const WI_CREATE_FLAGS = ["type", "title", "description", "area", "iteration", "priority", "assigned", "state", "tags", "field", "parent"];

/**
 * Every subcommand with its usage line and the flags it actually reads.
 * `--profile` and `--help` are accepted everywhere. Anything else is an error:
 * silently ignoring an invented flag made agents believe it had worked.
 */
const CLI: Record<string, Record<string, { usage: string; flags: string[] }>> = {
  profile: {
    get: { usage: "ado profile [get] [<name>]", flags: [] },
    list: { usage: "ado profile list", flags: [] },
    use: { usage: "ado profile use <name>", flags: [] },
  },
  pipeline: {
    list: { usage: "ado pipeline [list]", flags: [] },
    runs: { usage: "ado pipeline runs <pipelineId> [--limit <n>]", flags: ["id", "limit"] },
    run: { usage: "ado pipeline run <pipelineId> [--branch <b>]", flags: ["id", "branch"] },
  },
  pr: {
    list: { usage: "ado pr list", flags: [] },
    get: { usage: "ado pr get [repo] <prId>", flags: [] },
    threads: { usage: "ado pr threads [repo] <prId>  (full comments, thread ids for pr reply)", flags: [] },
    diff: { usage: "ado pr diff [repo] <prId> [--hunks]", flags: ["hunks"] },
    context: { usage: "ado pr context [repo] <prId>", flags: [] },
    comment: {
      usage: "ado pr comment [repo] <prId> --comment <text> | --comment-file <path> [--file <repo path to anchor on>] [--line <n>]",
      flags: ["comment", "comment-file", "file", "line"],
    },
    reply: {
      usage: "ado pr reply [repo] <prId> <threadId> [--comment <text> | --comment-file <path>] [--status active|fixed|wontFix|closed|byDesign|pending]",
      flags: ["comment", "comment-file", "status", "thread"],
    },
    vote: { usage: "ado pr vote [repo] <prId> <approve|reject|wait|suggestions> [--comment <text>]", flags: ["comment"] },
    select: { usage: "ado pr select [repo] <prId>", flags: [] },
    file: { usage: "ado pr file [repo] <prId> --path <file> [--start <n>] [--end <n>]", flags: ["path", "start", "end"] },
    create: {
      usage: "ado pr create --repo <r> --source <branch> --target <branch> --title <t> [--description <d>] [--wi 1,2] [--draft]",
      flags: ["repo", "source", "target", "title", "description", "wi", "draft"],
    },
    complete: {
      usage: "ado pr complete [repo] <prId> [--strategy squash|rebase|noFastForward|rebaseMerge] [--delete-source] [--bypass]",
      flags: ["strategy", "delete-source", "bypass"],
    },
    abandon: { usage: "ado pr abandon [repo] <prId>", flags: [] },
    publish: { usage: "ado pr publish [repo] <prId>", flags: [] },
    reviewers: { usage: "ado pr reviewers [repo] <prId> --add <user1,user2> [--required]", flags: ["add", "required"] },
    chain: {
      usage: "ado pr chain --repo <r> --wi 1,2,3 [--base <branch>] [--strategy feature-chain|stacked] [--prefix <p>] [--branches a,b,c]",
      flags: ["repo", "wi", "base", "strategy", "prefix", "branches"],
    },
  },
  wi: {
    list: { usage: "ado wi list [--state <s>] [--assigned <user|me>] [--tag <t>] [--type <type>]", flags: ["state", "assigned", "tag", "type"] },
    get: { usage: "ado wi get <id>", flags: [] },
    types: { usage: "ado wi types", flags: [] },
    fields: { usage: "ado wi fields --type <type>", flags: ["type"] },
    query: { usage: "ado wi query \"SELECT [System.Id] FROM WorkItems WHERE ...\"", flags: ["wiql"] },
    update: {
      usage: "ado wi update <id> [--title <t>] [--description <d>] [--state <s>] [--priority <n>] [--assigned <user>] [--area <p>] [--iteration <p>] [--tags <a;b>] [--field <Name>=<value>] [--comment <text> | --comment-file <path>] [--format markdown|html]",
      flags: ["title", "description", "state", "priority", "assigned", "area", "iteration", "tags", "field", "comment", "comment-file", "format"],
    },
    link: {
      usage: "ado wi link <id> --parent|--child|--related|--duplicate|--successor|--predecessor <targetId> [--comment <text>]",
      flags: ["parent", "child", "related", "duplicate", "successor", "predecessor", "comment"],
    },
    attach: { usage: "ado wi attach <id> --file <path> [--comment <text>]", flags: ["file", "comment"] },
    attachments: { usage: "ado wi attachments <id> [--dest <folder>]", flags: ["dest"] },
    comment: {
      usage: "ado wi comment <id> --comment <text> | --comment-file <path> [--format markdown|html]  (markdown by default)",
      flags: ["comment", "comment-file", "format"],
    },
    related: { usage: "ado wi related <id> [--state <s>] [--type <t>]", flags: ["state", "type"] },
    create: {
      usage: "ado wi create --title <t> [--type <type>] [--description <d>] [--area <p>] [--iteration <p>] [--priority <n>] [--assigned <user>] [--state <s>] [--tags <a;b>] [--parent <id>] [--field <Name>=<value>]",
      flags: WI_CREATE_FLAGS,
    },
    "create-child": {
      usage: "ado wi create-child --parent <id> --title <t> [--type <type>] [--description <d>] [--area <p>] [--iteration <p>] [--priority <n>] [--assigned <user>] [--state <s>] [--tags <a;b>] [--field <Name>=<value>]",
      flags: WI_CREATE_FLAGS,
    },
  },
};

function usage(group: string, sub: string): string {
  return yellow(`Usage: ${CLI[group][sub].usage}`);
}

function groupUsage(group: string): string {
  return Object.values(CLI[group]).map((c) => `  ${c.usage}`).join("\n");
}

/** Levenshtein distance, for "did you mean" on unknown flags. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function suggestFlag(flag: string, allowed: string[]): string | undefined {
  const f = flag.split("=")[0].toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const name of allowed) {
    const n = name.toLowerCase();
    const d = f.startsWith(n) || n.startsWith(f) ? 0 : editDistance(f, n);
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= Math.max(2, Math.floor(f.length / 3)) ? best.name : undefined;
}

/**
 * Handle `--help`, unknown subcommands and unknown flags before any ADO call.
 * Returns an exit code when the command must stop here, undefined to proceed.
 */
function preflight(group: string, argv: string[], defaultSub?: string): number | undefined {
  const cmds = CLI[group];
  const sub = argv[0];
  const known = sub !== undefined && Object.hasOwn(cmds, sub);
  // `ado profile work` / `ado pipeline --profile x` run the group's default subcommand.
  const key = known ? sub : defaultSub && (sub === undefined || group === "profile" || sub.startsWith("-")) ? defaultSub : undefined;
  const rest = known ? argv.slice(1) : argv;

  if (argv.includes("--help") || argv.includes("-h") || sub === "help") {
    console.log(known ? `Usage: ${cmds[sub].usage}` : `Usage:\n${groupUsage(group)}`);
    return 0;
  }
  if (!key) {
    console.log(yellow(`Unknown ${group} command: ${sub ?? "(none)"}`));
    console.log(`Usage:\n${groupUsage(group)}`);
    return 1;
  }
  const allowed = [...cmds[key].flags, "profile"];
  for (const flag of Object.keys(parseArgs(rest).flags)) {
    if (allowed.includes(flag)) continue;
    const hint = suggestFlag(flag, allowed);
    console.log(yellow(`Unknown flag --${flag} for 'ado ${group} ${key}'.${hint ? ` Did you mean --${hint}?` : ""}`));
    console.log(usage(group, key));
    return 1;
  }
  return undefined;
}

/** Comment body from `--comment` or `--comment-file` (UTF-8, trailing whitespace trimmed). */
function commentText(flags: ParsedArgs["flags"]): string | undefined {
  const file = flagStr(flags, "comment-file");
  const inline = flagStr(flags, "comment");
  if (file !== undefined && inline !== undefined) throw new Error("Use --comment or --comment-file, not both.");
  return file !== undefined ? readFileSync(file, "utf-8").trimEnd() : inline;
}

function commentFormat(flags: ParsedArgs["flags"]): "markdown" | "html" | undefined {
  const format = flagStr(flags, "format")?.toLowerCase();
  if (format === undefined || format === "markdown" || format === "html") return format;
  throw new Error(`Invalid --format '${format}'. Use markdown|html.`);
}

// ─── Group dispatchers ──────────────────────────────────────────────────────

async function runProfileGroup(argv: string[]): Promise<number> {
  const stop = preflight("profile", argv, "get");
  if (stop !== undefined) return stop;
  const sub = argv[0];
  if (sub === "list") return runCmd((c) => cmd.profileList(c));
  if (sub === "use") {
    const name = argv[1];
    if (!name) { console.log(usage("profile", "use")); return 1; }
    return runCmd((c) => cmd.profileUse(c, { name }));
  }
  // Default / `get`: show active profile. Optional name, positional or `--profile`.
  const { positional, flags } = parseArgs(sub === "get" ? argv.slice(1) : argv);
  return runCmd((c) => cmd.profileGet(c, { profile: flagStr(flags, "profile") ?? positional[0] }));
}

async function runPipelineGroup(argv: string[]): Promise<number> {
  const stop = preflight("pipeline", argv, "list");
  if (stop !== undefined) return stop;
  const sub = argv[0]?.startsWith("-") ? undefined : argv[0];
  const { positional, flags } = parseArgs(sub === undefined ? argv : argv.slice(1));
  const profile = flagStr(flags, "profile");

  switch (sub) {
    case undefined:
    case "list":
      return runCmd((c) => cmd.pipelineList(c, { profile }));
    case "runs": {
      const pipelineId = flagNum(flags, "id") ?? Number(positional[0]);
      if (!Number.isFinite(pipelineId)) { console.log(usage("pipeline", "runs")); return 1; }
      return runCmd((c) => cmd.pipelineRuns(c, { pipelineId, limit: flagNum(flags, "limit"), profile }));
    }
    case "run": {
      const pipelineId = flagNum(flags, "id") ?? Number(positional[0]);
      if (!Number.isFinite(pipelineId)) { console.log(usage("pipeline", "run")); return 1; }
      return runCmd((c) => cmd.pipelineRun(c, { pipelineId, branch: flagStr(flags, "branch"), profile }));
    }
    default:
      console.log(yellow(`Unknown pipeline command: ${sub}`));
      return 1;
  }
}

async function runPrGroup(argv: string[]): Promise<number> {
  const stop = preflight("pr", argv);
  if (stop !== undefined) return stop;
  const sub = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  const profile = flagStr(flags, "profile");
  const target = parsePrTarget(positional);

  switch (sub) {
    case "list":
      return runCmd((c) => cmd.prList(c, { profile }));
    case "get":
      return runCmd((c) => cmd.prGet(c, { ...target, profile }));
    case "threads":
      return runCmd((c) => cmd.prThreads(c, { ...target, profile }));
    case "diff":
      return runCmd((c) => cmd.prDiff(c, { ...target, hunks: flagBool(flags, "hunks"), profile }));
    case "context":
      return runCmd((c) => cmd.prContext(c, { ...target, profile }));
    case "comment": {
      const comment = commentText(flags);
      if (!comment) { console.log(usage("pr", "comment")); return 1; }
      return runCmd((c) => cmd.prComment(c, { ...target, comment, filePath: flagStr(flags, "file"), line: flagNum(flags, "line"), profile }));
    }
    case "reply": {
      const ids = positional.filter((p) => /^\d+$/.test(p)).map(Number);
      const threadId = flagNum(flags, "thread") ?? ids[1];
      if (threadId === undefined) { console.log(usage("pr", "reply")); return 1; }
      const comment = commentText(flags);
      return runCmd((c) => cmd.prReply(c, {
        repo: positional.find((p) => !/^\d+$/.test(p)),
        prId: ids[0],
        threadId,
        comment,
        status: flagStr(flags, "status"),
        profile,
      }));
    }
    case "vote": {
      const vote = positional.find((p) => ["approve", "reject", "wait", "suggestions"].includes(p));
      const t = parsePrTarget(positional.filter((p) => p !== vote));
      if (!vote) { console.log(usage("pr", "vote")); return 1; }
      return runCmd((c) => cmd.prVote(c, { ...t, vote, comment: flagStr(flags, "comment"), profile }));
    }
    case "select": {
      if (target.prId === undefined) { console.log(usage("pr", "select")); return 1; }
      return runCmd((c) => cmd.prSelect(c, { repo: target.repo, prId: target.prId!, profile }));
    }
    case "file": {
      const path = flagStr(flags, "path") ?? positional.find((p) => !/^\d+$/.test(p) && p.includes("/"));
      const t = parsePrTarget(positional.filter((p) => p !== path));
      if (!path) { console.log(usage("pr", "file")); return 1; }
      return runCmd((c) => cmd.prFile(c, { path, repo: t.repo, prId: t.prId, startLine: flagNum(flags, "start"), endLine: flagNum(flags, "end"), profile }));
    }
    case "create": {
      const repo = flagStr(flags, "repo");
      const sourceBranch = flagStr(flags, "source");
      const targetBranch = flagStr(flags, "target");
      const title = flagStr(flags, "title");
      if (!repo || !sourceBranch || !targetBranch || !title) {
        console.log(usage("pr", "create"));
        return 1;
      }
      return runCmd((c) => cmd.prCreate(c, {
        repo, sourceBranch, targetBranch, title,
        description: flagStr(flags, "description"),
        workItemIds: flagNumList(flags, "wi"),
        isDraft: flagBool(flags, "draft"),
        profile,
      }));
    }
    case "complete": {
      return runCmd((c) => cmd.prComplete(c, {
        ...target,
        mergeStrategy: flagStr(flags, "strategy"),
        deleteSourceBranch: flagBool(flags, "delete-source"),
        bypassPolicy: flagBool(flags, "bypass"),
        profile,
      }));
    }
    case "abandon":
      return runCmd((c) => cmd.prAbandon(c, { ...target, profile }));
    case "publish":
      return runCmd((c) => cmd.prPublish(c, { ...target, profile }));
    case "reviewers": {
      const add = flagStrList(flags, "add");
      if (!add?.length) { console.log(usage("pr", "reviewers")); return 1; }
      return runCmd((c) => cmd.prReviewers(c, { ...target, add, required: flagBool(flags, "required"), profile }));
    }
    case "chain": {
      const repo = flagStr(flags, "repo");
      const workItemIds = flagNumList(flags, "wi");
      if (!repo || !workItemIds?.length) {
        console.log(usage("pr", "chain"));
        return 1;
      }
      const strategy = flagStr(flags, "strategy");
      return runCmd((c) => cmd.prChain(c, {
        repo, workItemIds,
        baseBranch: flagStr(flags, "base"),
        strategy: strategy === "stacked" || strategy === "feature-chain" ? strategy : undefined,
        prefix: flagStr(flags, "prefix"),
        branchNames: flagStrList(flags, "branches"),
        profile,
      }));
    }
    default:
      console.log(yellow(`Unknown pr command: ${sub ?? "(none)"}`));
      return 1;
  }
}

async function runWiGroup(argv: string[]): Promise<number> {
  const stop = preflight("wi", argv);
  if (stop !== undefined) return stop;
  const sub = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  const profile = flagStr(flags, "profile");

  const wiCreateArgs = () => ({
    type: flagStr(flags, "type"),
    title: flagStr(flags, "title") ?? "",
    description: flagStr(flags, "description"),
    areaPath: flagStr(flags, "area"),
    iterationPath: flagStr(flags, "iteration"),
    priority: flagNum(flags, "priority"),
    assignedTo: flagStr(flags, "assigned"),
    state: flagStr(flags, "state"),
    tags: flagStr(flags, "tags"),
    customFields: parseFieldFlags(argv),
    profile,
  });

  switch (sub) {
    case "list":
      return runCmd((c) => cmd.wiList(c, {
        state: flagStr(flags, "state"),
        assignedTo: flagStr(flags, "assigned"),
        tag: flagStr(flags, "tag"),
        workItemType: flagStr(flags, "type"),
        profile,
      }));
    case "get": {
      const id = parseWorkItemId(positional[0]);
      if (!id) { console.log(usage("wi", "get")); return 1; }
      return runCmd((c) => cmd.wiGet(c, { id, profile }));
    }
    case "types":
      return runCmd((c) => cmd.wiTypes(c, { profile }));
    case "fields": {
      const type = flagStr(flags, "type") ?? positional[0];
      if (!type) { console.log(usage("wi", "fields")); return 1; }
      return runCmd((c) => cmd.wiFields(c, { type, profile }));
    }
    case "update": {
      const id = parseWorkItemId(positional[0]);
      if (!id) { console.log(usage("wi", "update")); return 1; }
      return runCmd((c) => cmd.wiUpdate(c, {
        id,
        title: flagStr(flags, "title"),
        description: flagStr(flags, "description"),
        state: flagStr(flags, "state"),
        priority: flagNum(flags, "priority"),
        assignedTo: flagStr(flags, "assigned"),
        areaPath: flagStr(flags, "area"),
        iterationPath: flagStr(flags, "iteration"),
        tags: flagStr(flags, "tags"),
        customFields: parseFieldFlags(argv),
        comment: commentText(flags),
        format: commentFormat(flags),
        profile,
      }));
    }
    case "link": {
      const id = parseWorkItemId(positional[0]);
      const linkType = ["parent", "child", "related", "duplicate", "successor", "predecessor"].find((t) => flagBool(flags, t) || flagStr(flags, t) !== undefined);
      const targetId = linkType ? parseWorkItemId(flagStr(flags, linkType) ?? positional[1]) : undefined;
      if (!id || !linkType || !targetId) {
        console.log(usage("wi", "link"));
        return 1;
      }
      return runCmd((c) => cmd.wiLink(c, { id, targetId, linkType, comment: flagStr(flags, "comment"), profile }));
    }
    case "attach": {
      const id = parseWorkItemId(positional[0]);
      const filePath = flagStr(flags, "file") ?? positional[1];
      if (!id || !filePath) { console.log(usage("wi", "attach")); return 1; }
      return runCmd((c) => cmd.wiAttach(c, { id, filePath, comment: flagStr(flags, "comment"), profile }));
    }
    case "attachments": {
      const id = parseWorkItemId(positional[0]);
      if (!id) { console.log(usage("wi", "attachments")); return 1; }
      return runCmd((c) => cmd.wiAttachments(c, { id, dest: flagStr(flags, "dest"), profile }));
    }
    case "query": {
      const wiql = flagStr(flags, "wiql") ?? positional[0];
      if (!wiql) { console.log(usage("wi", "query")); return 1; }
      return runCmd((c) => cmd.wiQuery(c, { wiql, profile }));
    }
    case "comment": {
      const id = parseWorkItemId(positional[0]);
      const comment = commentText(flags);
      const format = commentFormat(flags);
      if (!id || !comment) { console.log(usage("wi", "comment")); return 1; }
      return runCmd((c) => cmd.wiComment(c, { id, comment, format, profile }));
    }
    case "related": {
      const id = parseWorkItemId(positional[0]);
      if (!id) { console.log(usage("wi", "related")); return 1; }
      return runCmd((c) => cmd.wiRelated(c, { id, state: flagStr(flags, "state"), workItemType: flagStr(flags, "type"), profile }));
    }
    case "create": {
      if (!flagStr(flags, "title")) { console.log(usage("wi", "create")); return 1; }
      return runCmd((c) => cmd.wiCreate(c, { ...wiCreateArgs(), parentId: flagNum(flags, "parent") }));
    }
    case "create-child": {
      const parentId = flagNum(flags, "parent");
      if (!parentId || !flagStr(flags, "title")) { console.log(usage("wi", "create-child")); return 1; }
      return runCmd((c) => cmd.wiCreateChild(c, { ...wiCreateArgs(), parentId }));
    }
    default:
      console.log(yellow(`Unknown wi command: ${sub ?? "(none)"}`));
      return 1;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getPluginAdoConfig(plugins: unknown[]): Record<string, unknown> | undefined {
  const entry = plugins.find((e) => Array.isArray(e) && typeof e[0] === "string"
    && (e[0] === PLUGIN_SPEC || e[0].startsWith(`${PLUGIN_SPEC}@`) || e[0].startsWith("file:")));
  if (!Array.isArray(entry)) return undefined;
  const options = asRecord(entry[1]);
  if (!options) return undefined;
  const nested = asRecord(options["ado"]);
  return nested ?? options;
}

function normalizeAdoConfig(ado: Record<string, unknown>): Record<string, unknown> {
  if (!ado["profiles"] || typeof ado["profiles"] !== "object") {
    throw new Error("No ADO profiles found. Run `npx @cioffinahuel/opencode-ado init` first.");
  }
  return ado;
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
  const wiCreateEnabled = await yesNo("Allow work item creation from the CLI?");
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
  console.log(bold("  Azure DevOps CLI"));
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
    console.log("  Your PAT is stored securely in ~/.azure-devops-cli/pat (never in the config file)");
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
    console.log(`    repos:   ${(p.repos ?? []).join(", ")}`);
  }
  console.log();

  const ok = await yesNo("Apply this configuration?");
  if (!ok) { console.log(yellow("  Cancelled")); return 0; }

  // ── Step 5: Write config ──────────────────────────────────────────
  const ado = readCliAdo() ?? migrateLegacyAdo() ?? {};
  if (!ado["profiles"] || typeof ado["profiles"] !== "object") ado["profiles"] = {};
  const existingProfiles = ado["profiles"] as Record<string, ProfileConfig>;
  for (const [name, p] of Object.entries(profiles)) {
    existingProfiles[name] = p;
  }
  if (defaultProfileName) ado["defaultProfile"] = defaultProfileName;
  const configPath = writeCliAdo(ado);
  console.log();
  console.log(`  ${green("✓")} Wrote ${configPath}`);

  // ── Step 6: Next steps ────────────────────────────────────────────
  console.log();
  console.log(bold("  Done!"));
  console.log();
  console.log(`  Try: ${cyan("ado pr list")}, ${cyan("ado wi list")}, ${cyan("ado profile list")}`);
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
  const configPath = getAdoConfigPath();
  const ado = readCliAdo() ?? migrateLegacyAdo();
  if (!ado) {
    console.log(yellow("  No ADO profiles configured in " + configPath));
    console.log("    Run: npx @cioffinahuel/opencode-ado init");
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
    console.log(`    repos:   ${(p.repos ?? []).join(", ")}`);
    console.log();
  }

  // Check PAT
  const pat = process.env.AZURE_DEVOPS_PAT ?? loadStoredPAT();
  if (pat) {
    console.log(green("  ✓ PAT available"));
  } else {
    console.log(yellow("  ⚠ No PAT found"));
    console.log("    Run: npx @cioffinahuel/opencode-ado init");
  }
  console.log();

  return 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────

const USAGE = [
  "",
  bold("  @cioffinahuel/opencode-ado"),
  "  Azure DevOps CLI",
  "",
  "  Usage:",
  `    ${cyan("npx @cioffinahuel/opencode-ado init")}    Interactive setup wizard`,
  `    ${cyan("npx @cioffinahuel/opencode-ado config")}  Generate .adoconfig.toml for this project`,
  `    ${cyan("npx @cioffinahuel/opencode-ado show")}    Show current config`,
  `    ${cyan("ado profile [list|use <name>]")}          Show/list/switch ADO profile`,
  `    ${cyan("ado pr <list|get|threads|diff|context|comment|reply|vote|select|file|create|complete|abandon|publish|reviewers|chain>")}`,
  `    ${cyan("ado pipeline <list|runs|run>")}`,
  `    ${cyan("ado wi <list|get|types|fields|query|update|link|attach|attachments|comment|related|create|create-child>")}`,
  `    ${cyan("ado <group> [<command>] --help")}        Usage and flags of a group or command`,
  `    ${cyan("npx @cioffinahuel/opencode-ado --help")}  Show this help`,
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
  if (command === "show") return runShow();
  const groups: Record<string, (argv: string[]) => Promise<number>> = {
    profile: runProfileGroup, pr: runPrGroup, wi: runWiGroup, pipeline: runPipelineGroup,
  };
  if (groups[command]) {
    try {
      return await groups[command](argv.slice(1));
    } catch (err) {
      // Argument errors (unreadable --comment-file, bad --field/--format) end here.
      console.log(yellow(err instanceof Error ? err.message : String(err)));
      return 1;
    }
  }
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
