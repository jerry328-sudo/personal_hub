import type { ComponentType } from "react";
import type { InboxKind } from "../hooks/useInbox";

export interface ThemeComponents {
  AppShell: ComponentType;
  InboxPage: ComponentType<{ kind: InboxKind }>;
  AgentPage: ComponentType;
  EntryPage: ComponentType;
  TasksPage?: ComponentType;
  AgentsPage?: ComponentType;
  SecurityPage?: ComponentType;
  LoginPage?: ComponentType;
}
