import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskTagDto } from "../../shared/contracts";
import { subscribeDataChanged, taskTagsApi } from "../api";

export function useTaskTags(enabled = true) {
  const [tags, setTags] = useState<TaskTagDto[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current; setLoading(true); setError("");
    try { const result = await taskTagsApi.listAll(); if (current === generation.current) setTags(result); }
    catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : "标签读取失败"); }
    finally { if (current === generation.current) setLoading(false); }
  }, []);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh(); const unsubscribe = subscribeDataChanged(() => { void refresh(); });
    return () => { invalidate(); unsubscribe(); };
  }, [enabled, refresh, invalidate]);
  return { tags, error, loading, refresh };
}
