import { describe, expect, it } from "vitest";
import { parseFieldFlags, stripJsonComments } from "../src/bin/opencode-ado.js";

describe("stripJsonComments", () => {
  it("strips single-line comments", () => {
    const input = `{\n  // a comment\n  "key": "value"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("strips block comments", () => {
    const input = `{\n  /* block */\n  "key": "value"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("preserves string values that contain slashes", () => {
    const input = `{"url": "https://example.com"}`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({ url: "https://example.com" });
  });

  it("does not corrupt JSON when a comment contains an apostrophe", () => {
    // Before the fix, "user's" would open a string context on the apostrophe,
    // causing the rest of the comment (including //) to leak into output and
    // break JSON.parse.
    const input = `{\n  // user's config\n  "name": "alice"\n}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({ name: "alice" });
  });

  it("does not corrupt JSON when a block comment contains an apostrophe", () => {
    const input = `{\n  /* it's a block */\n  "key": "val"\n}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({ key: "val" });
  });

  it("preserves apostrophes inside JSON string values", () => {
    // Apostrophes inside double-quoted strings must pass through unchanged
    const input = `{"msg": "it's fine"}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ msg: "it's fine" });
  });

  it("handles escaped double-quotes inside strings", () => {
    const input = `{"key": "say \\"hello\\""}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: `say "hello"` });
  });
});

describe("parseFieldFlags", () => {
  it("returns undefined when no --field flag is present", () => {
    expect(parseFieldFlags(["create", "--title", "x"])).toBeUndefined();
  });

  it("collects repeated --field flags and prefixes bare names", () => {
    expect(
      parseFieldFlags(["--field", "Custom.Sponsors=ACME", "--field", "/fields/Custom.Team=Core"]),
    ).toEqual({ "/fields/Custom.Sponsors": "ACME", "/fields/Custom.Team": "Core" });
  });

  it("keeps values containing '='", () => {
    expect(parseFieldFlags(["--field", "Custom.Q=a=b"])).toEqual({ "/fields/Custom.Q": "a=b" });
  });

  it("throws when the value has no '='", () => {
    expect(() => parseFieldFlags(["--field", "Custom.Sponsors"])).toThrow(/Invalid --field/);
  });
});
