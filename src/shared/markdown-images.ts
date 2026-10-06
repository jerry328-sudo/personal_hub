import { decodeString } from "micromark-util-decode-string";

// One extra distinct URL lets the existing 100-image policy reject the whole
// write. Bounding the result also prevents nested destinations from creating an
// unbounded amount of overlapping output from a bounded Markdown document.
const MAX_IMAGE_URLS = 101;
const MAX_REFERENCE_LABEL = 999;

type Destination = { url: string; end: number };
type Fence = { character: string; size: number; quoteDepth: number; indent: number };

function isSpace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isPunctuation(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function normalizeLabel(value: string): string {
  // CommonMark labels normalize whitespace and Unicode case, but do not decode
  // entities or backslash escapes as destinations do.
  return value.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
}

function simpleInlineImages(source: string): string[] | null {
  // Ordinary inline images need no delimiter indexes. Any escape, code,
  // reference, title, entity, or nested label falls back to the shared scanner.
  if (source.includes("`") || source.includes("~~~") || source.includes("\\") || source.includes("&")) return null;
  const urls = new Set<string>();
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("![", cursor);
    if (open < 0) break;
    const close = source.indexOf("]", open + 2);
    if (close < 0 || /[[\r\n]/.test(source.slice(open + 2, close)) || source[close + 1] !== "(") return null;
    const destinationEnd = source.indexOf(")", close + 2);
    if (destinationEnd < 0) return null;
    const destination = source.slice(close + 2, destinationEnd);
    if (/[\s()<>"'\\&[\]]/.test(destination)) return null;
    if (destination) urls.add(destination);
    if (urls.size >= MAX_IMAGE_URLS) return [...urls];
    cursor = destinationEnd + 1;
  }
  return [...urls];
}

function lineContent(source: string, start: number, end: number): { start: number; quoteDepth: number; indent: number } {
  let cursor = start;
  let quoteDepth = 0;
  // Recognize explicit quote containers; an absent quote ends their fence.
  while (cursor < end) {
    let spaces = 0;
    while (source[cursor] === " " && spaces < 3) { cursor += 1; spaces += 1; }
    if (source[cursor] !== ">") { cursor -= spaces; break; }
    quoteDepth += 1;
    cursor += 1;
    if (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
  }
  let indent = 0;
  while (source[cursor] === " " || source[cursor] === "\t") {
    indent += source[cursor] === "\t" ? 4 - (indent % 4) : 1;
    cursor += 1;
  }
  // A fence may start as the first block in a list item.
  if (indent <= 3) {
    const markerStart = cursor;
    if (source[cursor] === "-" || source[cursor] === "+" || source[cursor] === "*") cursor += 1;
    else {
      let digits = 0;
      while (digits < 9 && source[cursor] !== undefined && source[cursor]! >= "0" && source[cursor]! <= "9") {
        cursor += 1; digits += 1;
      }
      if (!digits || (source[cursor] !== "." && source[cursor] !== ")")) cursor = markerStart;
      else cursor += 1;
    }
    if (cursor > markerStart && (source[cursor] === " " || source[cursor] === "\t")) {
      cursor += 1;
      indent += cursor - markerStart;
    } else cursor = markerStart;
  }
  return { start: cursor, quoteDepth, indent };
}

function markBlockCode(source: string, hidden: Uint8Array): void {
  let fence: Fence | null = null;
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    const next = end < source.length ? end + 1 : end;
    const content = lineContent(source, start, end);
    const blank = content.start >= end || source.slice(content.start, end).trim() === "";
    if (fence && (content.quoteDepth < fence.quoteDepth || (!blank && content.indent < fence.indent))) fence = null;
    let cursor = content.start;
    const character = source[cursor];
    let size = 0;
    if (character === "`" || character === "~") {
      while (source[cursor] === character) { size += 1; cursor += 1; }
    }
    if (fence) {
      hidden.fill(1, start, next);
      if (character === fence.character && size >= fence.size && source.slice(cursor, end).trim() === "") fence = null;
    } else if (size >= 3 && content.indent <= 3 && (character !== "`" || !source.slice(cursor, end).includes("`"))) {
      fence = { character: character!, size, quoteDepth: content.quoteDepth, indent: content.indent };
      hidden.fill(1, start, next);
    }
    start = next;
  }
}

function escapedCharacters(source: string): Uint8Array {
  const escaped = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && isPunctuation(source[index + 1])) { escaped[index + 1] = 1; index += 1; }
  }
  return escaped;
}

/** Precomputes destination boundaries once, including failed nested matches. */
function destinationReader(source: string, escaped: Uint8Array): (start: number) => Destination | null {
  const parentheses = new Int32Array(source.length);
  const stack: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (escaped[index]) continue;
    if (source[index] === "(") stack.push(index);
    else if (source[index] === ")" && stack.length) parentheses[stack.pop()!] = index + 1;
  }
  const bareEnd = new Int32Array(source.length + 1);
  const angleEnd = new Int32Array(source.length + 1);
  bareEnd[source.length] = source.length;
  angleEnd[source.length] = -1;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const character = source[index]!;
    if (character === "\\" && escaped[index + 1]) {
      bareEnd[index] = bareEnd[index + 2]!;
      angleEnd[index] = angleEnd[index + 2]!;
      continue;
    }
    angleEnd[index] = !escaped[index] && character === ">" ? index
      : (!escaped[index] && (character === "<" || character === "\n" || character === "\r")) ? -1
        : angleEnd[index + 1]!;
    if (!escaped[index] && (isSpace(character) || character.charCodeAt(0) < 32 || character === ")")) bareEnd[index] = index;
    else if (!escaped[index] && character === "<") bareEnd[index] = -1;
    else if (!escaped[index] && character === "(") {
      const close = parentheses[index]! - 1;
      bareEnd[index] = close >= 0 && bareEnd[index + 1] === close ? bareEnd[close + 1]! : -1;
    } else bareEnd[index] = bareEnd[index + 1]!;
  }
  return (start) => {
    if (source[start] === "<") {
      const end = angleEnd[start + 1]!;
      return end >= 0 ? { url: decodeString(source.slice(start + 1, end)), end: end + 1 } : null;
    }
    const end = bareEnd[start]!;
    return end >= start ? { url: decodeString(source.slice(start, end)), end } : null;
  };
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  let newlines = 0;
  while (isSpace(source[cursor])) {
    if (source[cursor] === "\n" && ++newlines > 1) return start;
    cursor += 1;
  }
  return cursor;
}

