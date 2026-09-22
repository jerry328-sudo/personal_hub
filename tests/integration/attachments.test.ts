import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, AttachmentDto } from "../../src/shared/contracts";
import app from "../../src/server/app";
import {
  purgeAgentAttachmentsStep,
  uploadAttachment,
} from "../../src/server/modules/attachments/service";

const ORIGIN = "http://localhost:5173";
const APP_ENV: CloudflareBindings = Object.assign(env, {
  ADMIN_LOGIN_SECRET: "test-admin-secret-with-sufficient-entropy",
  AUTH_PEPPER: "test-auth-pepper-with-different-entropy",
});
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

interface CreatedAgent {
  agent: { id: string };
  key: { secret: string };
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), APP_ENV);
}

async function errorBody(response: Response): Promise<ApiErrorBody> {
  return response.json<ApiErrorBody>();
}

async function loginAdmin(): Promise<string> {
  const response = await api("/api/v1/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
    },
    body: JSON.stringify({ secret: "test-admin-secret-with-sufficient-entropy" }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("Set-Cookie");
  expect(setCookie).not.toBeNull();
  return setCookie!.split(";", 1)[0]!;
}

async function createAgent(cookie: string, name: string): Promise<CreatedAgent> {
  const response = await api("/api/v1/admin/agents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: ORIGIN,
    },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return response.json<CreatedAgent>();
}

function upload(
  key: string,
  bytes: BlobPart = PNG_BYTES,
  type = "image/png",
  filename = "pixel.png",
): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type }));
  return api("/api/v1/agent/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
}

async function uploadedAttachment(key: string): Promise<AttachmentDto> {
  const response = await upload(key);
  expect(response.status).toBe(201);
  return response.json<AttachmentDto>();
}

