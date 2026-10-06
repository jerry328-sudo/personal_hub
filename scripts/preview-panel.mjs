import { build } from "vite";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({ configFile: false, root, define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { write: false, minify: true, lib: { entry: `${root}/tests/browser/panel-host.ts`, name: "PanelTestHost", formats: ["es"] } } });
const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
const js = outputs.find((item) => item.type === "chunk")?.code;
const panel = await readFile(`${root}/public/plugin/panel.html`, "utf8");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Personal Hub · 本地协议测试</title><style>body{margin:0;font:13px sans-serif;background:#f5f7f6;color:#54635a}header{height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;box-sizing:border-box}iframe{display:block;width:100%;height:calc(100dvh - 100px);border:0}footer{height:60px;display:flex;align-items:center;gap:12px;padding:0 12px;box-sizing:border-box}textarea{flex:1;height:28px;font:13px sans-serif}#context-text{display:none}</style><header><span id="test-status">测试宿主 · 模拟 MCP 数据</span><span id="context-count">聊天引用 0 条</span></header><iframe id="panel" title="Hub 面板" allow="clipboard-write"></iframe><footer><textarea aria-label="聊天草稿">保留的聊天草稿</textarea><button id="remove-context">移除引用</button></footer><pre id="context-text"></pre><script type="module" src="/host.js"></script></html>`;
createServer((request, response) => {
  const route = new URL(request.url ?? "/", "http://localhost").pathname;
  const content = route === "/" ? html.replace('<span id="test-status">', '<img id="sidebar-icon" width="20" height="20" alt="Hub 图标"><span id="test-status">')
    .replace('</footer>', '<button id="safe-area">测试安全留白</button></footer>') : route === "/host.js" ? js : route === "/panel.html" ? panel : null;
  if (!content) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": route === "/host.js" ? "text/javascript" : "text/html; charset=utf-8", "Cache-Control": "no-store",
    ...(route === "/panel.html" ? { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'" } : {}) }); response.end(content);
}).listen(4175, "127.0.0.1", () => { console.log("Hub 协议测试预览：http://127.0.0.1:4175/（仅模拟数据）"); });
