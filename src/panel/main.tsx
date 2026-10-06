import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Archive, ArrowLeft, Check, CircleCheck, Copy, FilePlus, Mail, Paperclip, RefreshCw, Search, X } from "lucide-react";
import type { EntryBriefDto, EntryFullDto, EntryVersionBriefDto, EntryVersionDto, Page, TaskDto } from "../shared/contracts";
import type { PanelSnapshot, PanelSource } from "../shared/panel";
import { app, attachContext, call, clearContext, connect, extensions } from "./client";
import "./style.css";

type Nav = "inbox" | "sources" | "tasks" | "archive";
type Selected = { source: string; entry: EntryVersionDto };
const tabs: [Nav, string][] = [["inbox", "收件箱"], ["sources", "来源"], ["tasks", "待办"], ["archive", "归档"]];
const layouts = { feed: "信息流", list: "清单", report: "报告" };
const dateText = (value: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";
const deduplicate = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()];

function HubIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 4.5h8M6 8h8M3 10.5v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>;
}

function Dialog({ title, close, children, actions }: { title: string; close: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={close}>
    <header className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X /></button></header>
    <div className="dialog-body">{children}</div><footer className="dialog-actions">{actions ?? <button className="button" onClick={close}>关闭</button>}</footer>
  </dialog>;
}

function Attachment({ src, alt }: { src?: string; alt?: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const id = /^\/api\/v1\/media\/([A-Za-z0-9_-]+)$/.exec(src ?? "")?.[1];
    if (!id) { setError(true); return; }
    void app.callServerTool({ name: "get_image", arguments: { id } }).then((result) => {
      const block = result.content.find((item) => item.type === "image");
      if (result.isError || !block || !/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)) throw new Error("图片不可用");
      if (!cancelled) setImage(`data:${block.mimeType};base64,${block.data}`);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [src]);
  return image ? <figure className="article-image"><img src={image} alt={alt ?? ""} /><figcaption>{alt}</figcaption></figure>
    : <span className="image-placeholder">{alt || "附件图片"} · {error ? "无法读取" : "加载中"}</span>;
}

function Markdown({ content, origin }: { content: string; origin: string }) {
  return <article className="article-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={(url, key) => {
      if (key === "src") return /^\/api\/v1\/media\/[A-Za-z0-9_-]+$/.test(url) ? url : "";
      try { const parsed = new URL(url, origin); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : ""; } catch { return ""; }
    }} components={{
      img: ({ src, alt }) => <Attachment src={src} alt={alt} />,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        if (!href) return; event.preventDefault(); void app.openLink({ url: href }).catch(() => undefined);
      }}>{children}</a>,
    }}>{content}</ReactMarkdown></article>;
}

function SourceCard({ record, mode, origin, source, selected, busy, revision, onSelect, onTask }: {
  record: EntryBriefDto; mode: "feed" | "list"; origin: string; source: string; selected: boolean; busy: boolean;
  revision: number; onSelect: (checked: boolean) => void; onTask?: (entry: EntryFullDto) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(mode === "feed");
  const [visible, setVisible] = useState(false);
  const [full, setFull] = useState<EntryFullDto | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(([target]) => { if (target?.isIntersecting) { setVisible(true); observer.disconnect(); } });
    if (ref.current) observer.observe(ref.current);
    return () => { observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false; setError("");
    void call<EntryFullDto>("get_entry", { id: record.id }).then((value) => { if (!cancelled) setFull(value); })
      .catch((failure: unknown) => { if (!cancelled) { setFull(null); setError(messageOf(failure)); } });
    return () => { cancelled = true; };
  }, [open, visible, record.id, revision]);
  return <div ref={ref} className="source-card">
    <div className="source-card-heading"><input type="checkbox" checked={selected} disabled={busy} aria-label={`选择：${record.title}`} onChange={(event) => { onSelect(event.target.checked); }} />
      <button className="row-open" aria-expanded={open} aria-label={`展开：${record.title}`} onClick={() => { setOpen((value) => !value); }}><strong>{record.title}</strong><span className="row-meta">{source} · {dateText(record.updated_at)} · 版本 {record.version}</span></button></div>
    {open ? <div className="source-card-body">{error ? <p role="alert">{error}</p> : full ? <><Markdown content={full.content} origin={origin} />{onTask ? <button className="button green-outline small" disabled={busy} onClick={() => { onTask(full); }}><FilePlus />创建待办</button> : null}</> : <p role="status">正在读取正文…</p>}</div> : null}
  </div>;
}

