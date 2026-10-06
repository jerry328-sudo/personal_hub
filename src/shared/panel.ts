import type { EntryBriefDto, EntryFullDto, Page, ReaderSourceDto } from "./contracts";

export interface PanelIdentity {
  role: "admin" | "agent" | "manager" | "reader";
  agent_id: string | null;
  can_write: boolean;
  can_manage_entries: boolean;
  can_manage_sources: boolean;
}

export type PanelSource = ReaderSourceDto & { role?: "agent" | "manager" | "reader" };

export interface PanelSnapshot {
  identity: PanelIdentity;
  app_origin: string;
  sources: Page<PanelSource>;
  entries: Page<EntryBriefDto>;
  entry: EntryFullDto | null;
}

export const PANEL_RESOURCE_URI = "ui://personal-hub/panel-v1.html";
export const PANEL_TOOL_NAME = "open_hub_panel";
