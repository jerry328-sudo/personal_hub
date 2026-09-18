import { Archive, Inbox, Menu, Search, Star } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { CompletionFilter, EntryFullDto } from "../../shared/contracts";
import { EntryReader } from "../components/EntryReader";
import { FeedView } from "../components/EntryViews";
import { useAppShell } from "../components/AppShell";
import { EmptyState, ErrorState, LoadingState } from "../components/ui";
import { useEntries } from "../hooks/useEntries";
import { isEntryUnread, isEntryUpdated } from "../lib/format";

export type InboxKind = "all" | "important" | "archive";
type ReadFilter = "all" | "unread" | "updated";

const pageCopy: Record<InboxKind, { title: string; subtitle: string }> = {
  all: { title: "全部信息", subtitle: "每一条值得留意的信息" },
  important: { title: "重要信息", subtitle: "集中查看标记为重要的内容" },
  archive: { title: "归档", subtitle: "已经收起、仍然可以查阅的信息" },
};

function HeaderIcon({ kind }: { kind: InboxKind }) {
  return kind === "important" ? <Star aria-hidden="true" /> : kind === "archive" ? <Archive aria-hidden="true" /> : <Inbox aria-hidden="true" />;
}

export function InboxPage({ kind }: { kind: InboxKind }) {
  const { agents, openNavigation } = useAppShell();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [completion, setCompletion] = useState<CompletionFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const query = useMemo(() => ({
    view: "full" as const,
    archived: kind === "archive" ? "yes" as const : "no" as const,
    important: kind === "important" ? "yes" as const : "all" as const,
    completion,
    order: "updated_desc" as const,
    query: deferredSearch || undefined,
    limit: 30,
  }), [completion, deferredSearch, kind]);
  const result = useEntries<EntryFullDto>(query);
  const rows = useMemo(() => result.items.filter((entry) => {
    if (readFilter === "unread") return isEntryUnread(entry.read_version, entry.version);
    if (readFilter === "updated") return isEntryUpdated(entry.read_version, entry.version);
    return true;
  }), [readFilter, result.items]);

  useEffect(() => {
    if (!selectedId || !result.items.some((entry) => entry.id === selectedId)) setSelectedId(result.items[0]?.id ?? null);
  }, [result.items, selectedId]);
  useEffect(() => {
    setReading(false);
    setSelectedId(null);
  }, [kind]);

  const select = (id: string) => {
    setSelectedId(id);
    setReading(true);
  };
  const copy = pageCopy[kind];
  return (
    <div className={`feed-page ${reading ? "reading" : ""}`}>
      <section className="list-pane" aria-label={copy.title}>
        <header className="list-head">
          <div className="title-line">
            <button className="icon-btn mobile-menu" type="button" onClick={openNavigation} aria-label="打开导航"><Menu aria-hidden="true" /></button>
            <HeaderIcon kind={kind} />
            <h1>{copy.title}</h1>
          </div>
          <p className="subtitle">{copy.subtitle}</p>
          <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或内容" /></label>
          <div className="filter-line">
            <div className="tabs" role="tablist" aria-label="阅读状态">
              {([['all', '全部'], ['unread', '未读'], ['updated', '有更新']] as Array<[ReadFilter, string]>).map(([id, label]) => (
                <button key={id} className={`tab ${readFilter === id ? "active" : ""}`} type="button" role="tab" aria-selected={readFilter === id} onClick={() => setReadFilter(id)}>{label}</button>
              ))}
            </div>
            <label className="completion-select"><span className="sr-only">完成状态</span>
              <select value={completion} onChange={(event) => setCompletion(event.target.value as CompletionFilter)}>
                <option value="all">全部状态</option><option value="open">未完成</option><option value="done">已完成</option>
              </select>
            </label>
          </div>
        </header>
        <div className="entries-scroll">
          {result.loading ? <LoadingState /> : result.error ? <ErrorState message={result.error} onRetry={result.refresh} /> : (
            <FeedView entries={rows} agents={agents} selectedId={selectedId} onSelect={select} emptyTitle={deferredSearch ? "没有符合条件的信息" : undefined} />
          )}
          {result.nextCursor ? <button className="load-more" type="button" onClick={result.loadMore} disabled={result.loadingMore}>{result.loadingMore ? "正在读取…" : "加载更多"}</button> : null}
        </div>
        <footer className="entry-count">{rows.length}{result.nextCursor ? "+" : ""} 条信息</footer>
      </section>
      <section className="reader-pane">
        {selectedId ? <EntryReader entryId={selectedId} agents={agents} onChanged={result.refresh} onBack={() => setReading(false)} /> : <EmptyState title="选择一条信息" detail="正文与历史版本会显示在这里。" />}
      </section>
    </div>
  );
}
