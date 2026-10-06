import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/shared/limits";
import { extractMarkdownImageUrls } from "../../src/shared/markdown-images";
import { extractAttachmentIds, findUnsupportedImageUrls } from "../../src/shared/markdown";
import { extractMarkdownImageUrls as extractServerImages } from "../../src/server/modules/attachments/validation";

const OWN_IMAGE = "/api/v1/media/image-one";
const FOREIGN_IMAGE = "/api/v1/media/foreign-image";

describe("bounded Markdown image scanning", () => {
  it("shares extraction between server policy checks and client previews", () => {
    const markdown = `![inline](<${OWN_IMAGE}> "title")\n![remote][source]\n\n[source]: https://example.com/remote.png`;
    expect(extractMarkdownImageUrls(markdown)).toEqual([OWN_IMAGE, "https://example.com/remote.png"]);
    expect(extractServerImages(markdown)).toEqual(extractMarkdownImageUrls(markdown));
    expect(extractAttachmentIds(markdown)).toEqual(["image-one"]);
    expect(findUnsupportedImageUrls(markdown)).toEqual(["https://example.com/remote.png"]);
  });

  it("normalizes case and whitespace in full, collapsed, and shortcut references", () => {
    const markdown = `![one][SCREEN SHOT]\n![screen\tshot][]\n![screen\nshot]\n\n[Screen   Shot]: <${OWN_IMAGE}> 'description'`;
    expect(extractMarkdownImageUrls(markdown)).toEqual([OWN_IMAGE]);
  });

  it("decodes entities and punctuation escapes before checking media ownership", () => {
    const markdown = "![one](<&#47;api/v1/media/image&#45;one>)\n![two](&sol;api&sol;v1&sol;media&sol;foreign\\-image)";
    expect(extractAttachmentIds(markdown)).toEqual(["image-one", "foreign-image"]);
    expect(extractMarkdownImageUrls(markdown)).toEqual([OWN_IMAGE, FOREIGN_IMAGE]);
  });

  it("keeps nested and escaped alt-label brackets and alt-text code from hiding the destination", () => {
    const markdown = `![outer [inner]](${OWN_IMAGE})\n![escaped\\]](${FOREIGN_IMAGE})\n![a \`]\`](${FOREIGN_IMAGE})`;
    expect(extractMarkdownImageUrls(markdown)).toEqual([OWN_IMAGE, FOREIGN_IMAGE]);
  });

  it("retains balanced destinations, angle destinations, and multiline titles", () => {
    const markdown = `![one](https://example.com/a(b(c)).png)\n![two](<${OWN_IMAGE}>)\n![three](${FOREIGN_IMAGE}\n"multi\nline title")`;
    expect(extractMarkdownImageUrls(markdown)).toEqual(["https://example.com/a(b(c)).png", OWN_IMAGE, FOREIGN_IMAGE]);
  });

  it("ignores ordinary fenced and same-line inline code examples", () => {
    const markdown = `\`\`\`markdown\n![hidden](https://example.com/code.png)\n\`\`\`\n~~~\n![hidden](${FOREIGN_IMAGE})\n~~~\nText \`![hidden](${FOREIGN_IMAGE})\` example.\n![visible](${OWN_IMAGE})`;
    expect(extractMarkdownImageUrls(markdown)).toEqual([OWN_IMAGE]);
  });

  it("does not treat an escaped image opener as an image", () => {
    expect(extractMarkdownImageUrls(`\\![literal](${FOREIGN_IMAGE})\n![real](${OWN_IMAGE})`)).toEqual([OWN_IMAGE]);
  });

  it.each([
    `[x]:\n ${FOREIGN_IMAGE}\n\n![x]`,
    `> [x]:\n> ${FOREIGN_IMAGE}\n\n![x]`,
    `- [x]:\n  ${FOREIGN_IMAGE}\n\n![x]`,
    `> [x\n> y]: ${FOREIGN_IMAGE}\n\n![x y]`,
    `> ![x\n> y]\n\n[x y]: ${FOREIGN_IMAGE}`,
  ])("checks multiline and container reference destinations: %s", (markdown) => {
    expect(extractMarkdownImageUrls(markdown)).toContain(FOREIGN_IMAGE);
  });

  it.each([
    `[x]: ${FOREIGN_IMAGE}\n\n![x](${OWN_IMAGE} invalid)`,
    `[x]: ${FOREIGN_IMAGE}\n\n![x][unknown-reference]`,
    `[x]: <${OWN_IMAGE}>"invalid title"\n\n[x]: ${FOREIGN_IMAGE}\n\n![x]`,
    `paragraph\n[x]: ${OWN_IMAGE}\n\n[x]: ${FOREIGN_IMAGE}\n\n![x]`,
    `[x]: ${OWN_IMAGE}\n\n[x]: ${FOREIGN_IMAGE}\n\n![x]`,
  ])("checks possible reference fallbacks and every ambiguous definition: %s", (markdown) => {
    expect(extractMarkdownImageUrls(markdown)).toContain(FOREIGN_IMAGE);
  });

  it.each([
    `\`\n \n![x](${FOREIGN_IMAGE})\n \n\``,
    `\`\n# ![x](${FOREIGN_IMAGE})\n\``,
    `\`\r\n\r\n![x](${FOREIGN_IMAGE})\r\n\r\n\``,
    `- item\n\n    ![x](${FOREIGN_IMAGE})`,
    `<span data-x="\`">![x](${FOREIGN_IMAGE})</span><span data-x="\`">`,
    `[a](foo\`bar) ![x](${FOREIGN_IMAGE}) [b](foo\`bar)`,
    `<https://example.com/\`> ![x](${FOREIGN_IMAGE}) <https://example.com/\`>`,
    `| \` | image | \` |\n|---|---|---|\n| \` | ![x](${FOREIGN_IMAGE}) | \` |`,
  ])("keeps rendered images visible in uncertain code contexts: %s", (markdown) => {
    expect(extractMarkdownImageUrls(markdown)).toContain(FOREIGN_IMAGE);
  });

  it("handles maximum-size unclosed labels without retrying each opener", () => {
    const markdown = "![x".repeat(Math.floor(LIMITS.markdownBytes / 3));
    expect(extractMarkdownImageUrls(markdown)).toEqual([]);
  });

  it("handles maximum-size unclosed angle destinations that include closing labels", () => {
    const markdown = "![x](<".repeat(Math.floor(LIMITS.markdownBytes / 6));
    expect(extractMarkdownImageUrls(markdown)).toEqual([]);
  });

  it("handles maximum-size nested labels while retaining their resource", () => {
    const suffix = `(${FOREIGN_IMAGE})`;
    const depth = Math.floor((LIMITS.markdownBytes - suffix.length) / 3);
    const markdown = "![".repeat(depth) + "]".repeat(depth) + suffix;
    expect(extractMarkdownImageUrls(markdown)).toEqual([FOREIGN_IMAGE]);
  });

  it("does not scan to EOF repeatedly for unclosed definition titles", () => {
    const definition = `[x]: <${FOREIGN_IMAGE}> (\n`;
    const markdown = definition.repeat(Math.floor((LIMITS.markdownBytes - 8) / definition.length)) + "\n![x]";
    expect(extractMarkdownImageUrls(markdown)).toEqual([FOREIGN_IMAGE]);
  });

  it("returns one overflow item for the existing 100-distinct-image policy", () => {
    const markdown = Array.from({ length: 150 }, (_, index) => `![${index}](/api/v1/media/image-${index})`).join("\n");
    expect(extractMarkdownImageUrls(markdown)).toHaveLength(101);
  });
});
