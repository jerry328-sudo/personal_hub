import { useDeferredValue, useMemo, useState } from "react";
import type { CompletionFilter, EntryBriefDto } from "../../shared/contracts";
import { useAppShell } from "./useAppShell";
import { useEntries } from "./useEntries";
import { useEntryNavigation } from "./useEntryNavigation";

export type InboxKind = "all" | "important" | "archive";
export type ReadFilter = "all" | "unread" | "updated";

export function useInbox(kind: InboxKind) {
  const { agents, openNavigation } = useAppShell();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [completion, setCompletion] = useState<CompletionFilter>("all");
  const [agentId, setAgentId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const navigation = useEntryNavigation();
  const query = useMemo(() => {
    const dateBound = (date: string, nextDay = false) => {
      if (!date) return undefined;
      const value = new Date(`${date}T00:00:00`);
      if (nextDay) value.setDate(value.getDate() + 1);
      return value.toISOString();
    };
    return {
      view: "brief" as const,
      agent_id: agentId || undefined,
      start: dateBound(startDate),
      end: dateBound(endDate, true),
      time_field: kind === "archive" ? "archived" as const : "updated" as const,
      read: readFilter,
      archived: kind === "archive" ? "yes" as const : "no" as const,
      important: kind === "important" ? "yes" as const : "all" as const,
      completion,
      order: "updated_desc" as const,
      query: deferredSearch || undefined,
      limit: 30,
    };
  }, [agentId, completion, deferredSearch, endDate, kind, readFilter, startDate]);
  const result = useEntries<EntryBriefDto>(query);
  const resetFilters = () => {
    setSearch(""); setReadFilter("all"); setCompletion("all");
    setAgentId(""); setStartDate(""); setEndDate("");
  };
  return {
    agents, openNavigation, search, setSearch, deferredSearch,
    readFilter, setReadFilter, completion, setCompletion, agentId, setAgentId,
    startDate, setStartDate, endDate, setEndDate, query, result, resetFilters,
    ...navigation,
  };
}
