import { ArrowRight, Fingerprint, KeyRound, Moon, Sun } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { useTheme } from "../hooks/useTheme";
import { passkeyError, supportsPasskeys } from "../passkeys";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, login, loginWithPasskey } = useSession();
  const { mode, setMode, resolvedTheme } = useTheme();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => setSecret(""), []);
  if (session) return <Navigate to="/" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(secret);
      setSecret("");
      const from = (location.state as { from?: string } | null)?.from;
      void navigate(from && from.startsWith("/") && !from.startsWith("//") ? from : "/", { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const passkeyLogin = async () => {
    setBusy(true); setError(null);
    try {
      await loginWithPasskey();
      setSecret("");
      const from = (location.state as { from?: string } | null)?.from;
      void navigate(from && from.startsWith("/") && !from.startsWith("//") ? from : "/", { replace: true });
    } catch (reason) { setError(passkeyError(reason)); }
    finally { setBusy(false); }
  };

  const cycleTheme = () => setMode(mode === "system" ? (resolvedTheme === "dark" ? "light" : "dark") : mode === "dark" ? "light" : "system");
  return (
    <main className="login-page">
      <button className="theme-shortcut" type="button" onClick={cycleTheme} aria-label="切换外观">
        {resolvedTheme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
      </button>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand"><span className="logo">H</span><span>Personal Hub</span></div>
        <div className="login-intro">
          <h1 id="login-title">回到你的信息中心</h1>
          <p>查看各个 Agent 整理的信息、报告与待办。</p>
        </div>
        <button className="btn primary login-submit" type="button" disabled={busy || !supportsPasskeys()} onClick={() => void passkeyLogin()}>
          <Fingerprint aria-hidden="true" />{busy ? "正在验证…" : "通行密钥登录"}
        </button>
        <p className="login-passkey-help">{supportsPasskeys() ? "使用 Windows Hello、手机指纹或锁屏验证。首次使用请先用管理员密钥登录，再到“登录与安全”绑定。" : "当前浏览器不支持通行密钥，请使用管理员密钥登录。"}</p>
        <form onSubmit={submit}>
          <label className="field login-field">管理员密钥
            <span className="input-with-icon"><KeyRound aria-hidden="true" /><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} required autoFocus autoComplete="current-password" /></span>
          </label>
          <button className="btn login-submit" type="submit" disabled={busy || !secret}>
            {busy ? "正在验证…" : "使用管理员密钥登录"}<ArrowRight aria-hidden="true" />
          </button>
        </form>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <p className="login-note">密钥仅用于本次登录，不会保存在浏览器中。</p>
      </section>
    </main>
  );
}
