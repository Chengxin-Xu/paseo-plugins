import { bindTranslator, createTranslator } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import { t } from "../shared/text";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { NotesSurface, NotesWorkspacePanel } from "../client/board";
import { Icon, Toasts } from "./adapter.jsx";
import { previewDirectory, previewQuick } from "./live.js";
import { paseoDark, paseoLight } from "./themes.js";

// ?theme=light|dark  ?scenario=…  ?panel=1 (workspace panel)  ?chrome=0 (hide the host title bar)  ?compact=1|0
// ?nav=0 (a client without navigation: a started launch stays in the dialog instead of opening the agent)
const params = new URLSearchParams(location.search);
const language = params.get("language") === "en" ? "en" : "zh-CN";
bindTranslator(createTranslator(language, language === "en" ? [en, kitEn] : [zh, kitZh]));
const light = params.get("theme") === "light";
const theme = light ? paseoLight : paseoDark;
globalThis.__previewTheme = theme;
globalThis.__notesNavigation = [];
document.documentElement.style.colorScheme = light ? "light" : "dark";
document.body.style.background = theme.colors.surface0;
const compact = params.has("compact") ? params.get("compact") === "1" : innerWidth < 720;
const panel = params.get("panel") === "1";
const navigation = params.get("nav") === "0" ? undefined : {
  openAgent: input => globalThis.__notesNavigation.push({ type: "agent", ...input }),
  openWorkspace: input => globalThis.__notesNavigation.push({ type: "workspace", ...input }),
};
// ?live=0 drops the resident's live copies (agent directory, one-tap list), like an older plugin stub.
const services = params.get("live") === "0" ? undefined : { directory: previewDirectory, quick: previewQuick };
const props = { theme, host: { id: "fixture-host", label: "dev-server-01" }, layout: { compact, platform: "web" }, navigation, services, params: params.get("view") ? { view: params.get("view") } : {} };
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** The host's own title bar around a plugin surface (not part of the plugin). */
function HostChrome() {
  const { colors } = theme;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface0 }}>
    <Icon name="NotebookPen" size={14} color={colors.foregroundMuted} />
    <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 14 }}>{panel ? t("boot.name") : t("boot.screenTitle")}</Text>
    <Icon name="X" size={16} color={colors.foregroundMuted} />
  </View>;
}

createRoot(document.getElementById("root")).render(<QueryClientProvider client={queryClient}>
  <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
    {params.get("chrome") !== "0" ? <HostChrome /> : null}
    <View style={{ flex: 1, minHeight: 0 }}>{panel ? <NotesWorkspacePanel {...props} context="workspace" workspaceId="wks_fixture" /> : <NotesSurface {...props} />}</View>
  </View>
  <Toasts theme={theme} />
</QueryClientProvider>);
