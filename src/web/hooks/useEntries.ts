import { useCallback, useEffect, useMemo, useState } from "react";
import type { EntryBriefDto, EntryFullDto } from "../../shared/contracts";
import { entriesApi, subscribeDataChanged, type EntryListQuery } from "../api";

export function useEntries<T extends EntryBriefDto | EntryFullDto = EntryBriefDto>(query: EntryListQuery) {
  const queryKey = JSON.stringify(query);
  const stableQuery = useMemo(() => JSON.parse(queryKey) as EntryListQuery, [queryKey]);
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState<{ key: string; cursors: Array<string | undefined> }>({ key: queryKey, cursors: [undefined] });
  if (paging.key !== queryKey) setPaging({ key: queryKey, cursors: [undefined] });
  const cursors = paging.key === queryKey ? paging.cursors : [undefined];
  const cursor = cursors.at(-1);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => subscribeDataChanged(refresh), [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    entriesApi.list<T>({ ...stableQuery, cursor }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "信息读取失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [stableQuery, cursor, revision]);

  const loadMore = () => {
    if (nextCursor && !loading) setPaging({ key: queryKey, cursors: [...cursors, nextCursor] });
  };
  const previousPage = () => {
    if (cursors.length > 1 && !loading) setPaging({ key: queryKey, cursors: cursors.slice(0, -1) });
  };
  return { items, loading, loadingMore: loading, error, nextCursor, refresh, loadMore, previousPage, page: cursors.length };
}
