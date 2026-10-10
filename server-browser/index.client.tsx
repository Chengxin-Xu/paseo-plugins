import type { PluginClientContext, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { ServerBrowserSurface, ServerBrowserWorkspacePanel } from './client/browser';

export default function contribute(client: PluginClientContext) {
  const WorkspacePanel = (props: PluginWorkspacePanelProps) => <ServerBrowserWorkspacePanel {...props} onOpenOverview={() => client.openSurface('server-browser')} />;
  client.addSurface('server-browser', ServerBrowserSurface);
  client.addSidebarItem({ id: 'server-browser', title: '服务器浏览器', icon: 'MonitorSmartphone', surface: 'server-browser' });
  client.addWorkspacePanel({ id: 'server-browser', title: '服务器浏览器', icon: 'MonitorSmartphone', context: 'workspace', Component: WorkspacePanel });
  client.addCommandCenterItem({
    id: 'open-server-browser', title: '打开服务器浏览器', icon: 'MonitorSmartphone', context: 'global',
    keywords: ['browser', '浏览器', '远程', '手机', '服务器'],
    onSelect({ openSurface }) { openSurface('server-browser'); },
  });
  client.addCommandCenterItem({
    id: 'open-workspace-browser', title: '打开当前工作区的服务器浏览器', icon: 'MonitorSmartphone', context: 'workspace',
    keywords: ['browser', '浏览器', '远程', '服务器'],
    onSelect({ openPanel }) { openPanel('server-browser'); },
  });
  client.addSlashCommand({
    name: 'server-browser', description: '查看和接管当前工作区的服务器浏览器', argumentHint: '', context: 'workspace',
    onSubmit({ openPanel }) { openPanel('server-browser'); },
  });
  return () => {};
}
