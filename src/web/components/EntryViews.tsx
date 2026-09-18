import { ChevronDown, CircleCheck, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { AgentDto, CompletionFilter, EntryBriefDto, EntryFullDto } from "../../shared/contracts";
import { entriesApi, notifyDataChanged } from "../api";
import { formatDay, formatTime, isEntryUnread, isEntryUpdated, previewText } from "../lib/format";
import { EntryReader } from "./EntryReader";
import { AgentBadge, EmptyState, useToast } from "./ui";

function byAgent(agents: AgentDto[]): Map<string, AgentDto> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

export function EntryRow({
  entry,
  agent,
  agentIndex,
  selected,
  onSelect,
}: {
  entry: EntryBriefDto | EntryFullDto;
  agent?: AgentDto;
  agentIndex: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const content = "content" in entry ? entry.content : "";
  return (
    <button className={`entry-row ${selected ? "active" : ""}`} type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}>
      <AgentBadge name={agent?.name ?? entry.agent_id} index={agentIndex} />
      <span className="entry-row-content">
        <span className="entry-row-top">
          <span>{agent?.name ?? entry.agent_id}</span>
          <time dateTime={entry.updated_at}>{formatTime(entry.updated_at)}</time>
        </span>
        <strong>{entry.title}</strong>
        {content ? <span className="entry-preview">{previewText(content)}</span> : null}
        <span className="entry-meta">
          {isEntryUnread(entry.read_version, entry.version) ? <span className="unread-label"><i />{entry.read_version ? "有更新" : "未读"}</span> : <span>已读</span>}
          {entry.important ? <span className="important">重要</span> : null}
          {entry.completed ? <span>已完成{isEntryUpdated(entry.read_version, entry.version) ? " · 有更新" : ""}</span> : null}
          <span className="version-number">v{entry.version}</span>
        </span>
      </span>
    </button>
  );
}

export function FeedView({
  entries,
  agents,
  selectedId,
  onSelect,
  emptyTitle = "这里暂时没有信息",
}: {
  entries: Array<EntryBriefDto | EntryFullDto>;
  agents: AgentDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyTitle?: string;
}) {
  const agentMap = useMemo(() => byAgent(agents), [agents]);
  const grouped = useMemo(() => {
    const groups = new Map<string, Array<EntryBriefDto | EntryFullDto>>();
    for (const entry of entries) {
      const key = formatDay(entry.updated_at);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [entries]);

  if (!entries.length) return <EmptyState title={emptyTitle} detail="Agent 写入内容后会显示在这里。" />;
  return (
    <div className="entry-groups">
      {grouped.map(([day, rows]) => (
        <section key={day} aria-labelledby={`day-${day}`}>
          <h2 className="group-label" id={`day-${day}`}>{day}</h2>
          {rows.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              agent={agentMap.get(entry.agent_id)}
              agentIndex={agents.findIndex((agent) => agent.id === entry.agent_id)}
              selected={selectedId === entry.id}
              onSelect={() => onSelect(entry.id)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

export function ListView({ entries, agents, onChanged }: { entries: EntryFullDto[]; agents: AgentDto[]; onChanged: () => void }) {
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const filtered = useMemo(() => entries.filter((entry) => {
    if (!deferredSearch) return true;
    return `${entry.title} ${entry.content}`.toLowerCase().includes(deferredSearch);
  }), [deferredSearch, entries]);

  const toggleCompleted = async (entry: EntryFullDto) => {
    try {
      await entriesApi.setState(entry.id, { completed: !entry.completed });
      notifyDataChanged();
      onChanged();
      showToast(entry.completed ? "已恢复为未完成" : "已完成，Agent 仍会读取这条记录");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "状态更新失败", "error");
    }
  };

  return (
    <div className="list-view">
      <label className="search-field board-search"><Search aria-hidden="true" /><span className="sr-only">搜索当前 Agent</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前 Agent 的内容" /></label>
      {filtered.length ? filtered.map((entry) => (
        <section className={`check-entry ${entry.completed ? "is-done" : ""}`} key={entry.id}>
          <div className="check-line">
            <label className="completion-check" aria-label={`${entry.completed ? "恢复" : "完成"}：${entry.title}`}>
              <input type="checkbox" checked={entry.completed} onChange={() => void toggleCompleted(entry)} />
            </label>
            <button className="check-open" type="button" onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)} aria-expanded={expanded === entry.id}>
              <strong>{entry.title}</strong>
              <span>{previewText(entry.content, 120)}</span>
            </button>
            {entry.completed ? <span className="complete-pill">已完成</span> : null}
            <span className="row-version">{isEntryUnread(entry.read_version, entry.version) ? (entry.read_version ? "有更新 · " : "未读 · ") : ""}v{entry.version}</span>
            <ChevronDown className={expanded === entry.id ? "rotate" : ""} aria-hidden="true" />
          </div>
          {expanded === entry.id ? <EntryReader entryId={entry.id} agents={agents} embedded onChanged={onChanged} /> : null}
        </section>
      )) : <EmptyState title="没有符合条件的信息" />}
    </div>
  );
}

export function ReportView({
  entries,
  agents,
  mainEntryId,
  onMainEntryChange,
  onChanged,
}: {
  entries: EntryFullDto[];
  agents: AgentDto[];
  mainEntryId: string | null;
  onMainEntryChange: (id: string) => Promise<void>;
  onChanged: () => void;
}) {
  const firstId = entries[0]?.id ?? null;
  const [localSelection, setLocalSelection] = useState<string | null>(mainEntryId ?? firstId);
  const selected = localSelection ?? mainEntryId ?? firstId;

  useEffect(() => {
    setLocalSelection(mainEntryId ?? firstId);
  }, [entries, firstId, mainEntryId]);

  if (!selected) return <EmptyState title="还没有报告" detail="Agent 写入第一份报告后会显示在这里。" />;
  return (
    <div className="report-view">
      <div className="report-picker">
        <label>当前报告
          <select value={selected} onChange={(event) => setLocalSelection(event.target.value)}>
            {mainEntryId && !entries.some((entry) => entry.id === mainEntryId) ? <option value={mainEntryId}>默认报告（尚未载入列表）</option> : null}
            {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}{entry.completed ? " · 已完成" : ""}</option>)}
          </select>
        </label>
        {selected !== mainEntryId ? (
          <button className="text-action" type="button" onClick={() => void onMainEntryChange(selected)}>设为默认报告</button>
        ) : <span className="main-report-label"><CircleCheck aria-hidden="true" />默认报告</span>}
      </div>
      <EntryReader entryId={selected} agents={agents} onChanged={onChanged} />
    </div>
  );
}

export function CompletionTabs({ value, onChange }: { value: CompletionFilter; onChange: (value: CompletionFilter) => void }) {
  const items: Array<[CompletionFilter, string]> = [["all", "全部"], ["open", "未完成"], ["done", "已完成"]];
  return (
    <div className="tabs compact-tabs" role="tablist" aria-label="完成状态">
      {items.map(([id, label]) => (
        <button key={id} className={`tab ${value === id ? "active" : ""}`} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}
