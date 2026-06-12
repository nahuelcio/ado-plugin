/**
 * ADO HTTP Client and business logic helpers.
 *
 * Framework-agnostic — used by both the OpenCode plugin (index.ts)
 * and the Pi extension (pi-entry.ts).
 *
 * Extracted from index.ts to avoid duplicating ~500 lines of ADO logic.
 */

import type { AdoConfig, AdoProfile } from "./shared.js";
import {
  asAdoConfig,
  resolveActiveProfile,
  resolveOrgUrl,
  getPAT,
  shortBranch,
  reviewerMatchesUser,
  fmtPR,
  fmtPRDetail,
  fmtThread,
  fmtWorkItem,
  fmtWorkItemDetail,
  abbrevType,
} from "./shared.js";
import {
  getActiveProfile,
  setSelectedPr,
  getSelectedPr,
} from "./profile-store.js";
import type { CreatePrOptions, GitRefUpdateResult, GitPullRequest } from "./chain-types.js";

// ─── Constants ────────────────────────────────────────────────────────────

export const API_VERSION = "7.1";
export const WIT_COMMENTS_API_VERSION = "7.1-preview.4";

// ─── ADO HTTP Client ──────────────────────────────────────────────────────

export class AdoClient {
  private authHeader: string;
  private workItemTypesCache: any[] | null = null;

  constructor(
    private orgUrl: string,
    private project: string,
    pat: string,
  ) {
    this.authHeader = "Basic " + Buffer.from(":" + pat).toString("base64");
  }

  private buildUrl(
    endpoint: string,
    scope: "org" | "project" = "project",
    apiVersion: string = API_VERSION,
  ): string {
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      const url = new URL(endpoint);
      url.searchParams.set("api-version", apiVersion);
      return url.toString();
    }

