import { useCallback, useEffect, useMemo, useState } from "react";
import type { EntryBriefDto, EntryFullDto } from "../../shared/contracts";
import { entriesApi, type EntryListQuery } from "../api";

export interface EntriesState<T extends EntryBriefDto | EntryFullDto> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  refresh: () => void;
  loadMore: () => void;
}

export function useEntries<T extends EntryBriefDto | EntryFullDto = EntryBriefDto>(query: EntryListQuery): EntriesState<T> {
  const queryKey = JSON.stringify(query);
  const stableQuery = useMemo(() => JSON.parse(queryKey) as EntryListQuery, [queryKey]);
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    entriesApi.list<T>(stableQuery, controller.signal)
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "信息读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [stableQuery, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    entriesApi.list<T>({ ...stableQuery, cursor: nextCursor })
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setNextCursor(page.next_cursor);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "下一页读取失败"))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, nextCursor, stableQuery]);

  return { items, loading, loadingMore, error, nextCursor, refresh, loadMore };
}
