import { Archive, Inbox, KeyRound, LogOut, Menu, Moon, Settings, SquareCheck, Star, Sun, X } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { AgentBadge } from "../../components/ui";
import { useAppShell } from "../../hooks/useAppShell";
import type { ThemeMode } from "../../lib/theme";

export function AppShell() {
  const { agents, agentsLoading, counts, navOpen, closeNavigation, openNavigation, mode, setMode, signOut } = useAppShell();
  const sources = agents.filter((agent) => agent.id !== "manual" && agent.role === "agent" && agent.status !== "removed" && agent.status !== "deleting");
  const navClass = ({ isActive }: { isActive: boolean }) => `tpl-nav-link${isActive ? " active" : ""}`;
  return <div className={`tpl-shell${navOpen ? " nav-open" : ""}`}>
    <a className="tpl-skip" href="#main-content">跳到主要内容</a>
    <header className="tpl-mobile-bar">
      <button type="button" className="icon-btn" aria-label="打开导航" aria-expanded={navOpen} aria-controls="template-navigation" onClick={openNavigation}><Menu /></button>
      <strong>Personal Hub</strong>
    </header>
    <aside id="template-navigation" className="tpl-sidebar" aria-label="主导航">
      <div className="tpl-brand"><span className="tpl-brand-mark"><Inbox aria-hidden="true" /></span><div><strong>Personal Hub</strong><span>个人信息中心</span></div><button type="button" className="icon-btn tpl-close-nav" aria-label="关闭导航" onClick={closeNavigation}><X /></button></div>
      <nav className="tpl-nav" aria-label="信息" onClick={closeNavigation}>
        <NavLink to="/" end className={navClass}><Inbox /><span>收件箱</span><b className="tpl-count" title="当前版本未读，含有更新的信息">{counts.unread}</b></NavLink>
        <NavLink to="/important" className={navClass}><Star /><span>重要信息</span><b className="tpl-count muted" title="重要信息未读数">{counts.important_unread}</b></NavLink>
        <NavLink to="/tasks" className={navClass}><SquareCheck /><span>待办</span><b className="tpl-count muted" title="未完成待办">{counts.open_tasks}</b></NavLink>
        <NavLink to="/archive" className={navClass}><Archive /><span>归档</span><b className="tpl-count muted">{counts.archived}</b></NavLink>
      </nav>
      <div className="tpl-sources"><div className="tpl-section-label"><span>信息来源</span><NavLink to="/admin/agents" onClick={closeNavigation}>管理</NavLink></div>
        <nav className="tpl-nav" aria-label="信息来源" onClick={closeNavigation}>
          {sources.map((agent, index) => <NavLink key={agent.id} to={`/agents/${encodeURIComponent(agent.id)}`} className={navClass} title={agent.name}>
            <AgentBadge name={agent.name} index={index} /><span>{agent.name}</span>{agent.status === "disabled" ? <small className="tpl-disabled">已停用</small> : null}
          </NavLink>)}
          {!agentsLoading && !sources.length ? <p className="tpl-nav-empty">还没有信息来源</p> : null}
        </nav>
      </div>
      <footer className="tpl-side-footer">
        <nav className="tpl-nav" aria-label="设置" onClick={closeNavigation}>
          <NavLink to="/admin/agents" className={navClass}><Settings /><span>Agent 管理</span></NavLink>
          <NavLink to="/admin/security" className={navClass}><KeyRound /><span>登录与安全</span></NavLink>
        </nav>
        <label className="tpl-appearance"><span>{mode === "dark" ? <Moon /> : <Sun />}外观</span><select aria-label="外观模式" value={mode} onChange={(event) => setMode(event.target.value as ThemeMode)}><option value="light">日间模式</option><option value="dark">夜间模式</option><option value="system">随系统</option></select></label>
        <button className="tpl-nav-link tpl-logout" type="button" onClick={() => void signOut()}><LogOut /><span>退出登录</span></button>
      </footer>
    </aside>
    <button className="tpl-backdrop" type="button" aria-label="关闭导航" onClick={closeNavigation} />
    <main id="main-content" className="tpl-workspace" tabIndex={-1}><Outlet /></main>
  </div>;
}