    const root = scope === "org"
      ? this.orgUrl
      : `${this.orgUrl}/${encodeURIComponent(this.project)}`;
    const apiPath = endpoint.startsWith("/_apis/")
      ? endpoint
      : `/_apis${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const url = new URL(root + apiPath);
    url.searchParams.set("api-version", apiVersion);
    return url.toString();
  }

  private async request<T>(
    endpoint: string,
    init?: RequestInit,
    scope: "org" | "project" = "project",
    apiVersion?: string,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, scope, apiVersion);
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
      throw new Error(`ADO ${res.status}: ${truncated}`);
    }
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.startsWith("application/json")) {
      throw new Error(`Invalid Content-Type: ${contentType}. Expected application/json.`);
    }
    return res.json() as Promise<T>;
  }

  private async requestRaw(
    endpoint: string,
    scope: "org" | "project" = "project",
  ): Promise<string> {
    const url = this.buildUrl(endpoint, scope);
    const res = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: "text/plain",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
      throw new Error(`ADO ${res.status}: ${truncated}`);
    }
    return res.text();
  }

  async getUserIdentity(): Promise<{ id: string; displayName: string }> {
    const data = await this.request<{ authenticatedUser: { id: string; displayName: string } }>(
      "/connectionData",
      undefined,
      "org",
      "7.1-preview.1",
    );
    return data.authenticatedUser;
  }

  async listPullRequests(repo: string, options?: { status?: string; reviewerId?: string; creatorId?: string }) {
    const params = new URLSearchParams({ "searchCriteria.status": options?.status ?? "active" });
    if (options?.reviewerId) params.set("searchCriteria.reviewerId", options.reviewerId);
    if (options?.creatorId) params.set("searchCriteria.creatorId", options.creatorId);
    const data = await this.request<{ value: any[] }>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests?${params.toString()}`,
    );
    return data.value;
  }

  async getPullRequest(repo: string, prId: number) {
    return this.request<any>(`/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}`);
  }

  async getThreads(repo: string, prId: number) {
    const data = await this.request<{ value: any[] }>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads`,
    );
    return data.value;
  }

  async voteReviewer(repo: string, prId: number, userId: string, vote: number) {
    await this.request(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/reviewers/${encodeURIComponent(userId)}`,
      { method: "PUT", body: JSON.stringify({ vote }) },
    );
  }

  async createThread(repo: string, prId: number, comment: string, context?: { filePath?: string; line?: number }) {
    const threadContext = context?.filePath
      ? {
          filePath: context.filePath,
          ...(context.line
            ? {
                rightFileStart: { line: context.line, offset: 1 },
                rightFileEnd: { line: context.line, offset: 1 },
              }
            : {}),
        }
      : undefined;
    return this.request<any>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads`,
      {
        method: "POST",
        body: JSON.stringify({
          comments: [{ content: comment, commentType: "text" }],
          status: "active",
          ...(threadContext ? { threadContext } : {}),
        }),
      },
    );
  }

  // ─── Diff & iteration methods ────────────────────────────────────

  async getIterations(repo: string, prId: number) {
    const data = await this.request<{ value: any[] }>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/iterations`,
    );
    return data.value;
  }

  async getIterationChanges(repo: string, prId: number, iterationId: number) {
    const data = await this.request<{ changeEntries: any[] }>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/iterations/${iterationId}/changes`,
    );
    return data.changeEntries ?? [];
  }

  async getCommits(repo: string, prId: number) {
    const data = await this.request<{ value: any[] }>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/commits`,
    );
    return data.value ?? [];
  }

  async getFileContent(repo: string, path: string, branch: string): Promise<string> {
    const url = `/_apis/git/repositories/${encodeURIComponent(repo)}/items`
      + `?path=${encodeURIComponent(path)}`
      + `&versionDescriptor.version=${encodeURIComponent(branch)}`
      + `&versionDescriptor.versionType=branch`
      + `&$format=text`;
    const res = await this.requestRaw(url);
    return res;
  }

  async getPrSourceBranch(repo: string, prId: number): Promise<string> {
    const pr = await this.getPullRequest(repo, prId);
    return (pr.sourceRefName ?? "").replace("refs/heads/", "");
  }

  // ─── Work Item Tracking (WIT) methods ────────────────

  async updateWorkItem(id: number, patchOps: Array<{ op: string; path: string; value: any }>): Promise<any> {
    const url = this.buildUrl(`/_apis/wit/workitems/${id}`, "org");
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(patchOps),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
      throw new Error(`ADO ${res.status}: ${truncated}`);
    }
    return res.json();
  }

  async getWorkItemComments(id: number): Promise<any> {
    const data = await this.request<{ value: any[] }>(
      `/_apis/wit/workItems/${id}/comments`,
      undefined,
      "project",
      WIT_COMMENTS_API_VERSION,
    );
    return data;
  }

  async addWorkItemComment(id: number, text: string): Promise<any> {
    return this.request<any>(
      `/_apis/wit/workItems/${id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
      "project",
      WIT_COMMENTS_API_VERSION,
    );
  }

  async getWorkItemTypes(): Promise<any[]> {
    if (this.workItemTypesCache) return this.workItemTypesCache;
    const data = await this.request<{ value: any[] }>(
      "/wit/workitemtypes",
      undefined,
      "project",
    );
    this.workItemTypesCache = data.value ?? [];
    return this.workItemTypesCache;
  }

  async queryWiql(wiql: string): Promise<{ workItems?: Array<{ id: number }>; workItemRelations?: Array<{ source?: { id: number }; target?: { id: number } }> }> {
    const data = await this.request<{ workItems?: Array<{ id: number }>; workItemRelations?: Array<{ source?: { id: number }; target?: { id: number } }> }>(
      "/wit/wiql",
      {
        method: "POST",
        body: JSON.stringify({ query: wiql }),
      },
      "project",
      "7.1-preview.2",
    );
    return data;
  }

  async getWorkItemsByIds(ids: number[], fields?: string[]): Promise<any[]> {
    if (ids.length === 0) return [];
    const defaultFields = [
      "System.Id", "System.Title", "System.State", "System.WorkItemType",
      "System.AssignedTo", "Microsoft.VSTS.Common.Priority", "System.ChangedDate",
    ];
    const fieldsParam = (fields ?? defaultFields).join(",");
    const data = await this.request<{ value: any[] }>(
      `/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fieldsParam}`,
      undefined,
      "org",
    );
    return data.value ?? [];
  }

  async getWorkItem(id: number, options?: { expandRelations?: boolean }): Promise<any> {
    const expand = options?.expandRelations ? "?$expand=relations" : "";
    return this.request<any>(
      `/_apis/wit/workitems/${id}${expand}`,
      undefined,
      "org",
    );
  }

  // ─── Chained PRs methods ──────────────────────────────────────────

  async getBranchTip(repo: string, branch: string): Promise<string> {
    const filter = `heads/${branch}`;
    const data = await this.request<{ value: Array<{ objectId: string }> }>(
      `/git/repositories/${encodeURIComponent(repo)}/refs?filter=${encodeURIComponent(filter)}`,
    );
    if (!data.value?.length) {
      throw new Error(`Branch "${branch}" not found in repo "${repo}"`);
    }
    return data.value[0].objectId;
  }

  async createBranch(
    repo: string,
    branchName: string,
    commitSha: string,
  ): Promise<GitRefUpdateResult> {
    const refName = `refs/heads/${branchName}`;
    const body = [
      {
        name: refName,
        oldObjectId: "0000000000000000000000000000000000000000",
        newObjectId: commitSha,
      },
    ];
    const data = await this.request<GitRefUpdateResult[]>(
      `/git/repositories/${encodeURIComponent(repo)}/refs`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const result = data[0];
    if (!result.success) {
      throw new Error(
        `Failed to create branch "${branchName}": ${result.updateStatus ?? "unknown error"}`,
      );
    }
    return result;
  }

  async createPullRequest(repo: string, options: CreatePrOptions): Promise<GitPullRequest> {
    return this.request(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests`,
      {
        method: "POST",
        body: JSON.stringify({
          sourceRefName: options.sourceRefName,
          targetRefName: options.targetRefName,
          title: options.title,
          description: options.description ?? "",
          isDraft: options.isDraft ?? false,
        }),
      },
    );
  }

  async linkWorkItemToPr(
    workItemId: number,
    prArtifactUrl: string,
  ): Promise<void> {
    const wi = await this.getWorkItem(workItemId, { expandRelations: true });
    const existing = (wi.relations ?? []).some(
      (r: any) => r.url === prArtifactUrl,
    );
    if (existing) return;

    await this.updateWorkItem(workItemId, [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "ArtifactLink",
          url: prArtifactUrl,
          attributes: { name: "Pull Request" },
        },
      },
    ]);
  }

  async getRepository(repo: string): Promise<{ repoId: string; projectId: string }> {
    const data = await this.request<{ id: string; project: { id: string } }>(
      `/git/repositories/${encodeURIComponent(repo)}`,
    );
    return { repoId: data.id, projectId: data.project.id };
  }
}

