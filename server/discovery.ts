import { constants, type Dir } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { ScanProgress, SkillRecord, SourceRoot } from '../shared/types.js';

const MAX_METADATA_SIZE = 2 * 1024 * 1024;
export const MAX_SCAN_ISSUES = 50;

export interface FileSignature {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  dev: number;
}

export interface CachedSkill {
  record: SkillRecord;
  // The path through the configured root proves where an external linked Skill
  // came from. Cached metadata alone never grants preview access to a new path.
  sourcePath: string;
  signature: FileSignature;
}

export function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error';
}

export function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

export function addIssue(
  progress: ScanProgress,
  location: string,
  explanation: string,
): void {
  if (progress.issues.length < MAX_SCAN_ISSUES)
    progress.issues.push({ path: location, message: explanation });
}

function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return (
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

export async function readSkill(
  directory: string,
  sourcePath: string,
  root: SourceRoot,
  cached?: CachedSkill,
): Promise<CachedSkill> {
  const skillPath = await realpath(path.join(directory, 'SKILL.md'));
  if (!within(directory, skillPath))
    throw new Error('SKILL.md links outside its Skill directory.');
  // Bound reads even if a file grows after stat; special files and a newly
  // substituted symlink must not block discovery or escape the Skill boundary.
  const handle = await open(
    skillPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const information = await handle.stat();
    if (!information.isFile())
      throw new Error('SKILL.md is not a regular file.');
    if (information.size > MAX_METADATA_SIZE)
      throw new Error('SKILL.md exceeds the 2 MB metadata limit.');
    const signature: FileSignature = {
      mtimeMs: information.mtimeMs,
      ctimeMs: information.ctimeMs,
      size: information.size,
      ino: information.ino,
      dev: information.dev,
    };
    let name: string;
    let description: string;
    if (
      cached &&
      !cached.record.issue &&
      sameSignature(cached.signature, signature)
    ) {
      // Only metadata already validated in this process can skip parsing.
      // Persisted cache records carry an issue until their contents are checked.
      // Opening the file still verifies readability after permission changes.
      name = cached.record.name;
      description = cached.record.description;
    } else {
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= MAX_METADATA_SIZE) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, MAX_METADATA_SIZE + 1 - size),
        );
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks, size);
      if (bytes.length > MAX_METADATA_SIZE)
        throw new Error('SKILL.md exceeds the 2 MB metadata limit.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const match = content
        .replace(/^\uFEFF/, '')
        .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) throw new Error('No YAML frontmatter found.');
      const document = parseDocument(match[1]!, {
        schema: 'core',
        uniqueKeys: true,
      });
      if (document.errors.length)
        throw new Error('Skill metadata contains invalid YAML.');
      const metadata: unknown = document.toJS({ maxAliasCount: 20 });
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Skill metadata must be a mapping.');
      const fields = metadata as Record<string, unknown>;
      if (typeof fields.name !== 'string' || !fields.name.trim())
        throw new Error('Skill metadata requires a nonempty name.');
      if (typeof fields.description !== 'string' || !fields.description.trim())
        throw new Error('Skill metadata requires a nonempty description.');
      name = fields.name.trim();
      description = fields.description.trim();
    }
    return {
      sourcePath,
      signature,
      record: {
        id: stableId(directory),
        name,
        description,
        path: directory,
        rootId: root.id,
        source: root.kind,
        modifiedAt: information.mtime.toISOString(),
      },
    };
  } finally {
    await handle.close();
  }
}

interface Frame {
  directory: string;
  sourcePath: string;
  boundary: string;
  handle: Dir;
}

export interface DiscoveryOptions {
  roots: SourceRoot[];
  cached: Map<string, CachedSkill>;
  progress: ScanProgress;
  cancelled: () => boolean;
  publish: (found: Map<string, CachedSkill>, force?: boolean) => void;
}

