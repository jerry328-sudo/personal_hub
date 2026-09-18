import { describe, expect, it } from "vitest";
import { AppError } from "../../src/server/shared/errors";
import {
  decodeCursor,
  encodeCursor,
  queryFingerprint,
} from "../../src/server/shared/pagination";

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
    const encoded = encodeCursor(["2026-09-18T12:00:00.000Z", "entry-42"], fingerprint);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, fingerprint)).toEqual([
      "2026-09-18T12:00:00.000Z",
      "entry-42",
    ]);
  });

  it("returns null when no cursor was supplied", () => {
    expect(decodeCursor(undefined, queryFingerprint({}))).toBeNull();
    expect(decodeCursor("", queryFingerprint({}))).toBeNull();
  });

  it("rejects a cursor when any bound query filter changes", () => {
    const original = queryFingerprint({ agent_id: "agent-1", completion: "all", order: "id_asc" });
    const changed = queryFingerprint({ agent_id: "agent-1", completion: "done", order: "id_asc" });
    const cursor = encodeCursor(["entry-20"], original);

    expect(() => decodeCursor(cursor, changed)).toThrowError(AppError);
    try {
      decodeCursor(cursor, changed);
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "bad_request",
        message: "分页游标无效或不属于当前查询",
      });
    }
  });

  it.each([
    "not-base64-json",
    // { v: 1, fingerprint: "fp", value: [1] }
    "eyJ2IjoxLCJmaW5nZXJwcmludCI6ImZwIiwidmFsdWUiOlsxXX0",
    // { v: 2, fingerprint: "fp", value: ["entry-1"] }
    "eyJ2IjoyLCJmaW5nZXJwcmludCI6ImZwIiwidmFsdWUiOlsiZW50cnktMSJdfQ",
  ])("rejects malformed or unsupported cursor %s", (cursor) => {
    expect(() => decodeCursor(cursor, "fp")).toThrowError("分页游标无效或不属于当前查询");
  });
});
