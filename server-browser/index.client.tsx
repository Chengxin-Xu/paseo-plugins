import type { PluginClientContext, PluginCommandCapabilities, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { lazySurfaces } from './client/lazy-chunk';
import { createChunkLifetime } from './client/chunk-lifetime';
import { getClientChunk } from './shared/ui-chunk';
import { UI_CHUNK } from './shared/generated/ui-chunk-manifest';
import { createClientI18n, useI18n } from './client/i18n-client';
import { boot as bootEn } from './shared/locales/en.json';
import { boot as bootZh } from './shared/locales/zh-CN.json';
import { t } from './shared/text';

/** Keep older hosts usable while 0.11 owns the screen's Chinese title and URL. */
function openBrowser(host: Pick<PluginCommandCapabilities, 'openScreen' | 'openSurface'>) {
  if (typeof host.openScreen === 'function') host.openScreen({ screenId: 'server-browser' });
  else host.openSurface('server-browser');
}
function BrowserSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  useI18n();
  return <SidebarRow icon="MonitorSmartphone" label={t('boot.name')} active={currentScreen?.screenId === 'server-browser'} onPress={() => openScreen({ screenId: 'server-browser' })} />;
}
export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void> = [];
  const i18n = createClientI18n(client, { pluginId: 'server-browser', boot: { 'zh-CN': { boot: bootZh }, en: { boot: bootEn } } });
  const lifetime = createChunkLifetime();
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t('boot.name'), text: i18n });
  const Browser = lazy('server-browser'), Workspace = lazy('workspace-browser');
  const ServerBrowserSurface = (props: any) => <Browser {...props} chunkLifetime={lifetime} />;
  const WorkspacePanel = (props: any) => <Workspace {...props} chunkLifetime={lifetime} />;
  cleanups.push(typeof client.addScreen === 'function'
    ? client.addScreen({ id: 'server-browser', title: () => t('boot.name'), Component: ServerBrowserSurface })
    : client.addSurface('server-browser', ServerBrowserSurface));
  cleanups.push(typeof client.addSidebarHeaderItem === 'function'
    ? client.addSidebarHeaderItem({ id: 'server-browser', title: t('boot.name'), Component: BrowserSidebar })
    : client.addSidebarItem({ id: 'server-browser', title: t('boot.name'), icon: 'MonitorSmartphone', surface: 'server-browser' }));
  cleanups.push(client.addWorkspacePanel({ id: 'server-browser', title: t('boot.name'), icon: 'MonitorSmartphone', context: 'workspace', Component: WorkspacePanel }));
  cleanups.push(client.addSettingsScreen({ id: 'language', title: t('boot.settingsTitle'), icon: 'Languages', Component: lazy('language') }));
  cleanups.push(i18n.localized(() => [client.addCommandCenterItem({
    id: 'open-server-browser', title: t('boot.openBrowser'), icon: 'MonitorSmartphone', context: 'global',
    keywords: t('boot.browserKeywords').split('|'),
    onSelect(context) { openBrowser(context); },
  }), client.addCommandCenterItem({
    id: 'open-workspace-browser', title: t('boot.openWorkspaceBrowser'), icon: 'MonitorSmartphone', context: 'workspace',
    keywords: t('boot.workspaceKeywords').split('|'),
    onSelect({ openPanel }) { openPanel('server-browser'); },
  }), client.addSlashCommand({
    name: 'server-browser', description: t('boot.slashDescription'), argumentHint: '', context: 'workspace',
    onSubmit({ openPanel }) { openPanel('server-browser'); },
  })]));
  return () => { lifetime.dispose(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); i18n.dispose(); };
}