function markInlineCode(source: string, hidden: Uint8Array, escaped: Uint8Array): void {
  const runs: { start: number; end: number; close: number; paragraph: number }[] = [];
  let paragraph = 0;
  for (let index = 0; index < source.length;) {
    if (hidden[index]) { paragraph += 1; while (hidden[index]) index += 1; continue; }
    // Keep the previous policy of ignoring same-line code examples. Multiline
    // spans would require full block parsing to distinguish headings, lists,
    // and blank lines; conservatively checking their images avoids omissions.
    if (source[index] === "\n" || source[index] === "\r") paragraph += 1;
    if (source[index] !== "`") { index += 1; continue; }
    const start = index;
    while (source[index] === "`") index += 1;
    runs.push({ start, end: index, close: -1, paragraph });
  }
  const nextByLength = new Map<number, number>();
  let currentParagraph = -1;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.paragraph !== currentParagraph) { nextByLength.clear(); currentParagraph = run.paragraph; }
    const size = run.end - run.start;
    run.close = nextByLength.get(size) ?? -1;
    nextByLength.set(size, index);
  }
  const candidates = new Uint8Array(source.length);
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    if (escaped[run.start] || run.close < 0) continue;
    const close = runs[run.close]!;
    candidates.fill(1, run.start, close.end);
    index = run.close;
  }
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    let ambiguous = false;
    for (let index = start; index < end; index += 1) {
      // HTML/autolinks, link destinations, and GFM table cells give backticks
      // meanings that cannot be inferred from a line-wide codespan match. Only
      // hide ordinary code examples; check uncertain contexts conservatively.
      if (!hidden[index] && !candidates[index] && !escaped[index]
        && "[]<>|".includes(source[index]!)) { ambiguous = true; break; }
    }
    if (!ambiguous) {
      for (let index = start; index < end; index += 1) if (candidates[index]) hidden[index] = 1;
    }
    start = end;
  }
}

function removeContainerMarkers(source: string): string {
  const chunks: string[] = [];
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    const next = end < source.length ? end + 1 : end;
    const content = lineContent(source, start, end);
    chunks.push(" ".repeat(content.start - start), source.slice(content.start, next));
    start = next;
  }
  return chunks.join("");
}

/**
 * Extract image destinations without an AST or retrying a failed regex at each
 * nested opener. Delimiters and destinations are indexed in linear passes.
 * Invalid inline suffixes are conservatively checked, never silently trusted.
 */
