import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateRemoteEnvironment } from "./cloudflare-environment.mjs";

const environment = process.argv[2];
if (environment !== "staging" && environment !== "production") {
  console.error("请使用 npm run deploy:staging 或 npm run deploy:production。");
  process.exit(1);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const childEnv = { ...process.env, CLOUDFLARE_ENV: environment };

try {
  validateRemoteEnvironment(environment);
} catch (error) {
  console.error(`拒绝发布：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function run(modulePath, args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(modulePath, import.meta.url)), ...args], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("../node_modules/vite/bin/vite.js", ["build"]);
run("../node_modules/wrangler/bin/wrangler.js", ["deploy"]);
