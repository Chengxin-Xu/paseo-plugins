import assert from 'node:assert/strict';
import { createServer, get as httpGet, type Server } from 'node:http';
import type { AddressInfo, ListenOptions } from 'node:net';
import { test } from 'node:test';
import { AgentPortService, MAX_PORT_ROWS, listenTarget, workspaceForDirectory } from '../server/agent-ports';
import type { OwnedSocket, PortScan } from '../server/proc-ports';
import type { PaseoWorkspace } from '../server/service';
import { agentName, freshPorts, mergePorts, openLabel, portKey, portLook, portsRequest, processName, scopeLabel, scopeTone, workspaceName } from '../client/agent-ports-model';
import type { BrowserAgentPort } from '../shared/browser';

const workspace = (id: string, directory: string, title: string, project: string) =>
  ({ id, projectRootPath: directory, workspaceDirectory: directory, projectDisplayName: project, name: title, title }) as unknown as PaseoWorkspace;
const WORKSPACES = [workspace('ws-one', '/work/one', 'feature-one', 'demo-project'), workspace('ws-two', '/work/two', 'main', 'api-project')];
let inodes = 1000;
const socket = (port: number, agentId: string, address = '127.0.0.1', family: 'tcp' | 'tcp6' = 'tcp', owner: Partial<OwnedSocket['owner']> = {}): OwnedSocket =>
  ({ family, address, port, inode: String(++inodes), owner: { pid: port, startTicks: 1, fd: '3', name: 'node', agentId, agentCwd: null, ...owner } });
const scanOf = (sockets: OwnedSocket[], extra: Partial<PortScan> = {}): PortScan => ({ supported: true, sockets, partial: false, scannedAt: 1000, ...extra });

type FakeAgent = { id: string; title: string | null; status: string; workspaceId: string | null; archivedAt: string | null };
function daemon(agents: Record<string, FakeAgent | null | Error>) {
  const refreshed: string[] = [];
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => {
    refreshed.push(id);
    const value = agents[id];
    if (value instanceof Error) throw value;
    return value ? { agent: value, project: null } : null;
  } }) } };
  return { paseo: paseo as never, refreshed };
}
const agent = (id: string, status: string, workspaceId: string | null, title: string | null = `Agent ${id}`, archivedAt: string | null = null): FakeAgent => ({ id, title, status, workspaceId, archivedAt });
function service(scans: () => PortScan | Promise<PortScan>, clock = { now: 1000 }) {
  let calls = 0;
  const ports = new AgentPortService(async () => WORKSPACES, { scanner: { scan: async () => { calls++; return scans(); } }, now: () => clock.now });
  return { ports, clock, scans: () => calls };
}
const brief = (rows: BrowserAgentPort[] | undefined) => (rows ?? []).map((row) => `${row.port} ${row.agentStatus} ${row.workspaceId ?? '-'} ${row.scope}`);

