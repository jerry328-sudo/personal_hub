import { ListTodo, Menu, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CompletionFilter, DisplayMode, EntryFullDto } from "../../shared/contracts";
import { agentsApi, notifyDataChanged } from "../api";
import { useAppShell } from "../components/AppShell";
import { EntryReader } from "../components/EntryReader";
import { CompletionTabs, FeedView, ListView, ReportView } from "../components/EntryViews";
import { AgentBadge, EmptyState, ErrorState, LoadingState, useToast } from "../components/ui";
import { useEntries } from "../hooks/useEntries";
import { relativeTime } from "../lib/format";
import { EntryPagination, MarkReadButton } from "../components/MarkReadButton";

export function AgentPage() {
  const { agentId = "" } = useParams();
  const { agents, agentsLoading, refreshShell, openNavigation } = useAppShell();
  const { showToast } = useToast();
  const agent = agents.find((item) => item.id === agentId);
  const [completion, setCompletion] = useState<CompletionFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const query = useMemo(() => ({
    agent_id: agentId,
    view: "full" as const,
    completion,
    archived: "no" as const,
    query: deferredSearch || undefined,
    order: agent?.display_mode === "list" ? "created_asc" as const : "updated_desc" as const,
    limit: 100,
  }), [agent?.display_mode, agentId, completion, deferredSearch]);
  const result = useEntries<EntryFullDto>(query);

  useEffect(() => {
    setSelectedId(null);
    setReading(false);
    setCompletion("all");
    setSearch("");
  }, [agentId]);
  useEffect(() => {
    if (!selectedId || !result.items.some((entry) => entry.id === selectedId)) {
      setSelectedId(agent?.main_entry_id && result.items.some((entry) => entry.id === agent.main_entry_id) ? agent.main_entry_id : result.items[0]?.id ?? null);
    }
  }, [agent?.main_entry_id, result.items, selectedId]);

  if (agentsLoading && !agent) return <LoadingState label="正在读取 Agent…" />;
  if (!agent) return <div className="wide-page"><ErrorState message="这个 Agent 不存在或已经删除" /></div>;

  const updateAgent = async (input: { display_mode?: DisplayMode; main_entry_id?: string | null }) => {
    try {
      await agentsApi.update(agent.id, input);
      notifyDataChanged();
      refreshShell();
      showToast(input.display_mode ? "展示方式已保存" : "默认报告已保存");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "设置保存失败", "error");
    }
  };
  const mode = agent.display_mode;
  const loadedCount = `${result.items.length}${result.nextCursor ? "+" : ""}`;
  const completedCount = result.items.filter((entry) => entry.completed).length;
  const completedLabel = result.nextCursor ? (completedCount > 0 ? `${completedCount}+` : "…") : String(completedCount);
  const commonHeader = (
    <header className="agent-board-head">
      <button className="icon-btn mobile-menu" type="button" onClick={openNavigation} aria-label="打开导航"><Menu aria-hidden="true" /></button>
      <AgentBadge name={agent.name} index={agents.indexOf(agent)} size="large" />
      <div className="agent-board-title"><h1>{agent.name}</h1><p>{agent.description || "暂无说明"}</p></div>
      <span className="spacer" />
      <MarkReadButton query={query} />
      <label className="layout-field">展示方式
        <select value={mode} onChange={(event) => void updateAgent({ display_mode: event.target.value as DisplayMode })}>
          <option value="feed">信息流</option><option value="list">清单</option><option value="report">报告</option>
        </select>
      </label>
    </header>
  );

  if (mode === "feed") {
    return (
      <div className={`feed-page agent-feed ${reading ? "reading" : ""}`}>
        <section className="list-pane">
          <div className="agent-feed-header">{commonHeader}</div>
          <div className="completion-row"><CompletionTabs value={completion} onChange={setCompletion} /></div>
          <div className="entries-scroll">
            {result.loading ? <LoadingState /> : result.error ? <ErrorState message={result.error} onRetry={result.refresh} /> : <FeedView entries={result.items} agents={agents} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setReading(true); }} />}
          </div>
          <EntryPagination result={result} />
          <footer className="entry-count">本页 {loadedCount} 条信息 · 最近上报 {relativeTime(agent.last_report_at)}</footer>
        </section>
        <section className="reader-pane">
          {selectedId ? <EntryReader entryId={selectedId} agents={agents} onChanged={result.refresh} onBack={() => setReading(false)} /> : <EmptyState title="选择一条信息" />}
        </section>
      </div>
    );
  }

  return (
    <div className="wide-page agent-board">
      {commonHeader}
      <div className="board-controls">
        <div className="board-summary"><span>{loadedCount} 条信息</span><span>{completedLabel} 条已完成</span><span>最近上报 {relativeTime(agent.last_report_at)}</span></div>
        <span className="spacer" />
        <CompletionTabs value={completion} onChange={setCompletion} />
        <Link className="text-action task-link" to={`/tasks?agent=${encodeURIComponent(agent.id)}`}><ListTodo aria-hidden="true" />查看关联待办</Link>
      </div>
      <label className="search-field board-search"><Search aria-hidden="true" /><span className="sr-only">搜索当前 Agent</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前 Agent 的内容" /></label>
      {result.loading ? <LoadingState /> : result.error ? <ErrorState message={result.error} onRetry={result.refresh} /> : <>
        {mode === "list" ? (
          <ListView entries={result.items} agents={agents} onChanged={result.refresh} />
        ) : (
          <ReportView entries={result.items} agents={agents} mainEntryId={result.items.some((entry) => entry.id === agent.main_entry_id) ? agent.main_entry_id : null} onMainEntryChange={async (id) => { await updateAgent({ main_entry_id: id }); }} onChanged={result.refresh} />
        )}
      </>}
      <EntryPagination result={result} />
    </div>
  );
}
