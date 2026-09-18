import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

function reject(message) {
  throw new Error(message);
}

export function validateRemoteEnvironment(environment) {
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const parseErrors = [];
  const config = parse(readFileSync(configPath, "utf8"), parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (parseErrors.length > 0 || !config || typeof config !== "object" || Array.isArray(config)) {
    const detail = parseErrors.map((error) => printParseErrorCode(error.error)).join(", ");
    reject(`wrangler.jsonc 无法解析${detail ? `（${detail}）` : ""}`);
  }

  const remote = config.env?.[environment];
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
    reject(`wrangler.jsonc 尚未定义 env.${environment}，请先按 docs/deployment.md 填写远程资源`);
  }

  const d1 = Array.isArray(remote.d1_databases)
    ? remote.d1_databases.find((binding) => binding?.binding === "DB")
    : undefined;
  if (
    !d1
    || typeof d1.database_id !== "string"
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(d1.database_id)
    || d1.database_id === "00000000-0000-0000-0000-000000000000"
  ) {
    reject(`env.${environment} 缺少真实的 DB database_id`);
  }

  const r2 = Array.isArray(remote.r2_buckets)
    ? remote.r2_buckets.find((binding) => binding?.binding === "MEDIA")
    : undefined;
  if (!r2 || typeof r2.bucket_name !== "string" || !r2.bucket_name || r2.bucket_name.includes("<")) {
    reject(`env.${environment} 缺少真实的 MEDIA bucket_name`);
  }

  const limiter = Array.isArray(remote.ratelimits)
    ? remote.ratelimits.find((binding) => binding?.name === "LOGIN_RATE_LIMITER")
    : undefined;
  if (!limiter || typeof limiter.namespace_id !== "string" || !/^[1-9][0-9]*$/.test(limiter.namespace_id)) {
    reject(`env.${environment} 缺少有效的 LOGIN_RATE_LIMITER namespace_id`);
  }

  let origin;
  try {
    origin = new URL(remote.vars?.APP_ORIGIN);
  } catch {
    reject(`env.${environment} 缺少有效的 APP_ORIGIN`);
  }
  if (origin.protocol !== "https:" || origin.origin !== origin.href.replace(/\/$/, "")) {
    reject(`env.${environment}.vars.APP_ORIGIN 必须是没有路径的 HTTPS Origin`);
  }
  if (!/^[1-9][0-9]*$/.test(remote.vars?.SESSION_TTL_SECONDS ?? "")) {
    reject(`env.${environment} 缺少有效的 SESSION_TTL_SECONDS`);
  }

  const declaredSecrets = Array.isArray(remote.secrets?.required) ? remote.secrets.required : [];
  const requiredSecrets = new Set(declaredSecrets);
  for (const secret of ["ADMIN_LOGIN_SECRET", "AUTH_PEPPER"]) {
    if (!requiredSecrets.has(secret)) reject(`env.${environment}.secrets.required 缺少 ${secret}`);
  }
}
