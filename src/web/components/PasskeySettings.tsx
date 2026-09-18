import { useEffect, useState, type FormEvent } from "react";
import { Fingerprint, Trash2 } from "lucide-react";
import type { PasskeyDto } from "../../shared/contracts";
import { passkeyError, passkeysApi, supportsPasskeys } from "../passkeys";
import { useToast } from "./ui";

export function PasskeySettings() {
  const [keys, setKeys] = useState<PasskeyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const { showToast } = useToast();
  async function refresh() {
    setLoading(true);
    try { setKeys((await passkeysApi.list()).items); }
    catch (reason) { setError(passkeyError(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function register(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    const verificationSecret = secret;
    setSecret("");
    try {
      await passkeysApi.register(name.trim(), verificationSecret);
      setName("");
      showToast("通行密钥已绑定，下次可直接验证登录");
      await refresh();
    } catch (reason) { setError(passkeyError(reason)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError("");
    try {
      await passkeysApi.remove(id);
      setRemoving(null);
      setKeys(previous => previous.filter(key => key.id !== id));
      showToast("绑定已移除，通过此通行密钥建立的会话已失效");
      // Refresh detects whether the current session used the removed key.
      await refresh();
    } catch (reason) { setError(passkeyError(reason)); }
    finally { setBusy(false); }
  }
  return <section className="security-card" aria-labelledby="passkey-title">
    <h2 id="passkey-title">通行密钥</h2>
    <p>绑定后可通过 Windows Hello 或手机指纹、锁屏验证登录。退出登录不会删除绑定。请保留管理员密钥，便于更换设备或恢复访问。</p>
    {loading ? <p role="status">正在读取绑定…</p> : keys.length === 0 ? <p>尚未绑定通行密钥。</p> : <ul className="passkey-list">
      {keys.map(key => <li key={key.id}>
        <div><strong>{key.name}</strong><small>绑定于 {new Date(key.created_at).toLocaleString()}<br />{key.last_used_at ? `最近使用 ${new Date(key.last_used_at).toLocaleString()}` : "尚未用于登录"}</small></div>
        {removing === key.id ? <div className="passkey-remove-confirm">
          <p>移除后，此凭据不能再登录，相关会话也会退出。</p>
          <button className="btn danger" disabled={busy} onClick={() => void remove(key.id)}>确认移除</button>
          <button className="btn" disabled={busy} onClick={() => setRemoving(null)}>取消</button>
        </div> : <button type="button" className="btn" aria-label={`移除 ${key.name}`} disabled={busy} onClick={() => setRemoving(key.id)}><Trash2 aria-hidden="true" />移除</button>}
      </li>)}
    </ul>}
    {!supportsPasskeys() ? <p>当前浏览器不支持创建通行密钥，可以使用支持此功能的浏览器绑定。</p> : <form onSubmit={(event) => void register(event)}>
      <fieldset disabled={busy || loading}>
        <label className="field">绑定名称<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：办公电脑、Android 手机" /></label>
        <label className="field">确认管理员密钥<input type="password" autoComplete="current-password" required maxLength={1024} value={secret} onChange={event => setSecret(event.target.value)} /><small>仅在新增绑定时确认，之后登录无需输入。</small></label>
        <button type="submit" className="btn primary" disabled={busy || !name.trim() || !secret}><Fingerprint aria-hidden="true" />{busy ? "请完成设备验证…" : "添加通行密钥"}</button>
      </fieldset>
    </form>}
    {error ? <p role="alert" className="security-error">{error}</p> : null}
  </section>;
}
