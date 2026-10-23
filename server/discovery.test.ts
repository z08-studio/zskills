import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ServiceError, SkillsService } from './service.js';
import type { WorkspaceSnapshot } from '../shared/types.js';

async function fixtureFor(context: TestContext) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'zskills-discovery-')),
  );
  const home = path.join(directory, 'home');
  const config = path.join(directory, 'config');
  await mkdir(home);
  const services: SkillsService[] = [];
  context.after(async () => {
    for (const service of services) service.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    home,
    config,
    service(overrides: ConstructorParameters<typeof SkillsService>[0] = {}) {
      const service = new SkillsService({
        homeDir: home,
        configDir: config,
        platform: 'linux',
        environment: {},
        ...overrides,
      });
      services.push(service);
      return service;
    },
  };
}

function skillSource(name: string, description = 'A useful Skill.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# Source only\n`;
}

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), skillSource(name));
}

async function waitForWorkspace(
  service: SkillsService,
  predicate: (snapshot: WorkspaceSnapshot) => boolean,
): Promise<WorkspaceSnapshot> {
  const deadline = Date.now() + 5_000;
  let snapshot = await service.getWorkspace();
  while (!predicate(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    snapshot = await service.getWorkspace();
  }
  assert.ok(
    predicate(snapshot),
    `The workspace did not reach the expected state: ${JSON.stringify({ names: snapshot.skills.map((skill) => skill.name), scanning: snapshot.scanning, progress: snapshot.scanProgress })}`,
  );
  return snapshot;
}

test('default Home discovery covers hidden folders, dependency directories, caches, and deep paths without a cwd root', async (context) => {
  const fixture = await fixtureFor(context);
  const project = path.join(fixture.directory, 'launch-directory');
  await writeSkill(path.join(project, 'not-in-home'), 'cwd-only');
  const locations = [
    ['.agents', 'skills', 'quick'],
    ['Work', 'repository', '.claude', 'skills', 'hidden'],
    ['node_modules', 'package', 'skills', 'dependency'],
    ['Library', 'Caches', 'examples', '.nested', 'cached'],
    ['.git', 'extracted', 'teaching'],
    [
      'Archive',
      ...Array.from({ length: 24 }, (_, index) => `level-${index}`),
      'deep',
    ],
  ];
  for (const [index, segments] of locations.entries()) {
    await writeSkill(
      path.join(fixture.home, ...segments),
      `home-skill-${index}`,
    );
  }
  const service = fixture.service({ projectDir: project });
  const snapshot = await service.rescan();
  assert.equal(snapshot.skills.length, locations.length);
  assert.ok(
    snapshot.roots.some(
      (root) => root.kind === 'home' && root.path === fixture.home,
    ),
  );
  assert.ok(
    !snapshot.roots.some(
      (root) => root.kind === 'project' || root.path === project,
    ),
  );
  assert.ok(!snapshot.skills.some((skill) => skill.name === 'cwd-only'));
  assert.equal(
    new Set(snapshot.skills.map((skill) => skill.path)).size,
    locations.length,
  );
  assert.equal(snapshot.scanProgress.phase, 'complete');
  assert.equal(snapshot.scanning, false);
});

test('discovery excludes invalid Skill candidates and leaves source files and scripts untouched', async (context) => {
  const fixture = await fixtureFor(context);
  const valid = path.join(fixture.home, 'valid');
  await writeSkill(valid, 'valid-skill');
  const marker = path.join(fixture.directory, 'executed');
  const script = `#!/bin/sh\ntouch '${marker}'\n`;
  await writeFile(path.join(valid, 'run.sh'), script, { mode: 0o700 });
  const invalidSources = [
    '# Missing metadata\n',
    '---\nname: [broken\n---\n',
    '---\n- list\n- metadata\n---\n',
    '---\nname: duplicate\nname: repeated\ndescription: Invalid.\n---\n',
    '---\nname: "  "\ndescription: Invalid.\n---\n',
    '---\nname: empty-description\ndescription: "  "\n---\n',
    '---\nname: 123\ndescription: Invalid.\n---\n',
    '---\nname: wrong-description\ndescription: [invalid]\n---\n',
  ];
  for (const [index, source] of invalidSources.entries()) {
    const candidate = path.join(fixture.home, `invalid-${index}`);
    await mkdir(candidate);
    await writeFile(path.join(candidate, 'SKILL.md'), source);
  }
  const oversized = path.join(fixture.home, 'oversized');
  await mkdir(oversized);
  await writeFile(
    path.join(oversized, 'SKILL.md'),
    Buffer.alloc(2 * 1024 * 1024 + 1, 'a'),
  );
  await mkdir(path.join(fixture.home, 'not-a-file', 'SKILL.md'), {
    recursive: true,
  });
  const service = fixture.service();
  const snapshot = await service.rescan();
  assert.deepEqual(
    snapshot.skills.map((skill) => skill.name),
    ['valid-skill'],
  );
  assert.equal(snapshot.scanProgress.invalidSkills, invalidSources.length + 2);
  assert.equal(
    await readFile(path.join(valid, 'SKILL.md'), 'utf8'),
    skillSource('valid-skill'),
  );
  assert.equal(await readFile(path.join(valid, 'run.sh'), 'utf8'), script);
  for (const [index, source] of invalidSources.entries()) {
    assert.equal(
      await readFile(
        path.join(fixture.home, `invalid-${index}`, 'SKILL.md'),
        'utf8',
      ),
      source,
    );
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('unreadable metadata produces explicit partial coverage instead of an invalid or valid Skill', async (context) => {
  if (process.getuid?.() === 0) {
    context.skip('Root can read files despite their permission bits.');
    return;
  }
  const fixture = await fixtureFor(context);
  const unreadable = path.join(fixture.home, 'unreadable');
  await writeSkill(unreadable, 'unreadable');
  const metadata = path.join(unreadable, 'SKILL.md');
  await chmod(metadata, 0);
  try {
    const snapshot = await fixture.service().rescan();
    assert.deepEqual(snapshot.skills, []);
    assert.equal(snapshot.scanProgress.invalidSkills, 0);
    assert.equal(snapshot.scanProgress.unreadableDirectories, 1);
    assert.equal(
      snapshot.roots.find((root) => root.kind === 'home')?.status,
      'partial',
    );
    assert.ok(
      snapshot.scanProgress.issues.some((issue) => issue.path === metadata),
    );
  } finally {
    await chmod(metadata, 0o600);
  }
});

test('canonical discovery deduplicates overlapping roots and cycles while respecting external directory boundaries', async (context) => {
  const fixture = await fixtureFor(context);
  const local = path.join(fixture.home, 'nested', 'local');
  const installed = path.join(fixture.directory, 'external', 'installed');
  const unrelated = path.join(fixture.directory, 'external', 'unrelated');
  await writeSkill(local, 'local');
  await writeSkill(installed, 'installed');
  await writeSkill(
    path.join(unrelated, 'must-not-be-followed'),
    'external-nested',
  );
  await symlink(fixture.home, path.join(fixture.home, 'cycle'), 'dir');
  await symlink(installed, path.join(fixture.home, 'installed'), 'dir');
  await symlink(installed, path.join(fixture.home, 'duplicate'), 'dir');
  await symlink(
    unrelated,
    path.join(fixture.home, 'external-container'),
    'dir',
  );
  const service = fixture.service({
    roots: [
      { label: 'Home', path: fixture.home, kind: 'home' },
      { label: 'Overlapping', path: path.dirname(local), kind: 'custom' },
    ],
  });
  const snapshot = await service.rescan();
  assert.deepEqual(snapshot.skills.map((skill) => skill.name).sort(), [
    'installed',
    'local',
  ]);
  assert.equal(new Set(snapshot.skills.map((skill) => skill.id)).size, 2);
  assert.equal(
    snapshot.skills.find((skill) => skill.name === 'installed')?.path,
    installed,
  );
  assert.ok(snapshot.scanProgress.externalLinksSkipped >= 1);
});

test('scan startup returns a progressive snapshot and keeps the current library available during rescans', async (context) => {
  const fixture = await fixtureFor(context);
  const source = path.join(fixture.home, 'first');
  await writeSkill(source, 'first');
  const service = fixture.service();
  const initial = await service.startScan();
  assert.equal(initial.scanning, true);
  assert.equal(initial.lastScannedAt, null);
  assert.deepEqual(initial.skills, []);
  const first = await service.rescan();
  assert.deepEqual(
    first.skills.map((skill) => skill.name),
    ['first'],
  );
  await writeSkill(path.join(fixture.home, 'second'), 'second');
  const started = await service.startScan();
  assert.equal(started.scanning, true);
  assert.deepEqual(
    started.skills.map((skill) => skill.name),
    ['first'],
  );
  assert.equal(started.lastScannedAt, first.lastScannedAt);
  const [completed, coalesced] = await Promise.all([
    service.rescan(),
    service.rescan(),
  ]);
  assert.deepEqual(completed.skills.map((skill) => skill.name).sort(), [
    'first',
    'second',
  ]);
  assert.equal(
    completed.scanProgress.startedAt,
    coalesced.scanProgress.startedAt,
  );
  assert.equal(completed.lastScannedAt, coalesced.lastScannedAt);
  assert.equal(completed.scanning, false);
});

test('root mutations requested during discovery are reflected by the completed rescan barrier', async (context) => {
  const fixture = await fixtureFor(context);
  await writeSkill(path.join(fixture.home, 'local'), 'local');
  const extra = path.join(fixture.directory, 'outside-home');
  await writeSkill(path.join(extra, 'extra'), 'extra');
  const service = fixture.service();
  assert.equal((await service.startScan()).scanning, true);
  assert.equal((await service.addRoot(extra)).scanning, true);
  const added = await service.rescan();
  assert.deepEqual(added.skills.map((skill) => skill.name).sort(), [
    'extra',
    'local',
  ]);
  const custom = added.roots.find((root) => root.path === extra);
  assert.ok(custom && custom.removable);
  assert.equal((await service.startScan()).scanning, true);
  const removing = await service.removeRoot(custom.id);
  assert.equal(removing.scanning, true);
  assert.ok(!removing.skills.some((skill) => skill.name === 'extra'));
  const removed = await service.rescan();
  assert.deepEqual(
    removed.skills.map((skill) => skill.name),
    ['local'],
  );
  assert.ok(!removed.roots.some((root) => root.path === extra));
});

test('legacy custom Home roots retain one mandatory, nonremovable Home source', async (context) => {
  const fixture = await fixtureFor(context);
  await writeSkill(path.join(fixture.home, 'local'), 'local');
  const alias = path.join(fixture.directory, 'home-alias');
  await symlink(fixture.home, alias, 'dir');
  await mkdir(fixture.config);
  await writeFile(
    path.join(fixture.config, 'settings.json'),
    JSON.stringify({ editor: 'system', roots: [fixture.home, alias] }),
  );
  const service = fixture.service();
  const snapshot = await service.rescan();
  const homeRoots = snapshot.roots.filter((root) => root.kind === 'home');
  assert.equal(homeRoots.length, 1);
  assert.equal(homeRoots[0]?.path, fixture.home);
  assert.equal(homeRoots[0]?.removable, false);
  assert.ok(!snapshot.roots.some((root) => root.kind === 'custom'));
  await assert.rejects(service.removeRoot(homeRoots[0]!.id), /Only custom/);
  assert.deepEqual(
    snapshot.skills.map((skill) => skill.name),
    ['local'],
  );
});

test('versioned cache restores the library before revalidation and removes stale Skills after completion', async (context) => {
  const fixture = await fixtureFor(context);
  const keep = path.join(fixture.home, 'keep');
  const stale = path.join(fixture.home, 'stale');
  await writeSkill(keep, 'keep');
  await writeSkill(stale, 'stale');
  const original = fixture.service();
  await original.rescan();
  original.dispose();
  const cache = JSON.parse(
    await readFile(path.join(fixture.config, 'discovery-cache.json'), 'utf8'),
  ) as { version: number; entries: unknown[] };
  assert.equal(cache.version, 1);
  assert.equal(cache.entries.length, 2);
  await rm(stale, { recursive: true });
  await writeSkill(path.join(fixture.home, 'added'), 'added');
  const restarted = fixture.service();
  const restored = await restarted.getWorkspace();
  assert.equal(restored.scanning, true);
  assert.equal(restored.scanProgress.restoredFromCache, true);
  assert.ok(restored.skills.some((skill) => skill.name === 'keep'));
  const completed = await restarted.rescan();
  assert.deepEqual(completed.skills.map((skill) => skill.name).sort(), [
    'added',
    'keep',
  ]);
  assert.equal(completed.scanning, false);
});

test('a corrupt or incompatible cache falls back to discovery without failing workspace startup', async (context) => {
  const fixture = await fixtureFor(context);
  await writeSkill(path.join(fixture.home, 'valid'), 'valid');
  await mkdir(fixture.config);
  for (const contents of [
    '{broken json',
    JSON.stringify({ version: 999, entries: [] }),
  ]) {
    await writeFile(
      path.join(fixture.config, 'discovery-cache.json'),
      contents,
    );
    const service = fixture.service();
    const initial = await service.getWorkspace();
    assert.equal(initial.scanProgress.restoredFromCache, false);
    const completed = await service.rescan();
    assert.deepEqual(
      completed.skills.map((skill) => skill.name),
      ['valid'],
    );
    service.dispose();
  }
});

test('cache entries cannot authorize a forged source outside every configured root', async (context) => {
  const fixture = await fixtureFor(context);
  await writeSkill(path.join(fixture.home, 'valid'), 'valid');
  const original = fixture.service();
  await original.rescan();
  original.dispose();
  const cachePath = path.join(fixture.config, 'discovery-cache.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
    entries: {
      record: { id: string; path: string; name: string };
      sourcePath: string;
    }[];
  };
  const outside = path.join(fixture.directory, 'outside');
  await writeSkill(outside, 'outside');
  const forged = cache.entries[0]!;
  forged.sourcePath = outside;
  forged.record.path = outside;
  forged.record.id = createHash('sha256')
    .update(outside)
    .digest('hex')
    .slice(0, 24);
  forged.record.name = 'forged';
  await writeFile(cachePath, JSON.stringify(cache));
  const restarted = fixture.service();
  const initial = await restarted.getWorkspace();
  assert.equal(initial.scanProgress.restoredFromCache, false);
  assert.ok(!initial.skills.some((skill) => skill.path === outside));
  await assert.rejects(
    restarted.getFile(forged.record.id, 'SKILL.md'),
    /Skill not found/,
  );
  const completed = await restarted.rescan();
  assert.deepEqual(
    completed.skills.map((skill) => skill.name),
    ['valid'],
  );
});

test('an in-Home link to an external container cannot become previewable through forged cached metadata', async (context) => {
  const fixture = await fixtureFor(context);
  const outside = path.join(fixture.directory, 'external-container');
  await mkdir(outside);
  await writeFile(
    path.join(outside, 'secret.txt'),
    'External fixture content.',
  );
  const sourcePath = path.join(fixture.home, 'linked-container');
  await symlink(outside, sourcePath, 'dir');
  const idFor = (location: string) =>
    createHash('sha256').update(location).digest('hex').slice(0, 24);
  const forgedId = idFor(outside);
  await mkdir(fixture.config);
  await writeFile(
    path.join(fixture.config, 'discovery-cache.json'),
    JSON.stringify({
      version: 1,
      homeDir: fixture.home,
      completedAt: new Date(0).toISOString(),
      entries: [
        {
          sourcePath,
          signature: { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0, dev: 0 },
          record: {
            id: forgedId,
            name: 'forged-skill',
            description: 'Cached metadata cannot authorize a plain directory.',
            path: outside,
            rootId: idFor(fixture.home),
            source: 'home',
            modifiedAt: new Date(0).toISOString(),
          },
        },
      ],
    }),
  );
  const service = fixture.service();
  const initial = await service.getWorkspace();
  assert.equal(initial.scanProgress.restoredFromCache, true);
  assert.match(
    initial.skills.find((skill) => skill.id === forgedId)?.issue ?? '',
    /awaiting filesystem validation/,
  );
  const attempts = await Promise.allSettled([
    service.getSkill(forgedId),
    service.getFile(forgedId, 'secret.txt'),
  ]);
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected');
    if (attempt.status === 'rejected') {
      assert.ok(attempt.reason instanceof ServiceError);
      assert.ok([403, 404].includes(attempt.reason.status));
    }
  }
  const completed = await service.rescan();
  assert.deepEqual(completed.skills, []);
  assert.ok(completed.scanProgress.externalLinksSkipped >= 1);
});

test('watching known Skill directories refreshes metadata and recovers recreated candidates', async (context) => {
  const fixture = await fixtureFor(context);
  const directory = path.join(fixture.home, 'watched');
  await writeSkill(directory, 'before');
  const service = fixture.service();
  const initial = await service.rescan();
  assert.equal(initial.scanProgress.watching, true);
  await writeFile(
    path.join(directory, 'SKILL.md'),
    skillSource('after', 'Updated description.'),
  );
  const refreshed = await waitForWorkspace(
    service,
    (snapshot) => snapshot.skills[0]?.name === 'after',
  );
  assert.equal(refreshed.skills[0]?.description, 'Updated description.');
  await rm(path.join(directory, 'SKILL.md'));
  await waitForWorkspace(service, (snapshot) => snapshot.skills.length === 0);
  await writeSkill(directory, 'recreated');
  await waitForWorkspace(
    service,
    (snapshot) => snapshot.skills[0]?.name === 'recreated',
  );
});

test('watched metadata that becomes invalid is removed and restored when fixed without a full scan', async (context) => {
  const fixture = await fixtureFor(context);
  const directory = path.join(fixture.home, 'watched-invalid');
  await writeSkill(directory, 'valid');
  const service = fixture.service();
  await service.rescan();
  await writeFile(
    path.join(directory, 'SKILL.md'),
    '---\nname: valid\ndescription: " "\n---\n',
  );
  const refreshed = await waitForWorkspace(
    service,
    (snapshot) => snapshot.skills.length === 0,
  );
  assert.ok(
    refreshed.scanProgress.issues.some((issue) =>
      issue.message.includes('nonempty description'),
    ),
  );
  await writeSkill(directory, 'fixed');
  await waitForWorkspace(
    service,
    (snapshot) => snapshot.skills[0]?.name === 'fixed',
  );
});
