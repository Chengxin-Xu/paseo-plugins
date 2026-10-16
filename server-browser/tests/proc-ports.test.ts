import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PortScanner, connectHost, decodeProcAddress, descendantsOf, findDaemon, nearestDaemons, parseNetTable, parseStat, programName, readAgentEnv, scopeOf, socketInode,
  type ProcIo, type ProcRow,
} from '../server/proc-ports';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
/** One /proc/net/tcp line: local address, state, uid, inode (the other columns as the kernel prints them). */
const line = (index: number, local: string, state: string, uid: number, inode: string | number) =>
  `   ${index}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
const v4 = (address: string, port: number) => `${address.split('.').map((part) => Number(part).toString(16).toUpperCase().padStart(2, '0')).reverse().join('')}:${hex(port)}`;
const ANY6 = (port: number) => `00000000000000000000000000000000:${hex(port)}`;

test('decodes IPv4, IPv6, loopback, wildcard and IPv4-mapped addresses (little- and big-endian hosts)', () => {
  assert.deepEqual(decodeProcAddress('tcp', '0100007F:0BB8', true), { address: '127.0.0.1', port: 3000 });
  assert.deepEqual(decodeProcAddress('tcp', '00000000:1A6F', true), { address: '0.0.0.0', port: 6767 });
  assert.deepEqual(decodeProcAddress('tcp', '0A0200C0:1F40', true), { address: '192.0.2.10', port: 8000 });
  assert.deepEqual(decodeProcAddress('tcp', '7F000001:0BB8', false), { address: '127.0.0.1', port: 3000 }, 'big-endian hosts print bytes in order');
  assert.deepEqual(decodeProcAddress('tcp6', ANY6(5173), true), { address: '::', port: 5173 });
  assert.deepEqual(decodeProcAddress('tcp6', '00000000000000000000000001000000:1F90', true), { address: '::1', port: 8080 });
  assert.deepEqual(decodeProcAddress('tcp6', '0000000000000000FFFF00000100007F:0050', true), { address: '127.0.0.1', port: 80 });
  assert.deepEqual(decodeProcAddress('tcp6', 'B80D0120000000000000000001000000:01BB', true), { address: '2001:db8::1', port: 443 });
  assert.deepEqual(decodeProcAddress('tcp6', '000080FE000000000000000001000000:0016', true), { address: 'fe80::1', port: 22 });
  for (const bad of ['0100007F', '0100007F:0BB', 'G100007F:0BB8', '0100007F:0BB8:1', `${'0'.repeat(31)}:0050`, '']) assert.equal(decodeProcAddress(bad.length > 20 ? 'tcp6' : 'tcp', bad, true), null, bad);
  assert.equal(decodeProcAddress('tcp', ANY6(80), true), null, 'an IPv6 address is not read as IPv4');
});

test('listen scope and the address the shared browser connects to', () => {
  assert.equal(scopeOf('0.0.0.0'), 'all'); assert.equal(scopeOf('::'), 'all');
  assert.equal(scopeOf('127.0.0.1'), 'local'); assert.equal(scopeOf('127.3.0.9'), 'local'); assert.equal(scopeOf('::1'), 'local');
  assert.equal(scopeOf('192.0.2.10'), 'address'); assert.equal(scopeOf('2001:db8::1'), 'address');
  assert.equal(connectHost('0.0.0.0'), '127.0.0.1'); assert.equal(connectHost('127.0.0.1'), '127.0.0.1');
  assert.equal(connectHost('::'), '[::1]', 'the IPv6 wildcard may be IPv6-only: it is reached over IPv6, never through 127.0.0.1');
  assert.equal(connectHost('127.0.0.2'), '127.0.0.2'); assert.equal(connectHost('::1'), '[::1]'); assert.equal(connectHost('2001:db8::1'), '[2001:db8::1]');
});

test('the table parser keeps only this user\'s listening sockets and ignores cut-off and malformed lines', () => {
  const text = HEADER
    + line(0, v4('127.0.0.1', 3000), '0A', 1000, 5001)
    + line(1, v4('0.0.0.0', 8000), '0A', 1000, 5002)
    + line(2, v4('127.0.0.1', 4000), '0A', 1001, 5003)
    + line(3, v4('127.0.0.1', 0), '0A', 1000, 5004)
    + line(4, v4('127.0.0.1', 5000), '0A', 1000, 0)
    + 'garbage line\n'
    + line(5, v4('127.0.0.1', 41234), '01', 1000, 5005);
  const parsed = parseNetTable(text, 'tcp', 1000, true);
  assert.deepEqual(parsed.sockets, [
    { family: 'tcp', inode: '5001', address: '127.0.0.1', port: 3000 },
    { family: 'tcp', inode: '5002', address: '0.0.0.0', port: 8000 },
  ], 'other users, port 0, inode 0, other states and garbage are skipped');
  assert.equal(parsed.ended, true, 'a line in another state ends the listening part');
  const cut = HEADER + line(0, v4('127.0.0.1', 3000), '0A', 1000, 5001) + line(1, v4('127.0.0.1', 3001), '0A', 1000, 5006).slice(0, 120);
  const partial = parseNetTable(cut, 'tcp', 1000, true);
  assert.deepEqual(partial.sockets.map((socket) => socket.port), [3000], 'a line cut off by the read limit is not parsed (its inode could be cut)');
  assert.equal(partial.ended, false);
  assert.deepEqual(parseNetTable(HEADER + line(0, ANY6(5173), '0A', 1000, 6001), 'tcp6', 1000, true).sockets, [{ family: 'tcp6', inode: '6001', address: '::', port: 5173 }]);
});

test('stat, program names, socket links and the two Agent variables', () => {
  const stat = parseStat('4321 (my (odd) ) name) S 99 4321 4321 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 777 1000 10 18446744073709551615');
  assert.deepEqual(stat, { name: 'my (odd) ) name', ppid: 99, startTicks: 777 });
  assert.equal(parseStat('garbage'), null);
  assert.equal(programName('npm exec hashpa'), 'npm');
  assert.equal(programName('nginx: master'), 'nginx');
  assert.equal(programName('py\u0007thon3'), 'py');
  assert.equal(programName('x'.repeat(80)).length, 32);
  assert.equal(socketInode('socket:[123456]'), '123456');
  for (const link of ['pipe:[1]', '/home/dev/file', 'socket:[0]', 'socket:[12]x', null]) assert.equal(socketInode(link), null, String(link));

  const environ = Buffer.from('TOKEN=fixture-secret\0PASEO_AGENT_ID=agent-fixture-1\0API_KEY=fixture-key\0PASEO_AGENT_CWD=/home/dev/project\0PATH=/usr/bin\0');
  const env = readAgentEnv(environ);
  assert.deepEqual(env, { agentId: 'agent-fixture-1', agentCwd: '/home/dev/project' });
  assert.deepEqual(Object.keys(env).sort(), ['agentCwd', 'agentId'], 'nothing else is kept');
  assert.doesNotMatch(JSON.stringify(env), /fixture-secret|fixture-key|usr\/bin/);
  assert.deepEqual(readAgentEnv(Buffer.from(`PASEO_AGENT_ID=${'a'.repeat(129)}\0PASEO_AGENT_CWD=relative/dir\0`)), { agentId: null, agentCwd: null }, 'too long and relative values are refused');
  assert.deepEqual(readAgentEnv(Buffer.from('PASEO_AGENT_ID=not/an/id\0PASEO_AGENT_CWD=/home/dev/\u0001x\0')), { agentId: null, agentCwd: null });
  assert.deepEqual(readAgentEnv(Buffer.concat([Buffer.from('PASEO_AGENT_CWD=/home/'), Buffer.from([0xff, 0xfe]), Buffer.from('\0')])), { agentId: null, agentCwd: null }, 'a path that is not UTF-8 is dropped');
  assert.deepEqual(readAgentEnv(Buffer.from('PASEO_AGENT_ID=agent-1\0PASEO_AGENT_CWD=/home/dev/pro')), { agentId: 'agent-1', agentCwd: null }, 'an entry cut off by the read limit is ignored');
  assert.deepEqual(readAgentEnv(Buffer.from('XPASEO_AGENT_ID=agent-2\0PASEO_AGENT_IDX=agent-3\0')), { agentId: null, agentCwd: null }, 'only exact variable names count');
});

test('the daemon is the nearest "Paseo Daemon" above the plugin; descendants are cycle-safe', () => {
  const rows: ProcRow[] = [
    { pid: 50, ppid: 1, name: 'systemd', startTicks: 1 }, { pid: 100, ppid: 50, name: 'Paseo Supervisor', startTicks: 2 },
    { pid: 101, ppid: 100, name: 'Paseo Daemon', startTicks: 3 }, { pid: 102, ppid: 101, name: 'node', startTicks: 4 },
    { pid: 103, ppid: 102, name: 'chrome-headless', startTicks: 5 }, { pid: 200, ppid: 50, name: 'Paseo Daemon', startTicks: 6 },
    { pid: 7, ppid: 8, name: 'a', startTicks: 7 }, { pid: 8, ppid: 7, name: 'b', startTicks: 8 },
  ];
  assert.equal(findDaemon(rows, 102), 101);
  assert.equal(findDaemon(rows.map((row) => ({ ...row, name: row.name === 'Paseo Daemon' ? 'renamed' : row.name })), 102), 101, 'without the name, the plugin\'s parent');
  assert.equal(findDaemon(rows, 999), null);
  assert.deepEqual([...descendantsOf([101], rows)].sort(), [101, 102, 103]);
  assert.deepEqual([...descendantsOf([7], rows)].sort(), [7, 8], 'a PID cycle from a racing scan ends');
  const nested: ProcRow[] = [...rows, { pid: 140, ppid: 103, name: 'Paseo Daemon', startTicks: 9 }, { pid: 141, ppid: 140, name: 'node', startTicks: 10 }];
  const nearest = nearestDaemons(nested);
  assert.equal(nearest.get(103), 101);
  assert.equal(nearest.get(141), 140, 'a daemon started below this one keeps its own processes');
  assert.equal(nearest.get(140), 140);
  assert.equal(nearest.get(50), null);
  assert.equal(nearest.get(7), null, 'cycles resolve to no daemon');
});

/** A fake /proc: processes with owners, names, parents, environments and descriptors; every read is recorded. */
type FakeProcess = { uid: number; ppid: number; name: string; start?: number; env?: string; fds?: Record<string, string>; environError?: string };
function fakeProc(processes: Record<number, FakeProcess>, tables: { tcp: string | null; tcp6?: string | null }) {
  const calls: string[] = [];
  const io: ProcIo = {
    async readNetTable(file) { calls.push(`table ${file}`); const text = file.endsWith('6') ? tables.tcp6 ?? null : tables.tcp; return text === null ? null : { text, truncated: false }; },
    async listPids() { calls.push('listPids'); return { pids: Object.keys(processes).map(Number), truncated: false }; },
    async ownerOf(pid) { calls.push(`owner ${pid}`); return processes[pid]?.uid ?? null; },
    async read(file, maxBytes) {
      calls.push(`read ${file}`);
      const [, pid, kind] = /^\/proc\/(\d+)\/(stat|environ)$/.exec(file)!;
      const process = processes[Number(pid)];
      if (!process) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (kind === 'environ' && process.environError) throw Object.assign(new Error('denied'), { code: process.environError });
      const data = Buffer.from(kind === 'stat' ? `${pid} (${process.name}) S ${process.ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${process.start ?? Number(pid) * 10} 0 0` : process.env ?? '');
      return { data: data.subarray(0, maxBytes), truncated: data.length > maxBytes };
    },
    async listFds(pid, limit) { calls.push(`fds ${pid}`); const fds = Object.keys(processes[pid]?.fds ?? {}); return { fds: fds.slice(0, limit), truncated: fds.length > limit }; },
    async readLink(pid, fd) { calls.push(`link ${pid}/${fd}`); return processes[pid]?.fds?.[fd] ?? null; },
  };
  return { io, calls };
}
const UID = 1000;
const agentEnv = (id: string, cwd = '/home/dev/project') => `SECRET=fixture-secret\0PASEO_AGENT_ID=${id}\0PASEO_AGENT_CWD=${cwd}\0`;
function host() {
  const processes: Record<number, FakeProcess> = {
    1: { uid: 0, ppid: 0, name: 'init' },
    50: { uid: UID, ppid: 1, name: 'systemd' },
    100: { uid: UID, ppid: 50, name: 'Paseo Supervisor' },
    101: { uid: UID, ppid: 100, name: 'Paseo Daemon', fds: { 20: 'socket:[6767]' } },
    102: { uid: UID, ppid: 101, name: 'node', fds: { 30: 'socket:[9300]' } },
    103: { uid: UID, ppid: 102, name: 'chrome-headless', env: agentEnv('agent-a'), fds: { 3: 'socket:[9222]' } },
    110: { uid: UID, ppid: 101, name: 'claude', env: agentEnv('agent-a'), fds: { 0: 'pipe:[1]', 1: 'pipe:[2]' } },
    111: { uid: UID, ppid: 110, name: 'node', env: agentEnv('agent-a'), fds: { 0: '/dev/null', 21: 'socket:[3000]' } },
    120: { uid: UID, ppid: 50, name: 'python3', env: agentEnv('agent-b', '/home/dev/other'), fds: { 3: 'socket:[8000]' } },
    130: { uid: UID, ppid: 50, name: 'node', env: 'HOME=/home/dev\0', fds: { 9: 'socket:[5000]' } },
    200: { uid: UID, ppid: 50, name: 'Paseo Daemon' },
    201: { uid: UID, ppid: 200, name: 'node', env: agentEnv('agent-a'), fds: { 4: 'socket:[7000]' } },
    300: { uid: 1001, ppid: 1, name: 'node', env: agentEnv('agent-a'), fds: { 5: 'socket:[4000]' } },
    // An Agent's own test daemon, started below the Agent's server: its processes are that daemon's, not this one's.
    140: { uid: UID, ppid: 111, name: 'Paseo Daemon', env: agentEnv('agent-a'), fds: { 6: 'socket:[7100]' } },
    141: { uid: UID, ppid: 140, name: 'node', env: agentEnv('agent-a'), fds: { 7: 'socket:[7101]' } },
  };
  const table = () => HEADER
    + line(0, v4('127.0.0.1', 6767), '0A', UID, 6767) + line(1, v4('127.0.0.1', 9300), '0A', UID, 9300) + line(2, v4('127.0.0.1', 9222), '0A', UID, 9222)
    + line(3, v4('127.0.0.1', 3000), '0A', UID, 3000) + line(4, v4('0.0.0.0', 8000), '0A', UID, 8000) + line(5, v4('127.0.0.1', 5000), '0A', UID, 5000)
    + line(6, v4('127.0.0.1', 7000), '0A', UID, 7000) + line(7, v4('127.0.0.1', 4000), '0A', UID, 4000)
    + line(10, v4('127.0.0.1', 7100), '0A', UID, 7100) + line(11, v4('127.0.0.1', 7101), '0A', UID, 7101)
    + Object.entries(processes).flatMap(([, process]) => Object.values(process.fds ?? {})).filter((link) => /^socket:\[3001\]$/.test(link)).map(() => line(8, v4('127.0.0.1', 3001), '0A', UID, 3001)).join('')
    + line(9, v4('127.0.0.1', 50000), '01', UID, 1);
  const tables = { get tcp() { return table(); }, tcp6: null };
  const fake = fakeProc(processes, tables);
  return { processes, ...fake };
}
const ports = (scan: Awaited<ReturnType<PortScanner['scan']>>) => scan.sockets.map((socket) => `${socket.port}:${socket.owner.pid}:${socket.owner.agentId}`).sort();

test('a scan lists Agent processes in and out of the daemon tree, never the plugin\'s, other daemons\' or other users\' processes', async () => {
  const { io, calls } = host();
  const scanner = new PortScanner({ io, uid: UID, selfPid: 102, platform: 'linux' });
  const scan = await scanner.scan();
  assert.equal(scan.supported, true);
  assert.equal(scan.partial, false);
  assert.deepEqual(ports(scan), ['3000:111:agent-a', '8000:120:agent-b'], 'the in-tree server and the one that left the tree (nohup) are found');
  const owner = scan.sockets.find((socket) => socket.port === 3000)!.owner;
  assert.deepEqual(owner, { pid: 111, startTicks: 1110, fd: '21', name: 'node', agentId: 'agent-a', agentCwd: '/home/dev/project' });
  assert.doesNotMatch(JSON.stringify(scan), /fixture-secret/, 'no other environment value is kept');
  const reads = calls.filter((call) => call.startsWith('read ') || call.startsWith('fds ') || call.startsWith('link '));
  for (const pid of [1, 300]) assert(!reads.some((call) => call.includes(`/${pid}/`) || call === `fds ${pid}` || call.startsWith(`link ${pid}/`)), `nothing of process ${pid} (another user) is read`);
  for (const pid of [102, 103, 200, 201, 140, 141]) assert(!calls.includes(`fds ${pid}`), `process ${pid} (the plugin's or another daemon's tree) is not searched`);
  const environs = calls.filter((call) => call.endsWith('/environ')).sort();
  assert.deepEqual(environs, ['read /proc/111/environ', 'read /proc/120/environ', 'read /proc/130/environ'], 'environments are read only for processes that hold a listening socket');
  assert(!calls.some((call) => call.includes('cmdline')), 'command lines are never read');
});

test('a quiet host costs three small reads per owner; a new socket or a gone owner starts a new walk', async () => {
  const { io, calls, processes } = host();
  const scanner = new PortScanner({ io, uid: UID, selfPid: 102, platform: 'linux' });
  await scanner.scan();
  calls.length = 0;
  const again = await scanner.scan();
  assert.deepEqual(ports(again), ['3000:111:agent-a', '8000:120:agent-b']);
  assert(!calls.includes('listPids') && !calls.some((call) => call.startsWith('fds ')), 'no walk when nothing new listens');
  assert.deepEqual(calls.filter((call) => call.startsWith('link ')).sort(), ['link 111/21', 'link 120/3'], 'owners are confirmed by their own descriptor');
  assert(!calls.some((call) => call.endsWith('/environ')), 'environments are read once per process');

  // The Agent's server opens a second port: one walk finds it.
  processes[111].fds = { ...processes[111].fds, 22: 'socket:[3001]' };
  calls.length = 0;
  assert.deepEqual(ports(await scanner.scan()), ['3000:111:agent-a', '3001:111:agent-a', '8000:120:agent-b']);
  assert.equal(calls.filter((call) => call === 'listPids').length, 1);

  // The orphan exits and its PID is reused by an unrelated process of the user: not this Agent's port any more.
  processes[120] = { uid: UID, ppid: 50, name: 'python3', start: 99999, env: 'HOME=/home/dev\0', fds: { 3: 'socket:[8000]' } };
  assert.deepEqual(ports(await scanner.scan()), ['3000:111:agent-a', '3001:111:agent-a'], 'a reused PID (another start time) is not the old owner');
  calls.length = 0;
  await scanner.scan();
  assert(!calls.includes('listPids'), 'sockets no Agent process holds are not looked for again');
});

test('caps, the deadline and unreadable environments mark a scan partial instead of guessing', async () => {
  const capped = host();
  const scan = await new PortScanner({ io: capped.io, uid: UID, selfPid: 102, platform: 'linux', limits: { processes: 3 } }).scan();
  assert.equal(scan.partial, true, 'more processes than the cap');

  const few = host();
  few.processes[111].fds = { 0: '/dev/null', 1: '/dev/null', 21: 'socket:[3000]' };
  const fdScan = await new PortScanner({ io: few.io, uid: UID, selfPid: 102, platform: 'linux', limits: { fdsPerProcess: 2 } }).scan();
  assert.equal(fdScan.partial, true, 'more descriptors than the cap');
  assert(!fdScan.sockets.some((socket) => socket.port === 3000));

  const slow = host();
  const listFds = slow.io.listFds;
  slow.io.listFds = async (pid, limit, signal) => { await new Promise((resolve) => setTimeout(resolve, 60)); return listFds(pid, limit, signal); };
  const late = await new PortScanner({ io: slow.io, uid: UID, selfPid: 102, platform: 'linux', limits: { durationMs: 30 } }).scan();
  assert.equal(late.partial, true, 'the deadline ends the walk');

  const denied = host();
  denied.processes[120].environError = 'EACCES';
  assert.deepEqual(ports(await new PortScanner({ io: denied.io, uid: UID, selfPid: 102, platform: 'linux' }).scan()), ['3000:111:agent-a'], 'an environment that cannot be read is no Agent\'s');

  const long = host();
  long.processes[111].env = `${'FILLER=x\0'.repeat(20)}PASEO_AGENT_ID=agent-a\0`;
  const cut = await new PortScanner({ io: long.io, uid: UID, selfPid: 102, platform: 'linux', limits: { environBytes: 64 } }).scan();
  assert(!cut.sockets.some((socket) => socket.port === 3000), 'an environment cut off before PASEO_AGENT_ID is not guessed');
});

test('hosts without /proc/net tables, or not Linux, are not supported (nothing is read)', async () => {
  const { io, calls } = fakeProc({}, { tcp: null, tcp6: null });
  assert.equal((await new PortScanner({ io, uid: UID, selfPid: 1, platform: 'linux' }).scan()).supported, false);
  calls.length = 0;
  assert.equal((await new PortScanner({ io, uid: UID, selfPid: 1, platform: 'darwin' }).scan()).supported, false);
  assert.deepEqual(calls, []);
  assert.equal((await new PortScanner({ io, uid: null, selfPid: 1, platform: 'linux' }).scan()).supported, false);
});

/** A real HTTP server on 127.0.0.1 that reports its port and PID; `orphan` starts it through a parent that exits at once. */
const SERVER = "const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>{process.stdout.write(JSON.stringify({port:s.address().port,pid:process.pid})+'\\n');});setTimeout(()=>process.exit(0),60000);";
const ORPHAN = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(SERVER)}],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',d=>{process.stdout.write(d);process.exit(0);});`;
function serve(env: Record<string, string>, orphan = false): Promise<{ child: ChildProcess; port: number; pid: number }> {
  const child = spawn(process.execPath, ['-e', orphan ? ORPHAN : SERVER], { env: { PATH: process.env.PATH ?? '/usr/bin', ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout!.on('data', (chunk) => { text += chunk; const at = text.indexOf('\n'); if (at >= 0) { const { port, pid } = JSON.parse(text.slice(0, at)); resolve({ child, port, pid }); } });
    child.once('error', reject);
    child.once('exit', () => { if (!text.includes('\n')) reject(new Error('server exited')); });
  });
}

test('on this host\'s /proc: Agent processes are found (also after leaving their parent) with their program name and only the two variables', { skip: process.platform !== 'linux' }, async () => {
  const plugin = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  const servers = await Promise.all([
    serve({ PASEO_AGENT_ID: 'agent-fixture-1', PASEO_AGENT_CWD: '/home/dev/project', FIXTURE_TOKEN: 'fixture-secret-value' }),
    serve({ PASEO_AGENT_ID: 'agent-fixture-2', FIXTURE_TOKEN: 'fixture-secret-value' }, true),
    serve({ FIXTURE_TOKEN: 'fixture-secret-value' }),
  ]);
  try {
    // The orphan's parent has exited: like `nohup … &` from an Agent's shell, the server lives on outside its tree.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(Number(readFileSync(`/proc/${servers[1].pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]), process.pid);
    // A stand-in plugin process next to the servers: the daemon is found above it, as in the host (or is this test).
    const scanner = new PortScanner({ selfPid: plugin.pid! });
    const scan = await scanner.scan();
    assert.equal(scan.supported, true);
    const found = scan.sockets.filter((socket) => servers.some((server) => server.port === socket.port)).sort((a, b) => a.owner.agentId.localeCompare(b.owner.agentId));
    assert.deepEqual(found.map((socket) => ({ port: socket.port, pid: socket.owner.pid, name: socket.owner.name, agentId: socket.owner.agentId, agentCwd: socket.owner.agentCwd, address: socket.address })), [
      { port: servers[0].port, pid: servers[0].pid, name: 'node', agentId: 'agent-fixture-1', agentCwd: '/home/dev/project', address: '127.0.0.1' },
      { port: servers[1].port, pid: servers[1].pid, name: 'node', agentId: 'agent-fixture-2', agentCwd: null, address: '127.0.0.1' },
    ], 'the process without PASEO_AGENT_ID is not listed');
    assert.doesNotMatch(JSON.stringify(scan), /fixture-secret-value/);
    const second = await scanner.scan();
    assert(servers.slice(0, 2).every((server) => second.sockets.some((socket) => socket.port === server.port)), 'owners are confirmed on the next scan');
  } finally {
    for (const pid of [...servers.map((server) => server.pid), plugin.pid!]) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
});
