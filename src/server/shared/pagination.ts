import { badRequest } from "./errors";

type CursorEnvelope = {
  v: 1;
  fingerprint: string;
  value: string[];
};

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function queryFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key] ?? null]));
}

export function encodeCursor(value: string[], fingerprint: string): string {
  return base64UrlEncode(JSON.stringify({ v: 1, fingerprint, value } satisfies CursorEnvelope));
}

export function decodeCursor(text: string | undefined, fingerprint: string): string[] | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(text)) as CursorEnvelope;
    if (parsed.v !== 1 || parsed.fingerprint !== fingerprint || !Array.isArray(parsed.value)) throw new Error();
    if (!parsed.value.every((item) => typeof item === "string")) throw new Error();
    return parsed.value;
  } catch {
    throw badRequest("分页游标无效或不属于当前查询");
  }
}
