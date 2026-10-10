import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensurePrivateDirectory, readPrivateJson } from '../server/private-files';

test('private directories are created or tightened to 0700, and links, files and foreign owners are refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paseo-browser-private-'));
  try {
    const fresh = path.join(root, 'data', 'workspace', 'profile');
    await ensurePrivateDirectory(fresh, '测试目录');
    assert.equal((await stat(fresh)).mode & 0o777, 0o700);
    const loose = path.join(root, 'loose');
    await mkdir(loose); await chmod(loose, 0o755);
    await ensurePrivateDirectory(loose, '测试目录');
    assert.equal((await stat(loose)).mode & 0o777, 0o700, 'an existing directory is tightened');
    const target = path.join(root, 'target'); await mkdir(target); await chmod(target, 0o755);
    await symlink(target, path.join(root, 'linked'));
    await assert.rejects(ensurePrivateDirectory(path.join(root, 'linked'), '测试目录'), /测试目录（.*linked）不是真实目录/);
    assert.equal((await stat(target)).mode & 0o777, 0o755, 'the link target is left alone');
    await writeFile(path.join(root, 'file'), 'x');
    await assert.rejects(ensurePrivateDirectory(path.join(root, 'file'), '测试目录'), /EEXIST|ENOTDIR|不是真实目录/);
    const getuid = process.getuid;
    process.getuid = () => (getuid?.() ?? 0) + 4242;
    try { await assert.rejects(ensurePrivateDirectory(loose, '测试目录'), /不属于运行 daemon 的用户/); }
    finally { process.getuid = getuid; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plugin JSON files are read only as small regular files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paseo-browser-json-'));
  try {
    const file = path.join(root, 'agent.json');
    await writeFile(file, JSON.stringify({ agentId: 'agent-1' }));
    assert.deepEqual(await readPrivateJson(file, 4096), { agentId: 'agent-1' });
    await writeFile(path.join(root, 'big.json'), JSON.stringify({ agentId: 'x'.repeat(5000) }));
    await assert.rejects(readPrivateJson(path.join(root, 'big.json'), 4096), /过大/);
    await symlink(file, path.join(root, 'link.json'));
    await assert.rejects(readPrivateJson(path.join(root, 'link.json'), 4096), /ELOOP/);
    execFileSync('mkfifo', [path.join(root, 'fifo.json')]);
    await assert.rejects(readPrivateJson(path.join(root, 'fifo.json'), 4096), /不是普通文件/, 'a FIFO is refused without blocking');
  } finally { await rm(root, { recursive: true, force: true }); }
});
