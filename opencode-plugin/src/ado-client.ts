/**
 * ADO HTTP Client and business logic helpers.
 *
 * Used by the `ado` CLI through cli-commands.ts.
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
import { buildFieldPatchOps } from "./wi-create.js";

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

  /** Reply on an existing PR thread. */
  async replyToThread(repo: string, prId: number, threadId: number, content: string) {
    return this.request<any>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads/${threadId}/comments`,
      { method: "POST", body: JSON.stringify({ content, commentType: "text" }) },
    );
  }

  /** Set a PR thread's status (active, fixed, wontFix, closed, byDesign, pending). */
  async updateThreadStatus(repo: string, prId: number, threadId: number, status: string) {
    return this.request<any>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads/${threadId}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
  }

  /** Patch a pull request (complete, abandon, reactivate, publish a draft). */
  async updatePullRequest(repo: string, prId: number, body: Record<string, unknown>) {
    return this.request<any>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  }

  /**
   * Complete (merge) a pull request. ADO requires the current source commit so
   * it can refuse the merge when the branch moved after the last review.
   */
  async completePullRequest(
    repo: string,
    prId: number,
    options?: { mergeStrategy?: string; deleteSourceBranch?: boolean; bypassPolicy?: boolean },
  ) {
    const pr = await this.getPullRequest(repo, prId);
    return this.updatePullRequest(repo, prId, {
      status: "completed",
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      completionOptions: {
        mergeStrategy: options?.mergeStrategy ?? "squash",
        deleteSourceBranch: options?.deleteSourceBranch ?? false,
        bypassPolicy: options?.bypassPolicy ?? false,
      },
    });
  }

  /** Add a reviewer by identity id. `isRequired` marks it a required reviewer. */
  async addReviewer(repo: string, prId: number, identityId: string, isRequired = false) {
    return this.request<any>(
      `/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/reviewers/${encodeURIComponent(identityId)}`,
      { method: "PUT", body: JSON.stringify({ vote: 0, isRequired }) },
    );
  }

  /** Resolve a user identity id from a display name or email. */
  async findIdentityId(query: string): Promise<{ id: string; displayName: string; uniqueName?: string } | null> {
    const data = await this.request<{ results?: any[]; value?: any[] }>(
      `/IdentityPicker/Identities?api-version=7.1-preview.1`,
      {
        method: "POST",
        body: JSON.stringify({
          query,
          identityTypes: ["user"],
          operationScopes: ["ims", "source"],
          properties: ["DisplayName", "Mail", "LocalId"],
          options: { MinResults: 1, MaxResults: 1 },
        }),
      },
      "org",
      "7.1-preview.1",
    );
    // The picker answers `{ results: [{ identities }] }`; `value` kept for older servers.
    const identity = (data.results ?? data.value)?.[0]?.identities?.[0];
    if (!identity) return null;
    const uniqueName = identity.signInAddress ?? identity.mail;
    return {
      id: identity.localId ?? identity.entityId,
      displayName: identity.displayName ?? query,
      ...(uniqueName ? { uniqueName } : {}),
    };
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

  /** File content at a specific commit (empty string when the file does not exist there). */
  async getFileContentAtCommit(repo: string, path: string, commitId: string): Promise<string> {
    const url = `/_apis/git/repositories/${encodeURIComponent(repo)}/items`
      + `?path=${encodeURIComponent(path)}`
      + `&versionDescriptor.version=${encodeURIComponent(commitId)}`
      + `&versionDescriptor.versionType=commit`
      + `&$format=text`;
    return this.requestRaw(url).catch(() => "");
  }

  /** Work items linked to a PR. ADO returns only ids + urls here. */
  async getPullRequestWorkItems(repo: string, prId: number): Promise<number[]> {
    const data = await this.request<{ value: Array<{ id: string }> }>(
      `/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/workitems`,
    );
    return (data.value ?? []).map((w) => Number(w.id)).filter((id) => Number.isFinite(id));
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

  /**
   * Create a work item.
   * POST /_apis/wit/workitems/$${type}?api-version=7.1
   * Content-Type: application/json-patch+json
   *
   * @param customFields - Arbitrary ADO fields as key-value pairs where keys are
   *   full ADO field paths (e.g. "/fields/Custom.Sponsors").
   */
  async createWorkItem(
    type: string,
    fields: Record<string, unknown>,
    parentRelation?: { parentId: number; relationType: string },
    customFields?: Record<string, string>,
  ): Promise<any> {
    const patchOps = buildFieldPatchOps(fields, customFields);

    if (parentRelation) {
      patchOps.push({
        op: "add",
        path: "/relations/-",
        value: {
          rel: parentRelation.relationType,
          url: `${this.orgUrl}/_apis/wit/workItems/${parentRelation.parentId}`,
        },
      });
    }

    const url = this.buildUrl(
      `/_apis/wit/workitems/$${encodeURIComponent(type)}`,
      "project",
    );
    const res = await fetch(url, {
      method: "POST",
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

  /**
   * Link two existing work items. `rel` is an ADO link type such as
   * `System.LinkTypes.Hierarchy-Reverse` (parent) or `System.LinkTypes.Related`.
   * No-ops when the same link already exists.
   */
  async linkWorkItems(id: number, targetId: number, rel: string, comment?: string): Promise<boolean> {
    const targetUrl = this.buildUrl(`/_apis/wit/workItems/${targetId}`, "org");
    const wi = await this.getWorkItem(id, { expandRelations: true });
    const exists = (wi.relations ?? []).some(
      (r: any) => r.rel === rel && String(r.url ?? "").endsWith(`/${targetId}`),
    );
    if (exists) return false;
    await this.updateWorkItem(id, [
      {
        op: "add",
        path: "/relations/-",
        value: { rel, url: targetUrl, ...(comment ? { attributes: { comment } } : {}) },
      },
    ]);
    return true;
  }

  /** Upload a file and attach it to a work item. */
  async attachFileToWorkItem(id: number, fileName: string, content: Buffer, comment?: string): Promise<string> {
    const url = this.buildUrl(
      `/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}`,
      "project",
    );
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(content),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ADO ${res.status}: ${body.slice(0, 200)}`);
    }
    const { url: attachmentUrl } = (await res.json()) as { url: string };
    await this.updateWorkItem(id, [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: attachmentUrl,
          attributes: { name: fileName, ...(comment ? { comment } : {}) },
        },
      },
    ]);
    return attachmentUrl;
  }

  /**
   * List files attached to a work item, including images pasted inline in rich
   * text fields. Azure Boards uploads those to the same attachments endpoint but
   * never adds an AttachedFile relation, so they only exist as <img> tags.
   */
  async listAttachments(id: number): Promise<Array<{ name: string; url: string; comment?: string; size?: number }>> {
    const wi = await this.getWorkItem(id, { expandRelations: true });
    const files = (wi.relations ?? [])
      .filter((r: any) => r.rel === "AttachedFile")
      .map((r: any) => ({
        name: r.attributes?.name ?? "unnamed",
        url: r.url,
        comment: r.attributes?.comment,
        size: r.attributes?.resourceSize,
      }));

    const seen = new Set(files.map((f: { url: string }) => f.url));
    for (const url of inlineAttachmentUrls(wi.fields ?? {})) {
      if (seen.has(url)) continue;
      seen.add(url);
      files.push({ name: attachmentFileName(url), url, comment: "inline" });
    }
    return files;
  }

  /** Download an attachment by its ADO attachment URL. */
  async downloadAttachment(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: "application/octet-stream" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ADO ${res.status}: ${body.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ─── Pipelines ───────────────────────────────────────────────────

  async listPipelines(): Promise<any[]> {
    const data = await this.request<{ value: any[] }>("/pipelines", undefined, "project");
    return data.value ?? [];
  }

  async listPipelineRuns(pipelineId: number): Promise<any[]> {
    const data = await this.request<{ value: any[] }>(
      `/pipelines/${pipelineId}/runs`,
      undefined,
      "project",
    );
    return data.value ?? [];
  }

  async runPipeline(pipelineId: number, branch?: string): Promise<any> {
    return this.request<any>(
      `/pipelines/${pipelineId}/runs`,
      {
        method: "POST",
        body: JSON.stringify(
          branch
            ? { resources: { repositories: { self: { refName: `refs/heads/${branch}` } } } }
            : {},
        ),
      },
      "project",
    );
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

  /** Markdown by default: without `format` ADO stores the text as HTML and Markdown renders literally. */
  async addWorkItemComment(id: number, text: string, format: "markdown" | "html" = "markdown"): Promise<any> {
    return this.request<any>(
      `/_apis/wit/workItems/${id}/comments?format=${format}`,
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

  /**
   * Fields defined for a work item type in this project, including custom ones,
   * with their data type, required flag and picklist values when the type has them.
   */
  async getWorkItemTypeFields(type: string): Promise<any[]> {
    const data = await this.request<{ value: any[] }>(
      `/wit/workitemtypes/${encodeURIComponent(type)}/fields?$expand=allowedValues`,
      undefined,
      "project",
    );
    return data.value ?? [];
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
    // ADO caps the ids parameter at 200 per request — batch accordingly.
    const chunks = chunkArray(ids, 200);
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const data = await this.request<{ value: any[] }>(
          `/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${fieldsParam}`,
          undefined,
          "org",
        );
        return data.value ?? [];
      }),
    );
    return results.flat();
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

/** Attachment URLs referenced by <img> tags in any rich text field of a work item. */
export function inlineAttachmentUrls(fields: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const value of Object.values(fields)) {
    if (typeof value !== "string" || !value.includes("<img")) continue;
    for (const match of value.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
      const url = decodeHtmlEntities(match[1]);
      if (/\/_apis\/wit\/attachments\//i.test(url)) urls.push(url);
    }
  }
  return urls;
}

/** Best-effort file name for an ADO attachment URL. */
export function attachmentFileName(url: string): string {
  const named = /[?&]fileName=([^&]+)/i.exec(url);
  if (named) return decodeURIComponent(named[1]);
  const guid = url.split("?")[0].split("/").pop();
  return guid ? `${guid}.png` : "unnamed";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

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
  return decodeHtmlEntities(String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " "))
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
    // Full text; continuation lines indented so each comment stays one block.
    const raw = String(c.format ?? "").toLowerCase() === "markdown" ? String(c.text ?? "").trim() : plainText(c.text ?? c.renderedText);
    const text = raw.replace(/\n{3,}/g, "\n\n").replace(/\n/g, "\n  ");
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
 * Used by the CLI commands.
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

  const pat = getPAT(profile.patEnvVar, profile?.pat);
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
      const pat = getPAT(profile.patEnvVar, profile?.pat);
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
 * Profile to use for a repo: the one whose `repos` lists it (case-insensitive).
 * Several matches → the active one if among them, else an error. No match →
 * undefined so callers fall back to the active profile.
 */
export function profileForRepo(config: AdoConfig, repo: string): string | undefined {
  const wanted = repo.toLowerCase();
  const matches = Object.entries(config.profiles)
    .filter(([, p]) => (p.repos ?? []).some((r) => r.toLowerCase() === wanted))
    .map(([name]) => name);
  if (matches.length <= 1) return matches[0];
  const persisted = getActiveProfile();
  const active = persisted && config.profiles[persisted] ? persisted : resolveActiveProfile(config).name;
  if (matches.includes(active)) return active;
  throw new Error(`Repo "${repo}" is configured in several profiles (${matches.join(", ")}). Pass --profile <name>.`);
}

/**
 * Resolve repo+prId with auto-discovery when only prId is provided.
 */
export async function resolvePrArgsAuto(
  config: AdoConfig,
  args: { repo?: string; prId?: number; profile?: string },
): Promise<{ repo: string; prId: number; profileName: string }> {
  if (args.repo && args.prId) {
    const profileName = args.profile ?? profileForRepo(config, args.repo) ?? getActiveProfile() ?? "";
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
      "No PR specified. Provide prId (auto-discovers across profiles), repo+prId, or select one with `ado pr select`.",
    );
  }
  const profileName = args.profile ?? profileForRepo(config, selected.repo) ?? getActiveProfile() ?? "";
  return { ...selected, profileName };
}
