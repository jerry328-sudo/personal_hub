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
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AgentDto,
  AgentKeyMetadataDto,
  AgentReadMode,
  AgentRole,
  DisplayMode,
  IssuedKeyDto,
} from "../../shared/contracts";
import { ApiError, agentsApi, keysApi, notifyDataChanged, readAccessApi } from "../api";
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

function KeyExpiryInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <label className="field">{label}
    <select value={value ? "dated" : "forever"} onChange={(event) => onChange(event.target.value === "forever" ? "" : defaultExpiryDate())}>
      <option value="dated">指定到期日</option><option value="forever">永不过期</option>
    </select>
    {value ? <input aria-label={`${label}日期`} type="date" required value={value} onChange={(event) => onChange(event.target.value)} /> : null}
    <small>普通 Agent 和总管均可选择永不过期；密钥仍可随时撤销，明文仅显示一次。</small>
  </label>;
}

function AgentForm({ open, agent, sourceOptions, onClose, onSaved, onIssued }: {
  open: boolean;
  agent: AgentDto | null;
  sourceOptions: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  onIssued: (key: IssuedKeyDto, agentName: string) => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<AgentRole>("agent");
  const [readMode, setReadMode] = useState<AgentReadMode>("selected");
  const [sources, setSources] = useState<string[]>([]);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("feed");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setRole(agent?.role ?? "agent");
    setReadMode(agent?.read_mode ?? "selected");
    setSources([]);
    setDisplayMode(agent?.display_mode ?? "feed");
    setExpires(agent ? "" : defaultExpiryDate());
  }, [agent, open]);

  const isReader = role === "reader";
  const creatingReader = isReader && !agent;
  const missingSource = creatingReader && readMode === "selected" && sources.length === 0;

  const toggleSource = (id: string, checked: boolean) => {
    setSources((current) => checked ? [...current, id] : current.filter((item) => item !== id));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (missingSource) return;
    setBusy(true);
    try {
      if (agent) {
        await agentsApi.update(agent.id, {
          name: name.trim(),
          description: description.trim(),
          ...(agent.role === "reader" ? {} : { display_mode: displayMode }),
        });
        showToast("Agent 设置已保存");
      } else {
        const result = await agentsApi.create({
          name: name.trim(),
          description: description.trim(),
          role,
          ...(isReader
            ? { read_access: { mode: readMode, agent_ids: readMode === "selected" ? sources : [] } }
            : { display_mode: displayMode }),
          key_expires_at: expires ? new Date(`${expires}T23:59:00`).toISOString() : null,
        });
        onIssued(result.key, result.agent.name);
        showToast(isReader ? "只读 Agent 已创建" : "Agent 已创建");
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
      <p className="dialog-description">{agent
        ? agent.role === "reader"
          ? "只读身份的名称和说明可以调整，读取范围请用列表上的“编辑读取范围”。"
          : "名称和说明可以调整，编号与权限范围保持不变。"
        : "为新的信息来源取一个名字，并签发第一把独立密钥。"}</p>
      <form onSubmit={submit}>
        <label className="field">名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label className="field">说明<textarea maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个 Agent 负责关注什么？" /></label>
        {agent ? null : (
          <label className="field">身份
            <select value={role} onChange={(event) => setRole(event.target.value as AgentRole)}>
              <option value="agent">普通 Agent · 仅管理自身</option>
              <option value="manager">总管 Agent · 跨来源管理</option>
              <option value="reader">只读 Agent · 只读取授权范围</option>
            </select>
            <small>{isReader ? "只读身份没有内容分区，不能创建、修改或上报任何业务数据。" : "总管是管理身份，不会成为内容分区。"}</small>
          </label>
        )}
        {creatingReader ? (
          <>
            <label className="field">读取范围
              <select value={readMode} onChange={(event) => setReadMode(event.target.value as AgentReadMode)}>
                <option value="selected">指定 Agent</option>
                <option value="all">全部内容分区</option>
              </select>
              {readMode === "all"
                ? <small>包含手动记录及未来新增的 Agent 内容。</small>
                : <small>新建只读身份至少选择一个来源，保存后仍可用“编辑读取范围”调整。</small>}
            </label>
            {readMode === "selected" ? (
              <fieldset className="field source-picker">
                <legend>来源（已选 {sources.length}）</legend>
                {sourceOptions.length === 0
                  ? <p className="key-meta">还没有可授权的内容来源。</p>
                  : sourceOptions.map((option) => (
                    <label className="checkbox-field" key={option.id}>
                      <input type="checkbox" checked={sources.includes(option.id)} onChange={(event) => toggleSource(option.id, event.target.checked)} />
                      {option.name}
                    </label>
                  ))}
              </fieldset>
            ) : null}
          </>
        ) : null}
        {isReader ? null : (
          <label className="field">默认展示
            <select value={displayMode} onChange={(event) => setDisplayMode(event.target.value as DisplayMode)}>
              <option value="feed">信息流</option><option value="list">清单</option><option value="report">报告</option>
            </select>
          </label>
        )}
        {agent ? null : (
          <KeyExpiryInput label="首把密钥有效期" value={expires} onChange={setExpires} />
        )}
        <div className="dialog-actions">
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || missingSource} type="submit">
            {busy ? "保存中…" : agent ? "保存修改" : "创建 Agent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function readAccessSummary(agent: AgentDto): string {
  if (agent.read_mode === "all") return "全部来源";
  if (!agent.read_source_count) return "未授权任何来源";
  return `指定 ${agent.read_source_count} 个来源`;
}

export function ReadAccessDialog({ agent, sourceOptions, onClose, onSaved }: {
  agent: AgentDto;
  sourceOptions: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [mode, setMode] = useState<AgentReadMode>("selected");
  const [sources, setSources] = useState<string[]>([]);
  const [grantedNames, setGrantedNames] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    setStale(false);
    setLoadError(null);
    setRevision(null);
    setMode("selected");
    setSources([]);
    setGrantedNames({});
    setLoadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    // 每个 Agent 由独立 key 挂载；卸载/重试后，旧请求不得改变新表单。
    let cancelled = false;
    readAccessApi.get(agent.id)
      .then((access) => {
        if (cancelled) return;
        setRevision(access.revision);
        setMode(access.mode);
        setSources(access.sources.map((source) => source.id));
        setGrantedNames(Object.fromEntries(access.sources.map((source) => [source.id, source.name])));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : "读取范围读取失败");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agent.id, loadAttempt]);

  const toggleSource = (id: string, checked: boolean) => {
    setSources((current) => checked ? [...current, id] : current.filter((item) => item !== id));
  };

  const save = async () => {
    if (loading || loadError || busy || stale || revision === null) return;
    setBusy(true);
    try {
      const access = await readAccessApi.replace(agent.id, {
        base_revision: revision,
        mode,
        agent_ids: mode === "selected" ? sources : [],
      });
      setRevision(access.revision);
      setSources(access.sources.map((source) => source.id));
      setStale(false);
      showToast("读取范围已更新，同一密钥的后续请求立即生效");
      notifyDataChanged();
      onSaved();
    } catch (reason) {
      // 并发修改时不静默覆盖另一处改动，保留用户当前选择并提示重新加载。
      if (reason instanceof ApiError && reason.status === 409) setStale(true);
      showToast(reason instanceof Error ? reason.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  // 已授权但当前不可选（已移除/停用）的来源继续展示，便于管理员自行取消勾选。
  const selectableIds = new Set(sourceOptions.map((option) => option.id));
  const extraGranted = sources.filter((id) => !selectableIds.has(id));

  return (
    <Dialog open title={`${agent.name} · 读取范围`} onClose={onClose}>
      {loading ? <LoadingState /> : loadError ? <ErrorState message={loadError} onRetry={load} /> : <>
        {stale ? (
          <p className="key-warning"><strong>读取范围已被其他操作修改</strong><span>当前页面上的选择已保留，但没有保存。重新加载后再确认要提交的范围。</span></p>
        ) : null}
        <label className="field">范围模式
          <select disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as AgentReadMode)}>
            <option value="selected">指定 Agent</option>
            <option value="all">全部内容分区</option>
          </select>
          {mode === "all"
            ? <small>动态包含现有和未来新增的内容分区，包括手动记录。</small>
            : <small>可以保存空清单，含义是无权读取任何业务内容，不等于全部范围。</small>}
        </label>
        {mode === "selected" ? (
          <fieldset className="field source-picker" disabled={busy}>
            <legend>来源（已选 {sources.length}）</legend>
            {sourceOptions.map((option) => (
              <label className="checkbox-field" key={option.id}>
                <input type="checkbox" checked={sources.includes(option.id)} onChange={(event) => toggleSource(option.id, event.target.checked)} />
                {option.name}
              </label>
            ))}
            {extraGranted.map((id) => (
              <label className="checkbox-field" key={id}>
                <input type="checkbox" checked onChange={(event) => toggleSource(id, event.target.checked)} />
                {grantedNames[id] ?? id}（当前不可作为新授权目标）
              </label>
            ))}
          </fieldset>
        ) : null}
        <p className="key-meta">权限版本 {revision ?? "—"}。保存后旧分页游标会失效，调用方需要从第一页重新读取。</p>
        <div className="dialog-actions">
          <button className="btn" type="button" onClick={stale ? load : onClose}>{stale ? "重新加载" : "取消"}</button>
          <button className="btn primary" type="button" disabled={busy || stale || revision === null} onClick={() => void save()}>{busy ? "保存中…" : "保存读取范围"}</button>
        </div>
      </>}
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
          <KeyExpiryInput label="新密钥有效期" value={expires} onChange={setExpires} />
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
  const [accessAgent, setAccessAgent] = useState<AgentDto | null>(null);
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

  // 可授权的来源：手动记录分区加上全部可写的普通内容分区。
  const sourceOptions = useMemo(() => {
    const manual = agents.find((agent) => agent.id === "manual");
    const partitions = agents
      .filter((agent) => agent.id !== "manual" && agent.role === "agent" && agent.status !== "deleting")
      .map((agent) => ({ id: agent.id, name: agent.name }));
    return manual ? [{ id: manual.id, name: manual.name }, ...partitions] : partitions;
  }, [agents]);

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
              <div className="agent-info"><h2>{agent.name}<StatusPill tone={tone}>{label}</StatusPill>{agent.role === "manager" ? <StatusPill tone="warning">总管</StatusPill> : null}{agent.role === "reader" ? <StatusPill tone="muted">只读</StatusPill> : null}</h2><p>{agent.description || "暂无说明"}</p><div className="agent-state">{agent.role === "reader" ? `${agent.id} · 读取范围 ${readAccessSummary(agent)}` : `${agent.id} · 最近上报 ${relativeTime(agent.last_report_at)}${agent.last_result === "failed" ? " · 上次失败" : ""}`}</div></div>
              <div className="agent-actions">
                <button className="btn" type="button" onClick={() => setKeyAgent(agent)}><KeyRound aria-hidden="true" />接入与密钥</button>
                {agent.role === "reader" ? <button className="btn" type="button" onClick={() => setAccessAgent(agent)}><ShieldCheck aria-hidden="true" />编辑读取范围</button> : null}
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
      <AgentForm open={formOpen} agent={editing} sourceOptions={sourceOptions} onClose={() => setFormOpen(false)} onSaved={load} onIssued={(key, agentName) => setIssued({ key, agentName })} />
      <KeysDialog agent={keyAgent} open={Boolean(keyAgent)} onClose={() => setKeyAgent(null)} onIssued={(key, agentName) => setIssued({ key, agentName })} />
      {accessAgent ? <ReadAccessDialog key={accessAgent.id} agent={accessAgent} sourceOptions={sourceOptions} onClose={() => setAccessAgent(null)} onSaved={load} /> : null}
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
