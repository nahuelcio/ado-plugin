/**
 * Persistent stores for the ADO CLI.
 *
 * Two stores at ~/.azure-devops-cli/:
 *   - active-profile  — currently active profile name
 *   - selected-pr     — currently selected PR (format: repo:prId)
 *
 * All operations are synchronous and defensive — they never throw.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE_DIR = join(homedir(), ".azure-devops-cli");
const PROFILE_FILE = join(STORE_DIR, "active-profile");
const SELECTED_PR_FILE = join(STORE_DIR, "selected-pr");

// ─── Active Profile ────────────────────────────────────────────────────────

/** Return the file path used for the active profile store. */
export function getActiveProfilePath(): string {
  return PROFILE_FILE;
}

/**
 * Read the active profile name from disk.
 * Returns null if the file is missing, empty, or unreadable (never throws).
 */
export function getActiveProfile(): string | null {
  try {
    if (!existsSync(PROFILE_FILE)) return null;
    const content = readFileSync(PROFILE_FILE, "utf-8").trim();
    return content || null;
  } catch { /* defensive: non-critical operation */ }
  return null;
}

/**
 * Persist the active profile name to disk.
 * Creates the store directory if it doesn't exist.
 */
export function setActiveProfile(name: string): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(PROFILE_FILE, name, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`Permission denied when accessing Azure DevOps profile storage. Please check permissions for ${STORE_DIR}`);
    }
    throw err;
  }
}

/** Delete the active profile file from disk. Silently ignores errors. */
export function clearActiveProfile(): void {
  try {
    if (existsSync(PROFILE_FILE)) unlinkSync(PROFILE_FILE);
  } catch { /* defensive: non-critical operation */ }
}

// ─── Selected PR ───────────────────────────────────────────────────────────

/**
 * Read the selected PR from disk.
 * Returns null if the file is missing, empty, or unreadable (never throws).
 */
export function getSelectedPr(): { repo: string; prId: number } | null {
  try {
    if (!existsSync(SELECTED_PR_FILE)) return null;
    const content = readFileSync(SELECTED_PR_FILE, "utf-8").trim();
    if (!content) return null;
    // Split on last ":" only, in case repo name contains ":"
    const lastColonIdx = content.lastIndexOf(":");
    if (lastColonIdx === -1) return null;
    const repo = content.slice(0, lastColonIdx);
    const idStr = content.slice(lastColonIdx + 1);
    const prId = parseInt(idStr, 10);
    if (!repo || isNaN(prId) || prId <= 0 || prId > 999999999) return null;
    return { repo, prId };
  } catch { /* defensive: non-critical operation */ }
  return null;
}

/**
 * Persist the selected PR to disk.
 * Creates the store directory if it doesn't exist.
 */
export function setSelectedPr(repo: string, prId: number): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(SELECTED_PR_FILE, `${repo}:${prId}`, "utf-8");
  } catch { /* defensive: non-critical operation */ }
}

/** Clear the selected PR file. Silently ignores errors. */
export function clearSelectedPr(): void {
  try {
    if (existsSync(SELECTED_PR_FILE)) writeFileSync(SELECTED_PR_FILE, "", "utf-8");
  } catch { /* defensive: non-critical operation */ }
}
