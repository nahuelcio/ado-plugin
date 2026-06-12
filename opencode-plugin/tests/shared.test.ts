import { describe, expect, it } from "vitest";
import {
  validatePAT,
  reviewerMatchesUser,
  fmtPR,
  fmtWorkItem,
  shortBranch,
  resolveOrgUrl,
  asAdoConfig,
  resolveActiveProfile,
} from "../src/shared.js";

describe("PAT validation", () => {
  it("rejects empty PAT", () => {
    expect(() => validatePAT("")).toThrow("PAT cannot be empty");
    expect(() => validatePAT(undefined as any)).toThrow("PAT cannot be empty");
  });

  it("rejects short PATs", () => {
    expect(() => validatePAT("short")).toThrow("PAT is too short");
  });

  it("rejects overly long PATs", () => {
    expect(() => validatePAT("a".repeat(200))).toThrow("PAT is too long");
  });

  it("rejects PATs with invalid characters", () => {
    expect(() => validatePAT("pat@with$invalid&chars")).toThrow("Invalid PAT format");
  });

  it("accepts valid PAT format", () => {
    const validPat = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_=";
    expect(() => validatePAT(validPat)).not.toThrow();
  });
});

describe("reviewer matching", () => {
  it("matches by ID", () => {
    const reviewer = { id: "user123", uniqueName: "testuser" };
    expect(reviewerMatchesUser(reviewer, "user123")).toBe(true);
  });

  it("matches by votedBy ID", () => {
    const reviewer = { votedBy: { id: "user123" } };
    expect(reviewerMatchesUser(reviewer, "user123")).toBe(true);
  });

  it("matches by uniqueName", () => {
    const reviewer = { uniqueName: "testuser" };
    expect(reviewerMatchesUser(reviewer, "testuser")).toBe(true);
  });

  it("handles null reviewer", () => {
    expect(reviewerMatchesUser(null, "user123")).toBe(false);
  });

  it("handles undefined userId", () => {
    expect(reviewerMatchesUser({ id: "user123" }, undefined)).toBe(false);
  });
});

describe("PR formatting", () => {
  const samplePR = {
    pullRequestId: 123,
    title: "Fix bug in authentication",
    status: "active",
    sourceRefName: "refs/heads/feature-auth",
    targetRefName: "refs/heads/main",
    isDraft: false,
    createdBy: { displayName: "John Doe" },
    repository: { name: "web-api" },
  };

  it("formats PR as single line", () => {
    const result = fmtPR(samplePR);
    expect(result).toContain("#123");
    expect(result).toContain("Fix bug in authentication");
    expect(result).toContain("web-api feature-auth→main");
    expect(result).toContain("@John Doe");
  });

  it("includes [DRAFT] for draft PRs", () => {
    const draftPR = { ...samplePR, isDraft: true };
    const result = fmtPR(draftPR);
    expect(result).toContain("[D]");
  });
});

describe("Work item formatting", () => {
  const sampleWorkItem = {
    id: 456,
    fields: {
      "System.Title": "Implement login feature",
      "System.State": "New",
      "System.WorkItemType": "User Story",
      "System.AssignedTo": { displayName: "Jane Smith" },
      "Microsoft.VSTS.Common.Priority": 2,
      "System.ChangedDate": "2024-01-01T00:00:00Z",
    },
  };

  it("formats work item as single line", () => {
    const result = fmtWorkItem(sampleWorkItem);
    expect(result).toContain("#456");
    expect(result).toContain("Implement login feature");
    expect(result).toContain("[US]");
    expect(result).toContain("New");
    expect(result).toContain("P2");
    expect(result).toContain("@Jane");
  });
});

describe("Branch shortening", () => {
  it("removes refs/heads/ prefix", () => {
    expect(shortBranch("refs/heads/main")).toBe("main");
    expect(shortBranch("refs/heads/feature/new-auth")).toBe("feature/new-auth");
  });

  it("removes refs/tags/ prefix", () => {
    expect(shortBranch("refs/tags/v1.0.0")).toBe("v1.0.0");
  });

  it("handles undefined input", () => {
    expect(shortBranch(undefined)).toBe("?");
    expect(shortBranch("")).toBe("?");
  });
});

describe("Org URL resolution", () => {
  it("handles full URLs", () => {
    expect(resolveOrgUrl("https://dev.azure.com/myorg")).toBe("https://dev.azure.com/myorg");
    expect(resolveOrgUrl("https://dev.azure.com/myorg/")).toBe("https://dev.azure.com/myorg");
  });

  it("handles short names", () => {
    expect(resolveOrgUrl("myorg")).toBe("https://dev.azure.com/myorg");
  });
});

describe("ADO config parsing", () => {
  it("parses valid config", () => {
    const config = {
      ado: {
        defaultProfile: "work",
        profiles: {
          work: {
            org: "myorg",
            project: "myproject",
            patEnvVar: "ADO_PAT",
            repos: ["backend", "frontend"],
          },
        },
      },
    };
    const result = asAdoConfig(config);
    expect(result).toBeTruthy();
    expect(result?.profiles.work.org).toBe("myorg");
  });

  it("returns undefined for invalid config", () => {
    expect(asAdoConfig(null)).toBeUndefined();
    expect(asAdoConfig("invalid")).toBeUndefined();
    expect(asAdoConfig({})).toBeUndefined();
  });
});

describe("Profile resolution", () => {
  const config = {
    defaultProfile: "work",
    profiles: {
      work: {
        org: "myorg",
        project: "myproject",
        patEnvVar: "ADO_PAT",
        repos: ["backend"],
        default: true,
      },
      personal: {
        org: "myorg",
        project: "personal",
        patEnvVar: "ADO_PAT",
        repos: ["frontend"],
      },
    },
  };

  it("resolves explicit default profile", () => {
    const result = resolveActiveProfile(config);
    expect(result.name).toBe("work");
  });

  it("resolves profile marked as default", () => {
    const noExplicitDefault = { ...config, defaultProfile: undefined };
    const result = resolveActiveProfile(noExplicitDefault);
    expect(result.name).toBe("work");
  });

  it("uses first profile as fallback", () => {
    const noDefaults = {
      ...config,
      defaultProfile: undefined,
      profiles: {
        personal: {
          org: "myorg",
          project: "personal",
          patEnvVar: "ADO_PAT",
          repos: ["frontend"],
        },
      },
    };
    const result = resolveActiveProfile(noDefaults);
    expect(result.name).toBe("personal");
  });
});