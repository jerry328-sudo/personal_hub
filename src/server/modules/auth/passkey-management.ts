import type { PasskeyDto } from "../../../shared/contracts";
import type { ServiceContext } from "../../env";
import { requireManagementActor } from "../../shared/authorize";
import { notFound } from "../../shared/errors";
import { nowIso } from "../../shared/ids";

export async function listPasskeys(ctx: ServiceContext): Promise<{ items: PasskeyDto[] }> {
  requireManagementActor(ctx.actor);
  const rows = await ctx.env.DB.prepare("SELECT id, name, created_at, last_used_at FROM admin_passkeys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT ?")
    .bind(20).all<PasskeyDto>();
  return { items: rows.results };
}

export async function revokePasskey(ctx: ServiceContext, id: string): Promise<void> {
  requireManagementActor(ctx.actor);
  const key = await ctx.env.DB.prepare("UPDATE admin_passkeys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id")
    .bind(nowIso(), id).first();
  if (!key) throw notFound("通行密钥不存在或已移除");
}
