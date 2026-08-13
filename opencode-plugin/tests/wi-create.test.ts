/**
 * TDD RED phase — tests for Work Item CRUD creation.
 *
 * The validateWorkItemCreation and buildFieldPatchOps functions DO NOT
 * EXIST yet (src/wi-create.ts). AdoClient.createWorkItem does NOT EXIST
 * on the AdoClient class yet.
 *
 * These tests define the contract. Implement until green.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AdoClient } from "../src/ado-client.js";
import {
  validateWorkItemCreation,
  buildFieldPatchOps,
} from "../src/wi-create.js";

// ─── Types for test configs ──────────────────────────────────────────────

/**
 * Minimal shape expected by validateWorkItemCreation.
 * The real ProjectConfig will extend chain-types.ts with work_item.create.
 */
interface WiCreateSection {
  enabled: boolean;
  allowed_types: string[];
  required_fields: string[];
  default_state: string;
  auto_assign: boolean;
  require_parent: boolean;
  default_type: string;
}

interface TestProjectConfig {
  chain: {
    strategy: "feature-chain" | "stacked";
    base_branch: string;
    max_length: number;
    prefix: string;
    tracker_name: string;
  };
  branch: {
    allowed_types: string[];
    slug_max_length: number;
    require_wi_id: boolean;
  };
  pr: {
    require_work_item: boolean;
    include_chain_context: boolean;
    review_budget: number;
    default_draft: boolean;
  };
  work_item: {
    auto_transition: boolean;
    target_state: string;
    create: WiCreateSection;
  };
}

// ─── Test helpers ────────────────────────────────────────────────────────

function makeClient(): AdoClient {
  return new AdoClient(
    "https://dev.azure.com/testorg",
    "TestProject",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a full TestProjectConfig with sensible defaults; override only the create section. */
function makeConfig(createOverrides?: Partial<WiCreateSection>): TestProjectConfig {
  return {
    chain: {
      strategy: "feature-chain",
      base_branch: "main",
      max_length: 10,
      prefix: "feature",
      tracker_name: "",
    },
    branch: {
      allowed_types: ["feature", "bugfix"],
      slug_max_length: 40,
      require_wi_id: true,
    },
    pr: {
      require_work_item: true,
      include_chain_context: true,
      review_budget: 400,
      default_draft: false,
    },
    work_item: {
      auto_transition: false,
      target_state: "Active",
      create: {
        enabled: true,
        allowed_types: [],
        required_fields: ["title"],
        default_state: "New",
        auto_assign: false,
        require_parent: false,
        default_type: "User Story",
        ...createOverrides,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. AdoClient.createWorkItem (mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════

describe("AdoClient.createWorkItem", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns a WI object with id on successful creation", async () => {
    const wiResponse = {
      id: 42,
      rev: 1,
      fields: {
        "System.Title": "Implement auth",
        "System.State": "New",
        "System.WorkItemType": "Task",
      },
      url: "https://dev.azure.com/testorg/TestProject/_apis/wit/workItems/42",
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(wiResponse));

    const result = await client.createWorkItem("Task", {
      title: "Implement auth",
    });

    expect(result.id).toBe(42);
    expect(result.fields["System.Title"]).toBe("Implement auth");
  });

  it("sends POST to /_apis/wit/workitems/$${type}?api-version=7.1", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));

    await client.createWorkItem("Task", { title: "Test" });

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/_apis/wit/workitems/$Task");
    expect(calledUrl).toContain("api-version=7.1");
    // Project-scoped: URL must include the project name
    expect(calledUrl).toContain("/TestProject/");
  });

  it("uses POST method with application/json-patch+json Content-Type", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));

    await client.createWorkItem("Bug", { title: "Crash on login" });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json-patch+json",
    });
  });

  it("includes Authorization header with Basic PAT", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));

    await client.createWorkItem("Task", { title: "Test" });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
  });

  it("sends JSON Patch body with field operations", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));

    await client.createWorkItem("Task", {
      title: "My Task",
      description: "Detailed description",
      priority: 2,
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: unknown;
    }>;

    // Body must be an array of patch operations
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);

    // All operations use "add"
    for (const op of body) {
      expect(op.op).toBe("add");
    }

    // Verify at least title is mapped
    const titleOp = body.find((op) => op.path === "/fields/System.Title");
    expect(titleOp).toBeDefined();
    expect(titleOp!.value).toBe("My Task");
  });

  it("adds parent relation to the patch body when parentRelation is provided", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 99 }));

    await client.createWorkItem("Task", { title: "Child task" }, {
      parentId: 42,
      relationType: "System.LinkTypes.Hierarchy-Reverse",
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: unknown;
    }>;

    const relationOp = body.find((op) => op.path === "/relations/-");
    expect(relationOp).toBeDefined();
    expect(relationOp!.value).toMatchObject({
      rel: "System.LinkTypes.Hierarchy-Reverse",
    });
    // URL must reference the parent ID
    const relValue = relationOp!.value as { url: string };
    expect(relValue.url).toContain("42");
  });

  it("propagates 400 API error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        '{"message":"Invalid work item type"}',
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      client.createWorkItem("InvalidType", { title: "Test" }),
    ).rejects.toThrow("ADO 400");
  });

  it("propagates 404 API error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(
      client.createWorkItem("Task", { title: "Test" }),
    ).rejects.toThrow("ADO 404");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Config validation for WI creation