// ─── Business logic helpers ───────────────────────────────────────────────

export function guessLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    cs: "csharp", rb: "ruby", php: "php", swift: "swift", c: "c", cpp: "cpp",
    scss: "scss", css: "css", html: "html", sql: "sql", sh: "bash",
    yaml: "yaml", yml: "yaml", json: "json", xml: "xml", md: "markdown",
  };
  return map[ext] ?? "";
}

export function wiqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function assignedToCondition(assignedTo?: string): string {
  const normalized = assignedTo?.trim();
  if (!normalized || normalized.toLowerCase() === "me" || normalized.toLowerCase() === "@me") {
    return "[System.AssignedTo] = @Me";
  }
  return `[System.AssignedTo] = ${wiqlLiteral(normalized)}`;
}

export function filterLabel(value?: string): string {
  if (!value || value.trim().toLowerCase() === "me" || value.trim().toLowerCase() === "@me") return "@Me";
  return value.trim();
}

export function workItemIdFromUrl(url?: string): number | undefined {
  const match = url?.match(/\/workItems\/(\d+)$/i);
  return match ? Number(match[1]) : undefined;
}

export function relationLabel(rel: any): string {
  return rel?.attributes?.name ?? rel?.rel ?? "Related";
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function plainText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function isMatchingWorkItemType(wi: any, workItemType?: string): boolean {
  if (!workItemType) return true;
  const type = String(wi?.fields?.["System.WorkItemType"] ?? "").trim().toLowerCase();
  return type === workItemType.trim().toLowerCase();
}

function commentList(commentsData: any): any[] {
  return commentsData?.comments ?? commentsData?.value ?? [];
}

export async function formatComments(ado: AdoClient, id: number): Promise<string> {
  const commentsData = await ado.getWorkItemComments(id).catch(() => ({ value: [] }));
  const comments = commentList(commentsData);
  if (!comments.length) return "\n## Comments None";
  let out = `\n## Comments (${comments.length})\n`;
  for (const c of comments.slice(0, 20)) {
    const author = c.createdBy?.displayName ?? c.author?.displayName ?? "?";
    const date = (c.createdDate ?? c.date ?? "")?.slice(0, 10);
    let text = plainText(c.text ?? c.renderedText);
    text = text.replace(/\\n/g, " ").replace(/\s+/g, " ").slice(0, 300);
    out += `- ${author}${date ? ` ${date}` : ""}: ${text}\n`;
  }
  return out;
}

export async function formatWorkItemRelations(ado: AdoClient, wi: any): Promise<string> {
  const relations = (wi.relations ?? [])
    .map((rel: any) => ({ rel, id: workItemIdFromUrl(rel.url) }))
    .filter((item: { id?: number }) => item.id !== undefined) as Array<{ rel: any; id: number }>;
  if (!relations.length) return "\n## Related None";

  const relatedIds = [...new Set(relations.map((r) => r.id))];
  const relatedItems = await ado.getWorkItemsByIds(relatedIds, [
    "System.Id", "System.Title", "System.State", "System.WorkItemType", "System.AssignedTo",
  ]).catch(() => []);
  const byId = new Map(relatedItems.map((item: any) => [item.id, item]));

  let out = "\n## Related\n";
  for (const relation of relations) {
    const related = byId.get(relation.id);
    if (related) {
      const title = (related.fields?.["System.Title"] ?? "?").slice(0, 40);
      const type = abbrevType(related.fields?.["System.WorkItemType"] ?? "?");
      const state = (related.fields?.["System.State"] ?? "?").replace(/\s+/g, "");
      out += `#${relation.id} ${title} [${type}] ${state} ${relationLabel(relation.rel)}\n`;
    } else {
      out += `#${relation.id} ${relationLabel(relation.rel)}\n`;
    }
  }
  return out;
}

export async function formatWorkItemFullDetail(ado: AdoClient, wi: any, title: string): Promise<string> {
  let out = `${title}\n${fmtWorkItemDetail(wi)}`;
  out += await formatWorkItemRelations(ado, wi);
  out += await formatComments(ado, wi.id);
  return out;
}

// ─── Shared tool logic (config resolution, client creation, PR discovery) ─

export interface ResolvedClient {
  client: AdoClient;
  profile: AdoProfile;
  name: string;
  userId: { id: string; displayName: string };
}

/**
 * Resolve the active profile and create an ADO client.
 * Used by both OpenCode and Pi entry points.
 */
export async function createClientFromConfig(
  config: AdoConfig,
  profileOverride?: string,
): Promise<ResolvedClient> {
  let profileName = profileOverride;
  if (!profileName) {
    const persisted = getActiveProfile();
    if (persisted && config.profiles[persisted]) {
      profileName = persisted;
    }
  }

  const { name, profile } = profileName && config.profiles[profileName]
    ? { name: profileName, profile: config.profiles[profileName] }
    : resolveActiveProfile(config);

  const pat = getPAT(profile.patEnvVar);
  const orgUrl = resolveOrgUrl(profile.org);
  const ado = new AdoClient(orgUrl, profile.project, pat);
  const userId = await ado.getUserIdentity();
  return { client: ado, profile, name, userId };
}

/**
 * Search for a PR by ID across all configured profiles.
 */
export async function findPrAcrossProfiles(
  config: AdoConfig,
  prId: number,
  profileHint?: string,
): Promise<{ repo: string; profileName: string } | null> {
  const profilesToSearch = profileHint
    ? ([[profileHint, config.profiles[profileHint]] as [string, AdoProfile]]).filter(([, p]) => p)
    : (Object.entries(config.profiles) as [string, AdoProfile][]);

  for (const [profileName, profile] of profilesToSearch) {
    try {
      const pat = getPAT(profile.patEnvVar);
      const orgUrl = resolveOrgUrl(profile.org);
      const ado = new AdoClient(orgUrl, profile.project, pat);

      for (const repo of profile.repos) {
        try {
          await ado.getPullRequest(repo, prId);
          return { repo, profileName };
        } catch { /* PR not in this repo */ }
      }
    } catch { /* PAT or config issue for this profile, skip */ }
  }

  return null;
}

/**
 * Resolve repo+prId with auto-discovery when only prId is provided.
 */
export async function resolvePrArgsAuto(
  config: AdoConfig,
  args: { repo?: string; prId?: number; profile?: string },
): Promise<{ repo: string; prId: number; profileName: string }> {
  if (args.repo && args.prId) {
    const profileName = args.profile ?? getActiveProfile() ?? "";
    return { repo: args.repo, prId: args.prId, profileName };
  }

  if (args.prId && !args.repo) {
    const found = await findPrAcrossProfiles(config, args.prId, args.profile);
    if (!found) {
      const scope = args.profile ? `profile "${args.profile}"` : "any repo across all profiles";
      throw new Error(`PR #${args.prId} not found in ${scope}. Provide a repo or check the PR ID.`);
    }
    return { repo: found.repo, prId: args.prId, profileName: found.profileName };
  }

  const selected = getSelectedPr();
  if (!selected) {
    throw new Error(
      "No PR specified. Provide prId (auto-discovers across profiles), repo+prId, or select a PR in the sidebar.",
    );
  }
  const profileName = args.profile ?? getActiveProfile() ?? "";
  return { ...selected, profileName };
}
