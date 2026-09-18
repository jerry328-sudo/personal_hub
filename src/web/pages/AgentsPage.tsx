import {
  Ban,
  Copy,
  KeyRound,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { AgentDto, AgentKeyMetadataDto, AgentScope, DisplayMode, IssuedKeyDto } from "../../shared/contracts";
import { agentsApi, keysApi, notifyDataChanged } from "../api";
import { useAppShell } from "../components/AppShell";
import { AgentBadge, ConfirmDialog, Dialog, EmptyState, ErrorState, LoadingState, StatusPill, useToast } from "../components/ui";
import { formatDateTime, relativeTime } from "../lib/format";

const statusCopy = {
  active: ["已启用", "default"],
  disabled: ["已停用", "muted"],
  removed: ["已移除", "warning"],
  deleting: ["删除中", "danger"],
} as const;

function defaultExpiryDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  return date.toISOString().slice(0, 10);
}

function AgentForm({ open, agent, onClose, onSaved, onIssued }: {
  open: boolean;
  agent: AgentDto | null;
  onClose: () => void;
  onSaved: () => void;
  onIssued: (key: IssuedKeyDto, agentName: string) => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<AgentScope>("own");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("feed");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setScope(agent?.scope ?? "own");
    setDisplayMode(agent?.display_mode ?? "feed");
    setExpires(agent ? "" : defaultExpiryDate());
  }, [agent, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (agent) {
        await agentsApi.update(agent.id, { name: name.trim(), description: description.trim(), display_mode: displayMode });
        showToast("Agent 设置已保存");
      } else {
        const result = await agentsApi.create({
          name: name.trim(),
          description: description.trim(),
          scope,
          display_mode: displayMode,
          key_expires_at: expires ? new Date(`${expires}T23:59:00`).toISOString() : null,
        });
        onIssued(result.key, result.agent.name);
        showToast("Agent 已创建");
      }
      notifyDataChanged();
      onSaved();
      onClose();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={agent ? "Agent 设置" : "新增 Agent"} onClose={onClose}>
      <p className="dialog-description">{agent ? "名称和说明可以调整，编号与权限范围保持不变。" : "为新的信息来源取一个名字，并签发第一把独立密钥。"}</p>
      <form onSubmit={submit}>
        <label className="field">名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label className="field">说明<textarea maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个 Agent 负责关注什么？" /></label>
        {agent ? null : (
          <label className="field">权限范围
            <select value={scope} onChange={(event) => setScope(event.target.value as AgentScope)}>
              <option value="own">普通 Agent · 仅管理自身</option>
              <option value="all">总管 Agent · 跨来源管理</option>
            </select>
            <small>总管是管理身份，不会成为内容分区。</small>
          </label>
        )}
        {scope === "own" ? (
          <label className="field">默认展示
            <select value={displayMode} onChange={(event) => setDisplayMode(event.target.value as DisplayMode)}>
              <option value="feed">信息流</option><option value="list">清单</option><option value="report">报告</option>
            </select>
          </label>
        ) : null}
        {agent ? null : (
          <label className="field">首把密钥到期日{scope === "own" ? "（可选）" : ""}
            <input type="date" value={expires} required={scope === "all"} onChange={(event) => setExpires(event.target.value)} />
            <small>总管密钥必须设置有效期。密钥创建后只显示一次。</small>
          </label>
        )}
        <div className="dialog-actions"><button className="btn" type="button" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} type="submit">{busy ? "保存中…" : agent ? "保存修改" : "创建 Agent"}</button></div>
      </form>
    </Dialog>
  );
}

function IssuedKeyDialog({ issued, onClose }: { issued: { key: IssuedKeyDto; agentName: string } | null; onClose: () => void }) {
  const { showToast } = useToast();
  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key.secret);
      showToast("密钥已复制");
    } catch {
      showToast("无法访问剪贴板，请手动复制", "error");
    }
  };
  return (
    <Dialog open={Boolean(issued)} title="保存这把密钥" onClose={onClose}>
      {issued ? <>
        <div className="key-warning"><KeyRound aria-hidden="true" /><div><strong>{issued.agentName}</strong><span>关闭后无法再次查看明文。如遗失，请撤销并重新签发。</span></div></div>
        <div className="secret-box"><code>{issued.key.secret}</code><button className="icon-btn" type="button" onClick={() => void copy()} aria-label="复制密钥"><Copy aria-hidden="true" /></button></div>
        <p className="key-meta">密钥编号 {issued.key.id} · {issued.key.expires_at ? `有效至 ${formatDateTime(issued.key.expires_at)}` : "长期有效"}</p>
        <div className="dialog-actions"><button className="btn primary" type="button" onClick={onClose}>我已保存</button></div>
      </> : null}
    </Dialog>
  );
}

