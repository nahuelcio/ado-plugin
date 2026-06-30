/**
 * OpenCode ADO Plugin — V1 Module Entry Point.
 *
 *
 * Server module — PR workflow tools
 * TUI module — sidebar panel
 *
 * Config in opencode.json:
 * ```jsonc
 * {
 *   "ado": {
 *     "defaultProfile": "work",
 *     "profiles": {
 *       "work": {
 *         "org": "myorg",
 *         "project": "myproject",
 *         "patEnvVar": "ADO_PAT",
 *         "repos": ["backend", "frontend"]
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Tool execute bodies delegate to ./cli-commands.ts so the plugin and the
 * `ado` CLI share one implementation and produce identical output.
 */

import type { Plugin, PluginInput, Hooks, PluginOptions, PluginModule } from "@opencode-ai/plugin";
import { z } from "zod/v4";
import type { AdoConfig } from "./shared.js";
import { asAdoConfig } from "./shared.js";
import { D } from "./tool-descriptions.js";
import * as cmd from "./cli-commands.js";

// All business logic (AdoClient + helpers) is in ./ado-client.js; command
// orchestration is in ./cli-commands.js. This file only wires OpenCode tool
// registration and config loading to those shared commands.

// ─── Server Plugin ────────────────────────────────────────────────────────

