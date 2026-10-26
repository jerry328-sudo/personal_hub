import { Archive, ArrowLeft, Check, ChevronRight, Search, SquareCheck, Star } from "lucide-react";
import { Link } from "react-router-dom";
import type { CompletionFilter, EntryBriefDto } from "../../../shared/contracts";
import { EntryReader } from "../../components/EntryReader";
import { EntryPagination, MarkReadButton } from "../../components/MarkReadButton";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { useAppShell } from "../../hooks/useAppShell";
import { useInbox, type InboxKind, type ReadFilter } from "../../hooks/useInbox";
import { formatDateTime, formatDay, formatTime, isEntryUnread } from "../../lib/format";

const copy = {
  all: { title: "收件箱", detail: "所有来源的未归档信息" },
  important: { title: "重要信息", detail: "最新版本被标为重要的信息" },
  archive: { title: "归档", detail: "已经收起，仍然可以查阅的信息" },
};

function Status({ entry }: { entry: EntryBriefDto }) {
  const unread = isEntryUnread(entry.read_version, entry.version);
  return <span className="tpl-chips">
    {unread ? <span className={`tpl-chip ${entry.read_version ? "updated" : "unread"}`}>{entry.read_version ? "有更新" : "未读"}</span> : <span className="tpl-read-label"><Check />已读</span>}
    {entry.important ? <span className="tpl-chip important"><Star />重要</span> : null}
    {entry.completed ? <span className="tpl-chip done">已完成</span> : null}
    <span className="tpl-version">v{entry.version}</span>
  </span>;
}

export function InboxPage({ kind }: { kind: InboxKind }) {
  const state = useInbox(kind);
  const { counts } = useAppShell();
  const { agents, search, setSearch, readFilter, setReadFilter, completion, setCompletion, agentId, setAgentId, startDate, setStartDate, endDate, setEndDate, query, result, reading, entryId, openEntry, closeEntry, resetFilters } = state;
  const filtered = Boolean(search || agentId || readFilter !== "all" || completion !== "all" || startDate || endDate);
  if (reading && entryId) return <div className="tpl-page tpl-reading-page">
    <button className="tpl-back" type="button" onClick={closeEntry}><ArrowLeft />返回{copy[kind].title}</button>
    <div className="tpl-reading-card"><EntryReader entryId={entryId} agents={agents} onChanged={result.refresh} /></div>
  </div>;

  let lastDay = "";
  return <div className="tpl-page">
    <header className="tpl-page-head"><div><h1>{copy[kind].title}</h1><p>{copy[kind].detail}</p></div></header>
    {kind === "all" ? <div className="tpl-stats">
      <button type="button" className="tpl-stat" onClick={() => { setReadFilter("unread"); }}><b>{counts.unread}</b><span>待阅读<span className="tpl-stat-note">含有更新</span></span></button>
      <Link className="tpl-stat" to="/important"><b>{counts.important_unread}</b><span><Star />重要未读</span></Link>
      <Link className="tpl-stat" to="/tasks"><b>{counts.open_tasks}</b><span><SquareCheck />未完成待办</span></Link>
      <Link className="tpl-stat" to="/archive"><b>{counts.archived}</b><span><Archive />已归档</span></Link>
    </div> : null}
    <section className="tpl-filter-card" aria-label="信息筛选">
      <div className="tpl-search-row"><label className="search-field"><Search aria-hidden="true" /><span className="sr-only">搜索标题或正文</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题和正文" /></label>
        <label className="tpl-inline-field">来源<select aria-label="信息来源" value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">全部来源</option>{agents.filter((agent) => agent.role === "agent").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.status === "removed" ? "（已移除）" : ""}</option>)}</select></label>
      </div>
      <div className="tpl-filter-row"><div className="tpl-segments" role="group" aria-label="阅读状态">{([["all", "全部"], ["unread", "未读"], ["updated", "有更新"]] as Array<[ReadFilter, string]>).map(([value, title]) => <button key={value} type="button" aria-pressed={readFilter === value} onClick={() => setReadFilter(value)}>{title}</button>)}</div>
        <label className="tpl-inline-field">完成状态<select value={completion} onChange={(event) => setCompletion(event.target.value as CompletionFilter)}><option value="all">全部状态</option><option value="open">未完成</option><option value="done">已完成</option></select></label>
        {filtered ? <button type="button" className="text-action tpl-reset" onClick={resetFilters}>清除筛选</button> : null}
      </div>
      {kind === "archive" ? <div className="tpl-date-row"><label className="tpl-inline-field">归档起始<input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} /></label><label className="tpl-inline-field">归档截止<input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></label></div> : null}
    </section>
    <div className="tpl-bulk-row"><span>标记当前筛选范围内的全部信息，包含其他分页</span><MarkReadButton query={query} /></div>
    {result.loading ? <LoadingState /> : result.error ? <ErrorState message={result.error} onRetry={result.refresh} /> : result.items.length ? <div className="tpl-items">
      {result.items.map((entry) => {
        const day = formatDay(entry.updated_at);
        const showDay = day !== lastDay;
        lastDay = day;
        const source = agents.find((agent) => agent.id === entry.agent_id)?.name ?? entry.agent_id;
        return <section className="tpl-item-section" key={entry.id}>
          {showDay ? <h2 className="tpl-date-heading">{day}</h2> : null}
          <button className={`tpl-item${isEntryUnread(entry.read_version, entry.version) ? " pending" : ""}`} type="button" onClick={() => openEntry(entry.id)}>
            <span className={`tpl-dot${entry.read_version && isEntryUnread(entry.read_version, entry.version) ? " updated" : ""}`} />
            <span className="tpl-item-main"><span className="tpl-item-meta"><span>{source}</span><time dateTime={entry.updated_at} title={formatDateTime(entry.updated_at)}>{formatTime(entry.updated_at)}</time></span><strong>{entry.title}</strong><Status entry={entry} /></span>
            <ChevronRight className="tpl-item-arrow" aria-hidden="true" />
          </button>
        </section>;
      })}
    </div> : <div className="tpl-empty-card"><EmptyState title={filtered ? "没有符合条件的信息" : "这里暂时没有信息"} detail={filtered ? "试试调整筛选条件，或换个搜索词。" : "来源提交的信息会显示在这里。"} action={filtered ? <button type="button" className="btn" onClick={resetFilters}>清除筛选</button> : undefined} /></div>}
    <EntryPagination result={result} />
    <footer className="tpl-page-foot">本页 {result.items.length} 条{result.nextCursor ? " · 后面还有信息" : ""}</footer>
  </div>;
}
