import { ImageOff, ZoomIn } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dialog } from "./ui";

const MEDIA_PATH = /^\/api\/v1\/media\/[A-Za-z0-9_-]+$/;

export function isAllowedLink(url: string): boolean {
  if (url.startsWith("#")) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveMediaUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin || !MEDIA_PATH.test(parsed.pathname) || parsed.search || parsed.hash) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

function AttachmentImage({ src, alt }: { src?: string; alt?: string }) {
  const safeSrc = resolveMediaUrl(src);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (!safeSrc || failed) {
    return <span className="image-placeholder"><ImageOff aria-hidden="true" />{alt || "图片暂不可用"}</span>;
  }
  return (
    <>
      <figure className="article-image">
        <button type="button" onClick={() => setOpen(true)} aria-label={`放大图片：${alt || "附件"}`}>
          <img src={safeSrc} alt={alt ?? ""} loading="lazy" onError={() => setFailed(true)} />
          <span className="image-zoom"><ZoomIn aria-hidden="true" />查看原图</span>
        </button>
        {alt ? <figcaption>{alt}</figcaption> : null}
      </figure>
      <Dialog open={open} title={alt || "图片预览"} onClose={() => setOpen(false)} size="wide">
        <img className="image-large" src={safeSrc} alt={alt ?? ""} />
      </Dialog>
    </>
  );
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url, key) => {
          if (key === "src") return resolveMediaUrl(url) ?? "";
          return isAllowedLink(url) ? url : "";
        }}
        components={{
          img: ({ src, alt }) => <AttachmentImage src={src} alt={alt} />,
          a: ({ href, children }) => (
            <a href={isAllowedLink(href ?? "") ? href : undefined} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
