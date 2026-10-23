import { constants, watch, type FSWatcher } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  addIssue,
  MAX_SCAN_ISSUES,
  discover,
  errorMessage as message,
  missing as isMissing,
  readSkill,
  stableId,
  within,
  type CachedSkill,
} from './discovery.js';
import type {
  EditorChoice,
  EditorSettings,
  FileContent,
  FileEntry,
  SkillDetail,
  SkillRecord,
  ScanProgress,
  SourceKind,
  SourceRoot,
  WorkspaceSnapshot,
} from '../shared/types.js';

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.Trash',
  'target',
  '.tox',
  'coverage',
]);
const CACHED_RECORD_ISSUE = 'Cached metadata; awaiting filesystem validation.';
const MAX_SCAN_DEPTH = 16;
const MAX_SKILL_FILES = 5_000;
const MAX_TEXT_SIZE = 2 * 1024 * 1024;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

interface RootDefinition {
  label: string;
  path: string;
  kind: SourceKind;
}
interface SavedConfig {
  editor: EditorChoice;
  roots: string[];
}
export interface EditorLaunch {
  command: string;
  args: string[];
}
export interface ServiceOptions {
  homeDir?: string;
  /** @deprecated Kept for callers upgrading from cwd-based discovery; ignored. */
  projectDir?: string;
  configDir?: string;
  platform?: string;
  hostname?: string;
  environment?: NodeJS.ProcessEnv;
  roots?: RootDefinition[];
  launchEditor?: (launch: EditorLaunch) => Promise<void>;
}

async function launchProcess(launch: EditorLaunch): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      launch.command,
      launch.args,
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error) => {
        if (error)
          reject(
            new ServiceError(
              503,
              'The editor could not be opened. Check that it is installed and available on this host.',
            ),
          );
        else resolve();
      },
    );
  });
}

export class SkillsService {
  private readonly homeDir: string;
  private readonly configDir: string;
  private readonly platform: string;
  private readonly hostname: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly defaultRoots: RootDefinition[];
  private readonly launchEditor: (launch: EditorLaunch) => Promise<void>;
  private config: SavedConfig = { editor: 'system', roots: [] };
  private snapshot: WorkspaceSnapshot | null = null;
  private scanning: Promise<WorkspaceSnapshot> | null = null;
  private initialized: Promise<void> | null = null;
  private configWrites: Promise<void> = Promise.resolve();
  private cacheWrites: Promise<void> = Promise.resolve();
  private entries = new Map<string, CachedSkill>();
  private visibleEntries = new Map<string, CachedSkill>();
  private readonly watchAnchors = new Map<string, CachedSkill>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchFailures = new Set<string>();
  private readonly pendingRefreshes = new Set<string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private hasStarted = false;
  private scanRevision = 0;

