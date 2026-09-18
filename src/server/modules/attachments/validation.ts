import { LIMITS } from "../../../shared/limits";
import { badRequest, payloadTooLarge, unsupportedMedia } from "../../shared/errors";

export const IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

export interface ValidatedImageUpload {
  bytes: Uint8Array;
  filename: string;
  contentType: ImageContentType;
  size: number;
}

function contentLength(request: Request): number | null {
  const value = request.headers.get("Content-Length");
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = contentLength(request);
  if (declared !== null && declared > limit) throw payloadTooLarge("上传请求不能超过 11 MiB");
  if (!request.body) throw badRequest("缺少上传内容");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        try {
          await reader.cancel("upload too large");
        } catch {
          // Preserve the bounded-read error even when the client stream cannot be cancelled cleanly.
        }
        throw payloadTooLarge("上传请求不能超过 11 MiB");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizedFilename(value: string): string {
  const leaf = [...(value.split(/[\\/]/).at(-1) ?? "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (!leaf) throw badRequest("图片文件名不能为空");
  if (leaf.length > 255) throw badRequest("图片文件名不能超过 255 个字符");
  return leaf;
}

function bytesEqual(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiEquals(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.byteLength < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

export function detectImageType(bytes: Uint8Array): ImageContentType | null {
  if (
    bytes.byteLength >= 24
    && bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && asciiEquals(bytes, 12, "IHDR")
  ) {
    return "image/png";
  }

  if (
    bytes.byteLength >= 4
    && bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])
    && bytes[3] !== 0x00
    && bytes[3] !== 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.byteLength >= 10
    && (asciiEquals(bytes, 0, "GIF87a") || asciiEquals(bytes, 0, "GIF89a"))
  ) {
    return "image/gif";
  }

  if (
    bytes.byteLength >= 16
    && asciiEquals(bytes, 0, "RIFF")
    && asciiEquals(bytes, 8, "WEBP")
  ) {
    const declaredPayloadSize = (
      bytes[4]!
      | (bytes[5]! << 8)
      | (bytes[6]! << 16)
      | (bytes[7]! << 24)
    ) >>> 0;
    if (declaredPayloadSize + 8 === bytes.byteLength) return "image/webp";
  }

  return null;
}

export async function validateImageUpload(file: File): Promise<ValidatedImageUpload> {
  if (file.size < 1) throw badRequest("图片不能为空");
  if (file.size > LIMITS.imageBytes) throw payloadTooLarge("图片不能超过 10 MiB");

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > LIMITS.imageBytes) throw payloadTooLarge("图片不能超过 10 MiB");
  const detected = detectImageType(bytes);
  if (!detected) throw unsupportedMedia("仅支持有效的 PNG、JPEG、WebP 或 GIF 图片");

  const declared = file.type.toLowerCase().split(";", 1)[0]?.trim();
  if (declared !== detected) throw unsupportedMedia("图片声明类型与实际文件格式不一致");

  return {
    bytes,
    filename: normalizedFilename(file.name),
    contentType: detected,
    size: bytes.byteLength,
  };
}

export async function readImageUpload(request: Request): Promise<ValidatedImageUpload> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !/\bboundary=/i.test(contentType)) {
    throw unsupportedMedia("请使用 multipart/form-data 上传图片");
  }

  const body = await readBoundedBody(request, LIMITS.multipartRequestBytes);
  let form: FormData;
  try {
    const responseBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(responseBody).set(body);
    form = await new Response(responseBody, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw badRequest("multipart 上传内容无效");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("multipart 字段 file 必须是一张图片");
  return validateImageUpload(file);
}

function stripMarkdownCode(markdown: string): string {
  return markdown
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/** Extracts inline and reference-style image URLs for server-side policy checks. */
export function extractMarkdownImageUrls(markdown: string): string[] {
  const source = stripMarkdownCode(markdown);
  const definitions = new Map<string, string>();
  for (const match of source.matchAll(/^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    const label = match[1]?.trim().toLowerCase();
    const url = match[2] ?? match[3];
    if (label && url) definitions.set(label, url);
  }

  const urls: string[] = [];
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const url = match[1] ?? match[2];
    if (url) urls.push(url);
  }
  for (const match of source.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const label = (match[2] || match[1] || "").trim().toLowerCase();
    const url = definitions.get(label);
    if (url) urls.push(url);
  }
  for (const match of source.matchAll(/!\[([^\]]+)\](?![ \t]*(?:\[|\())/g)) {
    const label = match[1]?.trim().toLowerCase();
    const url = label ? definitions.get(label) : undefined;
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}
