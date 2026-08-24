/**
 * Unit tests for lib/role-context/template — placeholder interpolation.
 *
 * The core regression: values are inserted literally. String.replace's
 * replacement-string semantics ($&, $', $`, $$) must never be interpreted,
 * since LLM-controlled values (agent names) flow straight into interpolate.
 *
 * Run: bun test tests/template.test.ts
 */
import { describe, it, expect } from "bun:test";
import { interpolate } from "../extensions/lib/role-context/template.ts";

describe("interpolate", () => {
  it("replaces all occurrences of a placeholder", () => {
    expect(interpolate("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(interpolate("{{a}} {{b}}", { a: "x" })).toBe("x {{b}}");
  });

  it("inserts dollar-containing values literally", () => {
    const t = "You are {{displayName}} ({{name}}), with tools: {{tools}}";
    const vars = { displayName: "Foo$'", name: "Foo$'", tools: "read,grep" };
    expect(interpolate(t, vars)).toBe(
      "You are Foo$' (Foo$'), with tools: read,grep",
    );
  });

  it("never interprets replacement-string sequences", () => {
    const t = "X{{name}}Y";
    for (const [name, want] of [
      ["A$&B", "XA$&BY"],
      ["A$$B", "XA$$BY"],
      ["A$'B", "XA$'BY"],
      ["A$`B", "XA$`BY"],
      ["A$1B", "XA$1BY"],
    ]) {
      expect(interpolate(t, { name })).toBe(want);
    }
  });
});
