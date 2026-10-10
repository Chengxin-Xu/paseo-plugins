import React from "react";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerBrowserSurface, ServerBrowserWorkspacePanel } from "../client/browser";
import { Icon, ToastHost } from "./adapter.jsx";
import { paseoDark, paseoLight } from "./themes.js";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? paseoLight : paseoDark;
globalThis.__previewTheme = theme;
const compact = innerWidth < 700;
const panel = params.get("panel");
document.documentElement.style.colorScheme = theme === paseoLight ? "light" : "dark";
document.body.style.background = theme.colors.surface0;
globalThis.__navigation = [];
const navigation = { openAgent: input => globalThis.__navigation.push({ kind: "agent", ...input }), openWorkspace: input => globalThis.__navigation.push({ kind: "workspace", ...input }), ...(compact || params.get("electron") === "0" ? {} : { openBrowser: input => globalThis.__navigation.push({ kind: "browser", ...input }) }) };
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const props = { theme, host: { id: "fixture-host", label: "测试主机" }, layout: { compact, platform: "web" }, navigation };

/** Host chrome stand-in: the surface title bar the real app draws above every plugin surface. */
function HostTitle() {
  if (params.get("host") === "0") return null;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: compact ? 44 : 36, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
    {compact ? <Icon name="ChevronLeft" size={18} color={theme.colors.foregroundMuted} /> : <Icon name="MonitorSmartphone" size={16} color={theme.colors.foregroundMuted} />}
    <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14 }}>服务器浏览器</Text>
    {compact ? null : <Icon name="X" size={16} color={theme.colors.foregroundMuted} />}
  </View>;
}

createRoot(document.getElementById("root")).render(<QueryClientProvider client={queryClient}>
  <HostTitle />
  <View testID="preview-surface" style={{ flex: 1, minHeight: 0 }}>
    {panel ? <ServerBrowserWorkspacePanel {...props} context="workspace" workspaceId={panel} /> : <ServerBrowserSurface {...props} />}
  </View>
  <ToastHost />
</QueryClientProvider>);
