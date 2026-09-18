import { useNavigate, useParams } from "react-router-dom";
import { useAppShell } from "../components/AppShell";
import { EntryReader } from "../components/EntryReader";
import { ErrorState } from "../components/ui";

export function EntryPage() {
  const { entryId } = useParams();
  const navigate = useNavigate();
  const { agents } = useAppShell();
  if (!entryId) return <div className="wide-page"><ErrorState message="缺少信息编号" /></div>;
  return <div className="standalone-reader"><EntryReader entryId={entryId} agents={agents} onBack={() => navigate(-1)} /></div>;
}
