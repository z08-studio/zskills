import type { SkillRecord, SourceRoot } from '../shared/types';

export interface ExplorerFolder {
  id: string;
  name: string;
  path: string;
  count: number;
  folders: ExplorerFolder[];
  skills: SkillRecord[];
  isRoot: boolean;
}

function normalizePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function containsPath(parent: string, child: string): boolean {
  return (
    child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`)
  );
}

function parentPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index <= 0 ? '/' : value.slice(0, index);
}

function displayPath(value: string, homeDir: string): string {
  if (!containsPath(homeDir, value)) return value;
  if (value === homeDir) return '~';
  return `~/${value.slice(homeDir === '/' ? 1 : homeDir.length + 1)}`;
}

function fallbackRootPath(skills: SkillRecord[]): string {
  let common = parentPath(normalizePath(skills[0]!.path));
  for (const skill of skills) {
    const parent = parentPath(normalizePath(skill.path));
    while (!containsPath(common, parent)) common = parentPath(common);
  }
  return common;
}

function finishFolder(folder: ExplorerFolder): ExplorerFolder {
  folder.folders = folder.folders.map(finishFolder);
  folder.folders.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  folder.skills.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  folder.count =
    folder.skills.length +
    folder.folders.reduce((count, child) => count + child.count, 0);

  if (
    !folder.isRoot &&
    folder.skills.length === 0 &&
    folder.folders.length === 1
  ) {
    const child = folder.folders[0]!;
    return { ...child, name: `${folder.name}/${child.name}` };
  }
  return folder;
}

/** Build the folder view from discovered records without reading their sources. */
export function buildExplorerTree(
  skills: SkillRecord[],
  roots: SourceRoot[],
  homeDir: string,
): ExplorerFolder[] {
  const rootsById = new Map(roots.map((root) => [root.id, root]));
  const skillsByRoot = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    const group = skillsByRoot.get(skill.rootId) ?? [];
    group.push(skill);
    skillsByRoot.set(skill.rootId, group);
  }

  const tree: ExplorerFolder[] = [];
  const homePath = normalizePath(homeDir);
  for (const [rootId, records] of skillsByRoot) {
    const sourceRoot = rootsById.get(rootId);
    const rootPath = sourceRoot
      ? normalizePath(sourceRoot.path)
      : fallbackRootPath(records);
    const root: ExplorerFolder = {
      id: `root:${rootId}`,
      name: displayPath(rootPath, homePath),
      path: rootPath,
      count: 0,
      folders: [],
      skills: [],
      isRoot: true,
    };
    const foldersByPath = new Map<string, ExplorerFolder>([[rootPath, root]]);

    for (const skill of records) {
      const skillPath = normalizePath(skill.path);
      let parent = root;
      // Canonical symlink targets can lie outside their configured scan root.
      // The records cannot recover the original link path, so keep these at root.
      if (containsPath(rootPath, skillPath) && skillPath !== rootPath) {
        const relative = skillPath.slice(
          rootPath === '/' ? 1 : rootPath.length + 1,
        );
        const segments = relative.split('/').slice(0, -1);
        let directory = rootPath === '/' ? '' : rootPath;
        for (const name of segments) {
          directory += `/${name}`;
          let folder = foldersByPath.get(directory);
          if (!folder) {
            folder = {
              id: `folder:${rootId}:${directory}`,
              name,
              path: directory,
              count: 0,
              folders: [],
              skills: [],
              isRoot: false,
            };
            foldersByPath.set(directory, folder);
            parent.folders.push(folder);
          }
          parent = folder;
        }
      }
      parent.skills.push(skill);
    }
    tree.push(finishFolder(root));
  }

  return tree.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
}