// ═══════════════════════════════════════════════════════════════════════════

describe("validateWorkItemCreation", () => {
  it('returns error "WI creation disabled" when enabled = false', () => {
    const config = makeConfig({ enabled: false });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Test" },
    });
    expect(result).toContain("disabled");
  });

  it("returns error when type is not in allowed_types", () => {
    const config = makeConfig({ allowed_types: ["Task", "Bug"] });
    const result = validateWorkItemCreation(config, {
      type: "User Story",
      fields: { title: "Test" },
    });
    expect(result).toContain("User Story");
    expect(result).toMatch(/not allowed|not permitted|allowed type/i);
  });

  it("returns null when allowed_types is empty (all types allowed)", () => {
    const config = makeConfig({ allowed_types: [] });
    const result = validateWorkItemCreation(config, {
      type: "User Story",
      fields: { title: "Test" },
    });
    expect(result).toBeNull();
  });

  it("returns error when a required field is missing", () => {
    const config = makeConfig({
      required_fields: ["title", "areaPath"],
    });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Test" },
      // areaPath is missing
    });
    expect(result).toContain("areaPath");
  });

  it("returns null when only title is required and present", () => {
    const config = makeConfig({ required_fields: ["title"] });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "My Task" },
    });
    expect(result).toBeNull();
  });

  it("returns error when require_parent=true and parentId is missing", () => {
    const config = makeConfig({ require_parent: true });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Child task" },
      // parentId is undefined
    });
    expect(result).toMatch(/parent/i);
  });

  it("returns null when require_parent=false and parentId is missing", () => {
    const config = makeConfig({ require_parent: false });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Standalone task" },
    });
    expect(result).toBeNull();
  });

  it("returns null when all validation passes", () => {
    const config = makeConfig({
      enabled: true,
      allowed_types: ["Task", "Bug"],
      required_fields: ["title"],
      require_parent: false,
    });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "My Task", description: "Details" },
    });
    expect(result).toBeNull();
  });

  it("returns null when require_parent=true and parentId is provided", () => {
    const config = makeConfig({ require_parent: true });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Child task" },
      parentId: 42,
    });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WI creation tools — validation logic (higher-level scenarios)
// ═══════════════════════════════════════════════════════════════════════════

