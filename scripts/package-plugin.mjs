import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "plugins", "personal-hub");
const manifest = JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(path.join(directory, "mcp.json"), "utf8"));
const info = manifest.extensions?.["com.openai"]?.interface;
if (manifest.name !== "personal-hub" || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !info || [...info.shortDescription].length > 30) throw new Error("插件身份、版本或简介无效");
if (mcp.mcpServers?.["personal-hub"]?.url !== "https://personal-hub.echem.ai/mcp" || mcp.mcpServers["personal-hub"].type !== "streamable-http") throw new Error("MCP 端点配置无效");
for (const key of ["logo", "composerIcon", "logoDark", "composerIconDark"]) {
  const relative = info[key]; const absolute = path.resolve(directory, relative);
  if (!absolute.startsWith(`${directory}${path.sep}`) || !(await stat(absolute)).isFile()) throw new Error("插件图标缺失或路径越界");
}
async function checkFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("不能打包符号链接");
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) await checkFiles(filename);
    else {
      if (/^(\.env|node_modules|dist)/.test(entry.name)) throw new Error("包中包含不应发布的文件");
      const content = await readFile(filename, "utf8");
      if (/phk\.[A-Za-z0-9_.-]{12,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_.-]{24,}/.test(content)) throw new Error(`检测到疑似凭据：${entry.name}`);
    }
  }
}
await checkFiles(directory);
const skill = await readFile(path.join(directory, "skills", "hub", "SKILL.md"), "utf8");
if (!/^---\r?\nname: hub\r?\ndescription: .+\r?\n---/.test(skill)) throw new Error("技能 frontmatter 无效");
await mkdir(path.join(root, "artifacts"), { recursive: true });
const archive = path.join(root, "artifacts", `personal-hub-${manifest.version}.tar.gz`);
const result = spawnSync("tar", ["-czf", archive, "-C", path.join(root, "plugins"), "personal-hub"], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("插件归档失败");
console.log(`插件包已验证：${archive}`);
