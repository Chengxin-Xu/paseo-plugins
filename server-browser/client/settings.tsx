import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ScrollView, Text, View } from 'react-native';
import { LanguageSettings } from './language-settings';
import { t } from '../shared/text';

export function BrowserLanguageSettings({ theme, layout }: PluginSurfaceProps) {
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}>
    <View style={{ gap: 12, maxWidth: 760, width: '100%', alignSelf: 'center' }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: '600' }}>{t('boot.name')}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{t('settings.description')}</Text>
      <LanguageSettings />
    </View>
  </ScrollView>;
}
