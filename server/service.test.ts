import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { createApp } from './index.js';
import { ServiceError, SkillsService, type EditorLaunch } from './service.js';
import type { WorkspaceSnapshot } from '../shared/types.js';

let fixture: string;
const services = new Set<SkillsService>();
before(async () => {
  fixture = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'zskills-tests-')),
  );
});
after(async () => {
  for (const service of services) service.dispose();
  await rm(fixture, { recursive: true, force: true });
});

async function directory(name: string): Promise<string> {
  const result = path.join(fixture, name);
  await mkdir(result, { recursive: true });
  return result;
}

async function skillAt(
  directoryPath: string,
  name = 'example-skill',
): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
  await writeFile(
    path.join(directoryPath, 'SKILL.md'),
    `---\nname: ${name}\ndescription: |\n  A useful Skill.\n  With a second line.\n---\n# Read me\n\nOnly source content.\n`,
  );
}

function serviceAt(
  root: string,
  configName: string,
  overrides: ConstructorParameters<typeof SkillsService>[0] = {},
): SkillsService {
  const service = new SkillsService({
    homeDir: fixture,
    configDir: path.join(fixture, configName),
    roots: [{ label: 'Test root', path: root, kind: 'personal' }],
    platform: 'linux',
    environment: {},
    ...overrides,
  });
  services.add(service);
  return service;
}

test('discovers real Skills, safely parses YAML, deduplicates canonical directories, and never executes scripts', async () => {
  const root = await directory('discovery');
  const installed = await directory('installed');
  await skillAt(path.join(root, 'first'), 'same-name');
  await skillAt(path.join(root, 'second'), 'same-name');
  await skillAt(path.join(installed, 'linked'), 'linked-skill');
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await skillAt(
    path.join(root, 'node_modules', 'included'),
    'dependency-skill',
  );
  await symlink(
    path.join(installed, 'linked'),
    path.join(root, 'linked'),
    'dir',
  );
  await symlink(
    path.join(installed, 'linked'),
    path.join(root, 'duplicate'),
    'dir',
  );
  await symlink(root, path.join(root, 'cycle'), 'dir');
  await writeFile(
    path.join(root, 'first', 'run.sh'),
    `#!/bin/sh\ntouch '${path.join(fixture, 'executed')}'\n`,
  );
  await skillAt(path.join(root, 'invalid-yaml'));
  await writeFile(
    path.join(root, 'invalid-yaml', 'SKILL.md'),
    '---\nname: [broken\n---\n# Still readable',
  );
  const service = serviceAt(root, 'discovery-config');
  const snapshot = await service.rescan();
  assert.equal(snapshot.skills.length, 4);
  assert.equal(
    snapshot.skills.filter((skill) => skill.name === 'same-name').length,
    2,
  );
  assert.notEqual(snapshot.skills[0]?.id, snapshot.skills[1]?.id);
  assert.equal(
    snapshot.skills.find((skill) => skill.name === 'linked-skill')?.path,
    path.join(installed, 'linked'),
  );
  assert.ok(snapshot.skills.some((skill) => skill.name === 'dependency-skill'));
  assert.ok(!snapshot.skills.some((skill) => skill.name === 'invalid-yaml'));
  assert.equal(snapshot.scanProgress.invalidSkills, 1);
  assert.equal(
    snapshot.skills.find((skill) => skill.name === 'same-name')?.description,
    'A useful Skill.\nWith a second line.',
  );
  await assert.rejects(readFile(path.join(fixture, 'executed')), {
    code: 'ENOENT',
  });
});

