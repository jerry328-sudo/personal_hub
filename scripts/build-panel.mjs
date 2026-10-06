import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  configFile: false, root, plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { write: false, sourcemap: false, cssCodeSplit: false, minify: true,
    lib: { entry: `${root}/src/panel/main.tsx`, name: "PersonalHubPanel", formats: ["iife"] },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
const js = outputs.find((item) => item.type === "chunk")?.code;
const css = outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".css")).map((item) => item.source).join("\n");
if (!js) throw new Error("面板脚本未构建");
const template = await readFile(`${root}/src/panel/index.html`, "utf8");
const html = template.replace('</head>', () => `<style>${css}</style></head>`)
  .replace('<script type="module" src="./main.tsx"></script>', () => `<script>${js.replaceAll("</script", "<\\/script")}</script>`);
await mkdir(`${root}/public/plugin`, { recursive: true });
await writeFile(`${root}/public/plugin/panel.html`, html);
console.log(`Hub 面板静态资源已构建：${Buffer.byteLength(html)} bytes，自包含 HTML。`);
