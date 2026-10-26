import { AgentPage as SharedAgentPage } from "../../pages/AgentPage";
import { EntryPage as SharedEntryPage } from "../../pages/EntryPage";
import type { ThemeComponents } from "../types";
import { AppShell } from "./AppShell";
import { InboxPage } from "./InboxPage";

function AgentPage() {
  return <div className="tpl-source-page"><SharedAgentPage /></div>;
}

function EntryPage() {
  return <div className="tpl-entry-page"><SharedEntryPage /></div>;
}

export const theme: ThemeComponents = { AppShell, InboxPage, AgentPage, EntryPage };
