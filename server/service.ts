import { constants } from 'node:fs';
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
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type {
  EditorChoice,
  EditorSettings,
  FileContent,
  FileEntry,
  SkillDetail,
  SkillRecord,
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
const MAX_SCAN_DIRECTORIES = 30_000;
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
  projectDir?: string;
  configDir?: string;
  platform?: string;
  hostname?: string;
  environment?: NodeJS.ProcessEnv;
  roots?: RootDefinition[];
  launchEditor?: (launch: EditorLaunch) => Promise<void>;
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error';
}

function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
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
  private readonly projectDir: string;
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

  constructor(options: ServiceOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.projectDir = path.resolve(options.projectDir ?? process.cwd());
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
        label: 'Plugin cache',
        path: path.join(this.homeDir, '.codex/plugins/cache'),
        kind: 'cache',
      },
      { label: 'Project', path: this.projectDir, kind: 'project' },
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

  async getWorkspace(): Promise<WorkspaceSnapshot> {
    await this.initialize();
    if (this.scanning) return this.scanning;
    if (!this.snapshot) return this.rescan();
    const editor = await this.getEditor();
    return {
      ...this.snapshot,
      host: { ...this.snapshot.host, editorAvailable: editor.available },
      editor,
    };
  }

  async rescan(): Promise<WorkspaceSnapshot> {
    await this.initialize();
    if (this.scanning) return this.scanning;
    this.scanning = this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(): Promise<WorkspaceSnapshot> {
    const definitions = [
      ...this.defaultRoots,
      ...this.config.roots.map((root): RootDefinition => ({
        label: path.basename(root) || root,
        path: root,
        kind: 'custom',
      })),
    ];
    const roots: SourceRoot[] = [];
    const skills = new Map<string, SkillRecord>();
    for (const definition of definitions) {
      const root: SourceRoot = {
        id: stableId(path.resolve(definition.path)),
        ...definition,
        status: 'ready',
        skillCount: 0,
        removable: definition.kind === 'custom',
      };
      roots.push(root);
      try {
        const canonicalRoot = await realpath(root.path);
        if (!(await stat(canonicalRoot)).isDirectory())
          throw new Error('The scan root is not a directory.');
        const visited = new Set<string>();
        let directoryCount = 0;
        const walk = async (
          directory: string,
          depth: number,
          boundary = canonicalRoot,
        ): Promise<void> => {
          if (directoryCount >= MAX_SCAN_DIRECTORIES) {
            root.error = `The scan stopped at the ${MAX_SCAN_DIRECTORIES.toLocaleString('en-US')} directory limit. Choose a more specific root.`;
            return;
          }
          if (depth > MAX_SCAN_DEPTH) {
            root.error = `Some folders exceed the scan depth limit (${MAX_SCAN_DEPTH}).`;
            return;
          }
          const canonical = await realpath(directory);
          if (visited.has(canonical)) return;
          // Installed Skills are often directory symlinks into a package cache. A
          // linked Skill establishes its own preview boundary; arbitrary linked
          // directories outside a scan root are never recursively explored.
          if (!within(boundary, canonical)) {
            const linkedSkill = await realpath(
              path.join(canonical, 'SKILL.md'),
            ).catch(() => null);
            if (
              !linkedSkill ||
              !within(canonical, linkedSkill) ||
              !(await stat(linkedSkill)).isFile()
            )
              return;
            boundary = canonical;
          }
          visited.add(canonical);
          directoryCount += 1;
          let entries;
          try {
            entries = await readdir(canonical, { withFileTypes: true });
          } catch (error) {
            root.error = `Some folders could not be read: ${message(error)}`;
            return;
          }
          const skillFile = entries.find((entry) => entry.name === 'SKILL.md');
          if (skillFile) {
            const skillFilePath = await realpath(
              path.join(canonical, 'SKILL.md'),
            ).catch(() => null);
            if (skillFilePath && within(canonical, skillFilePath)) {
              root.skillCount += 1;
              if (!skills.has(canonical))
                skills.set(canonical, await this.readRecord(canonical, root));
            }
          }
          const directories = entries.filter(
            (entry) =>
              !EXCLUDED_DIRECTORIES.has(entry.name) &&
              (entry.isDirectory() || entry.isSymbolicLink()),
          );
          for (const entry of directories) {
            const child = path.join(canonical, entry.name);
            try {
              if ((await stat(child)).isDirectory())
                await walk(child, depth + 1, boundary);
            } catch (error) {
              if (!isMissing(error))
                root.error = `Some folders could not be read: ${message(error)}`;
            }
          }
        };
        await walk(canonicalRoot, 0);
        if (root.error) root.status = 'error';
      } catch (error) {
        root.status = isMissing(error) ? 'missing' : 'error';
        if (!isMissing(error)) root.error = message(error);
      }
    }
    const editor = await this.getEditor();
    this.snapshot = {
      host: {
        hostname: this.hostname,
        platform: this.platform,
        homeDir: this.homeDir,
        editorAvailable: editor.available,
      },
      skills: [...skills.values()].sort(
        (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
      ),
      roots,
      lastScannedAt: new Date().toISOString(),
      scanning: false,
      editor,
    };
    return this.snapshot;
  }

  private async readRecord(
    directory: string,
    root: SourceRoot,
  ): Promise<SkillRecord> {
    const record: SkillRecord = {
      id: stableId(directory),
      name: path.basename(directory),
      description: '',
      path: directory,
      rootId: root.id,
      source: root.kind,
      modifiedAt: new Date(0).toISOString(),
    };
    try {
      const skillPath = path.join(directory, 'SKILL.md');
      const fileStat = await stat(skillPath);
      record.modifiedAt = fileStat.mtime.toISOString();
      if (!fileStat.isFile())
        throw new Error('SKILL.md is not a regular file.');
      if (fileStat.size > MAX_TEXT_SIZE)
        throw new Error('SKILL.md exceeds the 2 MB preview limit.');
      const content = await readFile(skillPath, 'utf8');
      const match = content
        .replace(/^\uFEFF/, '')
        .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) {
        record.issue = 'No YAML frontmatter found.';
        return record;
      }
      if (match[1]!.length > 128 * 1024)
        throw new Error('Skill metadata exceeds the 128 KB limit.');
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
      if (typeof fields.name === 'string' && fields.name.trim())
        record.name = fields.name.trim();
      if (typeof fields.description === 'string')
        record.description = fields.description.trim();
      if (!record.description)
        record.issue = 'No description found in Skill metadata.';
    } catch (error) {
      record.issue = message(error);
    }
    return record;
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
      if ((await realpath(skill.path)) !== skill.path)
        throw new ServiceError(
          403,
          'The Skill location changed. Rescan before opening it.',
        );
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
    if (this.scanning) await this.scanning;
    return this.rescan();
  }

  async removeRoot(id: string): Promise<WorkspaceSnapshot> {
    await this.initialize();
    const index = this.config.roots.findIndex((root) => stableId(root) === id);
    if (index < 0)
      throw new ServiceError(400, 'Only custom scan roots can be removed.');
    this.config.roots.splice(index, 1);
    await this.saveConfig();
    if (this.scanning) await this.scanning;
    return this.rescan();
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
    return this.getEditor();
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
