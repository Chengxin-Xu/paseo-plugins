import type { PluginClientContext, PluginCommandCapabilities, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { lazySurfaces } from './client/lazy-chunk';
import { createChunkLifetime } from './client/chunk-lifetime';
import { getClientChunk } from './shared/ui-chunk';
import { UI_CHUNK } from './shared/generated/ui-chunk-manifest';

/** Keep older hosts usable while 0.11 owns the screen's Chinese title and URL. */
function openBrowser(host: Pick<PluginCommandCapabilities, 'openScreen' | 'openSurface'>) {
  if (typeof host.openScreen === 'function') host.openScreen({ screenId: 'server-browser' });
  else host.openSurface('server-browser');
}
function BrowserSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="MonitorSmartphone" active={currentScreen?.screenId === 'server-browser'} onPress={() => openScreen({ screenId: 'server-browser' })} />;
}
export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void> = [];
  const lifetime = createChunkLifetime();
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: '服务器浏览器' });
  const Browser = lazy('server-browser'), Workspace = lazy('workspace-browser');
  const ServerBrowserSurface = (props: any) => <Browser {...props} chunkLifetime={lifetime} />;
  const WorkspacePanel = (props: any) => <Workspace {...props} chunkLifetime={lifetime} />;
  cleanups.push(typeof client.addScreen === 'function'
    ? client.addScreen({ id: 'server-browser', title: '服务器浏览器', Component: ServerBrowserSurface })
    : client.addSurface('server-browser', ServerBrowserSurface));
  cleanups.push(typeof client.addSidebarHeaderItem === 'function'
    ? client.addSidebarHeaderItem({ id: 'server-browser', title: '服务器浏览器', Component: BrowserSidebar })
    : client.addSidebarItem({ id: 'server-browser', title: '服务器浏览器', icon: 'MonitorSmartphone', surface: 'server-browser' }));
  cleanups.push(client.addWorkspacePanel({ id: 'server-browser', title: '服务器浏览器', icon: 'MonitorSmartphone', context: 'workspace', Component: WorkspacePanel }));
  cleanups.push(client.addCommandCenterItem({
    id: 'open-server-browser', title: '打开服务器浏览器', icon: 'MonitorSmartphone', context: 'global',
    keywords: ['browser', '浏览器', '远程', '手机', '服务器'],
    onSelect(context) { openBrowser(context); },
  }));
  cleanups.push(client.addCommandCenterItem({
    id: 'open-workspace-browser', title: '打开当前工作区的服务器浏览器', icon: 'MonitorSmartphone', context: 'workspace',
    keywords: ['browser', '浏览器', '远程', '服务器'],
    onSelect({ openPanel }) { openPanel('server-browser'); },
  }));
  cleanups.push(client.addSlashCommand({
    name: 'server-browser', description: '查看和接管当前工作区的服务器浏览器', argumentHint: '', context: 'workspace',
    onSubmit({ openPanel }) { openPanel('server-browser'); },
  }));
  return () => { lifetime.dispose(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
}
