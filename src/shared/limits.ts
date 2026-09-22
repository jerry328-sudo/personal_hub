export const LIMITS = {
  titleCharacters: 200,
  agentNameCharacters: 80,
  agentDescriptionCharacters: 1_000,
  markdownBytes: 256 * 1024,
  jsonRequestBytes: 320 * 1024,
  imageBytes: 10 * 1024 * 1024,
  multipartRequestBytes: 11 * 1024 * 1024,
  defaultPageSize: 20,
  maxPageSize: 100,
  responseBytes: 2 * 1024 * 1024,
  reportNoteCharacters: 2_000,
  taskTitleCharacters: 200,
  maxActiveKeys: 2,
  maxReadTargets: 500,
} as const;

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