describe("WI creation tools validation logic", () => {
  it("accepts creation when all required fields are present", () => {
    const config = makeConfig({
      required_fields: ["title", "areaPath"],
    });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Implement X", areaPath: "MyProject\\TeamA" },
    });
    expect(result).toBeNull();
  });

  it("rejects creation when title is missing (title always in required_fields)", () => {
    const config = makeConfig({ required_fields: ["title"] });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { description: "No title" },
    });
    expect(result).toMatch(/title/i);
  });

  it("accepts child WI creation with parentId", () => {
    const config = makeConfig({ require_parent: true });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Sub-task" },
      parentId: 100,
    });
    expect(result).toBeNull();
  });

  it("rejects child WI creation without parentId when require_parent=true", () => {
    const config = makeConfig({ require_parent: true });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Sub-task" },
    });
    expect(result).not.toBeNull();
    expect(result).toMatch(/parent/i);
  });

  it("rejects creation when type is not in allowed_types list", () => {
    const config = makeConfig({
      allowed_types: ["Task", "Bug"],
    });
    const result = validateWorkItemCreation(config, {
      type: "Feature",
      fields: { title: "New feature" },
    });
    expect(result).not.toBeNull();
  });

  it("accepts creation when auto_assign=true and no assignedTo (auto-assign deferred)", () => {
    const config = makeConfig({
      auto_assign: true,
    });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Auto-assigned task" },
      // no assignedTo — auto-assign happens at creation time, not validation time
    });
    expect(result).toBeNull();
  });

  it("accepts creation when all fields present and type is in allowed list", () => {
    const config = makeConfig({
      allowed_types: ["Task", "Bug", "User Story"],
      required_fields: ["title", "areaPath"],
    });
    const result = validateWorkItemCreation(config, {
      type: "User Story",
      fields: {
        title: "As a user I want X",
        areaPath: "MyProject",
        description: "Acceptance criteria...",
      },
    });
    expect(result).toBeNull();
  });

  it("rejects when WI creation is disabled regardless of valid fields", () => {
    const config = makeConfig({
      enabled: false,
      allowed_types: ["Task"],
    });
    const result = validateWorkItemCreation(config, {
      type: "Task",
      fields: { title: "Should not matter" },
    });
    expect(result).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. buildFieldPatchOps — JSON Patch body format (field mapping)
// ═══════════════════════════════════════════════════════════════════════════

describe("buildFieldPatchOps", () => {
  it("maps title to /fields/System.Title", () => {
    const ops = buildFieldPatchOps({ title: "My Task" });
    const titleOp = ops.find((op) => op.path === "/fields/System.Title");
    expect(titleOp).toEqual({
      op: "add",
      path: "/fields/System.Title",
      value: "My Task",
    });
  });

  it("maps description to /fields/System.Description", () => {
    const ops = buildFieldPatchOps({ description: "Detailed desc" });
    const descOp = ops.find((op) => op.path === "/fields/System.Description");
    expect(descOp).toEqual({
      op: "add",
      path: "/fields/System.Description",
      value: "Detailed desc",
    });
  });

  it("maps state to /fields/System.State", () => {
    const ops = buildFieldPatchOps({ state: "New" });
    const stateOp = ops.find((op) => op.path === "/fields/System.State");
    expect(stateOp).toEqual({
      op: "add",
      path: "/fields/System.State",
      value: "New",
    });
  });

  it("maps priority to /fields/Microsoft.VSTS.Common.Priority", () => {
    const ops = buildFieldPatchOps({ priority: 2 });
    const priorityOp = ops.find(
      (op) => op.path === "/fields/Microsoft.VSTS.Common.Priority",
    );
    expect(priorityOp).toEqual({
      op: "add",
      path: "/fields/Microsoft.VSTS.Common.Priority",
      value: 2,
    });
  });

  it("maps tags to /fields/System.Tags", () => {
    const ops = buildFieldPatchOps({ tags: "frontend;urgent" });
    const tagsOp = ops.find((op) => op.path === "/fields/System.Tags");
    expect(tagsOp).toEqual({
      op: "add",
      path: "/fields/System.Tags",
      value: "frontend;urgent",
    });
  });

  it("maps areaPath to /fields/System.AreaPath", () => {
    const ops = buildFieldPatchOps({ areaPath: "MyProject\\TeamA" });
    const areaOp = ops.find((op) => op.path === "/fields/System.AreaPath");
    expect(areaOp).toEqual({
      op: "add",
      path: "/fields/System.AreaPath",
      value: "MyProject\\TeamA",
    });
  });

  it("maps iterationPath to /fields/System.IterationPath", () => {
    const ops = buildFieldPatchOps({ iterationPath: "MyProject\\Sprint 5" });
    const iterOp = ops.find(
      (op) => op.path === "/fields/System.IterationPath",
    );
    expect(iterOp).toEqual({
      op: "add",
      path: "/fields/System.IterationPath",
      value: "MyProject\\Sprint 5",
    });
  });

  it("maps assignedTo to /fields/System.AssignedTo", () => {
    const ops = buildFieldPatchOps({ assignedTo: "john@contoso.com" });
    const assignOp = ops.find(
      (op) => op.path === "/fields/System.AssignedTo",
    );
    expect(assignOp).toEqual({
      op: "add",
      path: "/fields/System.AssignedTo",
      value: "john@contoso.com",
    });
  });

  it("produces correct patch ops for all known fields together", () => {
    const ops = buildFieldPatchOps({
      title: "Full WI",
      description: "All fields",
      state: "Active",
      priority: 1,
      tags: "backend;api",
      areaPath: "Proj\\Area",
      iterationPath: "Proj\\Sprint1",
      assignedTo: "jane@test.com",
    });

    // Must produce exactly 8 operations (one per field)
    expect(ops).toHaveLength(8);

    // Every op must use "add"
    for (const op of ops) {
      expect(op.op).toBe("add");
    }

    // Every op must have a /fields/ path
    for (const op of ops) {
      expect(op.path).toMatch(/^\/fields\//);
    }

    // Verify all expected paths are present
    const paths = ops.map((op) => op.path);
    expect(paths).toContain("/fields/System.Title");
    expect(paths).toContain("/fields/System.Description");
    expect(paths).toContain("/fields/System.State");
    expect(paths).toContain("/fields/Microsoft.VSTS.Common.Priority");
    expect(paths).toContain("/fields/System.Tags");
    expect(paths).toContain("/fields/System.AreaPath");
    expect(paths).toContain("/fields/System.IterationPath");
    expect(paths).toContain("/fields/System.AssignedTo");
  });

  it("returns empty array when no fields are provided", () => {
    const ops = buildFieldPatchOps({});
    expect(ops).toEqual([]);
  });

  it("preserves value types (number for priority, string for title)", () => {
    const ops = buildFieldPatchOps({
      title: "Type check",
      priority: 3,
      state: "New",
    });

    const titleOp = ops.find((op) => op.path === "/fields/System.Title");
    const priorityOp = ops.find(
      (op) => op.path === "/fields/Microsoft.VSTS.Common.Priority",
    );
    const stateOp = ops.find((op) => op.path === "/fields/System.State");

    expect(typeof titleOp!.value).toBe("string");
    expect(typeof priorityOp!.value).toBe("number");
    expect(typeof stateOp!.value).toBe("string");
  });
});

// ─── Parent relation operation format ────────────────────────────────────

describe("parent relation operation in createWorkItem body", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("constructs correct Hierarchy-Reverse relation for parent", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 99 }));

    await client.createWorkItem("Task", { title: "Child" }, {
      parentId: 42,
      relationType: "System.LinkTypes.Hierarchy-Reverse",
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: unknown;
    }>;

    const relOp = body.find((op) => op.path === "/relations/-");
    expect(relOp).toBeDefined();
    expect(relOp!.op).toBe("add");

    const relValue = relOp!.value as {
      rel: string;
      url: string;
    };
    expect(relValue.rel).toBe("System.LinkTypes.Hierarchy-Reverse");
    // URL must point to a work item with the correct parent ID
    expect(relValue.url).toMatch(/workItems\/42/);
  });

  it("places relation op after all field ops in the patch body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 99 }));

    await client.createWorkItem("Task", { title: "Child", description: "Desc" }, {
      parentId: 42,
      relationType: "System.LinkTypes.Hierarchy-Reverse",
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ path: string }>;

    const paths = body.map((op) => op.path);
    const relationIdx = paths.indexOf("/relations/-");
    const lastFieldIdx = paths.reduce(
      (last, p, i) => (p.startsWith("/fields/") ? i : last),
      -1,
    );

    // Relation must come after all field operations
    expect(relationIdx).toBeGreaterThan(lastFieldIdx);
  });

  it("does not include relation op when no parentRelation is provided", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 99 }));

    await client.createWorkItem("Task", { title: "Standalone" });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ path: string }>;

    const hasRelation = body.some((op) => op.path === "/relations/-");
    expect(hasRelation).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. buildFieldPatchOps with customFields — custom ADO field passthrough
