import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentDto } from "../../shared/contracts";
import { agentsApi, entriesApi, subscribeDataChanged } from "../api";
import { useToast } from "../components/ui";
import type { ThemeMode } from "../lib/theme";
import { useSession } from "./useSession";
import { useTheme } from "./useTheme";

interface ShellCounts {
  unread: number;
  important_unread: number;
  archived: number;
  open_tasks: number;
}

interface ShellContextValue {
  agents: AgentDto[];
  agentsLoading: boolean;
  counts: ShellCounts;
  refreshShell: () => void;
  openNavigation: () => void;
  closeNavigation: () => void;
  navOpen: boolean;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
  signOut: () => Promise<void>;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useAppShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useAppShell 必须在 AppShellProvider 中使用");
  return value;
}

export function AppShellProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { logout } = useSession();
  const { mode, setMode } = useTheme();
  const { showToast } = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [counts, setCounts] = useState<ShellCounts>({ unread: 0, important_unread: 0, archived: 0, open_tasks: 0 });
  const [revision, setRevision] = useState(0);
  const refreshShell = useCallback(() => setRevision((value) => value + 1), []);
  const openNavigation = useCallback(() => setNavOpen(true), []);
  const closeNavigation = useCallback(() => setNavOpen(false), []);

  useEffect(() => {
    const controller = new AbortController();
    setAgentsLoading(true);
    void Promise.allSettled([
      agentsApi.listAll({ status: "all", limit: 100 }, controller.signal),
      entriesApi.counts(controller.signal),
    ]).then(([agentResult, countResult]) => {
      if (controller.signal.aborted) return;
      if (agentResult.status === "fulfilled") setAgents(agentResult.value);
      if (countResult.status === "fulfilled") setCounts(countResult.value);
      setAgentsLoading(false);
    });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => subscribeDataChanged(refreshShell), [refreshShell]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeNavigation(); };
    window.addEventListener("popstate", closeNavigation);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", closeNavigation);
      window.removeEventListener("keydown", onKey);
    };
  }, [closeNavigation]);

  const signOut = useCallback(async () => {
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "退出失败", "error");
    }
  }, [logout, navigate, showToast]);

  const value = useMemo(() => ({
    agents, agentsLoading, counts, refreshShell, openNavigation, closeNavigation,
    navOpen, setNavOpen, signOut, mode, setMode,
  }), [agents, agentsLoading, counts, refreshShell, openNavigation, closeNavigation, navOpen, signOut, mode, setMode]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
