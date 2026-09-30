import { describe, expect, it } from "vitest";
import { oauthReturnPath } from "../../src/web/lib/oauth-return";

describe("OAuth login return path", () => {
  it("resumes only the local OAuth authorization page and rejects external or ambiguous paths", () => {
    const origin = "https://personal-hub.echem.ai";
    expect(oauthReturnPath(`?return_to=${encodeURIComponent("/oauth/authorize?client_id=test")}`, origin)).toBe("/oauth/authorize?client_id=test");
    expect(oauthReturnPath("?return_to=%2Foauth%2Fconnections", origin)).toBe("/oauth/connections");
    for (const path of ["https://evil.example", "//evil.example", "/\\evil.example", "/admin/security", "/oauth/authorize#fragment", "/oauth/authorize/../other"]) {
      expect(oauthReturnPath(`?return_to=${encodeURIComponent(path)}`, origin)).toBeNull();
    }
  });
});
