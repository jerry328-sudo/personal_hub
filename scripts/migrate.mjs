import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateRemoteEnvironment } from "./cloudflare-environment.mjs";

const environment = process.argv[2];
if (environment !== "staging" && environment !== "production") {
  console.error("请使用 npm run db:migrate:staging 或 npm run db:migrate:production。");
  process.exit(1);
}

try {
  validateRemoteEnvironment(environment);
} catch (error) {
  console.error(`拒绝远程迁移：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const result = spawnSync(process.execPath, [
  wrangler,
  "d1",
  "migrations",
  "apply",
  "DB",
  "--env",
  environment,
  "--remote",
], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