function KeysDialog({ agent, open, onClose, onIssued }: { agent: AgentDto | null; open: boolean; onClose: () => void; onIssued: (key: IssuedKeyDto, agentName: string) => void }) {
  const { showToast } = useToast();
  const [keys, setKeys] = useState<AgentKeyMetadataDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [expires, setExpires] = useState(defaultExpiryDate());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!agent) return;
    setLoading(true);
    keysApi.list(agent.id).then((result) => setKeys(result.items)).catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "密钥读取失败", "error")).finally(() => setLoading(false));
  }, [agent, showToast]);
  useEffect(() => { if (open) load(); }, [load, open]);

  const issue = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const key = await keysApi.issue(agent.id, expires ? new Date(`${expires}T23:59:00`).toISOString() : null);
      onIssued(key, agent.name);
      load();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "密钥签发失败", "error");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (keyId: string) => {
    if (!agent) return;
    try {
      await keysApi.revoke(agent.id, keyId);
      showToast("密钥已撤销");
      load();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "撤销失败", "error");
    }
  };
  return (
    <Dialog open={open} title={agent ? `${agent.name} · 接入与密钥` : "接入与密钥"} onClose={onClose} size="wide">
      {agent ? <>
        <div className="connection-guide"><strong>接口入口</strong><code>GET /api</code><code>GET /api/docs</code><span>请求头使用 <code>Authorization: Bearer &lt;密钥&gt;</code>。普通 Agent 默认读取自己的全部记录，包括已完成与归档内容。</span></div>
        <div className="key-issue-row">
          <label>新密钥到期日<input type="date" value={expires} required={agent.scope === "all"} onChange={(event) => setExpires(event.target.value)} /></label>
          <button className="btn primary" type="button" disabled={busy || agent.status === "removed" || agent.status === "deleting"} onClick={() => void issue()}><Plus aria-hidden="true" />签发新密钥</button>
        </div>
        <div className="key-list">
          {loading ? <LoadingState /> : keys.length ? keys.map((key) => {
            const revoked = Boolean(key.revoked_at);
            const expired = key.expires_at ? new Date(key.expires_at).getTime() < Date.now() : false;
            return <div className="key-row" key={key.id}><KeyRound aria-hidden="true" /><div><strong>{key.id}</strong><span>{revoked ? `已撤销 ${formatDateTime(key.revoked_at)}` : expired ? "已过期" : key.expires_at ? `有效至 ${formatDateTime(key.expires_at)}` : "长期有效"}{key.last_used_at ? ` · 最近使用 ${relativeTime(key.last_used_at)}` : " · 尚未使用"}</span></div>{!revoked ? <button className="btn danger" type="button" onClick={() => void revoke(key.id)}>撤销</button> : null}</div>;
          }) : <EmptyState title="还没有密钥" />}
        </div>
      </> : null}
    </Dialog>
  );
}

