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
 * Coerce a custom field value to the JSON type ADO expects.
 *
 * Boolean fields reject the strings "true"/"false" and must be sent as real
 * booleans. Numbers, dates and picklist values are accepted as strings by the
 * API, so they are left untouched.
 */
function coerceFieldValue(value: string): string | boolean {
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return value;
}

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
      ops.push({ op: "add", path, value: coerceFieldValue(value) });
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

/**
 * Check patch ops against the type's field definitions (`ado wi fields`):
 * unknown field references and values outside a picklist are reported before
 * the POST, so a create fails once with the allowed values instead of ADO's
 * opaque 400. Returns `null` when everything checks out.
 * ponytail: area/iteration paths are tree nodes, not picklists; ADO still validates those.
 */
export function checkFieldValues(
  type: string,
  fieldDefs: Array<{ referenceName?: string; allowedValues?: unknown[] }>,
  ops: Array<{ path: string; value: unknown }>,
): string | null {
  if (!fieldDefs.length) return null;
  const byRef = new Map(fieldDefs.map((f) => [String(f.referenceName ?? "").toLowerCase(), f]));
  for (const op of ops) {
    const ref = op.path.replace(/^\/fields\//, "");
    if (ref === "System.AssignedTo") continue; // identity, resolved separately
    const def = byRef.get(ref.toLowerCase());
    if (!def) return `'${ref}' is not a field of '${type}'. List them with: ado wi fields --type "${type}"`;
    const allowed = (def.allowedValues ?? []).map(String);
    if (allowed.length && !allowed.some((a) => a.toLowerCase() === String(op.value).toLowerCase())) {
      return `Invalid value '${op.value}' for ${ref} on '${type}'. Allowed: ${allowed.join(" | ")}`;
    }
  }
  return null;
}
