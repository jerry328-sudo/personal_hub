import { ExternalLink, Menu, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { TaskDto } from "../../shared/contracts";
import { notifyDataChanged, subscribeDataChanged, tasksApi } from "../api";
import { useAppShell } from "../components/AppShell";
import { TaskForm } from "../components/TaskForm";
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, useToast } from "../components/ui";
import { formatDateTime } from "../lib/format";

type TaskFilter = "open" | "done" | "all";

export function TasksPage() {
  const { agents, openNavigation } = useAppShell();
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const agentId = params.get("agent") ?? "";
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<TaskDto | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    tasksApi.list({ agent_id: agentId || undefined, done: filter === "all" ? "all" : filter === "done" ? "yes" : "no", limit: 100 })
      .then((page) => { setTasks(page.items); setNextCursor(page.next_cursor); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "待办读取失败"))
      .finally(() => setLoading(false));
  }, [agentId, filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeDataChanged(load), [load]);
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await tasksApi.list({
        agent_id: agentId || undefined,
        done: filter === "all" ? "all" : filter === "done" ? "yes" : "no",
        cursor: nextCursor,
        limit: 100,
      });
      setTasks((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "下一页读取失败", "error");
    } finally {
      setLoadingMore(false);
    }
  };
  const visible = useMemo(() => tasks.filter((task) => task.title.toLowerCase().includes(query.trim().toLowerCase())), [query, tasks]);
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  const toggle = async (task: TaskDto) => {
    try {
      const updated = await tasksApi.update(task.id, { done: !task.done });
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      notifyDataChanged();
      if ((filter === "open" && updated.done) || (filter === "done" && !updated.done)) load();
      showToast(updated.done ? "待办已完成" : "已恢复为未完成");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "待办更新失败", "error");
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await tasksApi.delete(deleting.id);
      setDeleting(null);
      notifyDataChanged();
      load();
      showToast("待办已删除");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "删除失败", "error");
    }
  };

  return (
    <div className="wide-page tasks-page">
      <header className="wide-header">
        <button className="icon-btn mobile-menu" type="button" onClick={openNavigation} aria-label="打开导航"><Menu aria-hidden="true" /></button>
        <div><h1>{agentId ? `${agentMap.get(agentId) ?? agentId} · 待办` : "待办"}</h1><p>从信息到行动，把需要处理的事情留在这里。</p></div>
        <span className="spacer" /><button className="btn primary" type="button" onClick={() => setFormOpen(true)}><Plus aria-hidden="true" />新增待办</button>
      </header>
      <div className="task-toolbar">
        <div className="tabs compact-tabs" role="tablist">
          {([['open', '未完成'], ['done', '已完成'], ['all', '全部']] as Array<[TaskFilter, string]>).map(([id, label]) => <button className={`tab ${filter === id ? "active" : ""}`} key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
        <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">搜索待办</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索待办" /></label>
        <label className="agent-filter">Agent
          <select value={agentId} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set("agent", event.target.value); else next.delete("agent"); setParams(next); }}>
            <option value="">全部</option><option value="manual">手动待办</option>{agents.filter((agent) => agent.id !== "manual" && agent.scope === "own").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
      </div>
      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={load} /> : tasks.length || nextCursor ? (
        <div className="task-list">
          {visible.length ? visible.map((task) => <article className={`task-row ${task.done ? "done" : ""}`} key={task.id}>
            <label className="completion-check"><input type="checkbox" checked={task.done} onChange={() => void toggle(task)} /><span className="sr-only">{task.done ? "恢复" : "完成"}：{task.title}</span></label>
            <div className="task-main"><h2>{task.title}</h2><p>{agentMap.get(task.agent_id) ?? (task.agent_id === "manual" ? "手动待办" : task.agent_id)}{task.due_at ? ` · 截止 ${formatDateTime(task.due_at)}` : ""}</p></div>
            {task.entry_id ? <Link className="text-action" to={`/entries/${encodeURIComponent(task.entry_id)}`}>查看来源 <ExternalLink aria-hidden="true" /></Link> : null}
            <button className="icon-btn danger-icon" type="button" onClick={() => setDeleting(task)} aria-label={`删除待办：${task.title}`}><Trash2 aria-hidden="true" /></button>
          </article>) : <EmptyState title="已载入的待办中没有匹配项" detail={nextCursor ? "可以继续加载后续页面。" : "请调整搜索文字。"} />}
          {nextCursor ? <button className="load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "正在读取…" : "加载更多"}</button> : null}
        </div>
      ) : <EmptyState title={filter === "done" ? "还没有已完成的待办" : "这里暂时没有待办"} detail="可以手动添加，或从信息正文中创建。" />}
      <TaskForm open={formOpen} onClose={() => setFormOpen(false)} agents={agents} defaultAgentId={agentId || undefined} onCreated={() => load()} />
      <ConfirmDialog open={Boolean(deleting)} title="删除待办" description="删除待办不会影响它所关联的原始信息。" confirmLabel="删除" danger onClose={() => setDeleting(null)} onConfirm={remove} />
    </div>
  );
}
