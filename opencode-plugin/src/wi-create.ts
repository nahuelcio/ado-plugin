/**
 * Work Item creation — validation and field mapping.
 *
 * Pure functions used by AdoClient.createWorkItem and by tool handlers
 * to validate creation requests against project configuration rules
 * and map input fields to ADO JSON Patch operations.
 */

/** Regex that valid custom field paths must match: /fields/<FieldName> */
const FIELD_PATH_RE = /^\/fields\/[A-Za-z0-9_.]+$/;

/** Mapping from input field keys to ADO API field paths. */
const FIELD_MAP: Record<string, string> = {
  title: "/fields/System.Title",
  description: "/fields/System.Description",
  state: "/fields/System.State",
  priority: "/fields/Microsoft.VSTS.Common.Priority",
  tags: "/fields/System.Tags",
  areaPath: "/fields/System.AreaPath",
  iterationPath: "/fields/System.IterationPath",
  assignedTo: "/fields/System.AssignedTo",
};

/**
 * Build JSON Patch operations from input fields to ADO API field paths.
 *
 * Only known fields are mapped; unknown keys are silently ignored.
 * All operations use "add" semantics.
 *
 * @param fields - Standard fields mapped via FIELD_MAP (title, description, etc.)
 * @param customFields - Arbitrary ADO fields where keys are full ADO paths
 *   (e.g. "/fields/Custom.Sponsors") and values are the field values.
 *   These are appended as direct "add" patch operations.
 */
export function buildFieldPatchOps(
  fields: Record<string, unknown>,
  customFields?: Record<string, string>,
): Array<{ op: string; path: string; value: unknown }> {
  const ops: Array<{ op: string; path: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(fields)) {
    const adoPath = FIELD_MAP[key];
    if (adoPath) {
      ops.push({ op: "add", path: adoPath, value });
    }
  }
  if (customFields) {
    const knownPaths = new Set(Object.values(FIELD_MAP));
    for (const [path, value] of Object.entries(customFields)) {
      if (!FIELD_PATH_RE.test(path)) {
        throw new Error(
          `Invalid customField path '${path}'. Must match /fields/<FieldName> (e.g. /fields/Custom.Sponsors).`,
        );
      }
      if (knownPaths.has(path)) {
        throw new Error(
          `customField path '${path}' conflicts with a mapped field. Use the standard field argument instead.`,
        );
      }
      ops.push({ op: "add", path, value });
    }
  }
  return ops;
}

/**
 * Validate work item creation against project config rules.
 *
 * Returns `null` if valid, or an error string describing the first
 * validation failure encountered.
 */
export function validateWorkItemCreation(
  config: {
    work_item: {
      create: {
        enabled: boolean;
        allowed_types: string[];
        required_fields: string[];
        default_state: string;
        auto_assign: boolean;
        require_parent: boolean;
        default_type: string;
      };
    };
  },
  args: { type: string; fields: Record<string, unknown>; parentId?: number },
): string | null {
  const create = config.work_item.create;

  // 1. Check if creation is enabled
  if (!create.enabled) {
    return "Work item creation is disabled in this project's configuration";
  }

  // 2. Check allowed types (empty = all allowed)
  if (create.allowed_types.length > 0 && !create.allowed_types.includes(args.type)) {
    return `Work item type '${args.type}' is not allowed. Allowed types: ${create.allowed_types.join(", ")}`;
  }

  // 3. Check required fields
  for (const field of create.required_fields) {
    if (!(field in args.fields)) {
      return `Missing required field: ${field}`;
    }
  }

  // 4. Check parent requirement
  if (create.require_parent && args.parentId === undefined) {
    return "Parent work item is required in this project's configuration";
  }

  return null;
}