// ═══════════════════════════════════════════════════════════════════════════

describe("buildFieldPatchOps with customFields", () => {
  it("appends custom fields as direct ADO path operations", () => {
    const ops = buildFieldPatchOps(
      { title: "My WI" },
      { "/fields/Custom.Sponsors": "Juan Pérez" },
    );
    const customOp = ops.find((op) => op.path === "/fields/Custom.Sponsors");
    expect(customOp).toEqual({
      op: "add",
      path: "/fields/Custom.Sponsors",
      value: "Juan Pérez",
    });
  });

  it("handles multiple custom fields", () => {
    const ops = buildFieldPatchOps(
      { title: "My WI" },
      {
        "/fields/Custom.Sponsors": "María",
        "/fields/Custom.USProducto": "yWhatsApp",
        "/fields/Custom.Version": "2.5",
      },
    );
    expect(ops).toHaveLength(4); // 1 known + 3 custom
    const paths = ops.map((op) => op.path);
    expect(paths).toContain("/fields/Custom.Sponsors");
    expect(paths).toContain("/fields/Custom.USProducto");
    expect(paths).toContain("/fields/Custom.Version");
  });

  it("returns empty array with no fields and no customFields", () => {
    const ops = buildFieldPatchOps({});
    expect(ops).toEqual([]);
  });

  it("handles only customFields with no standard fields", () => {
    const ops = buildFieldPatchOps({}, { "/fields/Custom.Foo": "bar" });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      op: "add",
      path: "/fields/Custom.Foo",
      value: "bar",
    });
  });

  it("places custom fields after known field ops", () => {
    const ops = buildFieldPatchOps(
      { title: "My WI", description: "Details" },
      { "/fields/Custom.X": "val" },
    );

    const customIdx = ops.findIndex((op) => op.path === "/fields/Custom.X");
    const lastKnownIdx = ops.reduce(
      (last, op, i) =>
        !op.path.startsWith("/fields/Custom.") ? i : last,
      -1,
    );

    expect(customIdx).toBeGreaterThan(lastKnownIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. buildFieldPatchOps customFields validation
// ═══════════════════════════════════════════════════════════════════════════

describe("buildFieldPatchOps customFields validation", () => {
  it("throws when customField path collides with a known FIELD_MAP path", () => {
    expect(() =>
      buildFieldPatchOps({}, { "/fields/System.Title": "Hacked" }),
    ).toThrow(/conflicts with a mapped field/);
  });

  it("throws when customField path does not match /fields/<name> format", () => {
    expect(() =>
      buildFieldPatchOps({}, { "/relations/-": "evil" }),
    ).toThrow(/Invalid customField path/);
  });

  it("throws on malformed paths like bare field name", () => {
    expect(() =>
      buildFieldPatchOps({}, { "Custom.Sponsors": "Juan" }),
    ).toThrow(/Invalid customField path/);
  });

  it("accepts valid custom field paths with dots and underscores", () => {
    const ops = buildFieldPatchOps({}, {
      "/fields/Custom.Sponsors": "Juan",
      "/fields/Custom.USProducto": "yWhatsApp",
      "/fields/Custom.My_Field": "value",
    });
    expect(ops).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. AdoClient.createWorkItem with customFields (mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════

describe("AdoClient.createWorkItem with customFields", () => {
  let client: AdoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClient();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("includes customFields in the JSON Patch body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 55 }));

    await client.createWorkItem("User Story", { title: "US" }, undefined, {
      "/fields/Custom.Sponsors": "Juan",
      "/fields/Custom.USProducto": "yWhatsApp",
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ path: string; value: unknown }>;

    expect(body.find((op) => op.path === "/fields/Custom.Sponsors")!.value).toBe("Juan");
    expect(body.find((op) => op.path === "/fields/Custom.USProducto")!.value).toBe("yWhatsApp");
  });

  it("includes customFields alongside parent relation", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 56 }));

    await client.createWorkItem("Task", { title: "Child" }, {
      parentId: 10,
      relationType: "System.LinkTypes.Hierarchy-Reverse",
    }, {
      "/fields/Custom.Extra": "value",
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ path: string; value: unknown }>;

    expect(body.find((op) => op.path === "/fields/Custom.Extra")!.value).toBe("value");
    expect(body.find((op) => op.path === "/relations/-")).toBeDefined();
  });

  it("works without customFields (backwards compatible)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 57 }));

    await client.createWorkItem("Bug", { title: "Old-style call" });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ path: string }>;

    // Should only have known fields, no custom paths
    const hasCustom = body.some((op) => op.path.startsWith("/fields/Custom."));
    expect(hasCustom).toBe(false);
  });
});

describe("buildFieldPatchOps value coercion", () => {
  it("sends boolean strings as real booleans for Boolean fields", () => {
    expect(buildFieldPatchOps({}, { "/fields/Custom.Vulnerability": "False" })).toEqual([
      { op: "add", path: "/fields/Custom.Vulnerability", value: false },
    ]);
  });

  it("leaves dates, numbers and picklist values as strings", () => {
    expect(
      buildFieldPatchOps({}, {
        "/fields/Custom.Version": "1.0",
        "/fields/Custom.TargetDate": "2026-08-13",
        "/fields/Custom.Classification": "US Producto",
      }),
    ).toEqual([
      { op: "add", path: "/fields/Custom.Version", value: "1.0" },
      { op: "add", path: "/fields/Custom.TargetDate", value: "2026-08-13" },
      { op: "add", path: "/fields/Custom.Classification", value: "US Producto" },
    ]);
  });
});
