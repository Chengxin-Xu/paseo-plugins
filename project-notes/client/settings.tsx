import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { LanguageSettings } from "./language-settings";
import { t } from "../shared/text";

export function NotesLanguageSettings({ theme }: PluginSurfaceProps) {
  return <View style={{ gap: 20 }}>
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>{t("boot.screenTitle")}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{t("settings.description")}</Text>
    </View>
    <LanguageSettings />
  </View>;
}
