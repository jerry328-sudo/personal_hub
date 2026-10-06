import { extractMarkdownImageUrls } from "./markdown-images";

const MEDIA_PREFIX = "/api/v1/media/";
const ATTACHMENT_ID = /^[a-z0-9][a-z0-9-]{2,127}$/i;

export function attachmentIdFromUrl(value: string): string | null {
  if (!value.startsWith(MEDIA_PREFIX)) return null;
  const tail = value.slice(MEDIA_PREFIX.length);
  if (!ATTACHMENT_ID.test(tail)) return null;
  return tail;
}

export function extractAttachmentIds(markdown: string): string[] {
  return extractMarkdownImageUrls(markdown)
    .map(attachmentIdFromUrl).filter((id): id is string => id !== null);
}

export function findUnsupportedImageUrls(markdown: string): string[] {
  return extractMarkdownImageUrls(markdown).filter((url) => attachmentIdFromUrl(url) === null);
}

export function isAllowedLink(value: string): boolean {
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