  constructor(options: ServiceOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.configDir = path.resolve(
      options.configDir ??
        process.env.ZSKILLS_CONFIG_DIR ??
        path.join(this.homeDir, '.config/zskills'),
    );
    this.platform = options.platform ?? process.platform;
    this.hostname = options.hostname ?? os.hostname();
    this.environment = options.environment ?? process.env;
    this.launchEditor = options.launchEditor ?? launchProcess;
    this.defaultRoots = options.roots ?? [
      {
        label: 'Codex skills',
        path: path.join(this.homeDir, '.codex/skills'),
        kind: 'personal',
      },
      {
        label: 'Agent skills',
        path: path.join(this.homeDir, '.agents/skills'),
        kind: 'personal',
      },
      {
        label: 'Claude skills',
        path: path.join(this.homeDir, '.claude/skills'),
        kind: 'personal',
      },
      {
        label: 'Gemini skills',
        path: path.join(this.homeDir, '.gemini/skills'),
        kind: 'personal',
      },
      {
        label: 'Plugin packages',
        path: path.join(this.homeDir, '.codex/plugins/cache'),
        kind: 'cache',
      },
      { label: 'Home directory', path: this.homeDir, kind: 'home' },
    ];
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        try {
          const data = JSON.parse(
            await readFile(path.join(this.configDir, 'settings.json'), 'utf8'),
          ) as Partial<SavedConfig>;
          if (['system', 'vscode', 'zed'].includes(data.editor ?? ''))
            this.config.editor = data.editor!;
          if (Array.isArray(data.roots))
            this.config.roots = [
              ...new Set(
                data.roots.filter(
                  (root): root is string =>
                    typeof root === 'string' && path.isAbsolute(root),
                ),
              ),
            ].slice(0, 64);
        } catch (error) {
          if (!isMissing(error))
            console.warn(
              'ZSkills settings could not be loaded; using defaults.',
            );
        }
        const canonicalHome = await realpath(this.homeDir).catch(
          () => this.homeDir,
        );
        this.config.roots = (
          await Promise.all(
            this.config.roots.map(async (root) =>
              (await realpath(root).catch(() => root)) === canonicalHome
                ? null
                : root,
            ),
          )
        ).filter((root): root is string => root !== null);
        await this.loadCache();
      })();
    }
    await this.initialized;
  }

  private async saveConfig(): Promise<void> {
    const serialized = `${JSON.stringify(this.config, null, 2)}\n`;
    const write = this.configWrites
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.configDir, { recursive: true, mode: 0o700 });
        const temporary = path.join(
          this.configDir,
          `settings.${randomUUID()}.tmp`,
        );
        await writeFile(temporary, serialized, { mode: 0o600 });
        await rename(temporary, path.join(this.configDir, 'settings.json'));
      });
    this.configWrites = write;
    await write;
  }

  private rootDefinitions(): RootDefinition[] {
    // Explicit tool/custom roots retain ownership when Home reaches the same
    // canonical directory later. The service working directory is not a source.
    const roots = [
      ...this.defaultRoots.filter((root) => root.kind !== 'home'),
      ...this.config.roots
        .filter(
          (root) =>
            !this.defaultRoots.some(
              (definition) =>
                definition.kind === 'home' &&
                path.resolve(definition.path) === path.resolve(root),
            ),
        )
        .map((root): RootDefinition => ({
          label: path.basename(root) || root,
          path: root,
          kind: 'custom',
        })),
      ...this.defaultRoots.filter((root) => root.kind === 'home'),
    ];
    return roots.filter(
      (root, index) =>
        roots.findIndex(
          (other) => path.resolve(other.path) === path.resolve(root.path),
        ) === index,
    );
  }

  private sourceRoots(): SourceRoot[] {
    return this.rootDefinitions().map((definition) => ({
      ...definition,
      path: path.resolve(definition.path),
      id: stableId(path.resolve(definition.path)),
      status: 'scanning',
      skillCount: 0,
      removable: definition.kind === 'custom',
    }));
  }

  private progress(): ScanProgress {
    return {
      phase: 'quick',
      startedAt: new Date().toISOString(),
      completedAt: null,
      directoriesScanned: 0,
      candidatesChecked: 0,
      invalidSkills: 0,
      unreadableDirectories: 0,
      externalLinksSkipped: 0,
      currentPath: null,
      restoredFromCache: false,
      watching: false,
      issues: [],
    };
  }

  private async loadCache(): Promise<void> {
    const roots = this.sourceRoots();
    let lastScannedAt: string | null = null;
    try {
      const data: unknown = JSON.parse(
        await readFile(
          path.join(this.configDir, 'discovery-cache.json'),
          'utf8',
        ),
      );
      if (!data || typeof data !== 'object') throw new Error('Invalid cache.');
      const cache = data as Record<string, unknown>;
      if (
        cache.version !== 1 ||
        cache.homeDir !== this.homeDir ||
        !Array.isArray(cache.entries)
      )
        throw new Error('Incompatible cache.');
      const restored = new Map<string, CachedSkill>();
      for (const value of cache.entries) {
        if (!value || typeof value !== 'object')
          throw new Error('Invalid cached Skill.');
        const entry = value as CachedSkill;
        const record = entry.record;
        const root = roots.find((candidate) => candidate.id === record?.rootId);
        if (
          !root ||
          !record ||
          !entry.signature ||
          typeof record.path !== 'string' ||
          record.path.includes('\0') ||
          !path.isAbsolute(record.path) ||
          path.resolve(record.path) !== record.path ||
          typeof entry.sourcePath !== 'string' ||
          entry.sourcePath.includes('\0') ||
          path.resolve(entry.sourcePath) !== entry.sourcePath ||
          !path.isAbsolute(entry.sourcePath) ||
          !within(root.path, entry.sourcePath) ||
          record.id !== stableId(record.path) ||
          record.source !== root.kind ||
          typeof record.name !== 'string' ||
          !record.name.trim() ||
          typeof record.description !== 'string' ||
          !record.description.trim() ||
          typeof record.modifiedAt !== 'string' ||
          !Number.isFinite(Date.parse(record.modifiedAt)) ||
          !['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'].every(
            (key) =>
              typeof entry.signature[key as keyof typeof entry.signature] ===
                'number' &&
              Number.isFinite(
                entry.signature[key as keyof typeof entry.signature],
              ),
          )
        )
          throw new Error('Invalid cached Skill.');
        restored.set(record.path, {
          sourcePath: entry.sourcePath,
          signature: entry.signature,
          record: {
            ...record,
            issue: CACHED_RECORD_ISSUE,
          },
        });
      }
      this.entries = restored;
      if (
        typeof cache.completedAt === 'string' &&
        Number.isFinite(Date.parse(cache.completedAt))
      )
        lastScannedAt = cache.completedAt;
    } catch {
      // Cache contents are advisory. Corruption or a different Home/root setup
      // never prevents a fresh discovery pass or exposes arbitrary cached paths.
      this.entries.clear();
    }
    const editor: EditorSettings = {
      editor: this.config.editor,
      available: Boolean(await this.editorCommand(this.config.editor)),
    };
    const progress = this.progress();
    progress.restoredFromCache = this.entries.size > 0;
    this.snapshot = {
      host: {
        hostname: this.hostname,
        platform: this.platform,
        homeDir: this.homeDir,
        editorAvailable: editor.available,
      },
      skills: [],
      roots,
      lastScannedAt,
      scanning: false,
      scanProgress: progress,
      editor,
    };
    this.publishEntries(this.entries, roots);
  }

  private publishEntries(
    entries: Map<string, CachedSkill>,
    roots = this.snapshot!.roots,
  ): void {
    if (this.disposed || !this.snapshot) return;
    this.visibleEntries = entries;
    const skills = [...entries.values()]
      .map((entry) => ({ ...entry.record }))
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
      );
    const counts = new Map<string, number>();
    for (const skill of skills)
      counts.set(skill.rootId, (counts.get(skill.rootId) ?? 0) + 1);
    this.snapshot = {
      ...this.snapshot,
      skills,
      roots: roots.map((root) => ({
        ...root,
        skillCount: counts.get(root.id) ?? 0,
      })),
      scanProgress: {
        ...this.snapshot.scanProgress,
        issues: [...this.snapshot.scanProgress.issues],
      },
    };
  }

  async getWorkspace(): Promise<WorkspaceSnapshot> {
    await this.initialize();
    if (this.disposed) throw new ServiceError(503, 'The service has stopped.');
    if (!this.hasStarted) this.beginScan();
    return this.snapshot!;
  }

  async startScan(): Promise<WorkspaceSnapshot> {
    await this.initialize();
    this.beginScan();
    return this.snapshot!;
  }

  async rescan(): Promise<WorkspaceSnapshot> {
    await this.initialize();
    return this.beginScan();
  }

  private beginScan(): Promise<WorkspaceSnapshot> {
    if (this.disposed) throw new ServiceError(503, 'The service has stopped.');
    if (this.scanning) return this.scanning;
    this.hasStarted = true;
    this.watchFailures.clear();
    const progress = this.progress();
    progress.restoredFromCache = this.snapshot!.scanProgress.restoredFromCache;
    progress.watching = this.watchers.size > 0 && !this.watchFailures.size;
    this.snapshot = {
      ...this.snapshot!,
      scanning: true,
      scanProgress: progress,
    };
    const scanning = this.scanRevisions(progress);
    this.scanning = scanning;
    // A request for the initial snapshot must never wait for an entire Home.
    void scanning.catch(() => undefined);
    return scanning;
  }

  private async scanRevisions(
    progress: ScanProgress,
  ): Promise<WorkspaceSnapshot> {
    try {
      while (!this.disposed) {
        const revision = this.scanRevision;
        await this.scan(progress, revision);
        if (revision === this.scanRevision) break;
        progress = this.progress();
        progress.restoredFromCache =
          this.snapshot!.scanProgress.restoredFromCache;
        this.snapshot = {
          ...this.snapshot!,
          scanning: true,
          scanProgress: progress,
        };
      }
      return this.snapshot!;
    } finally {
      // Clear the shared barrier in the same turn that decides no revision is
      // pending. A later mutation can then start work without losing a wakeup.
      this.scanning = null;
      if (!this.disposed && this.pendingRefreshes.size) this.scheduleRefresh();
    }
  }

  private async scan(
    progress: ScanProgress,
    revision: number,
  ): Promise<WorkspaceSnapshot> {
    await setImmediate();
    const roots = this.sourceRoots();
    const cached = this.entries;
    let lastPublished = 0;
    const publish = (found: Map<string, CachedSkill>, force = false): void => {
      if (
        this.disposed ||
        revision !== this.scanRevision ||
        (!force && Date.now() - lastPublished < 150)
      )
        return;
      lastPublished = Date.now();
      // Keep the previous library available until every readable folder has
      // been visited. Only a completed pass removes unobserved/stale records.
      this.snapshot = { ...this.snapshot!, scanProgress: progress };
      this.publishEntries(new Map([...cached, ...found]), roots);
    };
    try {
      const found = await discover({
        roots,
        cached,
        progress,
        cancelled: () => this.disposed || revision !== this.scanRevision,
        publish,
      });
      if (this.disposed) return this.snapshot!;
      if (revision === this.scanRevision) await this.reconcileWatchAnchors();
      if (this.disposed) return this.snapshot!;
      if (revision !== this.scanRevision) {
        // A source mutation cancels traversal before its replacement begins.
        // Keep progressive results only while their root is still authorized.
        const allowed = new Set(this.sourceRoots().map((root) => root.id));
        this.entries = new Map(
          [...cached, ...found].filter(([, entry]) =>
            allowed.has(entry.record.rootId),
          ),
        );
        this.publishEntries(this.entries);
        return this.snapshot!;
      }
      this.entries = found;
      this.syncWatchers(progress);
      progress.phase = 'complete';
      progress.completedAt = new Date().toISOString();
      progress.currentPath = null;
      progress.restoredFromCache = false;
      this.snapshot = {
        ...this.snapshot!,
        scanning: false,
        lastScannedAt: progress.completedAt,
        scanProgress: progress,
      };
      this.publishEntries(found, roots);
      await this.saveCache();
    } catch (error) {
      if (!this.disposed && revision === this.scanRevision) {
        if (progress.issues.length >= MAX_SCAN_ISSUES) progress.issues.pop();
        addIssue(progress, this.homeDir, `Discovery failed: ${message(error)}`);
        progress.phase = 'failed';
        progress.currentPath = null;
        this.snapshot = {
          ...this.snapshot!,
          scanning: false,
          scanProgress: progress,
        };
      }
    }
    return this.snapshot!;
  }

  private async saveCache(): Promise<void> {
    if (this.disposed) return;
    const serialized = `${JSON.stringify({ version: 1, homeDir: this.homeDir, completedAt: this.snapshot!.lastScannedAt, entries: [...this.entries.values()] })}\n`;
    const write = this.cacheWrites
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) return;
        await mkdir(this.configDir, { recursive: true, mode: 0o700 });
        if (this.disposed) return;
        const temporary = path.join(
          this.configDir,
          `discovery-cache.${randomUUID()}.tmp`,
        );
        await writeFile(temporary, serialized, { mode: 0o600 });
        await rename(
          temporary,
          path.join(this.configDir, 'discovery-cache.json'),
        );
      });
    this.cacheWrites = write;
    try {
      await write;
    } catch (error) {
      if (!this.disposed && this.snapshot) {
        const progress = {
          ...this.snapshot.scanProgress,
          issues: [...this.snapshot.scanProgress.issues],
        };
        addIssue(
          progress,
          this.configDir,
          `Discovery cache could not be saved: ${message(error)}`,
        );
        this.snapshot = { ...this.snapshot, scanProgress: progress };
      }
    }
  }

  private dropWatch(directory: string): void {
    this.watchers.get(directory)?.close();
    this.watchers.delete(directory);
    this.watchFailures.delete(directory);
    this.watchAnchors.delete(directory);
  }

  private async reconcileWatchAnchors(): Promise<void> {
    const allowed = new Set(this.sourceRoots().map((root) => root.id));
    for (const [directory, anchor] of this.watchAnchors) {
      if (!allowed.has(anchor.record.rootId)) {
        this.dropWatch(directory);
        continue;
      }
      try {
        if (
          (await realpath(anchor.sourcePath)) !== directory ||
          !(await stat(directory)).isDirectory()
        )
          this.dropWatch(directory);
      } catch (error) {
        // A metadata read failure does not revoke a known directory's watch.
        // Directory deletion or retargeting does: its old boundary is gone.
        if (isMissing(error)) this.dropWatch(directory);
      }
    }
  }

  private syncWatchers(progress: ScanProgress): void {
    for (const [directory, entry] of this.entries)
      this.watchAnchors.set(directory, entry);
    for (const directory of this.watchAnchors.keys()) {
      if (this.watchers.has(directory) || this.watchFailures.has(directory))
        continue;
      try {
        const watcher = watch(
          directory,
          { persistent: false },
          (_event, filename) => {
            if (
              filename !== null &&
              filename.toString() !== 'SKILL.md' &&
              filename.toString() !== path.basename(directory)
            )
              return;
            this.pendingRefreshes.add(directory);
            this.scheduleRefresh();
          },
        );
        watcher.on('error', (error) => {
          watcher.close();
          this.watchers.delete(directory);
          this.watchFailures.add(directory);
          if (this.disposed || !this.snapshot) return;
          const current = {
            ...this.snapshot.scanProgress,
            issues: [...this.snapshot.scanProgress.issues],
            watching: false,
          };
          addIssue(
            current,
            directory,
            `Live metadata updates unavailable: ${message(error)}`,
          );
          this.snapshot = { ...this.snapshot, scanProgress: current };
        });
        this.watchers.set(directory, watcher);
        // Reconcile once after watch installation: metadata may have changed
        // between its discovery read and the native watcher becoming active.
        this.pendingRefreshes.add(directory);
      } catch (error) {
        this.watchFailures.add(directory);
        addIssue(
          progress,
          directory,
          `Live metadata updates unavailable: ${message(error)}`,
        );
      }
    }
    progress.watching =
      this.watchAnchors.size > 0 &&
      this.watchers.size === this.watchAnchors.size &&
      !this.watchFailures.size;
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.scanning) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshMetadata();
    }, 180);
    this.refreshTimer.unref();
  }

  private async refreshMetadata(): Promise<void> {
    if (this.disposed || this.scanning || !this.snapshot) return;
    const directories = [...this.pendingRefreshes];
    this.pendingRefreshes.clear();
    for (const directory of directories) {
      const current =
        this.entries.get(directory) ?? this.watchAnchors.get(directory);
      if (!current || this.disposed) continue;
      const root = this.snapshot.roots.find(
        (candidate) => candidate.id === current.record.rootId,
      );
      if (!root) {
        this.dropWatch(directory);
        continue;
      }
      let sameDirectory = false;
      let changedLocation = false;
      try {
        if (
          (await realpath(current.sourcePath)) !== directory ||
          !(await stat(directory)).isDirectory()
        ) {
          changedLocation = true;
          throw new Error('The Skill location changed.');
        }
        sameDirectory = true;
        const updated = await readSkill(
          directory,
          current.sourcePath,
          root,
          current,
        );
        if (
          this.disposed ||
          !this.snapshot.roots.some((candidate) => candidate.id === root.id)
        )
          continue;
        this.entries.set(directory, updated);
        this.watchAnchors.set(directory, updated);
      } catch (error) {
        this.entries.delete(directory);
        if (
          changedLocation ||
          (!sameDirectory && isMissing(error)) ||
          !this.snapshot.roots.some((candidate) => candidate.id === root.id)
        )
          this.dropWatch(directory);
        if (!isMissing(error)) {
          const progress: ScanProgress = {
            ...this.snapshot.scanProgress,
            issues: [...this.snapshot.scanProgress.issues],
          };
          addIssue(
            progress,
            directory,
            `Skill removed from the library: ${message(error)}`,
          );
          this.snapshot = { ...this.snapshot, scanProgress: progress };
        }
      }
    }
    if (this.disposed) return;
    const progress = {
      ...this.snapshot.scanProgress,
      issues: [...this.snapshot.scanProgress.issues],
    };
    this.syncWatchers(progress);
    this.snapshot = { ...this.snapshot, scanProgress: progress };
    this.publishEntries(this.entries);
    await this.saveCache();
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watchAnchors.clear();
    this.pendingRefreshes.clear();
  }

  private configurationChanged(): WorkspaceSnapshot {
    this.scanRevision += 1;
    const previous = new Map(
      this.snapshot!.roots.map((root) => [root.id, root]),
    );
    const roots = this.sourceRoots().map((root) => ({
      ...root,
      ...previous.get(root.id),
    }));
    const allowed = new Set(roots.map((root) => root.id));
    this.entries = new Map(
      [...this.entries].filter(([, entry]) => allowed.has(entry.record.rootId)),
    );
    const skills = this.snapshot!.skills.filter((skill) =>
      allowed.has(skill.rootId),
    );
    this.visibleEntries = new Map(
      [...this.visibleEntries].filter(([, entry]) =>
        allowed.has(entry.record.rootId),
      ),
    );
    for (const [directory, anchor] of this.watchAnchors) {
      if (!allowed.has(anchor.record.rootId)) this.dropWatch(directory);
    }
    const progress = this.progress();
    progress.restoredFromCache = this.snapshot!.scanProgress.restoredFromCache;
    progress.watching =
      this.watchAnchors.size > 0 &&
      this.watchers.size === this.watchAnchors.size &&
      !this.watchFailures.size;
    this.snapshot = {
      ...this.snapshot!,
      scanning: true,
      skills,
      roots: roots.map((root) => ({
        ...root,
        skillCount: skills.filter((skill) => skill.rootId === root.id).length,
      })),
      scanProgress: progress,
    };
    this.beginScan();
    return this.snapshot;
  }

  private async resolveSkill(id: string): Promise<SkillRecord> {
    const workspace = await this.getWorkspace();
    const skill = workspace.skills.find((candidate) => candidate.id === id);
    if (!skill)
      throw new ServiceError(
        404,
        'Skill not found. Rescan to refresh the library.',
      );
    try {
      const sourcePath = this.visibleEntries.get(skill.path)?.sourcePath;
      if (
        (await realpath(skill.path)) !== skill.path ||
        !sourcePath ||
        (await realpath(sourcePath)) !== skill.path
      )
        throw new ServiceError(
          403,
          'The Skill location changed. Rescan before opening it.',
        );
      if (skill.issue === CACHED_RECORD_ISSUE) {
        const root = this.snapshot!.roots.find(
          (candidate) => candidate.id === skill.rootId,
        );
        if (!root)
          throw new ServiceError(
            403,
            'The Skill source is no longer configured.',
          );
        // Persisted metadata is advisory. Opening a cached record requires real
        // readable Skill metadata; a cache file cannot authorize a plain folder.
        const verified = await readSkill(skill.path, sourcePath, root);
        if (!this.snapshot!.roots.some((candidate) => candidate.id === root.id))
          throw new ServiceError(
            403,
            'The Skill source is no longer configured.',
          );
        if (this.visibleEntries.get(skill.path)?.record.rootId === root.id) {
          this.visibleEntries.set(skill.path, verified);
          this.entries.set(skill.path, verified);
          this.publishEntries(this.visibleEntries);
        }
        return verified.record;
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        404,
        'The Skill is no longer available. Rescan to refresh the library.',
      );
    }
    return skill;
  }

  private async resolveFile(
    skill: SkillRecord,
    relativePath: string,
  ): Promise<string> {
    if (
      !relativePath ||
      relativePath.includes('\0') ||
      relativePath.includes('\\') ||
      path.isAbsolute(relativePath) ||
      relativePath.split('/').includes('..')
    ) {
      throw new ServiceError(
        400,
        'Choose a relative file path within this Skill.',
      );
    }
    const candidate = path.resolve(skill.path, relativePath);
    if (!within(skill.path, candidate))
      throw new ServiceError(403, 'The file is outside this Skill.');
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new ServiceError(404, 'File not found.');
    }
    if (!within(skill.path, canonical))
      throw new ServiceError(
        403,
        'Symlinks outside this Skill cannot be opened.',
      );
    if (!(await stat(canonical)).isFile())
      throw new ServiceError(400, 'Choose a regular file.');
    return canonical;
  }

  async getSkill(id: string): Promise<SkillDetail> {
    const skill = await this.resolveSkill(id);
    const files: FileEntry[] = [];
    const visited = new Set<string>();
    const walk = async (
      directory: string,
      relative: string,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_SCAN_DEPTH) return;
      const canonical = await realpath(directory);
      if (!within(skill.path, canonical) || visited.has(canonical)) return;
      visited.add(canonical);
      const entries = await readdir(canonical, { withFileTypes: true });
      entries.sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const entryPath = path.join(canonical, entry.name);
        let resolved: string;
        try {
          resolved = await realpath(entryPath);
        } catch {
          continue;
        }
        if (!within(skill.path, resolved)) continue;
        const information = await stat(resolved);
        if (!information.isFile() && !information.isDirectory()) continue;
        const relativePath = relative
          ? `${relative}/${entry.name}`
          : entry.name;
        files.push({
          path: relativePath,
          kind: information.isDirectory() ? 'directory' : 'file',
          size: information.isDirectory() ? 0 : information.size,
        });
        if (files.length > MAX_SKILL_FILES)
          throw new ServiceError(
            413,
            `This Skill exceeds the ${MAX_SKILL_FILES.toLocaleString('en-US')} file listing limit.`,
          );
        if (information.isDirectory())
          await walk(resolved, relativePath, depth + 1);
      }
    };
    await walk(skill.path, '', 0);
    return { skill, files };
  }

  async getFile(id: string, relativePath: string): Promise<FileContent> {
    const skill = await this.resolveSkill(id);
    const canonical = await this.resolveFile(skill, relativePath);
    const information = await stat(canonical);
    const result: FileContent = {
      path: relativePath,
      content: '',
      kind: 'unsupported',
      size: information.size,
      modifiedAt: information.mtime.toISOString(),
    };
    const extension = path.extname(relativePath).toLowerCase();
    const imageType = IMAGE_TYPES[extension];
    if (information.size > (imageType ? MAX_IMAGE_SIZE : MAX_TEXT_SIZE))
      return result;
    const content = await readFile(canonical);
    if (imageType)
      return {
        ...result,
        kind: 'image',
        content: `data:${imageType};base64,${content.toString('base64')}`,
        mimeType: imageType,
      };
    if (content.includes(0)) return result;
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      return result;
    }
    return {
      ...result,
      kind: ['.md', '.markdown', '.mdx'].includes(extension)
        ? 'markdown'
        : 'text',
      content: decoded,
    };
  }

  async addRoot(input: unknown): Promise<WorkspaceSnapshot> {
    await this.initialize();
    if (typeof input !== 'string' || !input.trim() || input.includes('\0'))
      throw new ServiceError(400, 'Enter an absolute directory path.');
    const expanded =
      input === '~'
        ? this.homeDir
        : input.startsWith('~/')
          ? path.join(this.homeDir, input.slice(2))
          : input;
    if (!path.isAbsolute(expanded))
      throw new ServiceError(400, 'Enter an absolute directory path.');
    let canonical: string;
    try {
      canonical = await realpath(expanded);
      if (!(await stat(canonical)).isDirectory())
        throw new Error('Not a directory');
    } catch {
      throw new ServiceError(
        400,
        'This directory does not exist or cannot be read on the service host.',
      );
    }
    const existing = [
      ...this.defaultRoots.map((root) => root.path),
      ...this.config.roots,
    ];
    for (const root of existing) {
      if ((await realpath(root).catch(() => root)) === canonical)
        return this.getWorkspace();
    }
    if (this.config.roots.length >= 64)
      throw new ServiceError(
        400,
        'The maximum of 64 custom scan roots has been reached.',
      );
    this.config.roots.push(canonical);
    await this.saveConfig();
    return this.configurationChanged();
  }

  async removeRoot(id: string): Promise<WorkspaceSnapshot> {
    await this.initialize();
    const index = this.config.roots.findIndex((root) => stableId(root) === id);
    if (index < 0)
      throw new ServiceError(400, 'Only custom scan roots can be removed.');
    this.config.roots.splice(index, 1);
    await this.saveConfig();
    return this.configurationChanged();
  }

  private async executable(name: string): Promise<string | null> {
    for (const directory of (this.environment.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        /* Try the next PATH entry. */
      }
    }
    return null;
  }

  private async editorCommand(
    editor: EditorChoice,
    target = '',
  ): Promise<EditorLaunch | null> {
    if (
      this.platform === 'linux' &&
      !this.environment.DISPLAY &&
      !this.environment.WAYLAND_DISPLAY
    )
      return null;
    if (this.platform === 'darwin') {
      try {
        await access('/usr/bin/open', constants.X_OK);
      } catch {
        return null;
      }
      if (editor === 'system')
        return { command: '/usr/bin/open', args: [target] };
      const application =
        editor === 'vscode' ? 'Visual Studio Code.app' : 'Zed.app';
      for (const applications of [
        '/Applications',
        path.join(this.homeDir, 'Applications'),
      ]) {
        const applicationPath = path.join(applications, application);
        try {
          if ((await stat(applicationPath)).isDirectory())
            return {
              command: '/usr/bin/open',
              args: ['-a', applicationPath, target],
            };
        } catch {
          /* Check the command-line launcher next. */
        }
      }
    }
    if (this.platform !== 'darwin' && this.platform !== 'linux') return null;
    const command = await this.executable(
      editor === 'system' ? 'xdg-open' : editor === 'vscode' ? 'code' : 'zed',
    );
    return command ? { command, args: [target] } : null;
  }

  async getEditor(): Promise<EditorSettings> {
    await this.initialize();
    return {
      editor: this.config.editor,
      available: Boolean(await this.editorCommand(this.config.editor)),
    };
  }

  async setEditor(editor: unknown): Promise<EditorSettings> {
    await this.initialize();
    if (editor !== 'system' && editor !== 'vscode' && editor !== 'zed')
      throw new ServiceError(400, 'Choose system, vscode, or zed.');
    this.config.editor = editor;
    await this.saveConfig();
    const editorSettings = await this.getEditor();
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        editor: editorSettings,
        host: {
          ...this.snapshot.host,
          editorAvailable: editorSettings.available,
        },
      };
    }
    return editorSettings;
  }

  async openEditor(
    id: string,
    scope: unknown,
    relativePath?: unknown,
  ): Promise<{ message: string }> {
    if (scope !== 'skill' && scope !== 'file')
      throw new ServiceError(400, 'Choose a Skill or file to open.');
    const skill = await this.resolveSkill(id);
    let target = skill.path;
    if (scope === 'file') {
      if (typeof relativePath !== 'string')
        throw new ServiceError(400, 'Choose a file to open.');
      target = await this.resolveFile(skill, relativePath);
    } else if (this.config.editor === 'system')
      target = await this.resolveFile(skill, 'SKILL.md');
    const launch = await this.editorCommand(this.config.editor, target);
    if (!launch)
      throw new ServiceError(
        503,
        'The selected editor is unavailable on this host. Choose an installed editor or open the path on the host computer.',
      );
    await this.launchEditor(launch);
    return {
      message:
        'Editor open request sent. Save your changes, then reload the file.',
    };
  }
}