export async function discover(
  options: DiscoveryOptions,
): Promise<Map<string, CachedSkill>> {
  const { roots, cached, progress, cancelled, publish } = options;
  const found = new Map<string, CachedSkill>();
  const visited = new Set<string>();
  const checked = new Set<string>();
  const unreadable = new Set<string>();
  let workSinceYield = 0;
  let lastYield = Date.now();
  const yieldIfNeeded = async (): Promise<void> => {
    if (++workSinceYield < 128 && Date.now() - lastYield < 20) return;
    publish(found);
    await setImmediate();
    workSinceYield = 0;
    lastYield = Date.now();
  };
  for (const root of roots) {
    if (cancelled()) break;
    progress.phase = root.kind === 'home' ? 'home' : 'quick';
    root.status = 'scanning';
    publish(found, true);
    const stack: Frame[] = [];
    const failedDirectory = (location: string, error: unknown): void => {
      if (!unreadable.has(location)) {
        unreadable.add(location);
        progress.unreadableDirectories += 1;
      }
      root.error =
        'Some directories could not be read. See scan issues for details.';
      addIssue(progress, location, errorMessage(error));
    };
    const invalidCandidate = (location: string, error: unknown): void => {
      if (typeof (error as NodeJS.ErrnoException).syscall === 'string')
        failedDirectory(location, error);
      else {
        progress.invalidSkills += 1;
        addIssue(progress, location, errorMessage(error));
      }
    };
    const enter = async (
      directory: string,
      sourcePath: string,
      boundary: string,
    ): Promise<void> => {
      if (visited.has(directory) || cancelled()) return;
      try {
        const handle = await opendir(directory);
        visited.add(directory);
        progress.directoriesScanned += 1;
        progress.currentPath = directory;
        stack.push({ directory, sourcePath, boundary, handle });
      } catch (error) {
        failedDirectory(sourcePath, error);
      }
    };
    try {
      const canonicalRoot = await realpath(root.path);
      if (!(await stat(canonicalRoot)).isDirectory())
        throw new Error('The scan root is not a directory.');
      await enter(canonicalRoot, root.path, canonicalRoot);
      // Open directory iterators form an explicit DFS stack. Traversal has no
      // depth/count cutoff or directory-name exclusions, and does not accumulate
      // every descendant path in a breadth-first frontier.
      while (stack.length && !cancelled()) {
        await yieldIfNeeded();
        const frame = stack[stack.length - 1]!;
        progress.currentPath = frame.directory;
        let entry;
        try {
          entry = await frame.handle.read();
        } catch (error) {
          failedDirectory(frame.sourcePath, error);
          entry = null;
        }
        if (!entry) {
          stack.pop();
          await frame.handle.close().catch(() => undefined);
          continue;
        }
        const candidate = path.join(frame.directory, entry.name);
        const sourcePath = path.join(frame.sourcePath, entry.name);
        if (entry.name === 'SKILL.md' && !checked.has(frame.directory)) {
          checked.add(frame.directory);
          progress.candidatesChecked += 1;
          try {
            if (!found.has(frame.directory)) {
              found.set(
                frame.directory,
                await readSkill(
                  frame.directory,
                  frame.sourcePath,
                  root,
                  cached.get(frame.directory),
                ),
              );
              root.skillCount += 1;
            }
          } catch (error) {
            invalidCandidate(sourcePath, error);
          }
        }
        if (entry.isDirectory()) {
          await enter(candidate, sourcePath, frame.boundary);
        } else if (entry.isSymbolicLink() && entry.name !== 'SKILL.md') {
          try {
            const canonical = await realpath(candidate);
            if (
              !(await stat(canonical)).isDirectory() ||
              visited.has(canonical)
            )
              continue;
            if (!within(frame.boundary, canonical)) {
              // An exact linked Skill is safe to discover under its own preview
              // boundary. A link to an arbitrary external tree is never followed.
              try {
                // A missing SKILL.md means this is an external container, not a
                // malformed candidate. Existing candidates are counted once.
                await stat(path.join(canonical, 'SKILL.md'));
                if (checked.has(canonical) && !found.has(canonical)) {
                  progress.externalLinksSkipped += 1;
                  addIssue(
                    progress,
                    sourcePath,
                    'External directory link skipped: its Skill metadata is invalid or unreadable.',
                  );
                  continue;
                }
                if (!checked.has(canonical)) {
                  checked.add(canonical);
                  progress.candidatesChecked += 1;
                }
                const linked = await readSkill(
                  canonical,
                  sourcePath,
                  root,
                  cached.get(canonical),
                );
                if (!found.has(canonical)) {
                  found.set(canonical, linked);
                  root.skillCount += 1;
                }
              } catch (error) {
                if (checked.has(canonical))
                  invalidCandidate(path.join(sourcePath, 'SKILL.md'), error);
                else if (!missing(error)) failedDirectory(sourcePath, error);
                progress.externalLinksSkipped += 1;
                addIssue(
                  progress,
                  sourcePath,
                  `External directory link skipped: ${errorMessage(error)}`,
                );
                continue;
              }
              await enter(canonical, sourcePath, canonical);
            } else {
              await enter(canonical, sourcePath, frame.boundary);
            }
          } catch (error) {
            failedDirectory(sourcePath, error);
          }
        }
      }
      root.status = root.error ? 'partial' : 'ready';
    } catch (error) {
      root.status = missing(error) ? 'missing' : 'error';
      if (!missing(error)) {
        root.error = errorMessage(error);
        failedDirectory(root.path, error);
      }
    } finally {
      await Promise.all(
        stack.map((frame) => frame.handle.close().catch(() => undefined)),
      );
    }
    publish(found, true);
  }
  return found;
}
