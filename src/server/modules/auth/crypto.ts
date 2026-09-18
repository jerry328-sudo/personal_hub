export type CredentialKind = "agent" | "session";

export type ParsedCredential = {
  id: string;
  secret: string;
};

export const SESSION_COOKIE_NAME = "__Host-ph_session";

const AGENT_KEY_PREFIX = "phk";
const SESSION_TOKEN_PREFIX = "phs";
const DEFAULT_SECRET_BYTES = 32;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 64;
const MAX_ID_BYTES = 128;
const MAX_TOKEN_CHARACTERS = 300;
const HMAC_BYTES = 32;
const MIN_ADMIN_SECRET_BYTES = 32;
const MAX_ADMIN_SECRET_CHARACTERS = 1_024;
const MAX_ADMIN_SECRET_BYTES = MAX_ADMIN_SECRET_CHARACTERS * 4;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const credentialDomains: Record<CredentialKind, string> = {
  agent: "personal-hub/credential/v1/agent-key",
  session: "personal-hub/credential/v1/admin-session",
};

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return null;

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function encodeLengthPrefixed(fields: readonly string[]): Uint8Array {
  const encodedFields = fields.map((field) => encoder.encode(field));
  const totalLength = encodedFields.reduce((total, field) => total + 4 + field.byteLength, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  let offset = 0;

  for (const field of encodedFields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    output.set(field, offset);
    offset += field.byteLength;
  }

  return output;
}

function isCredentialKind(value: string): value is CredentialKind {
  return value === "agent" || value === "session";
}

function isValidId(id: string): boolean {
  const bytes = encoder.encode(id);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ID_BYTES) return false;
  return ![...id].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isValidSecret(secret: string): boolean {
  const bytes = decodeBase64Url(secret);
  return bytes !== null && bytes.byteLength >= MIN_SECRET_BYTES && bytes.byteLength <= MAX_SECRET_BYTES;
}

function requireValidId(id: string): void {
  if (!isValidId(id)) throw new TypeError("凭据 ID 格式无效");
}

function requireValidSecret(secret: string): void {
  if (!isValidSecret(secret)) throw new TypeError("凭据秘密格式无效");
}

function requirePepper(pepper: string): void {
  const size = encoder.encode(pepper).byteLength;
  if (size < 16 || size > 4_096) {
    throw new TypeError("AUTH_PEPPER 必须是有效的高强度秘密");
  }
}

async function importHmacKey(secret: Uint8Array | string): Promise<CryptoKey> {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function formatToken(prefix: string, id: string, secret: string): string {
  requireValidId(id);
  requireValidSecret(secret);
  return `${prefix}.${encodeBase64Url(encoder.encode(id))}.${secret}`;
}

function parseToken(text: string, expectedPrefix: string): ParsedCredential | null {
  if (text.length > MAX_TOKEN_CHARACTERS) return null;

  const segments = text.split(".");
  if (segments.length !== 3 || segments[0] !== expectedPrefix) return null;

  const encodedId = segments[1];
  const secret = segments[2];
  if (!encodedId || !secret || !isValidSecret(secret)) return null;

  const idBytes = decodeBase64Url(encodedId);
  if (!idBytes || idBytes.byteLength < 1 || idBytes.byteLength > MAX_ID_BYTES) return null;

  try {
    const id = fatalDecoder.decode(idBytes);
    if (!isValidId(id) || encodeBase64Url(encoder.encode(id)) !== encodedId) return null;
    return { id, secret };
  } catch {
    return null;
  }
}

function credentialMessage(kind: CredentialKind, id: string, secret: string): Uint8Array {
  return encodeLengthPrefixed([credentialDomains[kind], id, secret]);
}

export function generateSecret(bytes = DEFAULT_SECRET_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw new RangeError(`秘密长度必须是 ${MIN_SECRET_BYTES} 到 ${MAX_SECRET_BYTES} 字节的整数`);
  }

  const random = new Uint8Array(bytes);
  crypto.getRandomValues(random);
  return encodeBase64Url(random);
}

export async function hashCredential(
  kind: CredentialKind,
  id: string,
  secret: string,
  pepper: string,
): Promise<string> {
  if (!isCredentialKind(kind)) throw new TypeError("凭据类型无效");
  requireValidId(id);
  requireValidSecret(secret);
  requirePepper(pepper);

  const key = await importHmacKey(pepper);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(credentialMessage(kind, id, secret)),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyCredential(
  kind: CredentialKind,
  id: string,
  secret: string,
  digest: string,
  pepper: string,
): Promise<boolean> {
  if (!isCredentialKind(kind) || !isValidId(id) || !isValidSecret(secret)) return false;

  const signature = decodeBase64Url(digest);
  if (!signature || signature.byteLength !== HMAC_BYTES) return false;
  requirePepper(pepper);

  const key = await importHmacKey(pepper);
  return crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signature),
    toArrayBuffer(credentialMessage(kind, id, secret)),
  );
}

