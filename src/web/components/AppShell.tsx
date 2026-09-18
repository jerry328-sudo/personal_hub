import {
  Archive,
  Inbox,
  LogOut,
  Menu,
  Moon,
  Settings,
  SquareCheck,
  Star,
  Sun,
  X,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { AgentDto, EntryBriefDto } from "../../shared/contracts";
import { agentsApi, entriesApi, tasksApi } from "../api";
import { useSession } from "../hooks/useSession";
import { useTheme } from "../hooks/useTheme";
import type { ThemeMode } from "../lib/theme";
import { AgentBadge, useToast } from "./ui";

interface ShellContextValue {
  agents: AgentDto[];
  agentsLoading: boolean;
  refreshShell: () => void;
  openNavigation: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useAppShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useAppShell 必须在 AppShell 中使用");
  return value;
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  return mode === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />;
}

export function AppShell() {
  const navigate = useNavigate();
  const { logout } = useSession();
  const { mode, setMode } = useTheme();
  const { showToast } = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [entries, setEntries] = useState<EntryBriefDto[]>([]);
  const [entriesTruncated, setEntriesTruncated] = useState(false);
  const [openTasks, setOpenTasks] = useState(0);
  const [openTasksTruncated, setOpenTasksTruncated] = useState(false);
  const [revision, setRevision] = useState(0);

  const refreshShell = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setAgentsLoading(true);
    void Promise.allSettled([
      agentsApi.listAll({ status: "all", limit: 100 }, controller.signal),
      entriesApi.list<EntryBriefDto>({ view: "brief", archived: "all", completion: "all", limit: 100, order: "updated_desc" }, controller.signal),
      tasksApi.list({ done: "no", limit: 100 }, controller.signal),
    ]).then(([agentResult, entryResult, taskResult]) => {
      if (controller.signal.aborted) return;
      if (agentResult.status === "fulfilled") setAgents(agentResult.value);
      if (entryResult.status === "fulfilled") {
        setEntries(entryResult.value.items);
        setEntriesTruncated(entryResult.value.next_cursor !== null);
      }
      if (taskResult.status === "fulfilled") {
        setOpenTasks(taskResult.value.items.length);
        setOpenTasksTruncated(taskResult.value.next_cursor !== null);
      }
      setAgentsLoading(false);
    });
    const onDataChanged = () => refreshShell();
    window.addEventListener("personal-hub:data-changed", onDataChanged);
    return () => {
      controller.abort();
      window.removeEventListener("personal-hub:data-changed", onDataChanged);
    };
  }, [refreshShell, revision]);

  useEffect(() => {
    const close = () => setNavOpen(false);
    window.addEventListener("popstate", close);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const counts = useMemo(() => ({
    all: entries.filter((entry) => !entry.archived).length,
    important: entries.filter((entry) => entry.important && !entry.archived).length,
    archive: entries.filter((entry) => entry.archived).length,
  }), [entries]);
  const visibleAgents = agents.filter((agent) => agent.id !== "manual" && agent.scope === "own" && agent.status !== "removed" && agent.status !== "deleting");
  const context = useMemo(() => ({ agents, agentsLoading, refreshShell, openNavigation: () => setNavOpen(true) }), [agents, agentsLoading, refreshShell]);
  const countLabel = (value: number, truncated: boolean) => truncated ? (value > 0 ? `${value}+` : "…") : String(value);

  const signOut = async () => {
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "退出失败", "error");
    }
  };

  const navClass = ({ isActive }: { isActive: boolean }) => `nav-item ${isActive ? "active" : ""}`;
  return (
    <ShellContext.Provider value={context}>
      <div className={`app-shell ${navOpen ? "nav-open" : ""}`}>
        <aside className="sidebar" aria-label="主导航">
          <div className="brand">
            <div className="logo" aria-hidden="true">H</div>
            <div><strong>Personal Hub</strong><span>个人信息中心</span></div>
            <button className="icon-btn close-nav" type="button" onClick={() => setNavOpen(false)} aria-label="关闭导航"><X aria-hidden="true" /></button>
          </div>
          <nav className="nav" onClick={() => setNavOpen(false)}>
            <NavLink to="/" end className={navClass}><Inbox aria-hidden="true" /><span>全部信息</span><span className="count">{countLabel(counts.all, entriesTruncated)}</span></NavLink>
            <NavLink to="/important" className={navClass}><Star aria-hidden="true" /><span>重要信息</span><span className="count">{countLabel(counts.important, entriesTruncated)}</span></NavLink>
            <NavLink to="/tasks" className={navClass}><SquareCheck aria-hidden="true" /><span>待办</span><span className="count">{countLabel(openTasks, openTasksTruncated)}</span></NavLink>
            <NavLink to="/archive" className={navClass}><Archive aria-hidden="true" /><span>归档</span><span className="count">{countLabel(counts.archive, entriesTruncated)}</span></NavLink>
          </nav>
          <div className="agent-section">
            <div className="section-caption"><span>我的 AGENT</span></div>
            <nav className="nav" aria-label="Agent">
              {visibleAgents.map((agent, index) => (
                <NavLink key={agent.id} to={`/agents/${encodeURIComponent(agent.id)}`} className={navClass} onClick={() => setNavOpen(false)}>
                  <AgentBadge name={agent.name} index={index} />
                  <span className="agent-name">{agent.name}</span>
                  {agent.status === "disabled" ? <i className="agent-offline" title="已停用" /> : null}
                </NavLink>
              ))}
              {!agentsLoading && !visibleAgents.length ? <span className="sidebar-empty">还没有 Agent</span> : null}
            </nav>
          </div>
          <div className="sidebar-footer">
            <NavLink to="/admin/agents" className={navClass} onClick={() => setNavOpen(false)}><Settings aria-hidden="true" /><span>Agent 管理</span></NavLink>
            <label className="theme-control"><span><ThemeIcon mode={mode} />外观</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as ThemeMode)} aria-label="外观模式">
                <option value="dark">夜间模式</option>
                <option value="light">日间模式</option>
                <option value="system">随系统</option>
              </select>
            </label>
            <button className="nav-item logout-button" type="button" onClick={() => void signOut()}><LogOut aria-hidden="true" /><span>退出登录</span></button>
          </div>
        </aside>
        <button className="scrim" type="button" onClick={() => setNavOpen(false)} aria-label="关闭导航" />
        <main className="workspace"><Outlet /></main>
        <button className="floating-menu" type="button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu aria-hidden="true" /></button>
      </div>
    </ShellContext.Provider>
  );
}
