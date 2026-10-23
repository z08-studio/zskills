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

let fixture: string;
before(async () => {
  fixture = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'zskills-tests-')),
  );
});
after(async () => {
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
  return new SkillsService({
    homeDir: fixture,
    projectDir: root,
    configDir: path.join(fixture, configName),
    roots: [{ label: 'Test root', path: root, kind: 'personal' }],
    platform: 'linux',
    environment: {},
    ...overrides,
  });
}

test('discovers real Skills, safely parses YAML, deduplicates canonical directories, and never executes scripts', async () => {
  const root = await directory('discovery');
  const installed = await directory('installed');
  await skillAt(path.join(root, 'first'), 'same-name');
  await skillAt(path.join(root, 'second'), 'same-name');
  await skillAt(path.join(installed, 'linked'), 'linked-skill');
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await skillAt(path.join(root, 'node_modules', 'ignored'));
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
  const snapshot = await service.getWorkspace();
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
  assert.match(
    snapshot.skills.find((skill) => skill.name === 'invalid-yaml')?.issue ?? '',
    /invalid YAML/,
  );
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
  const id = (await service.getWorkspace()).skills[0]!.id;
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
  const snapshot = await service.addRoot(extra);
  assert.equal(snapshot.skills.length, 1);
  const custom = snapshot.roots.find(
    (candidate) => candidate.kind === 'custom',
  )!;
  assert.equal(custom.removable, true);
  await service.setEditor('zed');
  const fresh = serviceAt(root, 'settings-config');
  assert.equal((await fresh.getWorkspace()).skills.length, 1);
  assert.equal((await fresh.getEditor()).editor, 'zed');
  assert.equal((await fresh.getEditor()).available, false);
  assert.equal((await fresh.removeRoot(custom.id)).skills.length, 0);
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
  const id = (await service.getWorkspace()).skills[0]!.id;
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

test('HTTP API rejects foreign hosts, cross-site mutations, non-JSON writes, and malformed requests', async () => {
  const root = await directory('http');
  await skillAt(path.join(root, 'example'));
  const service = serviceAt(root, 'http-config');
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
