import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const ORIGIN = "http://localhost:5173";
const SECRET = "test-admin-secret-with-sufficient-entropy";
const ROOT = "/api/v1/auth/passkeys";
const encode = (value: Uint8Array<ArrayBuffer>) => isoBase64URL.fromBuffer(value);
const bytes = (value: string) => new TextEncoder().encode(value);
function concat(...parts: Uint8Array<ArrayBuffer>[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
async function hash(value: Uint8Array<ArrayBuffer>) { return new Uint8Array(await crypto.subtle.digest("SHA-256", value)); }
function cookie(response: Response, prefix: string) {
  const value = response.headers.getSetCookie().find(c => c.startsWith(prefix + "="));
  expect(value).toBeTruthy();
  return value!.split(";", 1)[0]!;
}
async function api(path: string, method = "GET", body?: unknown, cookies = "", origin = ORIGIN) {
  if (!("default" in exports)) throw new Error("Worker missing");
  return (exports.default as Fetcher).fetch(new Request(ORIGIN + path, {
    method, headers: { Origin: origin, Cookie: cookies, "Content-Type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function admin(secret = SECRET) {
  const r = await api("/api/v1/auth/login", "POST", { secret });
  expect(r.status).toBe(200);
  return cookie(r, "__Host-ph_session");
}

// A software authenticator exercises the real verifier and cryptography inside Workers.
async function authenticator(rsa = false) {
  const pair = rsa
    ? await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array<ArrayBuffer>>(rsa ? [
    [1, 3], [3, -257], [-1, isoBase64URL.toBuffer(jwk.n!)], [-2, isoBase64URL.toBuffer(jwk.e!)],
  ] : [
    [1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x!)], [-3, isoBase64URL.toBuffer(jwk.y!)],
  ]));
  const id = crypto.getRandomValues(new Uint8Array(32));
  async function authData(flags: number, counter: number, rp = "localhost") {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    return concat(await hash(bytes(rp)), new Uint8Array([flags]), count);
  }
  return {
    id: encode(id),
    register: async (options: PublicKeyCredentialCreationOptionsJSON, flags = 0x45): Promise<RegistrationResponseJSON> => {
      const client = bytes(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN }));
      const data = concat(await authData(flags, 0), new Uint8Array(16), new Uint8Array([0, id.length]), id, cose);
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array<ArrayBuffer> | Map<string, never>>([
        ["fmt", "none"], ["attStmt", new Map<string, never>()], ["authData", data],
      ]));
      return { id: encode(id), rawId: encode(id), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: encode(client), attestationObject: encode(attestation) } };
    },
    sign: async (options: PublicKeyCredentialRequestOptionsJSON, userHandle: string,
      overrides: { origin?: string; rp?: string; challenge?: string; flags?: number; counter?: number } = {}): Promise<AuthenticationResponseJSON> => {
      const client = bytes(JSON.stringify({ type: "webauthn.get", challenge: overrides.challenge ?? options.challenge, origin: overrides.origin ?? ORIGIN }));
      const data = await authData(overrides.flags ?? 0x05, overrides.counter ?? 1, overrides.rp);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: rsa ? "RSASSA-PKCS1-v1_5" : "ECDSA", hash: "SHA-256" }, pair.privateKey, concat(data, await hash(client))));
      function integer(part: Uint8Array<ArrayBuffer>) {
        let first = 0;
        while (first < part.length - 1 && part[first] === 0) first++;
        const trimmed = part.slice(first);
        const value = trimmed[0]! & 128 ? concat(new Uint8Array([0]), trimmed) : trimmed;
        return concat(new Uint8Array([2, value.length]), value);
      }
      const ints = rsa ? raw : concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
      return { id: encode(id), rawId: encode(id), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: encode(client), authenticatorData: encode(data), signature: encode(rsa ? raw : concat(new Uint8Array([48, ints.length]), ints)), userHandle } };
    },
  };
}
async function registerStart(session: string, name = "Test device") {
  const response = await api(ROOT + "/register/options", "POST", { name, secret: SECRET }, session);
  expect(response.status).toBe(200);
  const options = await response.json<PublicKeyCredentialCreationOptionsJSON>();
  return { options, cookies: `${session}; ${cookie(response, "__Host-ph_webauthn")}` };
}
async function bind(session: string, rsa = false) {
  const device = await authenticator(rsa);
  const start = await registerStart(session);
  const response = await api(ROOT + "/register/verify", "POST", await device.register(start.options), start.cookies);
  expect(response.status).toBe(201);
  return { device, userHandle: start.options.user.id, id: (await response.json<{ id: string }>()).id };
}
async function loginStart() {
  const r = await api(ROOT + "/login/options", "POST");
  expect(r.status).toBe(200);
  return { options: await r.json<PublicKeyCredentialRequestOptionsJSON>(), cookies: cookie(r, "__Host-ph_webauthn") };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"), env.DB.prepare("DELETE FROM admin_passkeys"),
    env.DB.prepare("DELETE FROM webauthn_challenges"),
    env.DB.prepare("UPDATE admin_credentials SET secret_hash = NULL, revision = 0 WHERE id = 1"),
  ]);
});

