const MEDIA_PREFIX = "/api/v1/media/";
const ATTACHMENT_ID = /^[a-z0-9][a-z0-9-]{2,127}$/i;

function stripCode(markdown: string): string {
  return markdown
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}

export function attachmentIdFromUrl(value: string): string | null {
  if (!value.startsWith(MEDIA_PREFIX)) return null;
  const tail = value.slice(MEDIA_PREFIX.length);
  if (!ATTACHMENT_ID.test(tail)) return null;
  return tail;
}

export function extractAttachmentIds(markdown: string): string[] {
  const source = stripCode(markdown);
  const references = new Map<string, string>();
  for (const match of source.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
    if (match[1] && match[2]) references.set(match[1].toLowerCase(), match[2]);
  }
  const urls: string[] = [];
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
    if (match[1]) urls.push(match[1].replace(/^<|>$/g, ""));
  }
  for (const match of source.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const label = (match[2] || match[1] || "").toLowerCase();
    const url = references.get(label);
    if (url) urls.push(url.replace(/^<|>$/g, ""));
  }
  for (const match of source.matchAll(/!\[([^\]]+)\](?![[(])/g)) {
    const url = references.get((match[1] ?? "").toLowerCase());
    if (url) urls.push(url.replace(/^<|>$/g, ""));
  }
  return [...new Set(urls.map(attachmentIdFromUrl).filter((id): id is string => id !== null))];
}

export function findUnsupportedImageUrls(markdown: string): string[] {
  const source = stripCode(markdown);
  const references = new Map<string, string>();
  for (const match of source.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
    if (match[1] && match[2]) references.set(match[1].toLowerCase(), match[2]);
  }
  const inlineUrls = [...source.matchAll(/!\[[^\]]*\]\(([^\s)]+)/g)]
    .map((match) => match[1]?.replace(/^<|>$/g, ""))
    .filter((value): value is string => Boolean(value));
  const referenceUrls = [...source.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)]
    .map((match) => references.get((match[2] || match[1] || "").toLowerCase()))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^<|>$/g, ""));
  const shortcutReferenceUrls = [...source.matchAll(/!\[([^\]]+)\](?![[(])/g)]
    .map((match) => references.get((match[1] ?? "").toLowerCase()))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^<|>$/g, ""));
  const urls = [...inlineUrls, ...referenceUrls, ...shortcutReferenceUrls];
  return urls.filter((url) => attachmentIdFromUrl(url) === null);
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
