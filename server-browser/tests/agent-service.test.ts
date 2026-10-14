import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import type { BrowserManager } from '../server/browser-manager';
import { BrowserAgentService } from '../server/service';
import type { BrowserAction, BrowserSession } from '../shared/browser';

type Paseo = PluginHandlerContext['paseo'];
type Profile = { id: string; name: string; provider: string; model?: string; modeId?: string; thinkingOptionId?: string };
type Provider = { provider: string; enabled?: boolean; status: string; models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[] };

const session = (workspaceId: string): BrowserSession => ({ workspaceId, status: 'running', title: '', url: '', mode: 'agent', width: 1120, height: 720, tabs: [], agentId: null, error: null, agentBusy: false });

/** A daemon with one workspace, the given profiles and providers; it records every Agent the service creates. */
function fixture(profiles: Profile[], providers: Provider[], existing: { id: string; workspaceId: string; status: string; archivedAt?: string | null; updatedAt?: string }[] = [], saved: string | null = null) {
  const created: { config: Record<string, any>; title?: string; labels?: Record<string, string> }[] = [];
  const sent: string[] = [];
  const actions: BrowserAction[] = [];
  const linked: (string | null)[] = [];
  const workspace = { id: 'ws-1', projectRootPath: '/home/user/projects/demo-project', workspaceDirectory: '/home/user/projects/demo-project', projectDisplayName: 'demo-project', name: 'main' };
  const paseo = {
    workspaces: {
      list: async () => ({ entries: [workspace], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({ agents: { create: async (input: { config: Record<string, any>; title?: string; labels?: Record<string, string> }) => { created.push(input); return { id: `agent-${created.length}`, send: async (text: string) => { sent.push(text); } }; } } }),
    },
    agents: { list: async () => ({ entries: existing.map(agent => ({ agent })) }) },
    config: { get: async () => ({ config: { agentProfiles: profiles } }) },
    providers: { snapshot: async () => ({ entries: providers }), waitForReady: async () => ({ entries: providers }) },
  } as unknown as Paseo;
  const manager = {
    bridgePath: '/data/mcp-bridge.mjs',
    metadataPath: (id: string) => `/data/${id}/session.json`,
    start: async (id: string) => session(id),
    state: async (id: string) => session(id),
    setAgentId: async (_id: string, agentId: string | null) => { linked.push(agentId); },
    getAgentId: async () => saved,
    action: async (id: string, action: BrowserAction) => { actions.push(action); return session(id); },
  } as unknown as BrowserManager;
  return { service: new BrowserAgentService(manager), paseo, created, sent, actions, linked };
}

const ready = (provider: string, models: string[] = []): Provider => ({ provider, status: 'ready', models: models.map((id, index) => ({ id, isDefault: index === 0 })) });

test('a browser Agent uses the selected profile and gets only the shared-browser MCP bridge', async () => {
  const { service, paseo, created, sent, actions, linked } = fixture(
    [{ id: 'everyday', name: 'Everyday', provider: 'claude', model: 'claude-sonnet-4-5', modeId: 'default' }, { id: 'review', name: 'Review', provider: 'codex', model: 'gpt-5' }],
    [ready('claude', ['claude-sonnet-4-5']), ready('codex', ['gpt-5'])],
  );
  const result = await service.create(paseo, 'ws-1', 'review');
  assert.deepEqual({ agentId: result.agentId, created: result.created }, { agentId: 'agent-1', created: true });
  assert.equal(created.length, 1);
  const { config, title, labels } = created[0];
  assert.equal(config.provider, 'codex/gpt-5');
  assert.equal(title, '共享服务器浏览器');
  assert.deepEqual(labels, { 'server-browser.workspace': 'ws-1' });
  assert.deepEqual(Object.keys(config.mcpServers), ['server_browser']);
  assert.deepEqual(config.mcpServers.server_browser, { type: 'stdio', command: process.execPath, args: ['/data/mcp-bridge.mjs', '/data/ws-1/session.json'], alwaysLoad: true });
  assert.deepEqual(linked, ['agent-1']);
  assert.deepEqual(actions, [{ kind: 'mode', mode: 'agent' }]);
  assert.equal(sent.length, 1, 'one short setup message, no browsing task');
});

test('without a selection the first usable profile is used, whatever its name', async () => {
  const { service, paseo, created } = fixture(
    [{ id: 'offline', name: 'Default offline', provider: 'gemini', model: 'gemini-pro' }, { id: 'work', name: 'Work', provider: 'claude', model: 'claude-opus-4-1', thinkingOptionId: 'high' }, { id: 'daily', name: 'Daily', provider: 'codex', model: 'gpt-5' }],
    [ready('claude', ['claude-opus-4-1']), ready('codex', ['gpt-5']), { provider: 'gemini', status: 'unavailable' }],
  );
  await service.create(paseo, 'ws-1');
  assert.equal(created[0].config.provider, 'claude/claude-opus-4-1');
  assert.equal(created[0].config.thinkingOptionId, 'high');
});

test('without profiles the first ready provider and its default model are used', async () => {
  const { service, paseo, created } = fixture([], [{ provider: 'opencode', status: 'error' }, ready('claude', ['claude-sonnet-4-5', 'claude-opus-4-1'])]);
  await service.create(paseo, 'ws-1');
  assert.equal(created[0].config.provider, 'claude/claude-sonnet-4-5');
});

test('an existing browser Agent for the workspace is reused and a vanished profile is reported', async () => {
  const reuse = fixture([{ id: 'p', name: 'P', provider: 'claude', model: 'm' }], [ready('claude', ['m'])], [{ id: 'agent-old', workspaceId: 'ws-1', status: 'idle', archivedAt: null }]);
  const result = await reuse.service.create(reuse.paseo, 'ws-1', 'p');
  assert.deepEqual({ agentId: result.agentId, created: result.created }, { agentId: 'agent-old', created: false });
  assert.equal(reuse.created.length, 0);
  const missing = fixture([{ id: 'p', name: 'P', provider: 'claude', model: 'm' }], [ready('claude', ['m'])]);
  await assert.rejects(missing.service.create(missing.paseo, 'ws-1', 'gone'), /Profile 已不存在/);
});

test('an archived browser Agent is replaced; failed metadata never creates a duplicate',async()=>{
  const target=fixture([], [ready('codex',['model'])],[{id:'old',workspaceId:'ws-1',status:'idle',archivedAt:'2026-01-01T00:00:00Z'}]);
  const result=await target.service.create(target.paseo,'ws-1');
  assert.equal(result.created,true);assert.equal(target.created.length,1);assert.deepEqual(target.linked,['agent-1']);
  const failed=fixture([], [ready('codex',['model'])]);
  failed.paseo.agents.list=async()=>{throw new Error('metadata unavailable');};
  await assert.rejects(failed.service.create(failed.paseo,'ws-1'),/metadata unavailable/);
  assert.equal(failed.created.length,0);assert.deepEqual(failed.linked,[]);
});

test('an unloaded (closed) browser Agent is reused, not duplicated: after a daemon restart every session is closed',async()=>{
  const closed=fixture([], [ready('codex',['model'])],[{id:'unloaded',workspaceId:'ws-1',status:'closed',archivedAt:null}],'unloaded');
  const result=await closed.service.create(closed.paseo,'ws-1');
  assert.deepEqual({agentId:result.agentId,created:result.created},{agentId:'unloaded',created:false});
  assert.equal(closed.created.length,0);assert.deepEqual(closed.sent,[],'reusing never sends a setup message');
  // Duplicates left by older versions: the linked one wins, else the most recently updated.
  const agents=[{id:'older',workspaceId:'ws-1',status:'closed',archivedAt:null,updatedAt:'2026-10-01T00:00:00Z'},{id:'newer',workspaceId:'ws-1',status:'closed',archivedAt:null,updatedAt:'2026-10-11T00:00:00Z'},{id:'linked',workspaceId:'ws-1',status:'closed',archivedAt:null,updatedAt:'2026-09-01T00:00:00Z'}];
  const linked=fixture([], [ready('codex',['model'])],agents,'linked');
  assert.equal((await linked.service.create(linked.paseo,'ws-1')).agentId,'linked');
  const latest=fixture([], [ready('codex',['model'])],agents,'gone');
  assert.equal((await latest.service.create(latest.paseo,'ws-1')).agentId,'newer');
});