test('ports are listed only for Agents this daemon knows, split into this workspace and the others', async () => {
  const { paseo } = daemon({
    'agent-a': agent('agent-a', 'running', 'ws-one', 'Dev server'),
    'agent-b': agent('agent-b', 'idle', 'ws-two', 'API', '2026-10-15T00:00:00.000Z'),
    'agent-c': null,
    'agent-d': new Error('daemon busy'),
    'agent-e': agent('agent-e-other', 'running', 'ws-one'),
    'agent-f': agent('agent-f', 'closed', null, null),
    'agent-g': agent('agent-g', 'paused-in-a-future-version', 'ws-one'),
  });
  const { ports } = service(() => scanOf([
    socket(3000, 'agent-a'), socket(8000, 'agent-b', '0.0.0.0'), socket(7000, 'agent-c'), socket(7001, 'agent-d'), socket(7002, 'agent-e'),
    socket(6006, 'agent-f', '::', 'tcp6', { agentCwd: '/work/two/' }), socket(5173, 'agent-g'),
  ]));
  const result = await ports.list(paseo, 'ws-one');
  assert.equal(result.supported, true);
  assert.deepEqual(brief(result.items), ['3000 running ws-one local', '5173 idle ws-one local'], 'an unknown status is shown as idle, not as stopped');
  assert.deepEqual(brief(result.others), ['6006 closed ws-two all', '8000 archived ws-two all'], 'archived wins over the state; a missing workspace comes from PASEO_AGENT_CWD');
  assert.equal(result.uncertain, true, 'an Agent that could not be looked up is retried later, not guessed');
  const dev = result.items![0];
  assert.deepEqual(dev, { port: 3000, scope: 'local', process: 'node', agentId: 'agent-a', agentTitle: 'Dev server', agentStatus: 'running', workspaceId: 'ws-one', workspaceTitle: 'feature-one', projectTitle: 'demo-project', openable: true });
  assert.equal(result.others![0].agentTitle, null);
  assert.equal(result.others![0].workspaceTitle, 'main');
  assert(!JSON.stringify(result).includes('agent-c') && !JSON.stringify(result).includes('agent-e'), 'other daemons\' Agents and inexact id matches stay out');
  assert.equal(await ports.target(paseo, 'ws-one', 8000), 'http://127.0.0.1:8000/', 'other workspaces\' ports open too');
  assert.equal(await ports.target(paseo, 'ws-one', 6006), 'http://[::1]:6006/', 'an Agent listening on IPv6 only is opened over IPv6');
  await assert.rejects(ports.target(paseo, 'ws-one', 7000), /端口 7000 不在 Agent 开的端口列表里/);
  await assert.rejects(ports.target(paseo, 'ws-one', 9999), /端口 9999 不在 Agent 开的端口列表里/);
});

test('one row per port: where it listens decides the label and the address the shared browser opens', async () => {
  assert.deepEqual(listenTarget([{ address: '127.0.0.1' }, { address: '::1' }]), { scope: 'local', address: '127.0.0.1', host: '127.0.0.1' });
  assert.deepEqual(listenTarget([{ address: '::1' }]), { scope: 'local', address: '::1', host: '[::1]' });
  assert.deepEqual(listenTarget([{ address: '127.0.0.2' }]), { scope: 'local', address: '127.0.0.2', host: '127.0.0.2' });
  assert.deepEqual(listenTarget([{ address: '::' }, { address: '127.0.0.1' }]), { scope: 'all', address: '127.0.0.1', host: '127.0.0.1' });
  assert.deepEqual(listenTarget([{ address: '0.0.0.0' }]), { scope: 'all', address: '0.0.0.0', host: '127.0.0.1' });
  // IPv6 only (`::` with IPV6_V6ONLY or bindv6only=1, or `::1`): never rewritten to 127.0.0.1.
  assert.deepEqual(listenTarget([{ address: '::' }]), { scope: 'all', address: '::', host: '[::1]' });
  assert.deepEqual(listenTarget([{ address: '::' }, { address: '::1' }]), { scope: 'all', address: '::', host: '[::1]' });
  assert.deepEqual(listenTarget([{ address: '127.0.0.2' }, { address: '::1' }]), { scope: 'local', address: '::1', host: '[::1]' });
  assert.deepEqual(listenTarget([{ address: '192.0.2.10' }, { address: '127.0.0.1' }]), { scope: 'address', address: '192.0.2.10', host: '127.0.0.1' }, 'reachable beyond this machine, opened through loopback');
  assert.deepEqual(listenTarget([{ address: '2001:db8::1' }]), { scope: 'address', address: '2001:db8::1', host: '[2001:db8::1]' });

  const { paseo } = daemon({ 'agent-a': agent('agent-a', 'idle', 'ws-one') });
  const { ports } = service(() => scanOf([
    socket(3000, 'agent-a', '127.0.0.1'), socket(3000, 'agent-a', '::1', 'tcp6'), socket(4000, 'agent-a', '::1', 'tcp6'),
    socket(8000, 'agent-a', '192.0.2.10'), socket(9000, 'agent-a', 'fe80::1', 'tcp6'),
  ]));
  const result = await ports.list(paseo, 'ws-one');
  assert.deepEqual(result.items!.map((row) => [row.port, row.scope, row.address ?? null, row.openable]), [
    [3000, 'local', null, true], [4000, 'local', null, true], [8000, 'address', '192.0.2.10', true], [9000, 'address', 'fe80::1', false],
  ]);
  assert.equal(await ports.target(paseo, 'ws-one', 4000), 'http://[::1]:4000/');
  assert.equal(await ports.target(paseo, 'ws-one', 8000), 'http://192.0.2.10:8000/');
  await assert.rejects(ports.target(paseo, 'ws-one', 9000), /端口 9000 监听的地址不能在共享浏览器里打开/, 'link-local addresses follow the navigation rules');
});

