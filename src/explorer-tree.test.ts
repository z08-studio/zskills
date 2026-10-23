import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillRecord, SourceRoot } from '../shared/types';
import { buildExplorerTree } from './explorer-tree';

const homeDir = '/home/bear';

function sourceRoot(path: string, id = path): SourceRoot {
  return {
    id,
    label: 'Scan folder',
    path,
    kind: 'personal',
    status: 'ready',
    skillCount: 0,
    removable: false,
  };
}

function skill(
  path: string,
  rootId: string,
  name = path.split('/').at(-1)!,
): SkillRecord {
  return {
    id: path,
    name,
    path,
    rootId,
    source: 'personal',
    description: '',
    modifiedAt: '2026-10-23T00:00:00.000Z',
  };
}

test('groups by scan root, uses home-relative names, sorts leaves, and omits empty roots', () => {
  const codex = sourceRoot(`${homeDir}/.codex/skills`);
  const agents = sourceRoot(`${homeDir}/.agents/skills`);
  const unused = sourceRoot(`${homeDir}/unused`);
  const records = [
    skill(`${codex.path}/zed`, codex.id),
    skill(`${agents.path}/pay`, agents.id),
    skill(`${codex.path}/alpha`, codex.id),
  ];
  const tree = buildExplorerTree(records, [codex, unused, agents], homeDir);

  assert.deepEqual(
    tree.map((folder) => folder.name),
    ['~/.agents/skills', '~/.codex/skills'],
  );
  assert.deepEqual(
    tree.map((folder) => folder.count),
    [1, 2],
  );
  assert.deepEqual(
    tree[1]!.skills.map((record) => record.name),
    ['alpha', 'zed'],
  );
  assert.equal(tree[1]!.path, codex.path);
  assert.deepEqual(
    records.map((record) => record.name),
    ['zed', 'pay', 'alpha'],
  );
});

test('keeps duplicate Skill names in their real version folders with separate identities', () => {
  const root = sourceRoot(`${homeDir}/.codex/plugins/cache`);
  const olderPath = `${root.path}/figma/11c74d6b/skills`;
  const newerPath = `${root.path}/figma/16.0.0/skills`;
  const older = skill(`${olderPath}/figma-design-to-code`, root.id);
  const newer = skill(`${newerPath}/figma-design-to-code`, root.id);
  const tree = buildExplorerTree([newer, older], [root], homeDir);
  const figma = tree[0]!.folders[0]!;

  assert.equal(tree[0]!.name, '~/.codex/plugins/cache');
  assert.equal(tree[0]!.isRoot, true);
  assert.equal(tree[0]!.count, 2);
  assert.equal(figma.name, 'figma');
  assert.equal(figma.count, 2);
  assert.deepEqual(
    figma.folders.map((folder) => folder.name),
    ['11c74d6b/skills', '16.0.0/skills'],
  );
  assert.deepEqual(
    figma.folders.map((folder) => folder.path),
    [olderPath, newerPath],
  );
  assert.deepEqual(
    figma.folders.map((folder) => folder.count),
    [1, 1],
  );
  assert.equal(figma.folders[0]!.skills[0], older);
  assert.equal(figma.folders[1]!.skills[0], newer);
  assert.notEqual(figma.folders[0]!.id, figma.folders[1]!.id);
});

test('compacts empty single-child chains while retaining the root and deepest folder path', () => {
  const root = sourceRoot('/cache');
  const parent = '/cache/figma/16.0.0/skills';
  const tree = buildExplorerTree(
    [skill(`${parent}/zed`, root.id), skill(`${parent}/alpha`, root.id)],
    [root],
    homeDir,
  );
  const compact = tree[0]!.folders[0]!;

  assert.equal(tree[0]!.name, '/cache');
  assert.equal(tree[0]!.folders.length, 1);
  assert.equal(compact.name, 'figma/16.0.0/skills');
  assert.equal(compact.path, parent);
  assert.equal(compact.id, `folder:${root.id}:${parent}`);
  assert.equal(compact.count, 2);
  assert.deepEqual(
    compact.skills.map((record) => record.name),
    ['alpha', 'zed'],
  );
  assert.deepEqual(compact.folders, []);
});

