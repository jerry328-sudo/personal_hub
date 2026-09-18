import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { LoadingState, ToastProvider } from "./components/ui";
import { SessionProvider, useSession } from "./hooks/useSession";
import { AgentPage } from "./pages/AgentPage";
import { AgentsPage } from "./pages/AgentsPage";
import { EntryPage } from "./pages/EntryPage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { TasksPage } from "./pages/TasksPage";

function ProtectedApp() {
  const location = useLocation();
  const { session, loading } = useSession();
  if (loading) return <div className="boot-screen"><span className="logo">H</span><LoadingState label="正在打开 Personal Hub…" /></div>;
  if (!session) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <AppShell />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedApp />}>
        <Route index element={<InboxPage kind="all" />} />
        <Route path="important" element={<InboxPage kind="important" />} />
        <Route path="archive" element={<InboxPage kind="archive" />} />
        <Route path="agents/:agentId" element={<AgentPage />} />
        <Route path="entries/:entryId" element={<EntryPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="admin/agents" element={<AgentsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return <SessionProvider><ToastProvider><AppRoutes /></ToastProvider></SessionProvider>;
}
