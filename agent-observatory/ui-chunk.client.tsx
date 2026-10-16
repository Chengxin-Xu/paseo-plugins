import { followText } from "./shared/i18n";
import type { ChunkExtras } from "./client/lazy-chunk";
import { LanguageScreen } from "./client/language-screen";
import type { ComponentType } from "react";
import type { PluginAgentPanelProps, PluginClientContext, PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ArchivedSurface, DashboardSurface, WorkspaceDashboard } from "./client/dashboard";
import { AgentInspector } from "./client/agent-inspector";
import { ScheduleSurface } from "./client/schedule-board";
import { focusScheduleRuns, scheduleScreenParams, type ScheduleFocus } from "./client/schedule-focus";
import { AttentionPopover } from "./client/attention-popover";
import { AttentionStoresContext } from "./client/attention-context";
import { CacheClockProvider } from "./client/cache-clock";
import { setChimePlayer } from "./client/alert-settings";

// Paseo freezes exports before running the module body; this declaration must be hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }

function createSurfaces(client: PluginClientContext, extras?: ChunkExtras): Record<string, ComponentType<any>> {
  followText(extras?.text);
  // The settings' 试听 plays through the host, as the resident chime does.
  setChimePlayer(typeof client.playAudio === "function" ? source => client.playAudio(source) : null);
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
  // 提示缓存倒计时 for the views that show sessions waiting on you (2.17): read while one of them is open.
  const clocked = (Surface: ComponentType<any>): ComponentType<any> => (props: any) => <CacheClockProvider><Surface {...props} /></CacheClockProvider>;
  return { observatory: provide(clocked(Overview)), archives: provide(Archives), "schedule-runs": provide(ScheduleSurface), "workspace-observatory": provide(clocked(Workspace)), "agent-inspector": provide(clocked(Inspector)),
    "attention-popover": clocked(AttentionPopover), language: LanguageScreen };
}