export function AgentsPage() {
  const { openNavigation, refreshShell } = useAppShell();
  const { showToast } = useToast();
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AgentDto | null>(null);
  const [keyAgent, setKeyAgent] = useState<AgentDto | null>(null);
  const [issued, setIssued] = useState<{ key: IssuedKeyDto; agentName: string } | null>(null);
  const [confirm, setConfirm] = useState<{ agent: AgentDto; action: "remove" | "purge" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    agentsApi.listAll({ status: "all", limit: 100 }).then(setAgents).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Agent 读取失败")).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  const visible = useMemo(() => agents.filter((agent) => {
    if (agent.id === "manual") return false;
    if (!showRemoved && (agent.status === "removed" || agent.status === "deleting")) return false;
    return `${agent.name} ${agent.description} ${agent.id}`.toLowerCase().includes(search.trim().toLowerCase());
  }), [agents, search, showRemoved]);

  const applyLifecycle = async (agent: AgentDto, action: "enable" | "disable" | "restore") => {
    try {
      await agentsApi[action](agent.id);
      notifyDataChanged();
      refreshShell();
      load();
      showToast(action === "enable" ? "Agent 已启用" : action === "disable" ? "Agent 已停用，历史内容保留" : "Agent 已恢复为停用状态，请重新签发密钥后启用");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "状态更新失败", "error");
    }
  };
  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.action === "remove") {
        await agentsApi.remove(confirm.agent.id);
        showToast("Agent 已移除，历史内容保留");
      } else {
        const progress = await agentsApi.purgeStep(confirm.agent.id);
        showToast(progress.status === "done" ? "Agent 及其内容已永久删除" : `清理进行中，剩余 ${progress.remaining_objects} 个图片对象`);
      }
      setConfirm(null);
      notifyDataChanged();
      refreshShell();
      load();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "操作失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wide-page management-page">
      <header className="wide-header">
        <button className="icon-btn mobile-menu" type="button" onClick={openNavigation} aria-label="打开导航"><Menu aria-hidden="true" /></button>
        <div><h1>Agent 管理</h1><p>每个 Agent 是一个长期的信息来源。随时添加，也可以让它暂时休息。</p></div>
        <span className="spacer" /><button className="btn primary" type="button" onClick={() => { setEditing(null); setFormOpen(true); }}><Plus aria-hidden="true" />新增 Agent</button>
      </header>
      <div className="management-tools">
        <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">搜索 Agent</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Agent" /></label>
        <label className="checkbox-field"><input type="checkbox" checked={showRemoved} onChange={(event) => setShowRemoved(event.target.checked)} />显示已移除</label>
      </div>
      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={load} /> : visible.length ? (
        <div className="agent-list">
          {visible.map((agent, index) => {
            const [label, tone] = statusCopy[agent.status];
            return <article className="agent-card" key={agent.id}>
              <AgentBadge name={agent.name} index={index} size="large" />
              <div className="agent-info"><h2>{agent.name}<StatusPill tone={tone}>{label}</StatusPill>{agent.scope === "all" ? <StatusPill tone="warning">总管</StatusPill> : null}</h2><p>{agent.description || "暂无说明"}</p><div className="agent-state">{agent.id} · 最近上报 {relativeTime(agent.last_report_at)}{agent.last_result === "failed" ? " · 上次失败" : ""}</div></div>
              <div className="agent-actions">
                <button className="btn" type="button" onClick={() => setKeyAgent(agent)}><KeyRound aria-hidden="true" />接入与密钥</button>
                <button className="btn" type="button" onClick={() => { setEditing(agent); setFormOpen(true); }}><Settings aria-hidden="true" />设置</button>
                {agent.status === "active" ? <button className="btn" type="button" onClick={() => void applyLifecycle(agent, "disable")}><Ban aria-hidden="true" />停用</button> : null}
                {agent.status === "disabled" ? <button className="btn" type="button" onClick={() => void applyLifecycle(agent, "enable")}><Play aria-hidden="true" />启用</button> : null}
                {agent.status === "removed" ? <button className="btn" type="button" onClick={() => void applyLifecycle(agent, "restore")}><RefreshCw aria-hidden="true" />恢复</button> : null}
                {agent.status !== "removed" && agent.status !== "deleting" ? <button className="btn danger" type="button" onClick={() => setConfirm({ agent, action: "remove" })}><Trash2 aria-hidden="true" />移除</button> : null}
                {agent.status === "removed" || agent.status === "deleting" ? <button className="btn danger" type="button" onClick={() => setConfirm({ agent, action: "purge" })}><Trash2 aria-hidden="true" />{agent.status === "deleting" ? "继续清理" : "永久删除"}</button> : null}
              </div>
            </article>;
          })}
        </div>
      ) : <EmptyState title="没有符合条件的 Agent" />}
      <AgentForm open={formOpen} agent={editing} onClose={() => setFormOpen(false)} onSaved={load} onIssued={(key, agentName) => setIssued({ key, agentName })} />
      <KeysDialog agent={keyAgent} open={Boolean(keyAgent)} onClose={() => setKeyAgent(null)} onIssued={(key, agentName) => setIssued({ key, agentName })} />
      <IssuedKeyDialog issued={issued} onClose={() => setIssued(null)} />
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.action === "remove" ? `移除 ${confirm.agent.name}` : `永久删除 ${confirm?.agent.name ?? "Agent"}`}
        description={confirm?.action === "remove" ? "Agent 将从日常导航隐藏，全部密钥立即撤销；历史信息和待办会保留，之后可以恢复。" : "这会清理 R2 图片、全部条目和版本。待办会保留为手动待办。清理可能需要分多次完成。"}
        confirmLabel={confirm?.action === "remove" ? "移除并保留历史" : "开始永久删除"}
        danger
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={runConfirm}
      />
    </div>
  );
}