test('an Agent listening on IPv6 only is opened over [::1], even when another IPv4 service holds the same port', async () => {
  const { paseo } = daemon({ 'agent-a': agent('agent-a', 'idle', 'ws-one'), 'agent-other': null });
  // The other IPv4 service is either not an Agent's (absent from the scan) or another daemon's Agent's (unknown).
  for (const sockets of [[socket(8208, 'agent-a', '::', 'tcp6')], [socket(8208, 'agent-other', '127.0.0.1'), socket(8208, 'agent-a', '::', 'tcp6')]]) {
    const { ports } = service(() => scanOf(sockets));
    const result = await ports.list(paseo, 'ws-one');
    assert.deepEqual(result.items!.map((row) => [row.port, row.agentId, row.scope]), [[8208, 'agent-a', 'all']]);
    assert.equal(await ports.target(paseo, 'ws-one', 8208), 'http://[::1]:8208/');
  }
});

/** Starts an HTTP server answering `text`; null when the address cannot be bound here (no IPv6 on this host, say). */
async function listen(text: string, options: ListenOptions): Promise<Server | null> {
  const server = createServer((_request, response) => response.end(text));
  return new Promise((resolve) => { server.once('error', () => resolve(null)); server.listen(options, () => resolve(server)); });
}
const get = (url: string) => new Promise<string>((resolve, reject) => {
  httpGet(url, (response) => { let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(body)); }).once('error', reject);
});

test('real sockets: the opened address reaches the Agent\'s IPv6-only server, not an unrelated IPv4 server on the same port', async (context) => {
  const v6 = await listen('agent-service', { host: '::', port: 0, ipv6Only: true });
  if (!v6) { context.skip('IPv6 is not available on this host'); return; }
  const port = (v6.address() as AddressInfo).port;
  const v4 = await listen('unrelated-ipv4-service', { host: '127.0.0.1', port });
  try {
    assert(v4, 'the unrelated IPv4 server shares the port');
    const { paseo } = daemon({ 'agent-a': agent('agent-a', 'idle', 'ws-one') });
    const { ports } = service(() => scanOf([socket(port, 'agent-a', '::', 'tcp6')]));
    await ports.list(paseo, 'ws-one');
    const target = await ports.target(paseo, 'ws-one', port);
    assert.equal(target, `http://[::1]:${port}/`);
    assert.equal(await get(target), 'agent-service');
    assert.equal(await get(`http://127.0.0.1:${port}/`), 'unrelated-ipv4-service', 'what the old address would have opened');
  } finally {
    v6.close(); v4?.close();
  }
});