function bearer(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}` };
}

async function countAttachmentRows(agentId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE agent_id = ?",
  ).bind(agentId).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("attachment and private media integration", () => {
  it("uploads a signature-validated PNG into R2 and serves it to its owner and admin", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "image owner");
    const attachment = await uploadedAttachment(owner.key.secret);

    expect(attachment).toMatchObject({
      agent_id: owner.agent.id,
      filename: "pixel.png",
      content_type: "image/png",
      size: PNG_BYTES.byteLength,
    });
    expect(attachment.url).toBe(`/api/v1/media/${attachment.id}`);
    expect(await countAttachmentRows(owner.agent.id)).toBe(1);

    const row = await env.DB.prepare(
      "SELECT object_key FROM attachments WHERE id = ?",
    ).bind(attachment.id).first<{ object_key: string }>();
    expect(row).not.toBeNull();
    const object = await env.MEDIA.get(row!.object_key);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_BYTES);

    const ownerMedia = await api(attachment.url, { headers: bearer(owner.key.secret) });
    expect(ownerMedia.status).toBe(200);
    expect(ownerMedia.headers.get("Content-Type")).toBe("image/png");
    expect(ownerMedia.headers.get("Content-Length")).toBe(String(PNG_BYTES.byteLength));
    expect(ownerMedia.headers.get("Cache-Control")).toBe("private, no-store");
    expect(ownerMedia.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await ownerMedia.arrayBuffer())).toEqual(PNG_BYTES);

    const adminMedia = await api(attachment.url, { headers: { Cookie: cookie } });
    expect(adminMedia.status).toBe(200);
    expect(new Uint8Array(await adminMedia.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("keeps media private and conceals another agent's attachment", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "private owner");
    const stranger = await createAgent(cookie, "private stranger");
    const attachment = await uploadedAttachment(owner.key.secret);

    const anonymous = await api(attachment.url);
    expect(anonymous.status).toBe(401);
    expect((await errorBody(anonymous)).error.code).toBe("unauthenticated");

    const crossAgent = await api(attachment.url, { headers: bearer(stranger.key.secret) });
    expect(crossAgent.status).toBe(404);
    expect((await errorBody(crossAgent)).error.code).toBe("not_found");
  });

  it("rejects forged, unsupported, and oversized image uploads without persistence", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "validation owner");

    const forged = await upload(
      owner.key.secret,
      new TextEncoder().encode("not a png"),
      "image/png",
      "forged.png",
    );
    expect(forged.status).toBe(415);
    expect((await errorBody(forged)).error.code).toBe("unsupported_media_type");

    const mismatched = await upload(owner.key.secret, PNG_BYTES, "image/jpeg", "wrong.jpg");
    expect(mismatched.status).toBe(415);
    expect((await errorBody(mismatched)).error.code).toBe("unsupported_media_type");

    const svg = await upload(
      owner.key.secret,
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      "image/svg+xml",
      "image.svg",
    );
    expect(svg.status).toBe(415);
    expect((await errorBody(svg)).error.code).toBe("unsupported_media_type");

    const oversizedBytes = new Uint8Array(10 * 1024 * 1024 + 1);
    oversizedBytes.set(PNG_BYTES);
    const oversized = await upload(owner.key.secret, oversizedBytes);
    expect(oversized.status).toBe(413);
    expect((await errorBody(oversized)).error.code).toBe("payload_too_large");

    expect(await countAttachmentRows(owner.agent.id)).toBe(0);
    const objects = await env.MEDIA.list({
      prefix: `agents/${encodeURIComponent(owner.agent.id)}/`,
    });
    expect(objects.objects).toHaveLength(0);
  });

  it("accepts only attachment URLs owned by the entry's target agent", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "markdown owner");
    const stranger = await createAgent(cookie, "markdown stranger");
    const attachment = await uploadedAttachment(owner.key.secret);

    const ownEntry = await api("/api/v1/agent/entries", {
      method: "POST",
      headers: {
        ...bearer(owner.key.secret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "entry with private image",
        content: `正文\n\n![chart](${attachment.url})`,
      }),
    });
    expect(ownEntry.status).toBe(201);

    const stolenReference = await api("/api/v1/agent/entries", {
      method: "POST",
      headers: {
        ...bearer(stranger.key.secret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "cross-owner image",
        content: `![chart](${attachment.url})`,
      }),
    });
    expect(stolenReference.status).toBe(400);
    expect((await errorBody(stolenReference)).error).toMatchObject({ code: "bad_request" });

    const collapsedStolenReference = await api("/api/v1/agent/entries", {
      method: "POST",
      headers: {
        ...bearer(stranger.key.secret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "collapsed cross-owner image",
        content: `![secret]\n\n[secret]: ${attachment.url}`,
      }),
    });
    expect(collapsedStolenReference.status).toBe(400);
    expect((await errorBody(collapsedStolenReference)).error).toMatchObject({ code: "bad_request" });

    const shortcutStolenReference = await api("/api/v1/agent/entries", {
      method: "POST",
      headers: {
        ...bearer(stranger.key.secret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "shortcut cross-owner image",
        content: `![secret]\n\n[secret]: ${attachment.url}`,
      }),
    });
    expect(shortcutStolenReference.status).toBe(400);
    expect((await errorBody(shortcutStolenReference)).error).toMatchObject({ code: "bad_request" });

    const collapsedMissingReference = await api("/api/v1/agent/entries", {
      method: "POST",
      headers: {
        ...bearer(owner.key.secret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "missing private image",
        content: "![missing]\n\n[missing]: /api/v1/media/att-does-not-exist",
      }),
    });
    expect(collapsedMissingReference.status).toBe(400);
    expect((await errorBody(collapsedMissingReference)).error).toMatchObject({ code: "bad_request" });

    const externalReference = await api("/api/v1/agent/entries", {
      method: "POST",
      headers: {
        ...bearer(owner.key.secret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "external image",
        content: "![remote](https://example.com/tracker.png)",
      }),
    });
    expect(externalReference.status).toBe(400);
    expect((await errorBody(externalReference)).error).toMatchObject({ code: "bad_request" });
  });

  it("does not overwrite an existing R2 object or insert D1 metadata on an object-key collision", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "collision owner");
    const collisionUuid = "00000000-0000-4000-8000-000000000003";
    const objectKey = `agents/${encodeURIComponent(owner.agent.id)}/${collisionUuid}`;
    const original = new TextEncoder().encode("existing object");
    await env.MEDIA.put(objectKey, original);

    const uuid = vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce(collisionUuid);
    let response: Response;
    try {
      response = await upload(owner.key.secret);
    } finally {
      uuid.mockRestore();
    }

    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe("conflict");
    expect(await countAttachmentRows(owner.agent.id)).toBe(0);
    const preserved = await env.MEDIA.get(objectKey);
    expect(preserved).not.toBeNull();
    expect(new Uint8Array(await preserved!.arrayBuffer())).toEqual(original);
  });

  it("purges both metadata-backed images and orphaned objects for a deleting agent", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "purge owner");
    await uploadedAttachment(owner.key.secret);
    const prefix = `agents/${encodeURIComponent(owner.agent.id)}/`;
    await env.MEDIA.put(`${prefix}orphan`, PNG_BYTES);
    await env.DB.prepare(
      "UPDATE agents SET status = 'deleting', deleting_at = ? WHERE id = ?",
    ).bind(new Date().toISOString(), owner.agent.id).run();

    const result = await purgeAgentAttachmentsStep({
      env: APP_ENV,
      actor: { type: "admin", sessionId: "purge-test" },
      requestId: "purge-test",
    }, owner.agent.id, 10);

    expect(result).toEqual({
      agent_id: owner.agent.id,
      status: "done",
      removed_objects: 2,
      remaining_objects: 0,
    });
    expect(await countAttachmentRows(owner.agent.id)).toBe(0);
    expect((await env.MEDIA.list({ prefix })).objects).toHaveLength(0);
  });

  it("keeps Agent deletion pending while an unexpired upload lease exists", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "leased upload owner");
    const objectKey = `agents/${encodeURIComponent(owner.agent.id)}/leased-upload`;
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO attachment_upload_leases (id, agent_id, object_key, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      "att-active-lease",
      owner.agent.id,
      objectKey,
      new Date(now).toISOString(),
      new Date(now + 5 * 60_000).toISOString(),
    ).run();
    await env.MEDIA.put(objectKey, PNG_BYTES);

    const pending = await api(`/api/v1/admin/agents/${owner.agent.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({
      agent_id: owner.agent.id,
      status: "pending",
      remaining_objects: 1,
    });
    expect(await env.DB.prepare("SELECT status FROM agents WHERE id = ?")
      .bind(owner.agent.id).first<{ status: string }>()).toEqual({ status: "deleting" });
    expect(await env.MEDIA.get(objectKey)).not.toBeNull();

    await env.MEDIA.delete(objectKey);
    await env.DB.prepare("DELETE FROM attachment_upload_leases WHERE id = ?")
      .bind("att-active-lease").run();
    const completed = await api(`/api/v1/admin/agents/${owner.agent.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: "done", remaining_objects: 0 });
    expect(await env.DB.prepare("SELECT id FROM agents WHERE id = ?")
      .bind(owner.agent.id).first()).toBeNull();

    const repeated = await api(`/api/v1/admin/agents/${owner.agent.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: "done", remaining_objects: 0 });
  });

  it("recovers an expired upload lease and its orphaned R2 object during deletion", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "expired lease owner");
    const objectKey = `agents/${encodeURIComponent(owner.agent.id)}/expired-upload`;
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO attachment_upload_leases (id, agent_id, object_key, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      "att-expired-lease",
      owner.agent.id,
      objectKey,
      new Date(now - 10 * 60_000).toISOString(),
      new Date(now - 5 * 60_000).toISOString(),
    ).run();
    await env.MEDIA.put(objectKey, PNG_BYTES);

    const completed = await api(`/api/v1/admin/agents/${owner.agent.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      status: "done",
      removed_objects: 1,
      remaining_objects: 0,
    });
    expect(await env.MEDIA.get(objectKey)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM attachment_upload_leases WHERE id = ?")
      .bind("att-expired-lease").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM agents WHERE id = ?")
      .bind(owner.agent.id).first()).toBeNull();
  });

  it("removes the R2 object when the target becomes unwritable before D1 metadata insertion", async () => {
    const cookie = await loginAdmin();
    const owner = await createAgent(cookie, "compensation owner");

    const sourceForm = new FormData();
    sourceForm.set("file", new File([PNG_BYTES], "race.png", { type: "image/png" }));
    const encoded = new Request(ORIGIN, { method: "POST", body: sourceForm });
    const contentType = encoded.headers.get("Content-Type");
    expect(contentType).not.toBeNull();
    const body = new Uint8Array(await encoded.arrayBuffer());

    let started!: () => void;
    let release!: () => void;
    const bodyReadStarted = new Promise<void>((resolve) => { started = resolve; });
    const bodyReleased = new Promise<void>((resolve) => { release = resolve; });
    const gatedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        started();
        await bodyReleased;
        controller.enqueue(body);
        controller.close();
      },
    }, { highWaterMark: 0 });

    const request = new Request(`${ORIGIN}/api/v1/agent/attachments`, {
      method: "POST",
      headers: { "Content-Type": contentType! },
      body: gatedBody,
    });
    const uploadPromise = uploadAttachment({
      env: APP_ENV,
      actor: {
        type: "agent",
        agentId: owner.agent.id,
        keyId: "test-key",
        role: "agent",
        status: "active",
      },
      requestId: "compensation-test",
    }, owner.agent.id, request);

    await bodyReadStarted;
    await env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?")
      .bind(owner.agent.id)
      .run();
    release();

    await expect(uploadPromise).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(await countAttachmentRows(owner.agent.id)).toBe(0);
    const objects = await env.MEDIA.list({
      prefix: `agents/${encodeURIComponent(owner.agent.id)}/`,
    });
    expect(objects.objects).toHaveLength(0);
  });
});