function paddedSecret(secret: string): Uint8Array | null {
  if (secret.length < 1 || secret.length > MAX_ADMIN_SECRET_CHARACTERS) return null;
  const bytes = encoder.encode(secret);
  if (bytes.byteLength > MAX_ADMIN_SECRET_BYTES) return null;

  const padded = new Uint8Array(4 + MAX_ADMIN_SECRET_BYTES);
  new DataView(padded.buffer).setUint32(0, bytes.byteLength, false);
  padded.set(bytes, 4);
  return padded;
}

function configuredAdminSecret(secret: string): Uint8Array {
  const padded = paddedSecret(secret);
  if (!padded || encoder.encode(secret).byteLength < MIN_ADMIN_SECRET_BYTES) {
    throw new TypeError(
      `ADMIN_LOGIN_SECRET 必须至少包含 ${MIN_ADMIN_SECRET_BYTES} 个 UTF-8 字节`,
    );
  }
  return padded;
}

export async function verifyAdminSecret(candidate: string, configuredSecret: string): Promise<boolean> {
  const configured = configuredAdminSecret(configuredSecret);

  const submitted = paddedSecret(candidate);
  if (!submitted) return false;

  const [configuredDigest, submittedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", toArrayBuffer(configured)),
    crypto.subtle.digest("SHA-256", toArrayBuffer(submitted)),
  ]);

  // Web Crypto's HMAC verification performs the equality check without a
  // JavaScript loop whose runtime could reveal the first mismatching byte.
  const comparisonKey = await importHmacKey("personal-hub/admin-secret-compare/v1");
  const submittedSignature = await crypto.subtle.sign("HMAC", comparisonKey, submittedDigest);
  return crypto.subtle.verify("HMAC", comparisonKey, submittedSignature, configuredDigest);
}

export async function hashAdminLoginSecret(secret: string, pepper: string): Promise<string> {
  configuredAdminSecret(secret);
  requirePepper(pepper);
  const key = await importHmacKey(pepper);
  const message = encodeLengthPrefixed(["personal-hub/admin-login/v1", secret]);
  const digest = await crypto.subtle.sign("HMAC", key, toArrayBuffer(message));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function verifyAdminLoginHash(secret: string, digest: string, pepper: string): Promise<boolean> {
  const signature = decodeBase64Url(digest);
  if (!paddedSecret(secret) || !signature || signature.byteLength !== HMAC_BYTES) return false;
  requirePepper(pepper);
  const key = await importHmacKey(pepper);
  const message = encodeLengthPrefixed(["personal-hub/admin-login/v1", secret]);
  return crypto.subtle.verify("HMAC", key, toArrayBuffer(signature), toArrayBuffer(message));
}

export function formatAgentKey(id: string, secret: string): string {
  return formatToken(AGENT_KEY_PREFIX, id, secret);
}

export function parseAgentKey(text: string): ParsedCredential | null {
  return parseToken(text, AGENT_KEY_PREFIX);
}

export function formatSessionToken(id: string, secret: string): string {
  return formatToken(SESSION_TOKEN_PREFIX, id, secret);
}

export function parseSessionToken(text: string): ParsedCredential | null {
  return parseToken(text, SESSION_TOKEN_PREFIX);
}

type CookieExpiry = Date | string | number;

function toCookieDate(value: CookieExpiry): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Session 到期时间无效");
  return date;
}

export function buildSessionCookie(token: string, expiresAt: CookieExpiry): string {
  if (!parseSessionToken(token)) throw new TypeError("Session token 格式无效");
  const expires = toCookieDate(expiresAt).toUTCString();
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expires}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`;
}
