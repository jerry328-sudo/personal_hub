import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { LoadingState, ToastProvider } from "./components/ui";
import { AppShellProvider } from "./hooks/useAppShell";
import { SessionProvider, useSession } from "./hooks/useSession";
import { AgentsPage } from "./pages/AgentsPage";
import { LoginPage } from "./pages/LoginPage";
import { TasksPage } from "./pages/TasksPage";
import { SecurityPage } from "./pages/SecurityPage";
import { siteThemes } from "./themes/registry";
import { SiteThemeProvider, useSiteTheme } from "./themes/SiteThemeProvider";

function ProtectedApp() {
  const location = useLocation();
  const { session, loading } = useSession();
  const { themeId } = useSiteTheme();
  const Shell = siteThemes[themeId].components.AppShell;
  if (loading) return <div className="boot-screen"><span className="logo">H</span><LoadingState label="正在打开 Personal Hub…" /></div>;
  if (!session) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <AppShellProvider><Shell /></AppShellProvider>;
}

function AppRoutes() {
  const { themeId } = useSiteTheme();
  const components = siteThemes[themeId].components;
  const ThemedInbox = components.InboxPage;
  const ThemedAgent = components.AgentPage;
  const ThemedEntry = components.EntryPage;
  const ThemedTasks = components.TasksPage ?? TasksPage;
  const ThemedAgents = components.AgentsPage ?? AgentsPage;
  const ThemedSecurity = components.SecurityPage ?? SecurityPage;
  const ThemedLogin = components.LoginPage ?? LoginPage;
  return (
    <Routes>
      <Route path="/login" element={<ThemedLogin />} />
      <Route element={<ProtectedApp />}>
        <Route index element={<ThemedInbox key="all" kind="all" />} />
        <Route path="important" element={<ThemedInbox key="important" kind="important" />} />
        <Route path="archive" element={<ThemedInbox key="archive" kind="archive" />} />
        <Route path="agents/:agentId" element={<ThemedAgent />} />
        <Route path="entries/:entryId" element={<ThemedEntry />} />
        <Route path="tasks" element={<ThemedTasks />} />
        <Route path="admin/agents" element={<ThemedAgents />} />
        <Route path="admin/security" element={<ThemedSecurity />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return <ToastProvider><SiteThemeProvider><SessionProvider><AppRoutes /></SessionProvider></SiteThemeProvider></ToastProvider>;
}