test('blocks traversal and symlink escape previews while allowing source and internal links', async () => {
  const root = await directory('preview');
  const skillPath = path.join(root, 'safe');
  await skillAt(skillPath);
  await mkdir(path.join(skillPath, 'scripts'));
  await writeFile(
    path.join(skillPath, 'scripts', 'example.ts'),
    'console.log("source only");',
  );
  await writeFile(path.join(fixture, 'outside.txt'), 'private external text');
  await symlink(
    path.join(fixture, 'outside.txt'),
    path.join(skillPath, 'escape.txt'),
  );
  await symlink(
    path.join(skillPath, 'SKILL.md'),
    path.join(skillPath, 'internal.md'),
  );
  await writeFile(
    path.join(skillPath, 'binary.bin'),
    Buffer.from([0, 1, 2, 3]),
  );
  await writeFile(
    path.join(skillPath, 'image.png'),
    Buffer.from([137, 80, 78, 71]),
  );
  await writeFile(
    path.join(skillPath, 'large.txt'),
    Buffer.alloc(2 * 1024 * 1024 + 1, 'a'),
  );
  const service = serviceAt(root, 'preview-config');
  const id = (await service.rescan()).skills[0]!.id;
  const detail = await service.getSkill(id);
  assert.ok(detail.files.some((file) => file.path === 'scripts/example.ts'));
  assert.ok(!detail.files.some((file) => file.path === 'escape.txt'));
  assert.equal((await service.getFile(id, 'SKILL.md')).kind, 'markdown');
  assert.equal((await service.getFile(id, 'internal.md')).kind, 'markdown');
  assert.equal((await service.getFile(id, 'scripts/example.ts')).kind, 'text');
  assert.equal((await service.getFile(id, 'binary.bin')).kind, 'unsupported');
  assert.equal((await service.getFile(id, 'large.txt')).kind, 'unsupported');
  assert.match(
    (await service.getFile(id, 'image.png')).content,
    /^data:image\/png;base64,/,
  );
  for (const invalidPath of [
    '../outside.txt',
    '/etc/passwd',
    '..\\outside.txt',
    'escape.txt',
  ]) {
    await assert.rejects(
      service.getFile(id, invalidPath),
      (error) =>
        error instanceof ServiceError && [400, 403].includes(error.status),
    );
  }
});

test('persists custom roots and editor choices outside Skill sources', async () => {
  const root = await directory('settings');
  const extra = await directory('custom');
  await skillAt(path.join(extra, 'added'));
  const service = serviceAt(root, 'settings-config');
  await service.addRoot(extra);
  const snapshot = await service.rescan();
  assert.equal(snapshot.skills.length, 1);
  const custom = snapshot.roots.find(
    (candidate) => candidate.kind === 'custom',
  )!;
  assert.equal(custom.removable, true);
  await service.setEditor('zed');
  service.dispose();
  const fresh = serviceAt(root, 'settings-config');
  assert.equal((await fresh.rescan()).skills.length, 1);
  assert.equal((await fresh.getEditor()).editor, 'zed');
  assert.equal((await fresh.getEditor()).available, false);
  await fresh.removeRoot(custom.id);
  assert.equal((await fresh.rescan()).skills.length, 0);
  await assert.rejects(fresh.removeRoot(snapshot.roots[0]!.id), /Only custom/);
  await assert.rejects(fresh.addRoot('relative/path'), /absolute/);
});

