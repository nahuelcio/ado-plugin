/**
 * Configuration loader for the chained PRs feature.
 *
 * Reads and validates .adoconfig.toml from the project root.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { ProjectConfigSchema, type ProjectConfig } from "./chain-types.js";

/**
 * Load and parse .adoconfig.toml from the project root.
 * Returns default config if file doesn't exist.
 */
export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = join(projectRoot, ".adoconfig.toml");

  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = parse(content);
    return ProjectConfigSchema.parse(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return ProjectConfigSchema.parse({});
    }
    throw new Error(`Failed to parse .adoconfig.toml: ${(err as Error).message}`);
  }
}