describe("Passkeys", () => {
  it("supports RS256 credentials used by Windows authenticators", async () => {
    const bound = await bind(await admin(), true);
    const start = await loginStart();
    expect((await api(ROOT + "/login/verify", "POST", await bound.device.sign(start.options, bound.userHandle), start.cookies)).status).toBe(200);
  });
  it("registers, logs out without removing binding, logs in with a signed assertion, rejects replay, and revokes sessions on removal", async () => {
    const session = await admin();
    const bound = await bind(session);
    const list = await api(ROOT, "GET", undefined, session);
    expect(await list.json()).toMatchObject({ items: [{ id: bound.id, name: "Test device", last_used_at: null }] });
    await api("/api/v1/auth/logout", "POST", undefined, session);
    const start = await loginStart();
    const assertion = await bound.device.sign(start.options, bound.userHandle);
    const response = await api(ROOT + "/login/verify", "POST", assertion, start.cookies);
    expect(response.status).toBe(200);
    const loggedIn = cookie(response, "__Host-ph_session");
    expect((await api("/api/v1/auth/session", "GET", undefined, loggedIn)).status).toBe(200);
    expect((await api(ROOT + "/login/verify", "POST", assertion, start.cookies)).status).toBe(400);
    const keeper = await admin();
    expect((await api(ROOT + "/" + bound.id, "DELETE", undefined, keeper)).status).toBe(204);
    expect((await api("/api/v1/auth/session", "GET", undefined, loggedIn)).status).toBe(401);
    const again = await loginStart();
    expect((await api(ROOT + "/login/verify", "POST", await bound.device.sign(again.options, bound.userHandle, { counter: 2 }), again.cookies)).status).toBe(401);
    expect((await api("/api/v1/auth/session", "GET", undefined, keeper)).status).toBe(200);
  });

  it("requires a session, current admin secret and same-origin for registration and management", async () => {
    expect((await api(ROOT + "/register/options", "POST", { name: "a", secret: SECRET })).status).toBe(401);
    const session = await admin();
    expect((await api(ROOT + "/register/options", "POST", { name: "a", secret: "wrong" }, session)).status).toBe(403);
    expect((await api(ROOT + "/register/options", "POST", { name: "a", secret: SECRET }, session, "https://evil.example")).status).toBe(403);
    expect((await api(ROOT + "/login/options", "POST", undefined, "", "https://evil.example")).status).toBe(403);
    const bound = await bind(session);
    expect((await api(ROOT + "/" + bound.id, "DELETE", undefined, session, "https://evil.example")).status).toBe(403);
  });

  it("binds registration to the initiating session, consumes it once and requires user verification", async () => {
    const session = await admin();
    const other = await admin();
    const device = await authenticator();
    const start = await registerStart(session);
    const response = await device.register(start.options);
    expect((await api(ROOT + "/register/verify", "POST", response, start.cookies.replace(session, other))).status).toBe(400);
    expect((await api(ROOT + "/register/verify", "POST", response, start.cookies)).status).toBe(201);
    expect((await api(ROOT + "/register/verify", "POST", response, start.cookies)).status).toBe(400);
    const noUV = await registerStart(session);
    expect((await api(ROOT + "/register/verify", "POST", await device.register(noUV.options, 0x41), noUV.cookies)).status).toBe(400);
  });

  it.each([
    { origin: "https://evil.example" }, { rp: "evil.example" }, { challenge: "wrong" },
    { flags: 0x01 }, { flags: 0x04 },
  ])("rejects signed assertions with invalid origin, RP, challenge, user verification or presence: %j", async overrides => {
    const bound = await bind(await admin());
    const start = await loginStart();
    const assertion = await bound.device.sign(start.options, bound.userHandle, overrides);
    expect((await api(ROOT + "/login/verify", "POST", assertion, start.cookies)).status).toBe(401);
    expect((await api(ROOT + "/login/verify", "POST", assertion, start.cookies)).status).toBe(400);
  });

  it("rejects an incorrect signature, wrong user handle, and missing browser challenge cookie", async () => {
    const bound = await bind(await admin());
    for (const mode of ["signature", "user", "cookie"]) {
      const start = await loginStart();
      const assertion = await bound.device.sign(start.options, mode === "user" ? "wrong" : bound.userHandle);
      if (mode === "signature") assertion.response.signature = encode(new Uint8Array(72));
      expect((await api(ROOT + "/login/verify", "POST", assertion, mode === "cookie" ? "" : start.cookies)).status).toBe(mode === "cookie" ? 400 : 401);
    }
  });

  it("expires challenges and rejects a consumed challenge in parallel", async () => {
    const bound = await bind(await admin());
    const expired = await loginStart();
    await env.DB.prepare("UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await api(ROOT + "/login/verify", "POST", await bound.device.sign(expired.options, bound.userHandle), expired.cookies)).status).toBe(400);
    const start = await loginStart();
    const assertion = await bound.device.sign(start.options, bound.userHandle);
    const results = await Promise.all([api(ROOT + "/login/verify", "POST", assertion, start.cookies), api(ROOT + "/login/verify", "POST", assertion, start.cookies)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it("accepts zero counters for synced credentials, but rejects a stale positive counter", async () => {
    const bound = await bind(await admin());
    const statuses: number[] = [];
    for (const counter of [0, 0, 5, 5]) {
      const start = await loginStart();
      const response = await api(ROOT + "/login/verify", "POST", await bound.device.sign(start.options, bound.userHandle, { counter }), start.cookies);
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 401]);
  });

  it("rotating the admin secret revokes passkeys, existing sessions and pending ceremonies", async () => {
    const session = await admin();
    const bound = await bind(session);
    const pending = await loginStart();
    const changed = await api("/api/v1/auth/change-secret", "POST", { current_secret: SECRET, new_secret: SECRET + "-new" }, session);
    expect(changed.status).toBe(204);
    expect((await api("/api/v1/auth/session", "GET", undefined, session)).status).toBe(401);
    expect((await api(ROOT + "/login/verify", "POST", await bound.device.sign(pending.options, bound.userHandle), pending.cookies)).status).toBe(400);
    const current = await admin(SECRET + "-new");
    expect(await (await api(ROOT, "GET", undefined, current)).json()).toEqual({ items: [] });
    const fresh = await loginStart();
    expect((await api(ROOT + "/login/verify", "POST", await bound.device.sign(fresh.options, bound.userHandle), fresh.cookies)).status).toBe(401);
  });
});
