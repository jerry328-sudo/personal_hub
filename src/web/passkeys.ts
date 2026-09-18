import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { PasskeyDto, SessionDto } from "../shared/contracts";
import { requestJson } from "./api";

export function supportsPasskeys(): boolean {
  return window.isSecureContext && browserSupportsWebAuthn();
}

export function passkeyError(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === "NotAllowedError" || reason.name === "AbortError") return "验证已取消或超时，可以重试或使用管理员密钥登录。";
    if (reason.name === "InvalidStateError") return "此凭据可能已经绑定，请使用已有通行密钥登录。";
    if (reason.name === "NotSupportedError") return "当前设备或凭据管理器不支持此通行密钥，请尝试其他浏览器或使用管理员密钥。";
    if (reason.name === "ConstraintError") return "请先设置设备指纹或锁屏 PIN，或选择支持通行密钥的凭据管理器。";
    if (reason.name === "SecurityError") return "请在本站的 HTTPS 页面中使用通行密钥。";
    return reason.message;
  }
  return "通行密钥操作失败，请重试";
}

export const passkeysApi = {
  list: () => requestJson<{ items: PasskeyDto[] }>("/api/v1/auth/passkeys"),
  remove: (id: string) => requestJson<void>(`/api/v1/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  register: async (name: string, secret: string) => {
    const optionsJSON = await requestJson<PublicKeyCredentialCreationOptionsJSON>("/api/v1/auth/passkeys/register/options", {
      method: "POST", body: JSON.stringify({ name, secret }),
    });
    const response = await startRegistration({ optionsJSON });
    await requestJson("/api/v1/auth/passkeys/register/verify", { method: "POST", body: JSON.stringify(response) });
  },
  login: async () => {
    const optionsJSON = await requestJson<PublicKeyCredentialRequestOptionsJSON>("/api/v1/auth/passkeys/login/options", { method: "POST" });
    const response = await startAuthentication({ optionsJSON });
    return requestJson<SessionDto>("/api/v1/auth/passkeys/login/verify", { method: "POST", body: JSON.stringify(response) });
  },
};
