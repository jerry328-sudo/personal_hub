import { CheckCheck } from "lucide-react";
import { useState } from "react";
import { entriesApi, notifyDataChanged, type EntryListQuery } from "../api";
import { useToast } from "./ui";

export function MarkReadButton({ query }: { query: EntryListQuery }) {
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();
  const markRead = async () => {
    setBusy(true);
    try {
      const result = await entriesApi.markRead(query);
      notifyDataChanged();
      showToast(`已将当前筛选范围内 ${result.updated} 条信息标为已读`);
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "标记失败", "error");
    } finally { setBusy(false); }
  };
  return <button type="button" className="btn" disabled={busy} onClick={() => void markRead()} title="标记当前筛选条件下的全部信息，包括尚未翻页的记录"><CheckCheck aria-hidden="true" />{busy ? "正在标记…" : "一键已读"}</button>;
}

export function EntryPagination({ result }: { result: { page: number; loading: boolean; nextCursor: string | null; previousPage: () => void; loadMore: () => void } }) {
  if (result.page === 1 && !result.nextCursor) return null;
  return <nav className="entry-pagination" aria-label="信息分页">
    <button className="btn" type="button" onClick={result.previousPage} disabled={result.loading || result.page === 1}>上一页</button>
    <span>第 {result.page} 页</span>
    <button className="btn" type="button" onClick={result.loadMore} disabled={result.loading || !result.nextCursor}>下一页</button>
  </nav>;
}
