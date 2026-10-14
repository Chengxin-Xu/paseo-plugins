import type { ComponentType } from "react";
import type { PluginAgentPanelProps, PluginClientContext, PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ArchivedSurface, DashboardSurface, WorkspaceDashboard } from "./client/dashboard";
import { AgentInspector } from "./client/agent-inspector";
import { ScheduleSurface } from "./client/schedule-board";
import { focusScheduleRuns, scheduleScreenParams, type ScheduleFocus } from "./client/schedule-focus";
import { AttentionPopover } from "./client/attention-popover";
import { AttentionStoresContext } from "./client/attention-context";

// Paseo freezes exports before running the module body; this declaration must be hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }

function createSurfaces(client: PluginClientContext): Record<string, ComponentType<any>> {
  const screens = typeof client.addScreen === "function";
  const open = (screenId: string, params?: Record<string, string>) => { if (screens) client.openScreen(params ? { screenId, params } : { screenId }); else client.openSurface(screenId); };
  // The schedule writer and reader remain in the same chunk, including the older-host fallback.
  const openSchedules = (focus: ScheduleFocus) => { if (screens) open("schedule-runs", scheduleScreenParams(focus)); else { focusScheduleRuns(focus); client.openSurface("schedule-runs"); } };
  const Overview = (props: PluginScreenProps) => <DashboardSurface {...props} onOpenArchive={() => open("archives")} onOpenSchedules={openSchedules} />;
  const Archives = (props: PluginScreenProps) => <ArchivedSurface {...props} onOpenOverview={() => open("observatory")} onOpenSchedules={openSchedules} />;
  const Workspace = (props: PluginWorkspacePanelProps) => <WorkspaceDashboard {...props} onOpenSchedules={openSchedules} />;
  const Inspector = (props: PluginAgentPanelProps) => <AgentInspector {...props} onOpenSchedules={openSchedules} onOpenOverview={agentId => open("observatory", screens ? { agent: agentId, t: Date.now().toString(36) } : undefined)} />;
  // Each surface provides the stub's 需要处理 stores (its `attentionStores` prop) to its subtree: a detail's 知道了 re-reads the badge.
  const provide = (Surface: ComponentType<any>): ComponentType<any> => (props: any) => <AttentionStoresContext.Provider value={props.attentionStores ?? null}><Surface {...props} /></AttentionStoresContext.Provider>;
  return { observatory: provide(Overview), archives: provide(Archives), "schedule-runs": provide(ScheduleSurface), "workspace-observatory": provide(Workspace), "agent-inspector": provide(Inspector), "attention-popover": AttentionPopover };
}