export function extractMarkdownImageUrls(markdown: string): string[] {
  if (!markdown.includes("![") || !markdown.includes("]")) return [];
  const simple = simpleInlineImages(markdown);
  if (simple) return simple;
  const source = removeContainerMarkers(markdown);
  const hidden = new Uint8Array(source.length);
  const escaped = escapedCharacters(source);
  markBlockCode(markdown, hidden);
  let reader: ReturnType<typeof destinationReader> | undefined;
  const readDestination = (start: number) => (reader ??= destinationReader(source, escaped))(start);
  const definitions = new Map<string, Set<string>>();
  const rememberDefinition = (label: string, url: string) => {
    let urls = definitions.get(label);
    if (!urls) { urls = new Set(); definitions.set(label, urls); }
    // Verify every candidate for a label: paragraph/container rules or an
    // invalid earlier definition must not shadow the destination actually used
    // by the renderer. This deliberately errs toward checking extra images.
    if (urls.size < MAX_IMAGE_URLS) urls.add(url);
  };
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    const next = end < source.length ? end + 1 : end;
    const content = lineContent(markdown, start, end);
    let cursor = content.start;
    if (!hidden[cursor] && content.indent <= 3 && source[cursor] === "[") {
      const labelStart = cursor + 1;
      cursor = labelStart;
      while (cursor < source.length && cursor - labelStart <= MAX_REFERENCE_LABEL && (source[cursor] !== "]" || escaped[cursor])) cursor += 1;
      if (source[cursor] === "]" && source[cursor + 1] === ":" && cursor > labelStart) {
        const label = normalizeLabel(source.slice(labelStart, cursor));
        const destinationStart = skipWhitespace(source, cursor + 2);
        const destination = readDestination(destinationStart);
        // Do not search to EOF for an optional title. Whether the suffix forms
        // a real definition is ambiguous without block parsing; every possible
        // destination is checked, so it cannot shadow the renderer's choice.
        if (destination?.url) rememberDefinition(label, destination.url);
      }
    }
    start = next;
  }
  markInlineCode(source, hidden, escaped);
  const brackets = new Int32Array(source.length);
  const codeLabels = new Uint8Array(source.length);
  const stack: number[] = [];
  const stackTicks: number[] = [];
  let ticks = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (hidden[index] || escaped[index]) continue;
    if (source[index] === "`") ticks += 1;
    if (source[index] === "[") { stack.push(index); stackTicks.push(ticks); }
    else if (source[index] === "]" && stack.length) {
      const open = stack.pop()!;
      brackets[open] = index + 1;
      codeLabels[open] = ticks > stackTicks.pop()! ? 1 : 0;
    }
  }
  let nextResource: Int32Array | undefined;
  let nextLineEnd: Int32Array | undefined;
  const resourceAfter = (start: number): number => {
    if (!nextResource) {
      nextResource = new Int32Array(source.length + 1);
      nextLineEnd = new Int32Array(source.length + 1);
      nextResource[source.length] = -1;
      nextLineEnd[source.length] = source.length;
      for (let index = source.length - 1; index >= 0; index -= 1) {
        nextResource[index] = source[index] === "]" && source[index + 1] === "(" && !escaped[index]
          ? index : nextResource[index + 1]!;
        nextLineEnd[index] = source[index] === "\n" ? index : nextLineEnd[index + 1]!;
      }
    }
    return nextResource[start]!;
  };
  const urls = new Set<string>();
  for (let index = 0; index < source.length && urls.size < MAX_IMAGE_URLS; index += 1) {
    if (hidden[index] || escaped[index] || source[index] !== "!" || source[index + 1] !== "[") continue;
    const altStart = index + 2;
    const altEnd = brackets[index + 1]! - 1;
    if (altEnd < altStart) continue;
    const suffix = altEnd + 1;
    if (source[suffix] !== "(" && codeLabels[index + 1]) {
      // A bracket inside alt-text code may look like the label's close. Keep
      // the ordinary match and also check its later same-line resource, rather
      // than hiding ambiguous code and accidentally hiding a real image.
      const close = resourceAfter(suffix);
      if (close >= 0 && close < nextLineEnd![suffix]!) {
        const destination = readDestination(skipWhitespace(source, close + 2));
        if (destination?.url) urls.add(destination.url);
      }
    }
    if (source[suffix] === "(") {
      const destination = readDestination(skipWhitespace(source, suffix + 1));
      if (destination?.url) {
        urls.add(destination.url);
        if (source[destination.end] === ")") continue;
        // A malformed inline suffix can fall back to the alt label's reference.
        // Check that possible reference too rather than trusting its prefix.
      }
    }
    let labelStart = altStart;
    let labelEnd = altEnd;
    if (source[suffix] === "[" && !hidden[suffix]) {
      const close = brackets[suffix]! - 1;
      if (close > suffix + 1) { labelStart = suffix + 1; labelEnd = close; }
      else if (close !== suffix + 1) { labelStart = altStart; labelEnd = altEnd; }
    }
    if (labelEnd - labelStart > MAX_REFERENCE_LABEL) continue;
    let references = definitions.get(normalizeLabel(source.slice(labelStart, labelEnd)));
    if (!references && altEnd - altStart <= MAX_REFERENCE_LABEL) references = definitions.get(normalizeLabel(source.slice(altStart, altEnd)));
    if (references) for (const url of references) { urls.add(url); if (urls.size >= MAX_IMAGE_URLS) break; }
  }
  return [...urls];
}
