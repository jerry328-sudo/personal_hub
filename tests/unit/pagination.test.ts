import { describe, expect, it } from "vitest";
import { AppError } from "../../src/server/shared/errors";
import {
  decodeCursor,
  encodeCursor,
  queryFingerprint,
  type CursorScope,
} from "../../src/server/shared/pagination";

const agentScope: CursorScope = { role: "agent", reader: null, revision: null };
const readerScope: CursorScope = { role: "reader", reader: "reader-1", revision: 3 };

describe("queryFingerprint", () => {
  it("is independent of object key insertion order", () => {
    const first = queryFingerprint({ agent_id: "agent-1", completion: "done", limit: 20 });
    const second = queryFingerprint({ limit: 20, completion: "done", agent_id: "agent-1" });

    expect(first).toBe(second);
  });

  it("normalizes missing-like values while preserving actual filter changes", () => {
    expect(queryFingerprint({ cursor: undefined })).toBe(queryFingerprint({ cursor: null }));
    expect(queryFingerprint({ completion: "all" })).not.toBe(queryFingerprint({ completion: "done" }));
  });
});

describe("pagination cursors", () => {
  it("round-trips string tuple values", () => {
    const fingerprint = queryFingerprint({ order: "updated_desc", completion: "all" });
    const encoded = encodeCursor(["2026-09-18T12:00:00.000Z", "entry-42"], fingerprint, agentScope);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, fingerprint, agentScope)).toEqual([
      "2026-09-18T12:00:00.000Z",
      "entry-42",
    ]);
  });

  it("returns null when no cursor was supplied", () => {
    expect(decodeCursor(undefined, queryFingerprint({}), agentScope)).toBeNull();
    expect(decodeCursor("", queryFingerprint({}), agentScope)).toBeNull();
  });

  it("rejects a cursor when any bound query filter changes", () => {
    const original = queryFingerprint({ agent_id: "agent-1", completion: "all", order: "id_asc" });
    const changed = queryFingerprint({ agent_id: "agent-1", completion: "done", order: "id_asc" });
    const cursor = encodeCursor(["entry-20"], original, agentScope);

    expect(() => decodeCursor(cursor, changed, agentScope)).toThrowError(AppError);
    try {
      decodeCursor(cursor, changed, agentScope);
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "invalid_cursor",
        message: "分页游标无效或不属于当前查询",
      });
    }
  });

  it("distinguishes a permission revision change from a filter change", () => {
    const fingerprint = queryFingerprint({ view: "brief" });
    const cursor = encodeCursor(["entry-20"], fingerprint, readerScope);

    try {
      decodeCursor(cursor, fingerprint, { ...readerScope, revision: 4 });
      throw new Error("expected cursor scope change");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "cursor_scope_changed",
        details: { restart_from_first_page: true },
      });
    }
  });

  it("rejects a cursor issued to a different identity or role", () => {
    const fingerprint = queryFingerprint({ view: "brief" });
    const cursor = encodeCursor(["entry-20"], fingerprint, readerScope);

    expect(() => decodeCursor(cursor, fingerprint, { ...readerScope, reader: "reader-2" })).toThrowError(AppError);
    expect(() => decodeCursor(cursor, fingerprint, agentScope)).toThrowError(AppError);
  });

  it.each([
    "not-base64-json",
    // { v: 1, fingerprint: "fp", value: [1] }
    "eyJ2IjoxLCJmaW5nZXJwcmludCI6ImZwIiwidmFsdWUiOlsxXX0",
    // { v: 2, fingerprint: "fp", value: ["entry-1"] } but without a scope field
    "eyJ2IjoyLCJmaW5nZXJwcmludCI6ImZwIiwidmFsdWUiOlsiZW50cnktMSJdfQ",
  ])("rejects malformed or unsupported cursor %s", (cursor) => {
    expect(() => decodeCursor(cursor, "fp", agentScope)).toThrowError("分页游标无效或不属于当前查询");
  });
});
