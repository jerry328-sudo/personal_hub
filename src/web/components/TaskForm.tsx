import { useEffect, useState, type FormEvent } from "react";
import type { AgentDto, EntryBriefDto, TaskDto } from "../../shared/contracts";
import { dateInputToIso } from "../lib/format";
import { notifyDataChanged, tasksApi } from "../api";
import { Dialog, useToast } from "./ui";

export function TaskForm({
  open,
  onClose,
  agents,
  entry,
  defaultAgentId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  agents: AgentDto[];
  entry?: EntryBriefDto | null;
  defaultAgentId?: string;
  onCreated?: (task: TaskDto) => void;
}) {
  const { showToast } = useToast();
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId ?? "manual");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(entry?.title ?? "");
    setAgentId(entry?.agent_id ?? defaultAgentId ?? "manual");
    setDue("");
  }, [defaultAgentId, entry, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const task = await tasksApi.create({
        title: title.trim(),
        agent_id: entry ? undefined : agentId,
        entry_id: entry?.id ?? null,
        due_at: dateInputToIso(due),
      });
      notifyDataChanged();
      onCreated?.(task);
      onClose();
      showToast("待办已创建");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "待办创建失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const selectableAgents = agents.filter((agent) => agent.id !== "manual" && agent.scope === "own" && agent.status !== "deleting");
  return (
    <Dialog open={open} title={entry ? "从信息创建待办" : "新增待办"} onClose={onClose}>
      <p className="dialog-description">
        {entry ? "待办会保留来源链接，原始信息更新时待办内容保持不变。" : "记录一件需要处理的事情。"}
      </p>
      <form onSubmit={submit}>
        <label className="field">待办标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} autoFocus />
        </label>
        {entry ? null : (
          <label className="field">归属
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="manual">手动待办</option>
              {selectableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
        )}
        <label className="field">截止日期（可选）
          <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "创建中…" : "创建待办"}</button>
        </div>
      </form>
    </Dialog>
  );
}
