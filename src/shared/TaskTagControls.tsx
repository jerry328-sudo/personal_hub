import { useState } from "react";
import type { TaskTagDto } from "./contracts";
import "./task-tags.css";

export function TaskTagBadges({ tags = [] }: { tags?: TaskTagDto[] }) {
  return <span className="task-tag-badges">{tags.length ? tags.map((tag) => <span className="task-tag-badge" key={tag.id}>{tag.name}</span>) : <span className="task-tag-empty">无标签</span>}</span>;
}

export function TaskTagPicker({ tags, selected, onChange, disabled = false }: { tags: TaskTagDto[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  return <fieldset className="task-tag-picker" disabled={disabled}><legend>标签（可多选）</legend>{tags.length ? tags.map((tag) =>
    <label key={tag.id}><input type="checkbox" checked={selected.includes(tag.id)} onChange={(event) => onChange(event.target.checked ? [...selected, tag.id] : selected.filter((id) => id !== tag.id))} />{tag.name}</label>) : <p>暂无可用标签，请由管理员或总管新增。</p>}</fieldset>;
}

export function TaskTagEditor({ tags, initial, save }: { tags: TaskTagDto[]; initial: TaskTagDto[]; save: (patch: { add_tag_ids: string[]; remove_tag_ids: string[] }) => Promise<void> }) {
  const [selected, setSelected] = useState(initial.map((tag) => tag.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form onSubmit={(event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    const original = initial.map((tag) => tag.id);
    void save({ add_tag_ids: selected.filter((id) => !original.includes(id)), remove_tag_ids: original.filter((id) => !selected.includes(id)) })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "标签更新失败"))
      .finally(() => setBusy(false));
  }}><TaskTagPicker tags={tags} selected={selected} onChange={setSelected} disabled={busy} />{error ? <p role="alert">{error}</p> : null}<button className="tag-control-button" type="submit" disabled={busy}>{busy ? "保存中…" : "保存标签"}</button></form>;
}

function TagNameRow({ tag, disabled, rename, remove }: { tag: TaskTagDto; disabled: boolean; rename: (name: string) => void; remove: () => void }) {
  const [name, setName] = useState(tag.name);
  return <div className="task-tag-manager-row"><input aria-label={`重命名标签：${tag.name}`} maxLength={40} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
    <button className="tag-control-button" type="button" disabled={disabled || !name.trim() || name.trim() === tag.name} aria-label={`保存标签：${tag.name}`} onClick={() => rename(name.trim())}>保存</button>
    <button className="tag-control-button" type="button" disabled={disabled} aria-label={`删除标签：${tag.name}`} onClick={remove}>删除</button></div>;
}

export function TaskTagManager({ tags, create, rename, remove }: { tags: TaskTagDto[]; create: (name: string) => Promise<void>; rename: (id: string, name: string) => Promise<void>; remove: (id: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<TaskTagDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); } finally { setBusy(false); }
  };
  return <div className="task-tag-manager"><p>标签可跨来源使用。删除标签只解除关联，待办及其他标签都会保留。</p>
    <form className="task-tag-manager-row" onSubmit={(event) => { event.preventDefault(); void run(async () => { await create(name.trim()); setName(""); }); }}>
      <input aria-label="新标签名称" placeholder="例如：工作、生活" value={name} maxLength={40} disabled={busy} onChange={(event) => setName(event.target.value)} />
      <button className="tag-control-button" disabled={busy || !name.trim()} type="submit">新增标签</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {tags.map((tag) => <TagNameRow key={`${tag.id}:${tag.name}`} tag={tag} disabled={busy} rename={(value) => { void run(() => rename(tag.id, value)); }} remove={() => setDeleting(tag)} />)}
    {deleting ? <div className="task-tag-delete" role="group" aria-label="删除标签确认"><p>删除“{deleting.name}”？所有待办都会保留，其他标签不受影响。</p>
      <button className="tag-control-button" type="button" disabled={busy} onClick={() => setDeleting(null)}>取消删除</button>
      <button className="tag-control-button" type="button" disabled={busy} onClick={() => { void run(async () => { await remove(deleting.id); setDeleting(null); }); }}>确认删除标签</button></div> : null}
  </div>;
}