function TaskForm({ sources, entry, onSubmit, busy }: { sources: PanelSource[]; entry: EntryFullDto | null; onSubmit: (args: Record<string, unknown>) => void; busy: boolean }) {
  const writable = sources.filter((source) => (!source.role || source.role === "agent") && source.status === "active");
  return <form id="task-form" onSubmit={(event) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    const due = String(values.get("due"));
    onSubmit({ title: String(values.get("title")).trim(), agent_id: entry?.agent_id ?? String(values.get("source")),
      ...(entry ? { entry_id: entry.id } : {}), due_at: due ? new Date(`${due}T23:59:59`).toISOString() : null });
  }}><label className="form-field">待办标题<input name="title" aria-label="待办标题" required maxLength={180} autoFocus disabled={busy} /></label>
    <label className="form-field">来源<select name="source" aria-label="待办来源" defaultValue={entry?.agent_id ?? writable[0]?.id} disabled={busy || Boolean(entry)} required>{writable.filter((source) => !entry || source.id === entry.agent_id).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
    <label className="form-field">截止日期（可选）<input name="due" type="date" aria-label="截止日期" disabled={busy} /></label>
  </form>;
}

function HubPanel({ initial }: { initial: PanelSnapshot }) {
  const [nav, setNav] = useState<Nav>("inbox");
  const [sources, setSources] = useState(initial.sources);
  const [entries, setEntries] = useState(initial.entries);
  const [sourceId, setSourceId] = useState("all");
  const [sourceBoard, setSourceBoard] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(initial.entry?.id ?? null);
  const [reading, setReading] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const [entry, setEntry] = useState(initial.entry);
  const [history, setHistory] = useState<Page<EntryVersionBriefDto>>({ items: [], next_cursor: null });
  const [historical, setHistorical] = useState<EntryVersionDto | null>(null);
  const [selected, setSelected] = useState<Map<string, Selected>>(() => new Map());
  const [attached, setAttached] = useState(false);
  const [tasks, setTasks] = useState<Page<TaskDto>>({ items: [], next_cursor: null });
  const [taskFilter, setTaskFilter] = useState("open");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [readerLoading, setReaderLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"context" | "manage" | "task" | "clear" | null>(null);
  const [clearScope, setClearScope] = useState<{ agent_id?: string; label: string } | null>(null);
  const [taskEntry, setTaskEntry] = useState<EntryFullDto | null>(null);
  const boot = useRef(true);
  const readerBoot = useRef(true);
  const requestVersion = useRef(0);
  const tasksRequestVersion = useRef(0);
  const mounted = useRef(true);
  const locking = useRef(false);
  const restoredContext = useRef(false);
  const [identity, setIdentity] = useState(initial.identity);
  const sourceName = (id: string) => sources.items.find((source) => source.id === id)?.name ?? id;
  const board = sources.items.find((source) => source.id === sourceBoard);
  const shownVersion = historical?.version ?? entry?.version;
  const displayed = historical ?? entry;
  const queryArgs = { view: "brief", archived: nav === "archive" ? "yes" : "no", order: "updated_desc", limit: 50,
    ...(sourceId !== "all" ? { agent_id: sourceId } : {}), ...(query ? { query } : {}),
    ...(filter === "unread" ? { read: "unread" } : {}), ...(filter === "important" ? { important: "yes" } : {}) };
  const entryQuery = JSON.stringify(queryArgs);
  const taskQuery = JSON.stringify({ done: taskFilter === "done" ? "yes" : taskFilter === "open" ? "no" : "all",
    limit: 100, ...(sourceId !== "all" ? { agent_id: sourceId } : {}) });
  const visibleTasks = tasks.items.filter((task) => task.title.toLowerCase().includes(search.trim().toLowerCase()));

  const prepareClear = () => {
    setClearScope({ ...(sourceId === "all" ? {} : { agent_id: sourceId }), label: sourceId === "all" ? "全部来源" : sourceName(sourceId) });
    setModal("clear");
  };
  const clearCompleted = async () => {
    if (!clearScope || locking.current) return;
    locking.current = true; setBusy(true); setError("");
    try {
      const { cleared } = await call<{ cleared: number }>("clear_completed_tasks", { agent_id: clearScope.agent_id });
      setNotice(`已清除 ${cleared} 项已完成待办`); setRevision((value) => value + 1);
    } catch { setError("暂时无法清除已完成待办，请稍后再试"); }
    finally { setModal(null); setClearScope(null); locking.current = false; setBusy(false); }
  };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); }, 250); return () => { clearTimeout(timer); }; }, [search]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => { setNotice(""); }, 3200); return () => { clearTimeout(timer); }; }, [notice]);

  useEffect(() => {
    if (nav === "tasks" || (nav === "sources" && !sourceBoard)) return;
    if (boot.current && nav === "inbox" && revision === 0) { boot.current = false; return; }
    const generation = ++requestVersion.current;
    setLoading(true); setError("");
    void call<Page<EntryBriefDto>>("list_entries", JSON.parse(entryQuery) as Record<string, unknown>).then((page) => {
      if (generation !== requestVersion.current || !mounted.current) return;
      setEntries(page);
      setVersion(null);
      setActiveId((id) => board?.display_mode === "report" && board.main_entry_id && filter === "all" && !query
        ? board.main_entry_id : page.items.some((item) => item.id === id) ? id : page.items[0]?.id ?? null);
    }).catch((failure: unknown) => {
      if (generation === requestVersion.current && mounted.current) { setError(messageOf(failure)); setEntries({ items: [], next_cursor: null }); setActiveId(null); }
    }).finally(() => { if (generation === requestVersion.current && mounted.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [entryQuery, nav, sourceBoard, revision, board, filter, query]);

  useEffect(() => {
    if (nav !== "tasks") return;
    let cancelled = false; const generation = ++tasksRequestVersion.current; setLoading(true); setError("");
    setTasks({ items: [], next_cursor: null });
    void call<Page<TaskDto>>("list_tasks", JSON.parse(taskQuery) as Record<string, unknown>).then((page) => {
      if (!cancelled) setTasks(page);
    }).catch((failure: unknown) => { if (!cancelled) { setError(messageOf(failure)); setTasks({ items: [], next_cursor: null }); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (tasksRequestVersion.current === generation) tasksRequestVersion.current++; };
  }, [nav, taskQuery, revision]);

  useEffect(() => {
    if (!activeId) { setEntry(null); setHistorical(null); setReaderLoading(false); setHistory({ items: [], next_cursor: null }); return; }
    let cancelled = false; setReaderLoading(true);
    const cached = readerBoot.current && revision === 0 && activeId === initial.entry?.id ? initial.entry : null;
    readerBoot.current = false;
    void Promise.all([
      cached ? Promise.resolve(cached) : call<EntryFullDto>("get_entry", { id: activeId }),
      call<Page<EntryVersionBriefDto>>("list_entry_versions", { id: activeId, limit: 50 }),
      version ? call<EntryVersionDto>("get_entry_version", { id: activeId, version }) : Promise.resolve(null),
    ]).then(([current, versions, past]) => {
      if (!cancelled) { setEntry(current); setHistory(versions); setHistorical(past); }
    }).catch((failure: unknown) => { if (!cancelled) { setError(messageOf(failure)); setEntry(null); setHistorical(null); } })
      .finally(() => { if (!cancelled) setReaderLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, version, revision, initial.entry]);

  const hostContextChanged = useCallback(() => {
    const context = extensions.modelContext?.getCurrent();
    if (context === null || (context && Array.isArray(context.structuredContent?.records) && context.structuredContent.records.length === 0)) { if (attached) setSelected(new Map()); setAttached(false); return; }
    if (attached && context?.content) {
      const references = context.content.flatMap((block) => {
        const record = block._meta?.personalHubEntry as { id?: unknown; version?: unknown } | undefined;
        return typeof record?.id === "string" && typeof record.version === "number" ? [record.id] : [];
      });
      if (references.length !== context.content.length) return;
      setSelected((previous) => new Map([...previous].filter(([id]) => references.includes(id))));
    }
  }, [attached]);
  useEffect(() => { app.addEventListener("hostcontextchanged", hostContextChanged); return () => { app.removeEventListener("hostcontextchanged", hostContextChanged); }; }, [hostContextChanged]);
  useEffect(() => {
    if (restoredContext.current) return; restoredContext.current = true;
    const current = extensions.modelContext?.getCurrent();
    if (!current?.content?.length) return;
    const records = current.content.flatMap((block) => {
      const record = block._meta?.personalHubEntry as { id?: unknown; version?: unknown; source?: unknown } | undefined;
      return typeof record?.id === "string" && typeof record.version === "number" && Number.isInteger(record.version) && record.version > 0
        ? [{ id: record.id, version: record.version, source: typeof record.source === "string" ? record.source : "Hub 引用" }] : [];
    });
    if (!records.length) return;
    void Promise.all(records.map(async (record) => {
      const value = await call<EntryVersionDto>("get_entry_version", { id: record.id, version: record.version });
      return [record.id, { entry: value, source: record.source }] as const;
    })).then((values) => { if (mounted.current) { setSelected(new Map(values)); setAttached(true); } })
      .catch((failure: unknown) => { if (mounted.current) setError(messageOf(failure)); });
  }, [initial.sources.items]);

  async function mutate(run: () => Promise<unknown>, success: string) {
    if (locking.current) return;
    locking.current = true; setBusy(true); setError("");
    try { await run(); setNotice(success); setRevision((value) => value + 1); }
    catch (failure) { setError(messageOf(failure)); }
    finally { locking.current = false; if (mounted.current) setBusy(false); }
  }

  function navigate(next: Nav) {
    setNav(next); setSourceBoard(null); setSourceId("all"); setFilter("all"); setSearch(""); setQuery(""); setVersion(null); setReading(false); setError("");
  }
  function openEntry(id: string) { setActiveId(id); setVersion(null); setReading(true); }
  function refresh() {
    void mutate(async () => {
      const snapshot = await app.callServerTool({ name: "open_hub_panel", arguments: {} });
      if (snapshot.isError) throw new Error("无法刷新 Hub，请检查连接授权。");
      const fresh = snapshot._meta?.personalHub as PanelSnapshot | undefined;
      if (!fresh) throw new Error("未收到 Hub 数据。");
      setIdentity(fresh.identity);
      setSources(fresh.sources);
    }, "已刷新");
  }

  async function selectRecord(record: EntryBriefDto, checked: boolean, forcedVersion?: number) {
    if (!checked) { setSelected((previous) => { const next = new Map(previous); next.delete(record.id); return next; }); setAttached(false); return; }
    if (locking.current) return;
    locking.current = true; setBusy(true);
    try {
      const targetVersion = forcedVersion ?? (record.id === activeId && shownVersion ? shownVersion : record.version);
      const full = await call<EntryVersionDto>("get_entry_version", { id: record.id, version: targetVersion });
      setSelected((previous) => new Map(previous).set(record.id, { source: sourceName(record.agent_id), entry: full })); setAttached(false);
    } catch (failure) { setError(messageOf(failure)); }
    finally { locking.current = false; setBusy(false); }
  }

  async function attachSelected() {
    if (locking.current) return; locking.current = true; setBusy(true); setError("");
    try {
      // Read snapshots again under the current authorization before sharing private content.
      const checked = await Promise.all([...selected.values()].map(async (item) => ({ ...item,
        entry: await call<EntryVersionDto>("get_entry_version", { id: item.entry.entry_id, version: item.entry.version }) })));
      await attachContext(checked.map(({ source, entry: item }) => ({ type: "text" as const,
        text: `# ${item.title}\n来源：${source}\n条目：${item.entry_id} · 版本 ${item.version}\n链接：${initial.app_origin}/entries/${encodeURIComponent(item.entry_id)}\n\n${item.content}`,
        _meta: { "openai/title": `${source} · ${item.title}（v${item.version}）`, personalHubEntry: { id: item.entry_id, version: item.version, source } } })),
      checked.map(({ entry: item }) => ({ id: item.entry_id, version: item.version })));
      setAttached(true); setModal(null); setNotice("已附到当前聊天，发送消息时会带上这些引用。");
    } catch (failure) { setError(messageOf(failure)); }
    finally { locking.current = false; setBusy(false); }
  }

  async function moreEntries() {
    const cursor = entries.next_cursor; if (!cursor || loading) return; const generation = requestVersion.current; setLoading(true);
    try { const page = await call<Page<EntryBriefDto>>("list_entries", { ...JSON.parse(entryQuery) as Record<string, unknown>, cursor });
      if (generation === requestVersion.current) setEntries((previous) => ({ items: deduplicate([...previous.items, ...page.items]), next_cursor: page.next_cursor }));
    } catch (failure) { if (generation === requestVersion.current) setError(messageOf(failure)); }
    finally { if (generation === requestVersion.current) setLoading(false); }
  }

  async function moreSources() {
    if (!sources.next_cursor) return;
    await mutate(async () => {
      const page = await call<Page<PanelSource>>("list_agents", { cursor: sources.next_cursor, limit: 100, ...(identity.role === "reader" ? {} : { status: "all" }) });
      setSources((previous) => ({ items: deduplicate([...previous.items, ...page.items]), next_cursor: page.next_cursor }));
    }, "已加载更多来源");
  }

  async function moreTasks() {
    if (!tasks.next_cursor || loading) return; const generation = tasksRequestVersion.current; setLoading(true);
    try { const page = await call<Page<TaskDto>>("list_tasks", { ...JSON.parse(taskQuery) as Record<string, unknown>, cursor: tasks.next_cursor });
      if (generation === tasksRequestVersion.current) setTasks((previous) => ({ items: deduplicate([...previous.items, ...page.items]), next_cursor: page.next_cursor }));
    } catch (failure) { if (generation === tasksRequestVersion.current) setError(messageOf(failure)); } finally { if (generation === tasksRequestVersion.current) setLoading(false); }
  }

  function sourceBoardOpen(source: PanelSource) { setSourceBoard(source.id); setSourceId(source.id); setVersion(null); setReading(false); }
  function row(record: EntryBriefDto) {
    return <div className={`entry-row ${activeId === record.id ? "selected" : ""}`} key={record.id}>
      <input type="checkbox" aria-label={`选择：${record.title}`} checked={selected.has(record.id)} disabled={busy} onChange={(event) => { void selectRecord(record, event.target.checked); }} />
      <button className="row-open" aria-label={`打开：${record.title}`} onClick={() => { openEntry(record.id); }}><strong>{record.title}</strong>
        <span className="row-meta">{sourceName(record.agent_id)} · {dateText(record.updated_at)}</span>
        <span className="row-summary">版本 {record.version} · {record.completed ? "已完成" : record.version > record.read_version ? "有未读更新" : "已读"}{record.important ? " · 重要" : ""}</span>
      </button>
    </div>;
  }

  function reader() {
    if (readerLoading) return <div className="empty-state" role="status">正在读取条目…</div>;
    if (!entry || !displayed) return <div className="empty-state">选择一条记录阅读。</div>;
    return <><button className="back-button" onClick={() => { setReading(false); }}><ArrowLeft />返回列表</button>
      <div className="reader-top"><div className="reader-meta">{sourceName(entry.agent_id)} · {dateText(historical?.created_at ?? entry.updated_at)}</div>
        <div className="reader-actions">{identity.can_manage_entries ? <>
          <button disabled={busy} onClick={() => { void mutate(() => call("update_entry_state", { id: entry.id, state: { read_version: Math.max(entry.read_version, shownVersion ?? entry.version) } }), "已标记当前版本为已读"); }}><Mail />{entry.read_version >= (shownVersion ?? entry.version) ? "已读" : "标记已读"}</button>
          <button disabled={busy} onClick={() => { void mutate(() => call("update_entry_state", { id: entry.id, state: { completed: !entry.completed } }), entry.completed ? "已恢复条目" : "条目已完成"); }}><CircleCheck />{entry.completed ? "恢复" : "完成"}</button>
          <button disabled={busy} onClick={() => { void mutate(() => call("update_entry_state", { id: entry.id, state: { archived: !entry.archived } }), entry.archived ? "已移回收件箱" : "已归档"); setReading(false); }}><Archive />{entry.archived ? "取消归档" : "归档"}</button>
        </> : null}<label className="version-control"><select aria-label="历史版本" value={shownVersion ?? ""} disabled={busy} onChange={(event) => { setVersion(Number(event.target.value)); }}>
          {!history.items.some((item) => item.version === entry.version) ? <option value={entry.version}>版本 {entry.version}</option> : null}
          {historical && historical.version !== entry.version && !history.items.some((item) => item.version === historical.version) ? <option value={historical.version}>版本 {historical.version}</option> : null}
          {history.items.map((item) => <option key={item.version} value={item.version}>版本 {item.version}</option>)}</select></label>
        </div></div>
      {history.next_cursor ? <button className="text-button" disabled={busy} onClick={() => {
        void call<Page<EntryVersionBriefDto>>("list_entry_versions", { id: entry.id, cursor: history.next_cursor, limit: 50 }).then((next) => {
          setHistory((previous) => ({ items: [...previous.items, ...next.items], next_cursor: next.next_cursor }));
        }).catch((failure: unknown) => { setError(messageOf(failure)); });
      }}>加载更早版本</button> : null}
      <h1 className="entry-title">{displayed.title}</h1><p className="version-note">版本 {shownVersion} · {shownVersion === entry.version ? "最新版本" : "历史版本"}
        {selected.has(entry.id) && selected.get(entry.id)?.entry.version !== shownVersion ? ` · 已选引用为版本 ${selected.get(entry.id)?.entry.version}` : ""}</p>
      <Markdown content={displayed.content} origin={initial.app_origin} />
      {identity.can_write ? <div className="article-create"><button className="button green-outline" disabled={busy} onClick={() => { setTaskEntry(entry); setModal("task"); }}><FilePlus />创建待办</button></div> : null}
      {selected.has(entry.id) && selected.get(entry.id)?.entry.version !== shownVersion ? <button className="text-button" disabled={busy} onClick={() => { void selectRecord(entry, true); }}>引用当前版本</button> : null}
    </>;
  }

  const sourcesView = <section className="full-view"><div className="view-heading"><div><h1>来源</h1><p>每个来源保留自己的记录与展示方式。</p></div></div>
    {sources.items.map((source) => <div className="source-row" key={source.id}><span className="source-symbol">{source.name.slice(0, 1)}</span><div className="source-copy"><strong>{source.name}</strong><p>{source.description || "暂无说明"}{source.status !== "active" ? ` · ${source.status === "disabled" ? "已停用" : "已移除"}` : ""}</p></div><span className="source-layout">{layouts[source.display_mode]}</span><button className="button small" aria-label={`查看来源：${source.name}`} onClick={() => { sourceBoardOpen(source); }}>查看</button></div>)}
    {sources.next_cursor ? <button className="button load-more" disabled={busy} onClick={() => { void moreSources(); }}>加载更多来源</button> : null}
  </section>;

  const listControls = <div className="list-controls"><div className="list-title"><h1>{board?.name ?? (nav === "archive" ? "归档" : "收件箱")}</h1><span className="record-count">{entries.items.length}{entries.next_cursor ? "+" : ""} 条记录</span></div>
    <div className="search-row"><label className="search-field"><Search /><input type="search" placeholder="搜索标题或内容" aria-label="搜索标题或内容" value={search} maxLength={200} onChange={(event) => { setSearch(event.target.value); setReading(false); }} /></label>
      {!board ? <select aria-label="来源筛选" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setReading(false); setVersion(null); }}><option value="all">全部来源</option>{sources.items.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select> : null}</div>
    <div className="filters">{[["all", "全部"], ["unread", "未读"], ["important", "重要"]].map(([id, label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? "active" : ""} onClick={() => { setFilter(id!); setReading(false); }}>{label}</button>)}</div>
  </div>;

  return <div className="hub-app">
    {modal === "clear" && clearScope ? <Dialog title="清除已完成待办" close={() => { if (!busy) { setModal(null); setClearScope(null); } }} actions={<><button className="button" disabled={busy} onClick={() => { setModal(null); setClearScope(null); }}>取消</button><button className="button primary" disabled={busy} onClick={() => { void clearCompleted(); }}>{busy ? "正在清除…" : "确认清除"}</button></>}>
      <p>将清除「{clearScope.label}」所有分页的已完成待办，包括归档关联项。搜索文字不影响范围。未完成待办和原始记录会保留。</p>
    </Dialog> : null}
    <header className="app-header"><button className="brand" onClick={() => { navigate("inbox"); }} aria-label="Personal Hub 收件箱"><HubIcon /><span>Personal Hub</span></button><div className="header-actions"><button className="icon-button" aria-label="刷新" disabled={busy} onClick={refresh}><RefreshCw /></button><button className="button" onClick={() => { setModal("manage"); }}>管理</button></div></header>
    <nav className="main-tabs" aria-label="Hub 导航">{tabs.map(([id, title]) => <button key={id} aria-current={nav === id ? "page" : undefined} onClick={() => { navigate(id); }}>{title}</button>)}</nav>
    {error ? <div className="error-banner" role="alert">{error}<button onClick={() => { setError(""); }} aria-label="关闭错误"><X /></button></div> : null}
    {nav === "sources" && !board ? <main className="workspace full">{sourcesView}</main> : nav === "tasks" ? <main className="workspace full"><section className="full-view">
      <div className="view-heading"><div><h1>待办</h1><p>从记录中提取下一步，逐项跟进。</p></div>{identity.can_write ? <button className="button green-outline" disabled={busy} onClick={() => { setTaskEntry(null); setModal("task"); }}><FilePlus />新增待办</button> : null}</div>
      <div className="task-toolbar"><div className="filters task-filters">{[["open", "未完成"], ["done", "已完成"], ["all", "全部"]].map(([id, label]) => <button key={id} className={taskFilter === id ? "active" : ""} aria-pressed={taskFilter === id} onClick={() => { setTaskFilter(id!); }}>{label}</button>)}</div>
        {identity.can_write ? <button className="button" disabled={busy} onClick={() => { void prepareClear(); }}>清除已完成</button> : null}
        <label className="search-field"><Search /><input type="search" placeholder="搜索待办" aria-label="搜索待办" value={search} onChange={(event) => { setSearch(event.target.value); }} /></label>
        <select aria-label="待办来源筛选" value={sourceId} onChange={(event) => { setSourceId(event.target.value); }}><option value="all">全部来源</option>{sources.items.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
      </div>
      {loading && tasks.items.length === 0 ? <div className="empty-state" role="status">正在读取待办…</div> : null}
      {visibleTasks.map((task) => <div className={`task-row ${task.done ? "done" : ""}`} key={task.id}><input type="checkbox" aria-label={`完成待办：${task.title}`} checked={task.done} disabled={busy || !identity.can_write} onChange={(event) => { void mutate(() => call("update_task", { id: task.id, task: { done: event.target.checked } }), "待办已更新"); }} /><div className="task-copy"><strong>{task.title}</strong><p>{sourceName(task.agent_id)}{task.due_at ? ` · 截止 ${dateText(task.due_at)}` : ""}</p></div>{identity.can_write ? <button className="text-button" disabled={busy} aria-label={`删除待办：${task.title}`} onClick={() => { if (window.confirm(`删除待办“${task.title}”？`)) void mutate(() => call("delete_task", { id: task.id }), "待办已删除"); }}>删除</button> : null}</div>)}
      {!loading && visibleTasks.length === 0 ? <div className="empty-state">{search ? "已载入的待办中没有匹配项。" : "没有符合条件的待办。"}</div> : null}
      {tasks.next_cursor ? <button className="button load-more" disabled={loading} onClick={() => { void moreTasks(); }}>加载更多待办</button> : null}
    </section></main> : <>
      {board ? <div className="board-toolbar"><button className="text-button" onClick={() => { setSourceBoard(null); setSourceId("all"); }}><ArrowLeft />返回来源</button><label className="layout-label">展示方式<select value={board.display_mode} disabled={busy || !identity.can_manage_sources} onChange={(event) => { const mode = event.target.value as PanelSource["display_mode"]; void mutate(async () => {
        await call("update_agent", { id: board.id, agent: { display_mode: mode } });
        setSources((previous) => ({ ...previous, items: previous.items.map((item) => item.id === board.id ? { ...item, display_mode: mode } : item) }));
      }, "展示方式已保存"); }}>{Object.entries(layouts).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label></div> : null}
      {board && board.display_mode !== "report" ? <main className="workspace full"><section className="full-view source-board"><div className="board-heading"><div className="board-title"><h1>{board.name}</h1><p>{board.description}</p></div></div>
        {loading && entries.items.length === 0 ? <div className="empty-state" role="status">正在读取来源记录…</div> : null}
        {entries.items.map((record) => <SourceCard key={`${record.id}-${board.display_mode}`} record={record} mode={board.display_mode as "feed" | "list"} origin={initial.app_origin} source={board.name} selected={selected.has(record.id)} busy={busy} revision={revision}
          onSelect={(checked) => { void selectRecord(record, checked, record.version); }} onTask={identity.can_write ? (value) => { setTaskEntry(value); setModal("task"); } : undefined} />)}
        {!loading && entries.items.length === 0 ? <div className="empty-state">这个来源暂时没有记录。</div> : null}
        {entries.next_cursor ? <button className="button load-more" disabled={loading} onClick={() => { void moreEntries(); }}>加载更多记录</button> : null}
      </section></main> : <main className={`workspace ${board ? "board-report" : ""}`} data-reading={String(reading || Boolean(board))}>
        <section className="list-pane" aria-label="条目列表">{listControls}<div className="entry-list" aria-busy={loading}>{entries.items.map(row)}
          {entries.next_cursor ? <button className="button load-more" disabled={loading} onClick={() => { void moreEntries(); }}>{loading ? "正在加载…" : "加载更多记录"}</button> : null}
          {!entries.items.length ? <div className="empty-state" role="status">{loading ? "正在读取记录…" : "没有符合条件的记录。"}</div> : null}
        </div></section><section className="reader-pane" aria-label="条目详情"><div className="reader-document">{reader()}</div></section>
      </main>}
    </>}
    <section className="selection-tray" aria-label="已选引用"><span className="selection-mark"><Check /></span><div className="selection-copy"><strong>已选 {selected.size} 条{attached ? " · 已附到聊天" : ""}</strong><span>{selected.size ? [...selected.values()].map((item) => item.entry.title).join("、") : "选择记录，再带入当前聊天"}</span></div><button className="button primary" disabled={!selected.size || busy} onClick={() => { setModal("context"); }}><Paperclip />带入聊天</button><button className="text-button" disabled={!selected.size || busy} onClick={() => { void mutate(async () => { await clearContext(); setSelected(new Map()); setAttached(false); }, "已清空引用"); }}>清空</button></section>
    <footer className="app-footer">{identity.role === "manager" ? "总管" : identity.role === "admin" ? "管理员" : identity.role === "reader" ? "只读" : "来源身份"} · Personal Hub</footer>
    {notice ? <div className="toast show" role="status">{notice}</div> : null}
    {modal === "context" ? <Dialog title="带入当前聊天" close={() => { setModal(null); }} actions={<><button className="button" disabled={busy} onClick={() => { void navigator.clipboard.writeText([...selected.values()].map(({ source, entry: item }) => `# ${item.title}\n来源：${source} · 版本 ${item.version}\n\n${item.content}`).join("\n\n---\n\n")).then(() => { setNotice("引用已复制"); }).catch(() => { setError("复制不可用，可以直接选取引用正文。"); }); }}><Copy />复制引用</button><button className="button primary" disabled={busy} onClick={() => { void attachSelected(); }}>附到聊天</button></>}>
      <p>引用包含来源、完整正文和所选版本。附上后，你可以继续在 Codex 输入消息。</p>{[...selected.values()].map(({ source, entry: item }) => <article className="context-item" key={item.entry_id}><h3>{item.title}</h3><div className="row-meta">{source} · 版本 {item.version}</div><div className="context-content">{item.content}</div></article>)}
    </Dialog> : modal === "task" ? <Dialog title="创建待办" close={() => { if (!busy) setModal(null); }} actions={<><button className="button" disabled={busy} onClick={() => { setModal(null); }}>取消</button><button className="button primary" form="task-form" type="submit" disabled={busy}>创建待办</button></>}>
      <TaskForm sources={sources.items} entry={taskEntry} busy={busy} onSubmit={(args) => { void mutate(async () => { await call("create_task", args); setModal(null); }, "待办已创建"); }} />
    </Dialog> : modal === "manage" ? <Dialog title="管理" close={() => { setModal(null); }}><div className="management-note">当前身份：{identity.role === "manager" ? "总管" : identity.role}。{identity.can_manage_sources ? "可以管理全部来源和展示方式。" : "当前连接未授权来源管理。"}</div>
      {sources.items.map((source) => <div className="management-row" key={source.id}><div className="source-copy"><strong>{source.name}</strong><p>{layouts[source.display_mode]} · {source.status === "active" ? "已启用" : "已停用"}</p></div>{identity.can_manage_sources && ["active", "disabled"].includes(source.status) ? <button className="button small" disabled={busy || source.id === identity.agent_id} onClick={() => { const action = source.status === "active" ? "disable" : "enable"; void mutate(async () => {
        await call("set_agent_status", { id: source.id, action }); setSources((previous) => ({ ...previous, items: previous.items.map((item) => item.id === source.id ? { ...item, status: action === "disable" ? "disabled" : "active" } : item) }));
      }, "来源状态已更新"); }}>{source.status === "active" ? "停用" : "启用"}</button> : null}</div>)}
      {sources.next_cursor ? <button className="button load-more" disabled={busy} onClick={() => { void moreSources(); }}>加载更多来源</button> : null}
    </Dialog> : null}
  </div>;
}

function Startup() {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (window.parent === window) { setError("请从 Codex 的 Personal Hub 插件打开这个面板。"); return; }
    void connect().then(setSnapshot).catch((failure: unknown) => { setError(messageOf(failure)); });
  }, []);
  if (snapshot) return <HubPanel initial={snapshot} />;
  return <div className="startup"><HubIcon /><h1>Personal Hub</h1><p role={error ? "alert" : "status"}>{error || "正在连接 Hub…"}</p>{error ? <button className="button" onClick={() => { window.location.reload(); }}>重新连接</button> : null}</div>;
}

createRoot(document.getElementById("root")!).render(<Startup />);
