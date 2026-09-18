import { describe, expect, it } from "vitest";
import {
  attachmentIdFromUrl,
  extractAttachmentIds,
  findUnsupportedImageUrls,
  isAllowedLink,
} from "../../src/shared/markdown";

describe("attachmentIdFromUrl", () => {
  it("accepts only canonical protected-media URLs", () => {
    expect(attachmentIdFromUrl("/api/v1/media/notice-2026-A")).toBe("notice-2026-A");
    expect(attachmentIdFromUrl("/api/v1/media/ab")).toBeNull();
    expect(attachmentIdFromUrl("/api/v1/media/image.png?download=1")).toBeNull();
    expect(attachmentIdFromUrl("https://example.com/api/v1/media/image-1")).toBeNull();
  });
});

describe("extractAttachmentIds", () => {
  it("extracts inline and case-insensitive reference images in document order", () => {
    const markdown = [
      "![first](/api/v1/media/attachment-one)",
      "![duplicate](/api/v1/media/attachment-one \"same object\")",
      "![second][SCREENSHOT]",
      "[screenshot]: </api/v1/media/attachment-two>",
      "![third]",
      "[third]: /api/v1/media/attachment-three",
    ].join("\n");

    expect(extractAttachmentIds(markdown)).toEqual([
      "attachment-one",
      "attachment-two",
      "attachment-three",
    ]);
  });

  it("ignores image-shaped text inside fenced and inline code", () => {
    const markdown = [
      "```md",
      "![fenced](/api/v1/media/secret-in-fence)",
      "```",
      "~~~markdown",
      "![tilde](/api/v1/media/secret-in-tilde-fence)",
      "~~~",
      "`![inline](/api/v1/media/secret-inline)`",
      "![visible](/api/v1/media/visible-image)",
    ].join("\n");

    expect(extractAttachmentIds(markdown)).toEqual(["visible-image"]);
  });

  it("does not treat links or unsupported image locations as attachments", () => {
    const markdown = [
      "[media link](/api/v1/media/not-an-image)",
      "![external](https://example.com/image.png)",
      "![other route](/assets/image.png)",
    ].join("\n");

    expect(extractAttachmentIds(markdown)).toEqual([]);
  });
});

describe("findUnsupportedImageUrls", () => {
  it("reports external, data, and non-media inline images", () => {
    const markdown = [
      "![allowed](/api/v1/media/allowed-image)",
      "![external](https://example.com/image.png)",
      "![data](data:image/png;base64,AAAA)",
      "![asset](/assets/image.png)",
    ].join("\n");

    expect(findUnsupportedImageUrls(markdown)).toEqual([
      "https://example.com/image.png",
      "data:image/png;base64,AAAA",
      "/assets/image.png",
    ]);
  });

  it("reports unsupported reference images and ignores code examples", () => {
    const markdown = [
      "![remote][remote-image]",
      "![private][private-image]",
      "![shortcut-remote]",
      "[remote-image]: https://example.com/remote.png",
      "[private-image]: /api/v1/media/private-image",
      "[shortcut-remote]: https://example.com/shortcut.png",
      "```md",
      "![example](https://example.com/in-code.png)",
      "```",
    ].join("\n");

    expect(findUnsupportedImageUrls(markdown)).toEqual([
      "https://example.com/remote.png",
      "https://example.com/shortcut.png",
    ]);
  });
});

describe("isAllowedLink", () => {
  it("allows same-origin paths and HTTP(S) links", () => {
    expect(isAllowedLink("/entries/entry-1")).toBe(true);
    expect(isAllowedLink("https://example.com/article")).toBe(true);
    expect(isAllowedLink("http://localhost:8787/docs")).toBe(true);
  });

  it("rejects protocol-relative and executable or malformed links", () => {
    expect(isAllowedLink("//evil.example/image.png")).toBe(false);
    expect(isAllowedLink("javascript:alert(1)")).toBe(false);
    expect(isAllowedLink("data:text/html,hello")).toBe(false);
    expect(isAllowedLink("not a URL")).toBe(false);
  });
});
