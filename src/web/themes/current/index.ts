import { CurrentAppShell } from "./AppShell";
import { InboxPage } from "./pages/InboxPage";
import { AgentPage } from "../../pages/AgentPage";
import { EntryPage } from "../../pages/EntryPage";
import type { ThemeComponents } from "../types";

export const theme: ThemeComponents = {
  AppShell: CurrentAppShell,
  InboxPage,
  AgentPage,
  EntryPage,
};