test('editor actions launch a fixed program with file arguments only after a request', async () => {
  const root = await directory('editor');
  const bin = await directory('bin');
  await writeFile(path.join(bin, 'code'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  await writeFile(path.join(bin, 'xdg-open'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  const skillPath = path.join(root, 'a $(ignored); skill');
  await skillAt(skillPath);
  const launches: EditorLaunch[] = [];
  const service = serviceAt(root, 'editor-config', {
    environment: { PATH: bin, DISPLAY: ':0' },
    launchEditor: async (launch) => {
      launches.push(launch);
    },
  });
  const id = (await service.rescan()).skills[0]!.id;
  await service.getSkill(id);
  await service.getFile(id, 'SKILL.md');
  assert.equal(launches.length, 0);
  await service.setEditor('vscode');
  await service.openEditor(id, 'skill');
  assert.deepEqual(launches[0], {
    command: path.join(bin, 'code'),
    args: [skillPath],
  });
  await service.openEditor(id, 'file', 'SKILL.md');
  assert.deepEqual(launches[1]?.args, [path.join(skillPath, 'SKILL.md')]);
  await service.setEditor('system');
  await service.openEditor(id, 'skill');
  assert.deepEqual(launches[2], {
    command: path.join(bin, 'xdg-open'),
    args: [path.join(skillPath, 'SKILL.md')],
  });
  await assert.rejects(
    service.openEditor(id, 'file', '../outside.txt'),
    /relative/,
  );
  assert.equal(launches.length, 3);
});

test('HTTP workspace and rescan return progressive snapshots with the existing library available', async () => {
  const root = await directory('http-progressive');
  await skillAt(path.join(root, 'first'), 'first');
  const service = serviceAt(root, 'http-progressive-config');
  const server: Server = createServer(createApp(service));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const initial = (await (
      await fetch(`${base}/api/workspace`)
    ).json()) as WorkspaceSnapshot;
    assert.equal(initial.scanning, true);
    assert.equal(initial.lastScannedAt, null);
    assert.deepEqual(initial.skills, []);
    await service.rescan();
    await skillAt(path.join(root, 'second'), 'second');
    const started = (await (
      await fetch(`${base}/api/rescan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).json()) as WorkspaceSnapshot;
    assert.equal(started.scanning, true);
    assert.deepEqual(
      started.skills.map((skill) => skill.name),
      ['first'],
    );
    await service.rescan();
    const completed = (await (
      await fetch(`${base}/api/workspace`)
    ).json()) as WorkspaceSnapshot;
    assert.equal(completed.scanning, false);
    assert.deepEqual(completed.skills.map((skill) => skill.name).sort(), [
      'first',
      'second',
    ]);
  } finally {
    service.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('HTTP custom-root removal accepts an empty JSON object and immediately revokes its library entries', async () => {
  const root = await directory('http-root-mutations');
  const extra = await directory('http-root-mutations-extra');
  await skillAt(path.join(extra, 'extra'), 'custom-root-skill');
  const service = serviceAt(root, 'http-root-mutations-config');
  const server: Server = createServer(createApp(service));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const addedResponse = await fetch(`${base}/api/roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: extra }),
    });
    assert.equal(addedResponse.status, 200);
    const added = (await addedResponse.json()) as WorkspaceSnapshot;
    const custom = added.roots.find((candidate) => candidate.path === extra);
    assert.ok(custom && custom.removable);
    const completed = await service.rescan();
    assert.ok(
      completed.skills.some((skill) => skill.name === 'custom-root-skill'),
    );
    const removeUrl = `${base}/api/roots/${custom.id}`;
    const rejected = await fetch(removeUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(rejected.status, 415);
    assert.ok(
      (await service.getWorkspace()).roots.some(
        (candidate) => candidate.id === custom.id,
      ),
    );
    const removedResponse = await fetch(removeUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(removedResponse.status, 200);
    const removed = (await removedResponse.json()) as WorkspaceSnapshot;
    assert.ok(!removed.roots.some((candidate) => candidate.id === custom.id));
    assert.ok(!removed.skills.some((skill) => skill.rootId === custom.id));
    await service.rescan();
  } finally {
    service.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('HTTP API rejects foreign hosts, cross-site mutations, non-JSON writes, and malformed requests', async () => {
  const root = await directory('http');
  await skillAt(path.join(root, 'example'));
  const service = serviceAt(root, 'http-config');
  await service.rescan();
  const server: Server = createServer(createApp(service));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const statusWithHost = (host: string): Promise<number | undefined> =>
    new Promise((resolve, reject) => {
      const call = request(
        `${base}/api/workspace`,
        { headers: { Host: host } },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      call.once('error', reject);
      call.end();
    });
  try {
    const response = await fetch(`${base}/api/workspace`);
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as { skills: { id: string }[] };
    assert.equal(snapshot.skills.length, 1);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await statusWithHost('evil.example'), 403);
    assert.equal(await statusWithHost('localhost#evil.example'), 403);
    assert.equal(
      (
        await fetch(`${base}/api/rescan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/rescan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/rescan`, { method: 'POST', body: '{}' }))
        .status,
      415,
    );
    assert.equal(
      (
        await fetch(`${base}/api/rescan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: base },
          body: '{}',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/editor`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/skills/${snapshot.skills[0]!.id}/file?path=..%2Foutside.txt`,
        )
      ).status,
      400,
    );
    const editorResponse = await fetch(
      `${base}/api/skills/${snapshot.skills[0]!.id}/open`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'skill' }),
      },
    );
    assert.equal(editorResponse.status, 503);
    assert.match(
      ((await editorResponse.json()) as { error: string }).error,
      /unavailable/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