test('scans and Agent records are shared and cached; lifecycle events and expiry refresh them', async () => {
  const { paseo, refreshed } = daemon({ 'agent-a': agent('agent-a', 'running', 'ws-one') });
  const { ports, clock, scans } = service(() => scanOf([socket(3000, 'agent-a')], { scannedAt: clock.now }));
  const [one, two] = await Promise.all([ports.list(paseo, 'ws-one'), ports.list(paseo, 'ws-two')]);
  assert.equal(scans(), 1, 'two viewers at once share one scan');
  assert.equal(one.items!.length, 1); assert.equal(two.others!.length, 1);
  clock.now += 1000;
  await ports.list(paseo, 'ws-one');
  assert.equal(scans(), 1, 'a scan is reused for a moment');
  assert.equal(refreshed.length, 1, 'the Agent record too');
  clock.now += 2000;
  await ports.list(paseo, 'ws-one');
  assert.equal(scans(), 2);
  assert.equal(refreshed.length, 1, 'Agent records live a few seconds longer than scans');
  ports.invalidateAgent('agent-a');
  await ports.list(paseo, 'ws-one');
  assert.equal(refreshed.length, 2, 'an Agent event drops its record');
});

test('the revision changes only with what a viewer sees; failures and unsupported hosts never throw', async () => {
  const states = { status: 'running' };
  const { paseo } = daemon({ get 'agent-a'() { return agent('agent-a', states.status, 'ws-one'); } } as never);
  const clock = { now: 1000 };
  const { ports } = service(() => scanOf([socket(3000, 'agent-a')], { scannedAt: clock.now }), clock);
  const first = await ports.list(paseo, 'ws-one');
  clock.now += 10_000;
  const second = await ports.list(paseo, 'ws-one');
  assert.equal(second.revision, first.revision, 'a new scan of the same ports keeps the revision');
  assert.notEqual(second.scannedAt, first.scannedAt);
  states.status = 'closed';
  ports.invalidateAgent();
  clock.now += 10_000;
  const third = await ports.list(paseo, 'ws-one');
  assert.notEqual(third.revision, first.revision);
  assert.equal(third.items![0].agentStatus, 'closed');

  const failing = new AgentPortService(async () => WORKSPACES, { scanner: { scan: async () => { throw new Error('boom'); } } });
  const failed = await failing.list(paseo, 'ws-one');
  assert.deepEqual({ supported: failed.supported, failed: failed.failed, items: failed.items }, { supported: true, failed: true, items: [] });
  const elsewhere = new AgentPortService(async () => WORKSPACES, { scanner: { scan: async () => ({ supported: false, sockets: [], partial: false, scannedAt: 1 }) } });
  assert.equal((await elsewhere.list(paseo, 'ws-one')).supported, false);
  const noDirectory = new AgentPortService(async () => { throw new Error('daemon reconnecting'); }, { scanner: { scan: async () => scanOf([socket(3000, 'agent-a')]) } });
  assert.equal((await noDirectory.list(paseo, 'ws-one')).items!.length, 1, 'a workspace listing failure leaves titles out, not the ports');
});

test('lists are capped and titles cleaned; a stale listing is renewed before opening', async () => {
  const many = Array.from({ length: MAX_PORT_ROWS + 5 }, (_, index) => socket(10_000 + index, 'agent-a'));
  const { paseo } = daemon({ 'agent-a': agent('agent-a', 'idle', 'ws-one', `Dev\u0007server ${'x'.repeat(200)}`) });
  const clock = { now: 1000 };
  let sockets = many;
  const { ports, scans } = service(() => scanOf(sockets, { scannedAt: clock.now }), clock);
  const result = await ports.list(paseo, 'ws-one');
  assert.equal(result.items!.length, MAX_PORT_ROWS);
  assert.equal(result.partial, true);
  assert.equal(result.items![0].agentTitle!.length, 120);
  assert.match(result.items![0].agentTitle!, /^Dev server x/);
  sockets = [socket(4321, 'agent-a')];
  clock.now += 60_000;
  assert.equal(await ports.target(paseo, 'ws-one', 4321), 'http://127.0.0.1:4321/', 'a port that appeared after the last listing is found by listing again');
  assert.equal(scans(), 2);
});

