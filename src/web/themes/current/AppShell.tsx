import { Archive, KeyRound, Inbox, LogOut, Menu, Moon, Settings, SquareCheck, Star, Sun, X } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAppShell } from "../../hooks/useAppShell";
import type { ThemeMode } from "../../lib/theme";
import { AgentBadge } from "../../components/ui";

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  return mode === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />;
}

export function CurrentAppShell() {
  const { agents, agentsLoading, counts, navOpen, setNavOpen, signOut, mode, setMode } = useAppShell();
  const visibleAgents = agents.filter((agent) => agent.id !== "manual" && agent.role === "agent" && agent.status !== "removed" && agent.status !== "deleting");
  const navClass = ({ isActive }: { isActive: boolean }) => `nav-item ${isActive ? "active" : ""}`;
  return (

      <div className={`app-shell ${navOpen ? "nav-open" : ""}`}>
        <aside className="sidebar" aria-label="主导航">
          <div className="brand">
            <div className="logo" aria-hidden="true">H</div>
            <div><strong>Personal Hub</strong><span>个人信息中心</span></div>
            <button className="icon-btn close-nav" type="button" onClick={() => setNavOpen(false)} aria-label="关闭导航"><X aria-hidden="true" /></button>
          </div>
          <nav className="nav" onClick={() => setNavOpen(false)}>
            <NavLink to="/" end className={navClass}><Inbox aria-hidden="true" /><span>全部信息</span><span className="count" title="未读信息">{counts.unread}</span></NavLink>
            <NavLink to="/important" className={navClass}><Star aria-hidden="true" /><span>重要信息</span><span className="count" title="未读重要信息">{counts.important_unread}</span></NavLink>
            <NavLink to="/tasks" className={navClass}><SquareCheck aria-hidden="true" /><span>待办</span><span className="count">{counts.open_tasks}</span></NavLink>
            <NavLink to="/archive" className={navClass}><Archive aria-hidden="true" /><span>归档</span><span className="count">{counts.archived}</span></NavLink>
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
            <NavLink to="/admin/security" className={navClass} onClick={() => setNavOpen(false)}><KeyRound aria-hidden="true" /><span>登录与安全</span></NavLink>
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

  );
}
