import { describe, expect, it } from "vitest";
import { LIMITS, utf8Size } from "../../src/shared/limits";
import {
  appendVersionSchema,
  createAgentSchema,
  createEntrySchema,
  entryQuerySchema,
  patchEntryStateSchema,
  patchTaskSchema,
  reportSchema,
} from "../../src/shared/validation";

describe("shared limits", () => {
  it("counts UTF-8 bytes instead of JavaScript code units", () => {
    expect("图".length).toBe(1);
    expect(utf8Size("图")).toBe(3);
    expect(utf8Size("A图")).toBe(4);
  });
});

describe("entry validation", () => {
  it("applies defaults and trims bounded display text", () => {
    const result = createEntrySchema.parse({
      title: "  Release note  ",
      content: " Body whitespace is meaningful. ",
    });

    expect(result).toEqual({
      title: "Release note",
      content: " Body whitespace is meaningful. ",
      important: false,
    });
  });

  it("enforces the Markdown limit in encoded bytes", () => {
    const atLimit = "a".repeat(LIMITS.markdownBytes);
    const overLimit = `${atLimit}a`;
    const multibyteOverLimit = "图".repeat(Math.floor(LIMITS.markdownBytes / 3) + 1);

    expect(createEntrySchema.safeParse({ title: "ok", content: atLimit }).success).toBe(true);
    const result = createEntrySchema.safeParse({ title: "too large", content: overLimit });
    expect(multibyteOverLimit.length).toBeLessThan(LIMITS.markdownBytes);
    expect(createEntrySchema.safeParse({ title: "too large", content: multibyteOverLimit }).success).toBe(false);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["content"], message: "正文过大" }),
      ]));
    }
  });

  it("accepts only HTTP(S) source URLs", () => {
    expect(createEntrySchema.safeParse({
      title: "http",
      content: "body",
      url: "https://example.com/source",
    }).success).toBe(true);
    expect(createEntrySchema.safeParse({
      title: "script",
      content: "body",
      url: "javascript:alert(1)",
    }).success).toBe(false);
  });

  it("requires a positive integer base version and rejects extra fields", () => {
    const valid = { title: "next", content: "full replacement", base_version: 1 };
    expect(appendVersionSchema.safeParse(valid).success).toBe(true);
    expect(appendVersionSchema.safeParse({ ...valid, base_version: 0 }).success).toBe(false);
    expect(appendVersionSchema.safeParse({ ...valid, base_version: 1.5 }).success).toBe(false);
    expect(appendVersionSchema.safeParse({ ...valid, entry_id: "entry-1" }).success).toBe(false);
  });
});

describe("strict object schemas", () => {
  it("rejects unknown fields instead of silently stripping them", () => {
    expect(createAgentSchema.safeParse({ name: "Watcher", enabled: true }).success).toBe(false);
    expect(reportSchema.safeParse({ result: "success", unexpected: true }).success).toBe(false);
  });

  it("requires patch requests to change at least one allowed field", () => {
    expect(patchEntryStateSchema.safeParse({}).success).toBe(false);
    expect(patchTaskSchema.safeParse({}).success).toBe(false);
    expect(patchEntryStateSchema.safeParse({ completed: false }).success).toBe(true);
    expect(patchTaskSchema.safeParse({ done: false }).success).toBe(true);
  });

  it("requires offset-aware timestamps", () => {
    expect(createAgentSchema.safeParse({
      name: "Watcher",
      key_expires_at: "2026-09-18T14:00:00+08:00",
    }).success).toBe(true);
    expect(createAgentSchema.safeParse({
      name: "Watcher",
      key_expires_at: "2026-09-18T14:00:00",
    }).success).toBe(false);
  });
});

describe("query validation", () => {
  it("coerces an integer page size within the documented bounds", () => {
    expect(entryQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(entryQuerySchema.parse({ limit: String(LIMITS.maxPageSize) }).limit).toBe(LIMITS.maxPageSize);
    expect(entryQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(entryQuerySchema.safeParse({ limit: String(LIMITS.maxPageSize + 1) }).success).toBe(false);
    expect(entryQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
  });

  it("rejects unsupported enum values and unknown query keys", () => {
    expect(entryQuerySchema.safeParse({ completion: "finished" }).success).toBe(false);
    expect(entryQuerySchema.safeParse({ sort: "updated_desc" }).success).toBe(false);
  });
});