test('a directory names a workspace only on an exact match of one workspace', () => {
  assert.equal(workspaceForDirectory('/work/one', WORKSPACES)?.id, 'ws-one');
  assert.equal(workspaceForDirectory('/work/one/./', WORKSPACES)?.id, 'ws-one');
  assert.equal(workspaceForDirectory('/work/one/sub', WORKSPACES), null, 'a subdirectory is not guessed');
  assert.equal(workspaceForDirectory('work/one', WORKSPACES), null);
  assert.equal(workspaceForDirectory(null, WORKSPACES), null);
  assert.equal(workspaceForDirectory('/work/one', [...WORKSPACES, workspace('ws-three', '/work/one', 'again', 'demo-project')]), null, 'two workspaces on one directory: unattributed');
});

const row = (extra: Partial<BrowserAgentPort> = {}): BrowserAgentPort => ({ port: 3000, scope: 'local', process: 'node', agentId: 'agent-a', agentTitle: 'Dev server', agentStatus: 'running', workspaceId: 'ws-one', workspaceTitle: 'feature-one', projectTitle: 'demo-project', openable: true, ...extra });

test('the panel model: states, labels, unchanged replies and rows that appear later', () => {
  assert.deepEqual(portLook(row()), { tone: 'info', label: 'Agent 运行中', working: true, stopped: false });
  assert.deepEqual(portLook(row({ agentStatus: 'idle' })), { tone: 'success', label: 'Agent 空闲', working: false, stopped: false });
  for (const [status, label] of [['closed', 'Agent 已停止，端口仍占用'], ['archived', 'Agent 已归档，端口仍占用'], ['error', 'Agent 出错，端口仍占用']] as const) {
    assert.deepEqual(portLook(row({ agentStatus: status })), { tone: 'warning', label, working: false, stopped: true }, status);
  }
  assert.equal(scopeLabel(row()), '仅本机'); assert.equal(scopeLabel(row({ scope: 'all' })), '所有地址'); assert.equal(scopeLabel(row({ scope: 'address', address: '192.0.2.10' })), '仅 192.0.2.10');
  assert.equal(scopeTone(row({ scope: 'all' })), 'orange'); assert.equal(scopeTone(row()), 'teal');
  assert.equal(agentName(row({ agentTitle: null })), '未命名 Agent');
  assert.equal(processName(row({ process: '' })), '未知进程');
  assert.equal(workspaceName(row()), 'demo-project / feature-one');
  assert.equal(workspaceName(row({ projectTitle: 'main', workspaceTitle: 'main' })), 'main');
  assert.equal(workspaceName(row({ projectTitle: null, workspaceTitle: null })), null);
  assert.equal(openLabel(row()), '在新标签页打开端口 3000：Dev server，node，仅本机，Agent 运行中');

  assert.deepEqual(portsRequest('ws-one', undefined), { workspaceId: 'ws-one' });
  const data = mergePorts(undefined, { supported: true, items: [row()], others: [], partial: false, scannedAt: 1, revision: 'r1' });
  assert.deepEqual(portsRequest('ws-one', data), { workspaceId: 'ws-one', revision: 'r1' });
  const kept = mergePorts(data, { supported: true, unchanged: true, revision: 'r1', scannedAt: 2 });
  assert.equal(kept.items, data.items, 'an unchanged reply keeps the rendered rows');
  assert.equal(kept.scannedAt, 2);
  assert.deepEqual(mergePorts(data, { supported: false, scannedAt: 3, revision: 'unsupported' }).supported, false);

  assert.deepEqual([...freshPorts(null, [row()])], [], 'the first rows a sheet shows are the baseline');
  assert.deepEqual([...freshPorts(new Set([portKey(row())]), [row(), row({ port: 5173 })])], ['5173:agent-a']);
  assert.notEqual(portKey(row()), portKey(row({ agentId: 'agent-b' })), 'the same port of another Agent is another row');
});