const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const { client } = input;

  // ─── Config loader (OpenCode-specific) ────────────────────────────
  async function loadConfig(): Promise<AdoConfig> {
    const fromOptions = asAdoConfig(options);
    if (fromOptions) return fromOptions;

    const resp = await client.config.get().catch(() => ({ data: {} }));
    const data = (resp.data ?? {}) as Record<string, unknown>;
    const ado = asAdoConfig(data["ado"]);
    if (!ado || !ado.profiles || Object.keys(ado.profiles).length === 0) {
      throw new Error("No ADO config found. Add an 'ado' section to opencode.json with profiles.");
    }
    return ado;
  }

  return {
    tool: {
      [D.pr_list.name]: {
        description: D.pr_list.description,
        args: { profile: z.string().optional().describe(D.pr_list.params.profile) },
        async execute(args: { profile?: string }) { return cmd.prList(await loadConfig(), args); },
      },

      [D.pr_get.name]: {
        description: D.pr_get.description,
        args: {
          repo: z.string().optional().describe(D.pr_get.params.repo),
          prId: z.number().optional().describe(D.pr_get.params.prId),
          profile: z.string().optional().describe(D.pr_get.params.profile),
        },
        async execute(args: { repo?: string; prId?: number; profile?: string }) { return cmd.prGet(await loadConfig(), args); },
      },

      [D.pr_threads.name]: {
        description: D.pr_threads.description,
        args: {
          repo: z.string().optional().describe(D.pr_threads.params.repo),
          prId: z.number().optional().describe(D.pr_threads.params.prId),
          profile: z.string().optional().describe(D.pr_threads.params.profile),
        },
        async execute(args: { repo?: string; prId?: number; profile?: string }) { return cmd.prThreads(await loadConfig(), args); },
      },

      [D.pr_comment.name]: {
        description: D.pr_comment.description,
        args: {
          repo: z.string().optional().describe(D.pr_comment.params.repo),
          prId: z.number().optional().describe(D.pr_comment.params.prId),
          comment: z.string(),
          filePath: z.string().optional().describe(D.pr_comment.params.filePath),
          line: z.number().optional().describe(D.pr_comment.params.line),
          profile: z.string().optional().describe(D.pr_comment.params.profile),
        },
        async execute(args: { repo?: string; prId?: number; comment: string; filePath?: string; line?: number; profile?: string }) {
          return cmd.prComment(await loadConfig(), args);
        },
      },

      [D.pr_vote.name]: {
        description: D.pr_vote.description,
        args: {
          repo: z.string().optional().describe(D.pr_vote.params.repo),
          prId: z.number().optional().describe(D.pr_vote.params.prId),
          vote: z.enum(["approve", "reject", "wait", "suggestions"]),
          comment: z.string().optional(),
          profile: z.string().optional().describe(D.pr_vote.params.profile),
        },
        async execute(args: { repo?: string; prId?: number; vote: string; comment?: string; profile?: string }) {
          return cmd.prVote(await loadConfig(), args);
        },
      },

      [D.profile_get.name]: {
        description: D.profile_get.description,
        args: { profile: z.string().optional().describe(D.profile_get.params.profile) },
        async execute(args: { profile?: string }) { return cmd.profileGet(await loadConfig(), args); },
      },

      // ─── Profiles ────────────────────────────────────────────────

      [D.profile_list.name]: {
        description: D.profile_list.description,
        args: {},
        async execute() { return cmd.profileList(await loadConfig()); },
      },

      [D.profile_use.name]: {
        description: D.profile_use.description,
        args: { name: z.string().describe(D.profile_use.params.name) },
        async execute(args: { name: string }) { return cmd.profileUse(await loadConfig(), args); },
      },

      // ─── PR selection ─────────────────────────────────────────────

      [D.pr_select.name]: {
        description: D.pr_select.description,
        args: {
          repo: z.string().optional().describe(D.pr_select.params.repo),
          prId: z.number().describe(D.pr_select.params.prId),
          profile: z.string().optional().describe(D.pr_select.params.profile),
        },
        async execute(args: { repo?: string; prId: number; profile?: string }) { return cmd.prSelect(await loadConfig(), args); },
      },

      // ─── PR diff & file content ───────────────────────────────────

      [D.pr_diff.name]: {
        description: D.pr_diff.description,
        args: {
          repo: z.string().optional().describe(D.pr_diff.params.repo),
          prId: z.number().optional().describe(D.pr_diff.params.prId),
          profile: z.string().optional().describe(D.pr_diff.params.profile),
        },
        async execute(args: { repo?: string; prId?: number; profile?: string }) { return cmd.prDiff(await loadConfig(), args); },
      },

      [D.pr_file.name]: {
        description: D.pr_file.description,
        args: {
          path: z.string().describe(D.pr_file.params.path),
          repo: z.string().optional().describe(D.pr_file.params.repo),
          prId: z.number().optional().describe(D.pr_file.params.prId),
          startLine: z.number().optional().describe(D.pr_file.params.startLine),
          endLine: z.number().optional().describe(D.pr_file.params.endLine),
          profile: z.string().optional().describe(D.pr_file.params.profile),
        },
        async execute(args: { path: string; repo?: string; prId?: number; startLine?: number; endLine?: number; profile?: string }) {
          return cmd.prFile(await loadConfig(), args);
        },
      },

      [D.pr_context.name]: {
        description: D.pr_context.description,
        args: {
          repo: z.string().optional().describe(D.pr_context.params.repo),
          prId: z.number().optional().describe(D.pr_context.params.prId),
          profile: z.string().optional().describe(D.pr_context.params.profile),
        },
        async execute(args: { repo?: string; prId?: number; profile?: string }) { return cmd.prContext(await loadConfig(), args); },
      },

      // ─── Work Item tools ──────────────────────────────────────────────

      [D.wi_list.name]: {
        description: D.wi_list.description,
        args: {
          state: z.string().optional().describe(D.wi_list.params.state),
          assignedTo: z.string().optional().describe(D.wi_list.params.assignedTo),
          tag: z.string().optional().describe(D.wi_list.params.tag),
          workItemType: z.string().optional().describe(D.wi_list.params.workItemType),
          profile: z.string().optional().describe(D.wi_list.params.profile),
        },
        async execute(args: { state?: string; assignedTo?: string; tag?: string; workItemType?: string; profile?: string }) {
          return cmd.wiList(await loadConfig(), args);
        },
      },

      [D.wi_get.name]: {
        description: D.wi_get.description,
        args: {
          id: z.number().describe(D.wi_get.params.id),
          profile: z.string().optional().describe(D.wi_get.params.profile),
        },
        async execute(args: { id: number; profile?: string }) { return cmd.wiGet(await loadConfig(), args); },
      },

      [D.wi_update.name]: {
        description: D.wi_update.description,
        args: {
          id: z.number().describe(D.wi_update.params.id),
          state: z.string().optional().describe(D.wi_update.params.state),
          priority: z.number().optional(),
          comment: z.string().optional(),
          profile: z.string().optional().describe(D.wi_update.params.profile),
        },
        async execute(args: { id: number; state?: string; priority?: number; comment?: string; profile?: string }) {
          return cmd.wiUpdate(await loadConfig(), args);
        },
      },

      [D.wi_comment.name]: {
        description: D.wi_comment.description,
        args: {
          id: z.number().describe(D.wi_comment.params.id),
          comment: z.string(),
          profile: z.string().optional().describe(D.wi_comment.params.profile),
        },
        async execute(args: { id: number; comment: string; profile?: string }) { return cmd.wiComment(await loadConfig(), args); },
      },

      [D.wi_types.name]: {
        description: D.wi_types.description,
        args: { profile: z.string().optional().describe(D.wi_types.params.profile) },
        async execute(args: { profile?: string }) { return cmd.wiTypes(await loadConfig(), args); },
      },

      [D.wi_create.name]: {
        description: D.wi_create.description,
        args: {
          type: z.string().optional().describe(D.wi_create.params.type),
          title: z.string(),
          description: z.string().optional().describe(D.wi_create.params.description),
          areaPath: z.string().optional().describe(D.wi_create.params.areaPath),
          iterationPath: z.string().optional().describe(D.wi_create.params.iterationPath),
          priority: z.number().optional(),
          assignedTo: z.string().optional().describe(D.wi_create.params.assignedTo),
          state: z.string().optional().describe(D.wi_create.params.state),
          tags: z.string().optional().describe(D.wi_create.params.tags),
          parentId: z.number().optional().describe(D.wi_create.params.parentId),
          customFields: z.record(z.string(), z.string()).optional().describe(D.wi_create.params.customFields),
          profile: z.string().optional().describe(D.wi_create.params.profile),
        },
        async execute(args: {
          type?: string; title: string; description?: string; areaPath?: string; iterationPath?: string;
          priority?: number; assignedTo?: string; state?: string; tags?: string; parentId?: number;
          customFields?: Record<string, string>; profile?: string;
        }) {
          return cmd.wiCreate(await loadConfig(), args);
        },
      },

      [D.wi_create_child.name]: {
        description: D.wi_create_child.description,
        args: {
          parentId: z.number().describe(D.wi_create_child.params.parentId),
          type: z.string().optional().describe(D.wi_create_child.params.type),
          title: z.string(),
          description: z.string().optional().describe(D.wi_create_child.params.description),
          areaPath: z.string().optional().describe(D.wi_create_child.params.areaPath),
          iterationPath: z.string().optional().describe(D.wi_create_child.params.iterationPath),
          priority: z.number().optional(),
          assignedTo: z.string().optional().describe(D.wi_create_child.params.assignedTo),
          state: z.string().optional().describe(D.wi_create_child.params.state),
          tags: z.string().optional().describe(D.wi_create_child.params.tags),
          customFields: z.record(z.string(), z.string()).optional().describe(D.wi_create_child.params.customFields),
          profile: z.string().optional().describe(D.wi_create_child.params.profile),
        },
        async execute(args: {
          parentId: number; type?: string; title: string; description?: string; areaPath?: string;
          iterationPath?: string; priority?: number; assignedTo?: string; state?: string; tags?: string;
          customFields?: Record<string, string>; profile?: string;
        }) {
          return cmd.wiCreateChild(await loadConfig(), args);
        },
      },

      [D.wi_related.name]: {
        description: D.wi_related.description,
        args: {
          id: z.number().describe(D.wi_related.params.id),
          state: z.string().optional().describe(D.wi_related.params.state),
          workItemType: z.string().optional().describe(D.wi_related.params.workItemType),
          profile: z.string().optional().describe(D.wi_related.params.profile),
        },
        async execute(args: { id: number; state?: string; workItemType?: string; profile?: string }) {
          return cmd.wiRelated(await loadConfig(), args);
        },
      },

      // ─── Chained PRs tools ─────────────────────────────────────────────

      [D.pr_create.name]: {
        description: D.pr_create.description,
        args: {
          repo: z.string().describe(D.pr_create.params.repo),
          sourceBranch: z.string().describe(D.pr_create.params.sourceBranch),
          targetBranch: z.string().describe(D.pr_create.params.targetBranch),
          title: z.string(),
          description: z.string().optional().describe(D.pr_create.params.description),
          workItemIds: z.array(z.number()).optional().describe(D.pr_create.params.workItemIds),
          isDraft: z.boolean().optional(),
          profile: z.string().optional().describe(D.pr_create.params.profile),
        },
        async execute(args: { repo: string; sourceBranch: string; targetBranch: string; title: string; description?: string; workItemIds?: number[]; isDraft?: boolean; profile?: string }) {
          return cmd.prCreate(await loadConfig(), args);
        },
      },

      [D.pr_chain.name]: {
        description: D.pr_chain.description,
        args: {
          repo: z.string().describe(D.pr_chain.params.repo),
          workItemIds: z.array(z.number()).min(1).max(50).describe(D.pr_chain.params.workItemIds),
          baseBranch: z.string().optional().describe(D.pr_chain.params.baseBranch),
          strategy: z.enum(["feature-chain", "stacked"]).optional().describe(D.pr_chain.params.strategy),
          prefix: z.string().optional().describe(D.pr_chain.params.prefix),
          branchNames: z.array(z.string()).optional().describe(D.pr_chain.params.branchNames),
          profile: z.string().optional().describe(D.pr_chain.params.profile),
        },
        async execute(args: { repo: string; workItemIds: number[]; baseBranch?: string; strategy?: "feature-chain" | "stacked"; prefix?: string; branchNames?: string[]; profile?: string }) {
          return cmd.prChain(await loadConfig(), args);
        },
      },
    },
  };
};

const pluginModule: PluginModule & { id: string } = {
  id: "@cioffinahuel/opencode-ado",
  server,
};

export default pluginModule;
export { server };
