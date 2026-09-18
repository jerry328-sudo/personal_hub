import { useState, type FormEvent } from "react";
import { Menu } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAppShell } from "../components/AppShell";
import { useToast } from "../components/ui";
import { useSession } from "../hooks/useSession";

export function SecurityPage() {
  const { openNavigation } = useAppShell();
  const { changeSecret } = useSession();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function generate() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    setNext(value); setConfirm(value); setShowNew(true); setSaved(false); setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) { setError("两次输入的新密钥不一致"); return; }
    if (current === next) { setError("新密钥不能与旧密钥相同"); return; }
    setBusy(true); setError("");
    try {
      await changeSecret(current, next);
      setCurrent(""); setNext(""); setConfirm("");
      showToast("登录密钥已修改，请使用新密钥重新登录");
      void navigate("/login", { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "修改失败");
    } finally { setBusy(false); }
  }

  return <div className="security-page">
    <header className="security-heading"><button type="button" className="icon-btn" aria-label="打开导航" onClick={openNavigation}><Menu /></button><h1>登录与安全</h1></header>
    <section className="security-card" aria-labelledby="change-secret-title">
      <h2 id="change-secret-title">修改管理员登录密钥</h2>
      <p>修改后，所有设备上的登录会话都会失效，需要使用新密钥重新登录。Agent 密钥不受影响。</p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          <label className="field">当前登录密钥<input type="password" autoComplete="current-password" required maxLength={1024} value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
          <label className="field">新登录密钥<input type={showNew ? "text" : "password"} autoComplete="new-password" required minLength={32} maxLength={1024} value={next} onChange={(event) => { setNext(event.target.value); setSaved(false); }} /><small>至少 32 个字符，建议使用生成的随机密钥并保存在密码管理器中。</small></label>
          <div className="security-actions"><button type="button" className="btn" onClick={generate}>生成随机密钥</button><button type="button" className="btn" onClick={() => setShowNew(!showNew)}>{showNew ? "隐藏新密钥" : "显示新密钥"}</button></div>
          <label className="field">确认新密钥<input type="password" autoComplete="new-password" required minLength={32} maxLength={1024} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
          <label className="security-confirm"><input type="checkbox" required checked={saved} onChange={(event) => setSaved(event.target.checked)} />我已保存新密钥，理解修改后需要重新登录</label>
          {error ? <p role="alert" className="security-error">{error}</p> : null}
          <button type="submit" className="btn primary" disabled={!saved || busy}>{busy ? "修改中…" : "修改密钥并退出所有设备"}</button>
        </fieldset>
      </form>
    </section>
  </div>;
}