test('retains a matching Skill ancestry and stable deepest IDs when given a search subset', () => {
  const root = sourceRoot('/cache');
  const match = skill('/cache/figma/16.0.0/skills/figma-use', root.id);
  const other = skill('/cache/figma/17.0.0/skills/figma-use', root.id);
  const full = buildExplorerTree([match, other], [root], homeDir);
  const filtered = buildExplorerTree([match], [root], homeDir);
  const fullVersion = full[0]!.folders[0]!.folders.find((folder) =>
    folder.path.includes('/16.0.0/'),
  )!;
  const filteredVersion = filtered[0]!.folders[0]!;

  assert.equal(filtered[0]!.id, full[0]!.id);
  assert.equal(filtered[0]!.count, 1);
  assert.equal(filteredVersion.name, 'figma/16.0.0/skills');
  assert.equal(filteredVersion.id, fullVersion.id);
  assert.equal(filteredVersion.path, '/cache/figma/16.0.0/skills');
  assert.deepEqual(filteredVersion.skills, [match]);
});

test('does not compact a folder that also contains a Skill leaf', () => {
  const root = sourceRoot('/skills');
  const top = skill('/skills/package/top', root.id);
  const nested = skill('/skills/package/nested/version/child', root.id);
  const tree = buildExplorerTree([nested, top], [root], homeDir);
  const folder = tree[0]!.folders[0]!;

  assert.equal(folder.name, 'package');
  assert.equal(folder.count, 2);
  assert.deepEqual(folder.skills, [top]);
  assert.equal(folder.folders[0]!.name, 'nested/version');
  assert.equal(folder.folders[0]!.count, 1);
});

test('keeps canonical symlink targets and common-prefix siblings under their originating root', () => {
  const root = sourceRoot(`${homeDir}/.agents/skills`);
  const linked = skill('/packages/plugin/1.0/skills/imagegen', root.id);
  const prefixSibling = skill(`${root.path}-extra/group/pay`, root.id);
  const contained = skill(`${root.path}/local/group/reader`, root.id);
  const tree = buildExplorerTree(
    [linked, contained, prefixSibling],
    [root],
    homeDir,
  );

  assert.equal(tree[0]!.count, 3);
  assert.deepEqual(
    tree[0]!.skills.map((record) => record.id),
    [linked.id, prefixSibling.id],
  );
  assert.deepEqual(
    tree[0]!.folders.map((folder) => folder.name),
    ['local/group'],
  );
  assert.deepEqual(tree[0]!.folders[0]!.skills, [contained]);
});

test('builds a common-parent fallback when a scan root is missing from the snapshot', () => {
  const rootId = 'removed-root';
  const records = [
    skill(`${homeDir}/custom/one/reader`, rootId),
    skill(`${homeDir}/custom/two/writer`, rootId),
  ];
  const tree = buildExplorerTree(records, [], homeDir);

  assert.equal(tree[0]!.id, `root:${rootId}`);
  assert.equal(tree[0]!.name, '~/custom');
  assert.equal(tree[0]!.path, `${homeDir}/custom`);
  assert.equal(tree[0]!.count, 2);
  assert.deepEqual(
    tree[0]!.folders.map((folder) => folder.name),
    ['one', 'two'],
  );
});

test('uses path boundaries for home shortening and supports a filesystem-root scan', () => {
  const root = sourceRoot('/');
  const sibling = sourceRoot('/home/bear-other/skills');
  const tree = buildExplorerTree(
    [
      skill('/opt/package/reader', root.id),
      skill(`${sibling.path}/writer`, sibling.id),
    ],
    [root, sibling],
    homeDir,
  );

  assert.deepEqual(
    tree.map((folder) => folder.name),
    ['/', '/home/bear-other/skills'],
  );
  assert.equal(tree[0]!.folders[0]!.name, 'opt/package');
  assert.equal(tree[0]!.folders[0]!.path, '/opt/package');
  assert.equal(buildExplorerTree([], [root], homeDir).length, 0);
});
