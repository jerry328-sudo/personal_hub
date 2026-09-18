import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  ChevronLeft,
  CircleCheck,
  FileClock,
  ImagePlus,
  ListTodo,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { AgentDto, EntryFullDto, EntryVersionDto } from "../../shared/contracts";
import { attachmentsApi, entriesApi, notifyDataChanged } from "../api";
import { formatDateTime } from "../lib/format";
import { MarkdownContent } from "./MarkdownContent";
import { TaskForm } from "./TaskForm";
import { AgentBadge, ConfirmDialog, Dialog, ErrorState, LoadingState, useToast } from "./ui";

interface EntryReaderProps {
  entryId: string;
  agents: AgentDto[];
  onChanged?: () => void;
  onBack?: () => void;
  embedded?: boolean;
}

export function EntryReader({ entryId, agents, onChanged, onBack, embedded = false }: EntryReaderProps) {
  const { showToast } = useToast();
  const [entry, setEntry] = useState<EntryFullDto | null>(null);
  const [version, setVersion] = useState<EntryVersionDto | null>(null);
  const [versions, setVersions] = useState<number[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    return Promise.all([
      entriesApi.get(entryId, signal),
      entriesApi.listVersions(entryId, undefined, signal),
    ]).then(([current, history]) => {
      setEntry(current);
      setVersions(history.items.map((item) => item.version).sort((a, b) => b - a));
      setSelectedVersion((existing) => existing && existing <= current.version ? existing : current.version);
    }).catch((reason: unknown) => {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "正文读取失败");
    }).finally(() => {
      if (!signal?.aborted) setLoading(false);
    });
  }, [entryId]);

  useEffect(() => {
    const controller = new AbortController();
    setEntry(null);
    setVersion(null);
    setSelectedVersion(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!entry || selectedVersion === null || selectedVersion === entry.version) {
      setVersion(null);
      return;
    }
    const controller = new AbortController();
    entriesApi.getVersion(entryId, selectedVersion, controller.signal)
      .then(setVersion)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) showToast(reason instanceof Error ? reason.message : "历史版本读取失败", "error");
      });
    return () => controller.abort();
  }, [entry, entryId, selectedVersion, showToast]);

  const agent = useMemo(() => agents.find((item) => item.id === entry?.agent_id), [agents, entry?.agent_id]);
  const displayed = version ?? entry;
  const displayedVersion = version?.version ?? entry?.version ?? 0;
  const isHistory = Boolean(entry && displayedVersion !== entry.version);
  const displayedAt = isHistory && version ? version.created_at : entry?.updated_at;

  const mutateState = async (patch: { completed?: boolean; archived?: boolean; read_version?: number }, success: string) => {
    if (!entry) return;
    setBusy(true);
    try {
      const state = await entriesApi.setState(entry.id, patch);
      setEntry((current) => current ? { ...current, ...state } : current);
      notifyDataChanged();
      onChanged?.();
      showToast(success);
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "状态更新失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async () => {
    if (!entry || !version) return;
    setBusy(true);
    try {
      await entriesApi.appendVersion(entry.id, {
        base_version: entry.version,
        title: version.title,
        content: version.content,
        url: version.url,
        important: version.important,
      });
      setRestoreOpen(false);
      setSelectedVersion(null);
      await load();
      notifyDataChanged();
      onChanged?.();
      showToast("已把历史内容追加为新版本");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "恢复版本失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const uploadImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !entry) return;
    setBusy(true);
    try {
      const attachment = await attachmentsApi.upload(entry.agent_id, file);
      const alt = attachment.filename.replaceAll("[", "").replaceAll("]", "");
      const content = `${entry.content.trimEnd()}\n\n![${alt}](${attachment.url})\n`;
      await entriesApi.appendVersion(entry.id, {
        base_version: entry.version,
        title: entry.title,
        content,
        url: entry.url,
        important: entry.important,
      });
      setImageOpen(false);
      await load();
      notifyDataChanged();
      onChanged?.();
      showToast("图片已上传，并追加为新版本");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "图片上传失败", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !entry) return <LoadingState label="正在读取正文…" />;
  if (error || !entry || !displayed) return <ErrorState message={error ?? "信息不存在"} onRetry={() => void load()} />;

  return (
    <section className={`entry-reader ${embedded ? "embedded" : ""}`} aria-label="信息正文">
      <div className="reader-toolbar">
        {onBack ? <button className="icon-btn back-list" type="button" onClick={onBack} aria-label="返回信息列表"><ChevronLeft aria-hidden="true" /></button> : null}
        <span className="source-name">
          <AgentBadge name={agent?.name ?? entry.agent_id} index={agents.findIndex((item) => item.id === entry.agent_id)} />
          {agent?.name ?? entry.agent_id}
        </span>
        <span className="spacer" />
        <button className="btn" type="button" disabled={busy} onClick={() => void mutateState({ completed: !entry.completed }, entry.completed ? "已恢复为未完成" : "已完成，Agent 读取时仍会包含这条记录")}>
          {entry.completed ? <RotateCcw aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
          {entry.completed ? "恢复未完成" : "标为已完成"}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => void mutateState({ archived: !entry.archived }, entry.archived ? "已移出归档" : "已归档") }>
          {entry.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
          {entry.archived ? "取消归档" : "归档"}
        </button>
        <button className="btn" type="button" onClick={() => setTaskOpen(true)}><ListTodo aria-hidden="true" />创建待办</button>
        <button className="btn" type="button" onClick={() => setImageOpen(true)}><ImagePlus aria-hidden="true" />添加图片</button>
      </div>
      <div className="article-scroll">
        <article className="article">
          <h1>{displayed.title}</h1>
          <div className="article-meta">
            <time dateTime={displayedAt}>{formatDateTime(displayedAt)}</time>
            <span>·</span>
            <span>{isHistory ? "历史版本" : "当前版本"}</span>
            <label className="version-field">
              <span className="sr-only">选择版本</span>
              <select value={displayedVersion} onChange={(event) => setSelectedVersion(Number(event.target.value))}>
                {(versions.length ? versions : [entry.version]).map((number) => (
                  <option value={number} key={number}>v{number}{number === entry.version ? " · 最新" : ""}</option>
                ))}
              </select>
            </label>
          </div>
          {entry.completed ? (
            <div className="done-banner"><CircleCheck aria-hidden="true" />已完成{entry.completed_at ? ` · ${formatDateTime(entry.completed_at)}` : ""}{entry.read_version < entry.version ? " · 完成后有更新" : ""}</div>
          ) : null}
          {isHistory ? (
            <div className="notice history"><FileClock aria-hidden="true" />你正在查看历史版本 v{displayedVersion}，处理状态显示的是当前条目状态。</div>
          ) : entry.read_version < entry.version ? (
            <div className="notice"><FileClock aria-hidden="true" />当前版本尚未标记为已读。</div>
          ) : null}
          <MarkdownContent content={displayed.content} />
          {displayed.url ? (
            <div className="source-block">
              <span>来源</span>
              <a href={displayed.url} target="_blank" rel="noreferrer noopener">打开原始页面 <ArrowUpRight aria-hidden="true" /></a>
            </div>
          ) : null}
          <div className="article-actions">
            {isHistory ? <button className="btn" type="button" onClick={() => setRestoreOpen(true)}><RotateCcw aria-hidden="true" />作为新版本恢复</button> : null}
            {entry.read_version >= displayedVersion ? (
              <span className="read-marker"><Check aria-hidden="true" />v{displayedVersion} 已读</span>
            ) : (
              <button className="text-action" type="button" disabled={busy} onClick={() => void mutateState({ read_version: displayedVersion }, `已标记 v${displayedVersion} 为已读`)}>标记 v{displayedVersion} 为已读</button>
            )}
          </div>
        </article>
      </div>
      <TaskForm open={taskOpen} onClose={() => setTaskOpen(false)} agents={agents} entry={entry} />
      <Dialog open={imageOpen} title="添加图片" onClose={() => setImageOpen(false)}>
        <p className="dialog-description">图片将保存到私有 R2，并以新版本追加到正文末尾。PNG、JPEG、WebP 或 GIF，最大 10 MiB。</p>
        <label className={`file-drop ${busy ? "disabled" : ""}`}>
          <ImagePlus aria-hidden="true" />
          <strong>{busy ? "正在处理…" : "选择图片"}</strong>
          <span>上传成功前请不要关闭页面</span>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(event) => void uploadImage(event)} />
        </label>
      </Dialog>
      <ConfirmDialog
        open={restoreOpen}
        title={`恢复历史版本 v${displayedVersion}`}
        description="历史正文会作为一个新的最新版本追加，旧版本和完成、归档状态都会保留。"
        confirmLabel="追加新版本"
        busy={busy}
        onClose={() => setRestoreOpen(false)}
        onConfirm={restoreVersion}
      />
    </section>
  );
}
