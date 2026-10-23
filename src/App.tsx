import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type ReactNode,
} from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Code2,
  Command,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FileText,
  Files,
  Folder,
  FolderOpen,
  Home,
  Laptop,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { buildExplorerTree, type ExplorerFolder } from './explorer-tree';
import type {
  EditorChoice,
  FileContent,
  FileEntry,
  SkillDetail,
  SkillRecord,
  SourceKind,
  WorkspaceSnapshot,
} from '../shared/types';

type Tab = { id: string; skillId: string; path: string };
type FileState = { content?: FileContent; loading?: boolean; error?: string };
type Modal = 'sources' | 'editor' | null;
const SOURCE_LABELS: Record<SourceKind, string> = {
  personal: 'User directories',
  project: 'Project',
  home: 'Home directories',
  cache: 'Plugin packages',
  custom: 'Custom',
};
const SOURCE_ORDER: SourceKind[] = [
  'home',
  'personal',
  'cache',
  'custom',
  'project',
];
const EDITORS: {
  value: EditorChoice;
  label: string;
  description: string;
  icon: typeof Monitor;
}[] = [
  {
    value: 'system',
    label: 'System default',
    description: 'Use the default app on the service computer.',
    icon: Monitor,
  },
  {
    value: 'vscode',
    label: 'Visual Studio Code',
    description: 'Open the Skill folder in VS Code.',
    icon: Code2,
  },
  {
    value: 'zed',
    label: 'Zed',
    description: 'Open the Skill folder in Zed.',
    icon: Terminal,
  },
];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'The service returned an unreadable response.'
        : `The service returned ${response.status}.`,
    );
  }
  if (!response.ok)
    throw new Error(
      (body as { error?: string })?.error ||
        `The request failed (${response.status}).`,
    );
  return body as T;
}

function retainWorkspaceData(
  previous: WorkspaceSnapshot | undefined,
  next: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (!previous) return next;
  const sameSkills =
    previous.skills.length === next.skills.length &&
    previous.skills.every((skill, index) => {
      const other = next.skills[index]!;
      return (
        skill.id === other.id &&
        skill.name === other.name &&
        skill.description === other.description &&
        skill.path === other.path &&
        skill.rootId === other.rootId &&
        skill.source === other.source &&
        skill.modifiedAt === other.modifiedAt &&
        skill.issue === other.issue
      );
    });
  const sameRoots =
    previous.roots.length === next.roots.length &&
    previous.roots.every((root, index) => {
      const other = next.roots[index]!;
      return (
        root.id === other.id &&
        root.label === other.label &&
        root.path === other.path &&
        root.kind === other.kind &&
        root.status === other.status &&
        root.skillCount === other.skillCount &&
        root.error === other.error &&
        root.removable === other.removable
      );
    });
  return {
    ...next,
    skills: sameSkills ? previous.skills : next.skills,
    roots: sameRoots ? previous.roots : next.roots,
  };
}

function shortPath(path: string, homeDir?: string) {
  return homeDir && (path === homeDir || path.startsWith(`${homeDir}/`))
    ? `~${path.slice(homeDir.length)}`
    : path;
}
function basename(path: string) {
  return path.split('/').pop() || path;
}
function fileKey(skillId: string, path: string) {
  return `${skillId}:${path}`;
}
function relativePath(current: string, href: string) {
  const clean = href.split(/[?#]/)[0];
  if (
    !clean ||
    clean.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(clean) ||
    clean.startsWith('\\')
  )
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const segments = current.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else if (segment !== '.' && segment) segments.push(segment);
  }
  return segments.join('/');
}
function safeUrl(url: string) {
  if (/^(?:https?:|mailto:)/i.test(url)) return url;
  if (
    /^[a-z][a-z\d+.-]*:/i.test(url) ||
    url.startsWith('//') ||
    url.startsWith('\\')
  )
    return '';
  return url;
}
function previewContent(content: string) {
  return content.replace(
    /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
    '',
  );
}
function headingSlug(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}
function rehypeHeadingIds() {
  return (tree: MarkdownNode) => {
    const counts = new Map<string, number>();
    const textOf = (node: MarkdownNode): string =>
      node.type === 'text'
        ? node.value || ''
        : (node.children || []).map(textOf).join('');
    const visit = (node: MarkdownNode) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName || '')) {
        const slug = headingSlug(textOf(node));
        const count = counts.get(slug) || 0;
        counts.set(slug, count + 1);
        node.properties = {
          ...node.properties,
          id: `skill-heading-${slug}${count ? `-${count}` : ''}`,
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
function timeLabel(date: string | null) {
  if (!date) return 'Not scanned yet';
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf())
    ? 'Scan complete'
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function sizeLabel(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  if (/\.mdx?$/i.test(path))
    return <FileText size={size} className="file-icon markdown-icon" />;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path))
    return <FileImage size={size} className="file-icon" />;
  if (/\.(ts|js|tsx|jsx|py|sh|json|yml|yaml|toml|html|css|rb)$/i.test(path))
    return <FileCode2 size={size} className="file-icon code-icon" />;
  return <File size={size} className="file-icon" />;
}

function SkillImage({
  src,
  alt,
  skillId,
  currentPath,
}: {
  src?: string;
  alt?: string;
  skillId: string;
  currentPath: string;
}) {
  const [image, setImage] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setImage(undefined);
    setFailed(false);
    if (!src) return;
    if (/^https?:/i.test(src)) return;
    const path = relativePath(currentPath, src);
    if (!path) {
      setFailed(true);
      return;
    }
    api<FileContent>(
      `/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(path)}`,
    )
      .then((result) => {
        if (!cancelled) {
          if (result.kind === 'image') setImage(result.content);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, skillId, currentPath]);
  if (src && /^https?:/i.test(src))
    return (
      <a
        className="image-placeholder"
        href={src}
        target="_blank"
        rel="noopener noreferrer"
      >
        <FileImage size={14} />
        {alt || 'External image'}
        <ArrowUpRight size={12} />
      </a>
    );
  return image ? (
    <img src={image} alt={alt || ''} loading="lazy" />
  ) : (
    <span className="image-placeholder">
      <FileImage size={14} /> {failed ? 'Image unavailable' : 'Loading image…'}
      {alt ? ` · ${alt}` : ''}
    </span>
  );
}

const MarkdownPreview = memo(function MarkdownPreview({
  content,
  skillId,
  path,
  onOpen,
}: {
  content: string;
  skillId: string;
  path: string;
  onOpen: (path: string) => void;
}) {
  const components: Components = {
    a: ({ href, children }) => {
      const safe = href && safeUrl(href);
      if (!safe) return <span>{children}</span>;
      if (/^(https?:|mailto:)/i.test(safe))
        return (
          <a href={safe} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      if (safe.startsWith('#'))
        return (
          <a
            href={safe}
            onClick={(event) => {
              event.preventDefault();
              let anchor = safe.slice(1);
              try {
                anchor = decodeURIComponent(anchor);
              } catch {
                return;
              }
              document
                .getElementById(`skill-heading-${anchor}`)
                ?.scrollIntoView({ block: 'start' });
            }}
          >
            {children}
          </a>
        );
      const nextPath = relativePath(path, safe);
      return nextPath ? (
        <a
          href={safe}
          onClick={(event) => {
            event.preventDefault();
            onOpen(nextPath);
          }}
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ src, alt }) => (
      <SkillImage src={src} alt={alt} skillId={skillId} currentPath={path} />
    ),
  };
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHeadingIds]}
        skipHtml
        urlTransform={safeUrl}
        components={components}
      >
        {previewContent(content)}
      </ReactMarkdown>
    </article>
  );
});

function FileTree({
  files,
  activePath,
  indent = 0,
  onOpen,
}: {
  files: FileEntry[];
  activePath?: string;
  indent?: number;
  onOpen: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const entries = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const entry of files) {
      const segments = entry.path.split('/');
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join('/');
        if (!map.has(path)) map.set(path, { path, kind: 'directory', size: 0 });
      }
      map.set(entry.path, entry);
    }
    return [...map.values()].sort((left, right) => {
      const a = left.path.split('/');
      const b = right.path.split('/');
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] === b[index]) continue;
        const aDirectory = index < a.length - 1 || left.kind === 'directory';
        const bDirectory = index < b.length - 1 || right.kind === 'directory';
        if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
        return a[index].localeCompare(b[index]);
      }
      return a.length - b.length;
    });
  }, [files]);
  return (
    <div className="file-tree" role="group" aria-label="Skill files">
      {entries
        .filter(
          (entry) =>
            ![...collapsed].some((path) => entry.path.startsWith(`${path}/`)),
        )
        .map((entry) => {
          const isDirectory = entry.kind === 'directory';
          const closed = collapsed.has(entry.path);
          return (
            <button
              key={entry.path}
              className={`tree-file ${activePath === entry.path ? 'selected' : ''}`}
              style={{
                paddingLeft:
                  27 + indent + (entry.path.split('/').length - 1) * 13,
              }}
              onClick={() => {
                if (!isDirectory) {
                  onOpen(entry.path);
                  return;
                }
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
              }}
              title={entry.path}
              aria-expanded={isDirectory ? !closed : undefined}
            >
              {isDirectory ? (
                <>
                  <span className="tree-chevron">
                    {closed ? (
                      <ChevronRight size={11} />
                    ) : (
                      <ChevronDown size={11} />
                    )}
                  </span>
                  {closed ? <Folder size={13} /> : <FolderOpen size={13} />}
                </>
              ) : (
                <>
                  <span className="tree-chevron" />
                  <FileIcon path={entry.path} size={13} />
                </>
              )}
              <span>{basename(entry.path)}</span>
            </button>
          );
        })}
    </div>
  );
}

function Dialog({
  title,
  subtitle,
  children,
  onClose,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    container.current
      ?.querySelector<HTMLElement>('button, input, select')
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const elements = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || []),
        ];
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="dialog-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

function ScanCoverage({
  workspace,
  detailed = false,
  onDetails,
  pending = false,
}: {
  workspace: WorkspaceSnapshot;
  detailed?: boolean;
  onDetails?: () => void;
  pending?: boolean;
}) {
  const progress = workspace.scanProgress;
  const discovering = pending || workspace.scanning;
  const interrupted = !discovering && progress.phase !== 'complete';
  const incomplete =
    progress.unreadableDirectories > 0 ||
    progress.externalLinksSkipped > 0 ||
    workspace.roots.some((root) => ['partial', 'error'].includes(root.status));
  const cached = progress.restoredFromCache && progress.phase !== 'complete';
  const failure = interrupted ? progress.issues.at(-1) : undefined;
  const issues = progress.issues.slice(0, 8);
  const title = discovering
    ? progress.phase === 'quick'
      ? 'Checking familiar Skill folders'
      : 'Searching your Home directory'
    : interrupted
      ? 'Search interrupted'
      : incomplete
        ? 'Search finished with gaps'
        : 'Search complete';

  return (
    <section
      className={`scan-coverage ${incomplete || interrupted ? 'has-warning' : ''}`}
      aria-label="Discovery and coverage"
    >
      <div className="scan-coverage-heading">
        {discovering ? (
          <LoaderCircle size={14} className="spin" />
        ) : incomplete || interrupted ? (
          <CircleAlert size={14} />
        ) : (
          <CheckCheck size={14} />
        )}
        <strong>{title}</strong>
        {cached && (
          <span className="cached-status">Cached · not yet verified</span>
        )}
        {!discovering && !interrupted && progress.watching && (
          <span className="watch-status">Watching discovered Skills</span>
        )}
        {onDetails && (
          <button className="small-link" onClick={onDetails}>
            Coverage <ArrowUpRight size={12} />
          </button>
        )}
      </div>
      <div className="scan-counts" role="status">
        <span>
          <strong>{progress.directoriesScanned.toLocaleString()}</strong>{' '}
          folders checked
        </span>
        <span>
          <strong>{workspace.skills.length.toLocaleString()}</strong>{' '}
          {cached || interrupted ? 'Skills available' : 'valid Skills found'}
        </span>
        <span>
          <strong>{progress.invalidSkills.toLocaleString()}</strong> invalid
          candidates
        </span>
      </div>
      <p>
        {interrupted
          ? 'The search stopped before it finished. Your available results and open files are preserved. Rescan to try again.'
          : cached
            ? 'Saved results are available while this search verifies them. Keep reading as fresh results arrive.'
            : discovering
              ? 'Skills appear as they are found. You can search and read while discovery continues.'
              : 'Searched Home and your configured folders. Browsing does not run or modify Skills.'}
      </p>
      {failure && (
        <div className="scan-failure" role="alert">
          <span>{failure.message}</span>
          <code>{shortPath(failure.path, workspace.host.homeDir)}</code>
        </div>
      )}
      {discovering && progress.currentPath && (
        <code className="scan-current-path" title={progress.currentPath}>
          Checking {shortPath(progress.currentPath, workspace.host.homeDir)}
        </code>
      )}
      {incomplete && (
        <div className="coverage-warnings">
          {progress.unreadableDirectories > 0 && (
            <span>
              {progress.unreadableDirectories.toLocaleString()} location
              {progress.unreadableDirectories === 1 ? '' : 's'} could not be
              read.
            </span>
          )}
          {progress.externalLinksSkipped > 0 && (
            <span>
              {progress.externalLinksSkipped.toLocaleString()} link
              {progress.externalLinksSkipped === 1 ? '' : 's'} outside the
              searched folders skipped. Add their target folder to include them.
            </span>
          )}
          {!progress.unreadableDirectories &&
            workspace.roots.some((root) =>
              ['partial', 'error'].includes(root.status),
            ) && <span>Some scan folders were only partly read.</span>}
        </div>
      )}
      {detailed && (
        <p className="scan-candidate-note">
          {progress.candidatesChecked.toLocaleString()} SKILL.md candidates
          checked. Invalid candidates are excluded from the library.
        </p>
      )}
      {detailed && issues.length > 0 && (
        <details className="coverage-issues">
          <summary>Inspect paths and reasons ({issues.length} shown)</summary>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.path}:${index}`}>
                <code>{shortPath(issue.path, workspace.host.homeDir)}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
          <p>Showing a sample of issues from this search.</p>
        </details>
      )}
    </section>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [loading, setLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceKind | 'all'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [folderExpansion, setFolderExpansion] = useState<
    Record<string, boolean>
  >({});
  const [searchCollapsedFolders, setSearchCollapsedFolders] = useState<
    Set<string>
  >(new Set());
  const [details, setDetails] = useState<Record<string, SkillDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState('home');
  const [contents, setContents] = useState<Record<string, FileState>>({});
  const [sourceMode, setSourceMode] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [rescanLoading, setRescanLoading] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [openLoading, setOpenLoading] = useState(false);
  const [newRoot, setNewRoot] = useState('');
  const [modalError, setModalError] = useState<string>();
  const [toast, setToast] = useState<{ message: string; error?: boolean }>();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [openMenu, setOpenMenu] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const pendingDetails = useRef(
    new Map<string, Promise<SkillDetail | undefined>>(),
  );
  const pendingFiles = useRef(new Set<string>());
  const workspaceRequestPending = useRef(false);
  const workspaceMutationPending = useRef(false);
  const workspaceRequestVersion = useRef(0);
  const lastCompletedScan = useRef<string | null>(null);
  const scanObserved = useRef(false);
  const notifyOnScanComplete = useRef(false);
  const explorerFolders = useMemo(
    () =>
      buildExplorerTree(
        workspace?.skills || [],
        workspace?.roots || [],
        workspace?.host.homeDir || '',
      ),
    [workspace?.skills, workspace?.roots, workspace?.host.homeDir],
  );

  useEffect(() => {
    setSearchCollapsedFolders(new Set());
  }, [query, sourceFilter]);

  const revealSkill = (skillId: string) => {
    const ancestors = (
      folders: ExplorerFolder[],
      parents: string[] = [],
    ): string[] | undefined => {
      for (const folder of folders) {
        const branch = [...parents, folder.id];
        if (folder.skills.some((skill) => skill.id === skillId)) return branch;
        const found = ancestors(folder.folders, branch);
        if (found) return found;
      }
    };
    const ids = ancestors(explorerFolders);
    if (ids)
      setFolderExpansion((previous) => ({
        ...previous,
        ...Object.fromEntries(ids.map((id) => [id, true])),
      }));
  };

  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  const closeModal = useCallback(() => {
    setModal(null);
    setModalError(undefined);
  }, []);
  const loadWorkspace = useCallback(async (initial = false) => {
    if (workspaceRequestPending.current || workspaceMutationPending.current)
      return;
    workspaceRequestPending.current = true;
    const requestVersion = workspaceRequestVersion.current;
    if (initial) setLoading(true);
    try {
      const next = await api<WorkspaceSnapshot>('/workspace');
      if (
        requestVersion !== workspaceRequestVersion.current ||
        workspaceMutationPending.current
      )
        return;
      setWorkspace((previous) => retainWorkspaceData(previous, next));
      setWorkspaceError(undefined);
    } catch (error) {
      if (requestVersion === workspaceRequestVersion.current)
        setWorkspaceError((error as Error).message);
    } finally {
      workspaceRequestPending.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadWorkspace(true);
  }, [loadWorkspace]);
  useEffect(() => {
    if (mutationLoading || rescanLoading) return;
    const interval = window.setInterval(
      () => {
        void loadWorkspace();
      },
      workspace?.scanning ? 1000 : 30000,
    );
    return () => window.clearInterval(interval);
  }, [loadWorkspace, workspace?.scanning, mutationLoading, rescanLoading]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => setToast(undefined),
      toast.error ? 7000 : 4000,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSidebarVisible(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === 'Escape') setOpenMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!openMenu) return;
    const handler = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.editor-action'))
        setOpenMenu(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenu]);
  useEffect(() => {
    if (readerRef.current)
      readerRef.current.scrollTop = scrollPositions.current[activeId] || 0;
  }, [activeId, contents[activeId]?.content]);

  const loadDetail = useCallback(
    async (
      skillId: string,
      force = false,
    ): Promise<SkillDetail | undefined> => {
      if (!force && details[skillId]) return details[skillId];
      if (pendingDetails.current.has(skillId))
        return pendingDetails.current.get(skillId);
      setDetailLoading((previous) => new Set(previous).add(skillId));
      setDetailErrors((previous) => {
        const next = { ...previous };
        delete next[skillId];
        return next;
      });
      const promise = api<SkillDetail>(`/skills/${encodeURIComponent(skillId)}`)
        .then((detail) => {
          setDetails((previous) => ({ ...previous, [skillId]: detail }));
          return detail;
        })
        .catch((error: Error) => {
          setDetailErrors((previous) => ({
            ...previous,
            [skillId]: error.message,
          }));
          return undefined;
        })
        .finally(() => {
          pendingDetails.current.delete(skillId);
          setDetailLoading((previous) => {
            const next = new Set(previous);
            next.delete(skillId);
            return next;
          });
        });
      pendingDetails.current.set(skillId, promise);
      return promise;
    },
    [details],
  );

  const loadFile = useCallback(
    async (skillId: string, path: string, force = false) => {
      const key = fileKey(skillId, path);
      if ((!force && contents[key]?.content) || pendingFiles.current.has(key))
        return;
      pendingFiles.current.add(key);
      setContents((previous) => ({
        ...previous,
        [key]: { ...previous[key], loading: true, error: undefined },
      }));
      try {
        const content = await api<FileContent>(
          `/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(path)}`,
        );
        setContents((previous) => ({ ...previous, [key]: { content } }));
      } catch (error) {
        setContents((previous) => ({
          ...previous,
          [key]: { error: (error as Error).message },
        }));
      } finally {
        pendingFiles.current.delete(key);
      }
    },
    [contents],
  );

  useEffect(() => {
    if (!workspace) return;
    if (workspace.scanning) {
      scanObserved.current = true;
      return;
    }
    if (workspace.scanProgress.phase !== 'complete') {
      scanObserved.current = false;
      if (notifyOnScanComplete.current) {
        notify(
          'Search interrupted. Your available results are preserved.',
          true,
        );
        notifyOnScanComplete.current = false;
      }
      return;
    }
    const completedAt =
      workspace.scanProgress.completedAt || workspace.lastScannedAt;
    if (!completedAt || lastCompletedScan.current === completedAt) return;
    const previousCompletedAt = lastCompletedScan.current;
    lastCompletedScan.current = completedAt;
    if (
      !previousCompletedAt &&
      !scanObserved.current &&
      !notifyOnScanComplete.current
    )
      return;
    scanObserved.current = false;
    const skillIds = new Set(workspace.skills.map((skill) => skill.id));
    const incomplete =
      workspace.scanProgress.unreadableDirectories > 0 ||
      workspace.roots.some((root) =>
        ['partial', 'error'].includes(root.status),
      );
    // An unreadable folder cannot establish that a previously open Skill is gone.
    if (!incomplete) {
      setTabs((previous) =>
        previous.filter((tab) => skillIds.has(tab.skillId)),
      );
      setActiveId((previous) =>
        tabs.some((tab) => tab.id === previous && !skillIds.has(tab.skillId))
          ? 'home'
          : previous,
      );
    }
    setDetails((previous) =>
      incomplete
        ? Object.fromEntries(
            Object.entries(previous).filter(([id]) => !skillIds.has(id)),
          )
        : {},
    );
    setDetailErrors({});
    setContents((previous) =>
      incomplete
        ? Object.fromEntries(
            Object.entries(previous).filter(([id]) =>
              tabs.some((tab) => tab.id === id && !skillIds.has(tab.skillId)),
            ),
          )
        : {},
    );
    const selected = tabs.find((tab) => tab.id === activeId);
    if (selected && skillIds.has(selected.skillId)) {
      void loadDetail(selected.skillId, true);
      void loadFile(selected.skillId, selected.path, true);
    }
    if (notifyOnScanComplete.current) {
      notify(
        `Search complete · ${workspace.skills.length} valid Skills${incomplete || workspace.scanProgress.externalLinksSkipped ? ' · Review coverage' : ''}`,
      );
      notifyOnScanComplete.current = false;
    }
  }, [workspace, tabs, activeId, loadDetail, loadFile, notify]);

  const openFile = useCallback(
    (skillId: string, path: string) => {
      const id = fileKey(skillId, path);
      setTabs((previous) =>
        previous.some((tab) => tab.id === id)
          ? previous
          : [...previous, { id, skillId, path }],
      );
      setActiveId(id);
      setOpenMenu(false);
      void loadFile(skillId, path);
      void loadDetail(skillId);
    },
    [loadFile, loadDetail],
  );
  const openSkill = (skill: SkillRecord) => {
    revealSkill(skill.id);
    setExpanded((previous) => new Set(previous).add(skill.id));
    openFile(skill.id, 'SKILL.md');
  };
  const toggleSkill = (skill: SkillRecord) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });
    void loadDetail(skill.id);
  };
  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    setTabs((previous) => previous.filter((tab) => tab.id !== id));
    if (activeId === id)
      setActiveId(tabs[index - 1]?.id || tabs[index + 1]?.id || 'home');
  };
  const rescan = async () => {
    if (workspaceMutationPending.current) return;
    workspaceMutationPending.current = true;
    workspaceRequestVersion.current += 1;
    notifyOnScanComplete.current = true;
    setRescanLoading(true);
    setModalError(undefined);
    try {
      const next = await api<WorkspaceSnapshot>('/rescan', { method: 'POST' });
      setWorkspace((previous) => retainWorkspaceData(previous, next));
      setWorkspaceError(undefined);
    } catch (error) {
      notifyOnScanComplete.current = false;
      notify((error as Error).message, true);
    } finally {
      workspaceMutationPending.current = false;
      setRescanLoading(false);
    }
  };
  const addRoot = async () => {
    if (workspaceMutationPending.current) return;
    if (!newRoot.trim().startsWith('/')) {
      setModalError(
        'Enter an absolute folder path, such as /Volumes/Work/skills.',
      );
      return;
    }
    workspaceMutationPending.current = true;
    workspaceRequestVersion.current += 1;
    setMutationLoading(true);
    setModalError(undefined);
    try {
      const next = await api<WorkspaceSnapshot>('/roots', {
        method: 'POST',
        body: JSON.stringify({ path: newRoot.trim() }),
      });
      setWorkspace((previous) => retainWorkspaceData(previous, next));
      setNewRoot('');
      notify('Scan folder added');
    } catch (error) {
      setModalError((error as Error).message);
    } finally {
      workspaceMutationPending.current = false;
      setMutationLoading(false);
    }
  };
  const removeRoot = async (rootId: string) => {
    if (workspaceMutationPending.current) return;
    workspaceMutationPending.current = true;
    workspaceRequestVersion.current += 1;
    setMutationLoading(true);
    setModalError(undefined);
    try {
      const next = await api<WorkspaceSnapshot>(
        `/roots/${encodeURIComponent(rootId)}`,
        { method: 'DELETE', body: '{}' },
      );
      setWorkspace((previous) => retainWorkspaceData(previous, next));
      notify('Scan folder removed');
    } catch (error) {
      setModalError((error as Error).message);
    } finally {
      workspaceMutationPending.current = false;
      setMutationLoading(false);
    }
  };
  const setEditor = async (editor: EditorChoice) => {
    if (workspaceMutationPending.current) return;
    workspaceMutationPending.current = true;
    workspaceRequestVersion.current += 1;
    setMutationLoading(true);
    setModalError(undefined);
    try {
      const next = await api<WorkspaceSnapshot['editor']>('/editor', {
        method: 'PUT',
        body: JSON.stringify({ editor }),
      });
      setWorkspace((previous) =>
        previous ? { ...previous, editor: next } : previous,
      );
    } catch (error) {
      setModalError((error as Error).message);
    } finally {
      workspaceMutationPending.current = false;
      setMutationLoading(false);
    }
  };
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeSkill =
    workspace?.skills.find((skill) => skill.id === activeTab?.skillId) ||
    (activeTab && details[activeTab.skillId]?.skill);
  const currentFile = contents[activeId];
  const openRelatedFile = useCallback(
    (path: string) => {
      if (activeTab) openFile(activeTab.skillId, path);
    },
    [activeTab, openFile],
  );
  const openInEditor = async (scope: 'skill' | 'file') => {
    if (!activeTab) return;
    setOpenLoading(true);
    setOpenMenu(false);
    try {
      const result = await api<{ message: string }>(
        `/skills/${encodeURIComponent(activeTab.skillId)}/open`,
        {
          method: 'POST',
          body: JSON.stringify({
            scope,
            ...(scope === 'file' ? { path: activeTab.path } : {}),
          }),
        },
      );
      notify(result.message);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setOpenLoading(false);
    }
  };
  const copyPath = async () => {
    if (!activeSkill || !activeTab) return;
    try {
      await navigator.clipboard.writeText(
        `${activeSkill.path}/${activeTab.path}`,
      );
      notify('File path copied');
    } catch {
      notify('The browser could not copy the path.', true);
    }
  };
  const sources = useMemo(
    () =>
      SOURCE_ORDER.map((kind) => ({
        kind,
        count:
          workspace?.skills.filter((skill) => skill.source === kind).length ||
          0,
      })).filter(({ kind, count }) => kind !== 'project' || count > 0),
    [workspace?.skills],
  );
  const skillsByName = useMemo(() => {
    const groups = new Map<string, SkillRecord[]>();
    for (const skill of workspace?.skills || []) {
      const group = groups.get(skill.name);
      if (group) group.push(skill);
      else groups.set(skill.name, [skill]);
    }
    return groups;
  }, [workspace?.skills]);
  const duplicateNames = useMemo(
    () =>
      new Set(
        [...skillsByName]
          .filter(([, skills]) => skills.length > 1)
          .map(([name]) => name),
      ),
    [skillsByName],
  );
  const skillContexts = useMemo(() => {
    const contexts: Record<string, string> = {};
    const rootLabels = new Map(
      workspace?.roots.map((root) => [root.id, root.label]),
    );
    for (const peers of skillsByName.values()) {
      if (peers.length < 2) continue;
      for (const skill of peers) {
        const rootLabel =
          rootLabels.get(skill.rootId) || SOURCE_LABELS[skill.source];
        const hasSameLabel = peers.some(
          (other) =>
            other.id !== skill.id &&
            (rootLabels.get(other.rootId) || SOURCE_LABELS[other.source]) ===
              rootLabel,
        );
        if (!hasSameLabel) {
          contexts[skill.id] = rootLabel;
          continue;
        }
        const parent = skill.path.split('/').slice(0, -1);
        let suffix = parent.slice(-1).join('/');
        for (let depth = 1; depth <= parent.length; depth++) {
          suffix = parent.slice(-depth).join('/');
          if (
            !peers.some(
              (other) =>
                other.id !== skill.id &&
                other.path.split('/').slice(0, -1).slice(-depth).join('/') ===
                  suffix,
            )
          )
            break;
        }
        contexts[skill.id] = suffix;
      }
    }
    return contexts;
  }, [skillsByName, workspace?.roots]);
  const filteredSkills = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (workspace?.skills || [])
      .filter(
        (skill) =>
          (sourceFilter === 'all' || skill.source === sourceFilter) &&
          (!search ||
            `${skill.name} ${skill.description} ${skill.path}`
              .toLowerCase()
              .includes(search)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workspace?.skills, sourceFilter, query]);
  const filteredFolders = useMemo(
    () =>
      buildExplorerTree(
        filteredSkills,
        workspace?.roots || [],
        workspace?.host.homeDir || '',
      ),
    [filteredSkills, workspace?.roots, workspace?.host.homeDir],
  );
  const recentSkills = useMemo(
    () =>
      [...(workspace?.skills || [])]
        .sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''))
        .slice(0, 7),
    [workspace?.skills],
  );
  const activeRoots =
    workspace?.roots.filter((root) =>
      ['ready', 'partial'].includes(root.status),
    ).length || 0;
  const scanBusy = rescanLoading || !!workspace?.scanning;

  const renderSkill = (skill: SkillRecord, depth: number) => (
    <div
      key={skill.id}
      className={`skill-group ${activeSkill?.id === skill.id ? 'has-active' : ''}`}
    >
      <div
        className={`skill-row ${activeSkill?.id === skill.id ? 'active' : ''}`}
        style={{ paddingLeft: depth * 13 }}
      >
        <button
          className="expand-skill"
          onClick={() => toggleSkill(skill)}
          aria-label={`${expanded.has(skill.id) ? 'Collapse' : 'Expand'} ${skill.name}`}
          aria-expanded={expanded.has(skill.id)}
        >
          {expanded.has(skill.id) ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </button>
        <button
          className="skill-label"
          onClick={() => openSkill(skill)}
          title={`${skill.description || skill.name}\n\n${skill.path}`}
        >
          <BookOpen size={14} />
          <span>{skill.name}</span>

          {skill.issue ? (
            <CircleAlert
              size={12}
              className="warning-icon"
              aria-label="Skill has a scan issue"
            />
          ) : (
            <span
              className={`source-dot source-${skill.source}`}
              title={SOURCE_LABELS[skill.source]}
            />
          )}
        </button>
      </div>
      {expanded.has(skill.id) && (
        <>
          {detailLoading.has(skill.id) && !details[skill.id] ? (
            <div className="tree-state">
              <LoaderCircle size={12} className="spin" /> Loading files…
            </div>
          ) : detailErrors[skill.id] ? (
            <div className="tree-state error-text">
              <CircleAlert size={12} />
              <span>{detailErrors[skill.id]}</span>
              <button
                className="small-link"
                onClick={() => void loadDetail(skill.id, true)}
              >
                Retry
              </button>
            </div>
          ) : details[skill.id] ? (
            <FileTree
              files={details[skill.id].files}
              indent={depth * 13}
              activePath={
                activeSkill?.id === skill.id ? activeTab?.path : undefined
              }
              onOpen={(path) => openFile(skill.id, path)}
            />
          ) : (
            <div className="tree-state">
              <button
                className="small-link"
                onClick={() => void loadDetail(skill.id)}
              >
                Load files
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderFolder = (folder: ExplorerFolder, depth = 0): ReactNode => {
    const searching = Boolean(query.trim());
    const isOpen = searching
      ? !searchCollapsedFolders.has(folder.id)
      : (folderExpansion[folder.id] ?? folder.isRoot);
    return (
      <div
        key={folder.id}
        className={`explorer-folder ${folder.isRoot ? 'source-folder' : ''}`}
      >
        <button
          className={`folder-row ${folder.isRoot ? 'root-folder-row' : ''}`}
          style={{ paddingLeft: 12 + depth * 13 }}
          title={folder.path}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} folder ${folder.name}`}
          aria-expanded={isOpen}
          onClick={() => {
            if (searching) {
              setSearchCollapsedFolders((previous) => {
                const next = new Set(previous);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              });
            } else {
              setFolderExpansion((previous) => ({
                ...previous,
                [folder.id]: !isOpen,
              }));
            }
          }}
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span className="folder-name">{folder.name}</span>
          <span className="folder-skill-count" title={`${folder.count} Skills`}>
            {folder.count}
          </span>
        </button>
        {isOpen && (
          <div role="group" aria-label={`${folder.name} contents`}>
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.skills.map((skill) => renderSkill(skill, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Progress counters can update without rebuilding a large explorer tree.
  const explorerContents = useMemo(
    () => filteredFolders.map((folder) => renderFolder(folder)),
    [
      filteredFolders,
      explorerFolders,
      query,
      searchCollapsedFolders,
      folderExpansion,
      expanded,
      activeSkill?.id,
      activeTab?.path,
      detailLoading,
      detailErrors,
      details,
      duplicateNames,
      skillContexts,
      loadDetail,
      openFile,
    ],
  );

  const collapseExplorer = () => {
    const ids: string[] = [];
    const visit = (folders: ExplorerFolder[]) => {
      for (const folder of folders) {
        ids.push(folder.id);
        visit(folder.folders);
      }
    };
    visit(explorerFolders);
    visit(filteredFolders);
    setExpanded(new Set());
    setFolderExpansion(Object.fromEntries(ids.map((id) => [id, false])));
    setSearchCollapsedFolders(new Set(ids));
  };

  return (
    <div className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
      <header className="appbar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setActiveId('home');
          }}
          aria-label="ZSkills home"
        >
          <img
            className="brand-mark"
            src="/brand/mark.svg"
            alt=""
            aria-hidden="true"
            width={28}
            height={28}
          />
          <span>ZSkills</span>
          <span className="version-tag">WORKSPACE</span>
        </a>
        <div
          className="appbar-host"
          title={
            workspace
              ? `The service reads Skills on ${workspace.host.hostname}.`
              : 'Connecting to the service computer'
          }
        >
          <span
            className={`connection-dot ${workspaceError ? 'offline' : ''}`}
          />
          <Laptop size={13} />
          <span>{workspace?.host.hostname || 'Connecting…'}</span>
          <span className="host-separator">/</span>
          <span className="muted">
            {workspace?.host.platform === 'darwin'
              ? 'macOS'
              : workspace?.host.platform || 'Service host'}
          </span>
        </div>
        <div className="appbar-actions">
          <button
            className="text-button compact"
            onClick={() => {
              setModalError(undefined);
              setModal('sources');
            }}
            title="Manage scan folders"
          >
            <Folder size={13} />
            <span>Sources</span>
          </button>
          <button
            className={`icon-button ${scanBusy ? 'busy' : ''}`}
            onClick={() => void rescan()}
            disabled={scanBusy || mutationLoading || !workspace}
            title="Rescan all folders"
            aria-label="Rescan all folders"
          >
            <RefreshCw size={14} />
          </button>
          <span className="action-divider" />
          <button
            className="icon-button"
            onClick={() => {
              setModalError(undefined);
              setModal('editor');
            }}
            title="Editor settings"
            aria-label="Editor settings"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <div className="workbench">
        <nav className="activity-rail" aria-label="Workspace navigation">
          <div>
            <button
              className={`rail-button ${sidebarVisible ? 'active' : ''}`}
              onClick={() => setSidebarVisible((value) => !value)}
              title="Toggle Skills explorer"
              aria-label="Toggle Skills explorer"
              aria-pressed={sidebarVisible}
            >
              <Files size={20} />
            </button>
            <button
              className={`rail-button ${activeId === 'home' ? 'home-active' : ''}`}
              onClick={() => setActiveId('home')}
              title="Workspace overview"
              aria-label="Workspace overview"
            >
              <Home size={19} />
            </button>
            <button
              className="rail-button"
              onClick={() => {
                setSidebarVisible(true);
                window.setTimeout(() => searchRef.current?.focus(), 0);
              }}
              title="Search Skills (⌘K / Ctrl+K)"
              aria-label="Search Skills"
            >
              <Search size={19} />
            </button>
          </div>
          <div>
            <button
              className="rail-button"
              onClick={() => {
                setModalError(undefined);
                setModal('sources');
              }}
              title="Scan sources"
              aria-label="Scan sources"
            >
              <Folder size={19} />
            </button>
            <button
              className="rail-button"
              onClick={() => {
                setModalError(undefined);
                setModal('editor');
              }}
              title="Editor settings"
              aria-label="Editor settings"
            >
              <Settings2 size={19} />
            </button>
          </div>
        </nav>

        <aside className="sidebar" aria-label="Skills explorer">
          <div className="sidebar-heading">
            <span>EXPLORER</span>
            <span className="count-label">
              {workspace?.skills.length ?? '—'} Skills
            </span>
            <button
              className="icon-button tiny"
              onClick={collapseExplorer}
              title="Collapse all folders"
              aria-label="Collapse all folders"
            >
              <ArrowDownToLine size={13} />
            </button>
          </div>
          <div className="search-wrap">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Skills…"
              aria-label="Search Skills by name, description or path"
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                className="icon-button tiny"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </div>
          <div className="filter-row">
            <button
              className={sourceFilter === 'all' ? 'selected' : ''}
              onClick={() => setSourceFilter('all')}
            >
              All <span>{workspace?.skills.length || 0}</span>
            </button>
            {sources
              .filter((source) => source.count)
              .map(({ kind, count }) => (
                <button
                  key={kind}
                  className={sourceFilter === kind ? 'selected' : ''}
                  onClick={() => setSourceFilter(kind)}
                  title={`${SOURCE_LABELS[kind]} · ${count} Skills`}
                >
                  {SOURCE_LABELS[kind]} <span>{count}</span>
                </button>
              ))}
          </div>
          <div className="explorer-section-heading">
            <ChevronDown size={12} />
            <span>FOLDERS</span>
            <span>{filteredSkills.length} Skills</span>
          </div>
          <div className="skill-list">
            {loading ? (
              <div className="sidebar-state">
                <LoaderCircle size={18} className="spin" />
                <span>Discovering Skills…</span>
              </div>
            ) : !workspace ? (
              <div className="sidebar-state">
                <CircleAlert size={20} />
                <span>Cannot reach the service</span>
                <button
                  className="small-link"
                  onClick={() => void loadWorkspace(true)}
                >
                  Retry connection
                </button>
              </div>
            ) : filteredSkills.length ? (
              explorerContents
            ) : (
              <div className="sidebar-state">
                <Search size={20} />
                <strong>
                  {workspace.skills.length
                    ? 'No matching Skills'
                    : workspace.scanning
                      ? 'Searching for Skills…'
                      : workspace.scanProgress.phase !== 'complete'
                        ? 'Search interrupted'
                        : 'No Skills found'}
                </strong>
                <span>
                  {workspace.skills.length
                    ? 'Try another name or source.'
                    : workspace.scanning
                      ? 'Home is searched automatically. Results appear as they are found.'
                      : workspace.scanProgress.phase !== 'complete'
                        ? 'Review coverage and rescan to try again.'
                        : 'Home has been searched. Review coverage or add an external folder.'}
                </span>
                {workspace.skills.length ? (
                  <button
                    className="small-link"
                    onClick={() => {
                      setQuery('');
                      setSourceFilter('all');
                    }}
                  >
                    Clear filters
                  </button>
                ) : (
                  <button
                    className="small-link"
                    onClick={() => setModal('sources')}
                  >
                    Manage sources
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            {workspace?.scanning ? (
              <LoaderCircle size={11} className="spin" />
            ) : (
              <span className="connection-dot" />
            )}
            <span>
              {workspace?.scanning
                ? `${workspace.scanProgress.directoriesScanned.toLocaleString()} folders checked`
                : `${activeRoots} source${activeRoots === 1 ? '' : 's'} available`}
            </span>
            <button
              className="icon-button tiny"
              onClick={() => setModal('sources')}
              aria-label="Manage sources"
              title="Manage sources"
            >
              <SlidersHorizontal size={12} />
            </button>
          </div>
        </aside>

        <main className="main-panel">
          <div className="tabbar" role="tablist" aria-label="Open files">
            <button
              role="tab"
              aria-selected={activeId === 'home'}
              className={`editor-tab home-tab ${activeId === 'home' ? 'active' : ''}`}
              onClick={() => setActiveId('home')}
            >
              <Home size={13} />
              <span>Overview</span>
            </button>
            {tabs.map((tab) => {
              const skill =
                workspace?.skills.find((item) => item.id === tab.skillId) ||
                details[tab.skillId]?.skill;
              return (
                <div
                  key={tab.id}
                  className={`editor-tab ${activeId === tab.id ? 'active' : ''}`}
                >
                  <button
                    role="tab"
                    aria-selected={activeId === tab.id}
                    className="tab-select"
                    onClick={() => {
                      setActiveId(tab.id);
                      void loadFile(tab.skillId, tab.path);
                    }}
                    title={`${skill?.name || 'Skill'} / ${tab.path}`}
                  >
                    <FileIcon path={tab.path} size={13} />
                    <span>
                      {tab.path === 'SKILL.md'
                        ? skill?.name || 'SKILL.md'
                        : basename(tab.path)}
                    </span>
                    {(tab.path !== 'SKILL.md' ||
                      (skill && duplicateNames.has(skill.name))) && (
                      <span className="tab-skill-name">
                        {tab.path !== 'SKILL.md'
                          ? skill?.name
                          : skill
                            ? skillContexts[skill.id]
                            : ''}
                      </span>
                    )}
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close ${tab.path === 'SKILL.md' ? skill?.name || 'Skill' : basename(tab.path)}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
            <div className="tabbar-spacer" />
          </div>

          {workspaceError && workspace && (
            <div className="connection-banner">
              <CircleAlert size={14} />
              <span>
                Connection interrupted. Showing your last loaded workspace.
              </span>
              <button onClick={() => void loadWorkspace()}>Reconnect</button>
            </div>
          )}

          {activeId === 'home' ? (
            <div className="overview-scroll">
              <div className="overview">
                <div className="overview-eyebrow">
                  <span className="connection-dot" />
                  {workspaceError
                    ? 'CONNECTION UNAVAILABLE'
                    : 'YOUR SKILL WORKSPACE'}
                </div>
                <div className="overview-title-row">
                  <div className="overview-heading">
                    <img
                      className="overview-brand-mark"
                      src="/brand/mark.svg"
                      alt=""
                      aria-hidden="true"
                      width={44}
                      height={44}
                    />
                    <div>
                      <h1>A closer look at your Skills.</h1>
                      <p>
                        Explore what is on this computer. Read the source. Make
                        it your own.
                      </p>
                    </div>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => void rescan()}
                    disabled={scanBusy || mutationLoading || !workspace}
                  >
                    <RefreshCw size={13} className={scanBusy ? 'spin' : ''} />
                    {scanBusy ? 'Scanning…' : 'Rescan'}
                  </button>
                </div>

                {loading ? (
                  <div className="home-loading">
                    <LoaderCircle className="spin" size={24} />
                    <h3>Reading your workspace</h3>
                    <p>Looking for Skills on the service computer…</p>
                  </div>
                ) : !workspace ? (
                  <div className="home-loading error-state">
                    <CircleAlert size={30} />
                    <h3>Could not connect to ZSkills</h3>
                    <p>{workspaceError}</p>
                    <button
                      className="primary-button"
                      onClick={() => void loadWorkspace(true)}
                    >
                      <RefreshCw size={14} />
                      Retry connection
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="workspace-summary">
                      <div className="summary-total">
                        <span className="summary-number">
                          {workspace.skills.length}
                        </span>
                        <span>Skills discovered</span>
                      </div>
                      <div className="summary-divider" />
                      <div className="summary-detail">
                        <Laptop size={16} />
                        <div>
                          <strong>{workspace.host.hostname}</strong>
                          <span>
                            {workspace.host.platform === 'darwin'
                              ? 'macOS'
                              : workspace.host.platform}{' '}
                            · Service computer
                          </span>
                        </div>
                      </div>
                      <div className="summary-detail">
                        <Folder size={16} />
                        <div>
                          <strong>
                            {activeRoots} active scan folder
                            {activeRoots === 1 ? '' : 's'}
                          </strong>
                          <span>
                            {workspace.scanning
                              ? 'Searching Home and configured folders'
                              : workspace.lastScannedAt
                                ? `Last search at ${timeLabel(workspace.lastScannedAt)}`
                                : 'Home is searched automatically'}
                          </span>
                        </div>
                      </div>
                      <span className="read-only-badge">
                        <CheckCheck size={12} />
                        Read-only browsing
                      </span>
                    </div>

                    <ScanCoverage
                      workspace={workspace}
                      pending={rescanLoading || mutationLoading}
                      onDetails={() => setModal('sources')}
                    />

                    <div className="overview-columns">
                      <section className="overview-section source-overview">
                        <div className="section-title">
                          <h2>Where your Skills live</h2>
                          <button
                            className="small-link"
                            onClick={() => setModal('sources')}
                          >
                            Manage <ArrowUpRight size={12} />
                          </button>
                        </div>
                        <div
                          className="source-bar"
                          aria-label="Skill distribution by source"
                        >
                          {sources
                            .filter((source) => source.count)
                            .map(({ kind, count }) => (
                              <span
                                key={kind}
                                className={`source-${kind}`}
                                style={{ flex: count }}
                                title={`${SOURCE_LABELS[kind]}: ${count}`}
                              />
                            ))}
                          {!workspace.skills.length && (
                            <span className="empty-bar" />
                          )}
                        </div>
                        <div className="source-table">
                          {sources.map(({ kind, count }) => (
                            <button
                              key={kind}
                              className="source-summary-row"
                              onClick={() => {
                                setSourceFilter(kind);
                                setQuery('');
                                setSidebarVisible(true);
                              }}
                              title={`Show ${SOURCE_LABELS[kind].toLowerCase()} Skills`}
                            >
                              <span className={`source-dot source-${kind}`} />
                              <span>{SOURCE_LABELS[kind]}</span>
                              <span className="source-row-description">
                                {kind === 'personal'
                                  ? 'User-level Skill folders'
                                  : kind === 'home'
                                    ? 'Home, including repository Skills'
                                    : kind === 'project'
                                      ? 'Project directories'
                                      : kind === 'cache'
                                        ? 'Skills from plugin packages'
                                        : 'Folders you added'}
                              </span>
                              <strong>{count}</strong>
                              <ChevronRight size={12} />
                            </button>
                          ))}
                        </div>
                        <div className="scan-note">
                          <div className="scan-note-icon">
                            <Check size={14} />
                          </div>
                          <div>
                            <strong>
                              {scanBusy
                                ? 'A scan is in progress'
                                : 'Source files stay yours'}
                            </strong>
                            <p>
                              {scanBusy
                                ? 'New Skills appear as they are found. Keep browsing and reading during the search.'
                                : 'Browsing never runs a Skill or changes its files. Open your editor when you are ready to make changes.'}
                            </p>
                          </div>
                        </div>
                      </section>
                      <section className="overview-section">
                        <div className="section-title">
                          <h2>Recently modified</h2>
                          <span className="quiet-label">ON THIS COMPUTER</span>
                        </div>
                        <div className="recent-list">
                          {recentSkills.length ? (
                            recentSkills.map((skill) => (
                              <button
                                key={skill.id}
                                className="recent-skill"
                                onClick={() => openSkill(skill)}
                                title={skill.path}
                              >
                                <span className="recent-icon">
                                  <BookOpen size={15} />
                                </span>
                                <span className="recent-copy">
                                  <strong>{skill.name}</strong>
                                  <span>
                                    {skill.description ||
                                      shortPath(
                                        skill.path,
                                        workspace.host.homeDir,
                                      )}
                                  </span>
                                </span>
                                <ArrowUpRight size={13} />
                              </button>
                            ))
                          ) : (
                            <div className="recent-empty">
                              {workspace.scanning ? (
                                <LoaderCircle size={24} className="spin" />
                              ) : (
                                <Folder size={24} />
                              )}
                              <strong>
                                {workspace.scanning
                                  ? 'Looking through your Home directory'
                                  : 'Your first Skill starts here'}
                              </strong>
                              <p>
                                {workspace.scanning
                                  ? 'You can start reading as soon as a Skill appears.'
                                  : 'Home is searched automatically. Add a folder for Skills stored elsewhere.'}
                              </p>
                              <button
                                className="secondary-button"
                                onClick={() => setModal('sources')}
                              >
                                <Plus size={13} />
                                Add scan folder
                              </button>
                            </div>
                          )}
                        </div>
                      </section>
                    </div>

                    <section className="workflow-strip">
                      <div className="workflow-copy">
                        <span className="workflow-number">01</span>
                        <div>
                          <strong>Find a Skill</strong>
                          <span>Search or browse the explorer</span>
                        </div>
                      </div>
                      <ChevronRight size={15} />
                      <div className="workflow-copy">
                        <span className="workflow-number">02</span>
                        <div>
                          <strong>Read the source</strong>
                          <span>Keep multiple files open in tabs</span>
                        </div>
                      </div>
                      <ChevronRight size={15} />
                      <div className="workflow-copy">
                        <span className="workflow-number">03</span>
                        <div>
                          <strong>Make a change</strong>
                          <span>Open in your preferred editor</span>
                        </div>
                      </div>
                    </section>
                    <div className="overview-bottom">
                      <span>
                        ZSkills <span className="muted">/</span> A small
                        workspace for understanding Skills.
                      </span>
                      <span>
                        <Command size={11} /> K{' '}
                        <span className="muted">to find a Skill</span>
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : activeTab ? (
            <>
              <div className="reader-toolbar">
                <div className="breadcrumbs">
                  <BookOpen size={13} />
                  <button
                    onClick={() => {
                      setSidebarVisible(true);
                      revealSkill(activeTab.skillId);
                      setExpanded((previous) =>
                        new Set(previous).add(activeTab.skillId),
                      );
                      void loadDetail(activeTab.skillId);
                    }}
                    title={activeSkill?.path}
                  >
                    {activeSkill?.name || 'Skill'}
                  </button>
                  <ChevronRight size={12} />
                  {activeTab.path.split('/').map((part, index, parts) => (
                    <span
                      key={`${part}-${index}`}
                      className={
                        index === parts.length - 1 ? 'breadcrumb-current' : ''
                      }
                    >
                      {part}
                      {index < parts.length - 1 && <ChevronRight size={12} />}
                    </span>
                  ))}
                </div>
                <div className="reader-actions">
                  {currentFile?.content?.kind === 'markdown' && (
                    <div
                      className="mode-switch"
                      role="group"
                      aria-label="File view mode"
                    >
                      <button
                        className={!sourceMode ? 'selected' : ''}
                        onClick={() => setSourceMode(false)}
                      >
                        Preview
                      </button>
                      <button
                        className={sourceMode ? 'selected' : ''}
                        onClick={() => setSourceMode(true)}
                      >
                        Source
                      </button>
                    </div>
                  )}
                  <button
                    className="icon-button"
                    onClick={() => void copyPath()}
                    title="Copy file path"
                    aria-label="Copy file path"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => {
                      void loadFile(activeTab.skillId, activeTab.path, true);
                      void loadDetail(activeTab.skillId, true);
                    }}
                    title="Reload file after saving in your editor"
                    aria-label="Reload current file"
                    disabled={currentFile?.loading}
                  >
                    <RefreshCw
                      size={13}
                      className={currentFile?.loading ? 'spin' : ''}
                    />
                  </button>
                  <div className="editor-action">
                    <div className="split-button">
                      <button
                        onClick={() => void openInEditor('skill')}
                        disabled={openLoading}
                        title={`Open the Skill folder on ${workspace?.host.hostname || 'the service computer'}`}
                      >
                        {openLoading ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : (
                          <ExternalLink size={13} />
                        )}
                        <span>Open in editor</span>
                      </button>
                      <button
                        className="split-toggle"
                        onClick={() => setOpenMenu((value) => !value)}
                        aria-label="More editor actions"
                        aria-expanded={openMenu}
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>
                    {openMenu && (
                      <div className="dropdown-menu">
                        <button onClick={() => void openInEditor('skill')}>
                          <Folder size={14} />
                          Open Skill folder
                        </button>
                        <button onClick={() => void openInEditor('file')}>
                          <FileCode2 size={14} />
                          Open current file
                        </button>
                        <div className="menu-divider" />
                        <button
                          onClick={() => {
                            setOpenMenu(false);
                            setModal('editor');
                          }}
                        >
                          <Settings2 size={14} />
                          Editor settings
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="file-info-strip">
                <span
                  className={`source-dot source-${activeSkill?.source || 'custom'}`}
                />
                <span>
                  {activeSkill
                    ? SOURCE_LABELS[activeSkill.source]
                    : 'Skill source'}
                </span>
                <span
                  className="file-info-path"
                  title={
                    activeSkill
                      ? `${workspace?.host.hostname}: ${activeSkill.path}/${activeTab.path}`
                      : activeTab.path
                  }
                >
                  {activeSkill
                    ? shortPath(activeSkill.path, workspace?.host.homeDir)
                    : ''}
                  /{activeTab.path}
                </span>
                {currentFile?.content && (
                  <span>{sizeLabel(currentFile.content.size)}</span>
                )}
                <span className="file-readonly">READ ONLY</span>
              </div>
              <div
                className="reader-scroll"
                ref={readerRef}
                onScroll={(event) => {
                  scrollPositions.current[activeId] =
                    event.currentTarget.scrollTop;
                }}
              >
                {currentFile?.loading && !currentFile.content ? (
                  <div className="reader-state">
                    <LoaderCircle size={24} className="spin" />
                    <h3>Loading {basename(activeTab.path)}</h3>
                    <p>Reading the file from the service computer.</p>
                  </div>
                ) : currentFile?.error ? (
                  <div className="reader-state error-state">
                    <CircleAlert size={27} />
                    <h3>This file could not be read</h3>
                    <p>{currentFile.error}</p>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void loadFile(activeTab.skillId, activeTab.path, true)
                      }
                    >
                      <RefreshCw size={13} />
                      Try again
                    </button>
                  </div>
                ) : currentFile?.content ? (
                  <>
                    {currentFile.content.kind === 'markdown' && !sourceMode ? (
                      <MarkdownPreview
                        content={currentFile.content.content}
                        skillId={activeTab.skillId}
                        path={activeTab.path}
                        onOpen={openRelatedFile}
                      />
                    ) : currentFile.content.kind === 'image' ? (
                      <div className="image-viewer">
                        <img
                          src={currentFile.content.content}
                          alt={basename(activeTab.path)}
                        />
                        <span>
                          {activeTab.path} ·{' '}
                          {sizeLabel(currentFile.content.size)}
                        </span>
                      </div>
                    ) : currentFile.content.kind === 'unsupported' ? (
                      <div className="reader-state">
                        <File size={28} />
                        <h3>Preview is unavailable for this file</h3>
                        <p>
                          {basename(activeTab.path)} ·{' '}
                          {sizeLabel(currentFile.content.size)}
                          <br />
                          Open the file in your editor to inspect it.
                        </p>
                        <button
                          className="secondary-button"
                          onClick={() => void openInEditor('file')}
                        >
                          <ExternalLink size={13} />
                          Open current file
                        </button>
                      </div>
                    ) : (
                      <div className="source-view" aria-label="Source code">
                        <div className="line-numbers" aria-hidden="true">
                          {currentFile.content.content
                            .split('\n')
                            .map((_, index) => (
                              <span key={index}>{index + 1}</span>
                            ))}
                        </div>
                        <pre>
                          <code>{currentFile.content.content}</code>
                        </pre>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="reader-state">
                    <LoaderCircle size={24} className="spin" />
                    <p>Opening file…</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="reader-state">
              <FileText size={28} />
              <h3>Select a Skill to start reading</h3>
              <button
                className="small-link"
                onClick={() => setActiveId('home')}
              >
                Return to overview
              </button>
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <div>
          <span
            className={`status-connection ${workspaceError ? 'disconnected' : ''}`}
          >
            <span className="connection-dot" />
            {workspaceError
              ? 'Disconnected'
              : workspace
                ? 'Connected'
                : 'Connecting'}
          </span>
          <span className="status-host">
            <Laptop size={11} />
            {workspace?.host.hostname || 'Service computer'}
          </span>
          <span>{workspace?.skills.length ?? '—'} Skills</span>
        </div>
        <div>
          <button
            onClick={() => void rescan()}
            disabled={scanBusy || mutationLoading || !workspace}
          >
            <RefreshCw size={11} className={scanBusy ? 'spin' : ''} />
            <span>
              {scanBusy
                ? `Searching · ${workspace?.scanProgress.directoriesScanned.toLocaleString() || 0} folders checked`
                : workspace && workspace.scanProgress.phase !== 'complete'
                  ? 'Search interrupted · Rescan'
                  : workspace?.scanProgress.restoredFromCache
                    ? 'Cached results · awaiting verification'
                    : `Searched ${timeLabel(workspace?.lastScannedAt || null)}`}
            </span>
          </button>
          <span className="footer-divider" />
          <span>
            {activeTab
              ? currentFile?.content?.kind === 'markdown' && !sourceMode
                ? 'Markdown preview'
                : 'Source viewer'
              : 'Workspace overview'}
          </span>
          <span className="readonly-status">
            <CheckCheck size={11} />
            Read only
          </span>
        </div>
      </footer>

      {toast && (
        <div
          className={`toast ${toast.error ? 'toast-error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <CircleAlert size={16} /> : <Check size={16} />}
          <span>{toast.message}</span>
          <button
            className="icon-button tiny"
            onClick={() => setToast(undefined)}
            aria-label="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {modal === 'sources' && (
        <Dialog
          title="Scan sources"
          subtitle={`Folders are read on ${workspace?.host.hostname || 'the service computer'}.`}
          onClose={closeModal}
          footer={
            <>
              <span>Scanning does not run or modify Skills.</span>
              <button
                className="secondary-button"
                onClick={() => void rescan()}
                disabled={scanBusy || mutationLoading || !workspace}
              >
                <RefreshCw size={13} className={scanBusy ? 'spin' : ''} />
                {scanBusy ? 'Scanning…' : 'Rescan all'}
              </button>
            </>
          }
        >
          <div className="source-scope-note">
            <Home size={15} />
            <p>
              Your Home directory is always searched, including Skills inside
              repositories. Add folders for Skills stored elsewhere, such as on
              an external drive.
            </p>
          </div>
          {workspace && (
            <ScanCoverage
              workspace={workspace}
              detailed
              pending={rescanLoading || mutationLoading}
            />
          )}
          <div className="dialog-section-heading">
            <span>SCAN FOLDERS</span>
            <span>{workspace?.roots.length || 0} configured</span>
          </div>
          <div className="roots-list">
            {workspace?.roots.map((root) => (
              <div key={root.id} className="root-item">
                <Folder
                  size={17}
                  className={root.status === 'ready' ? 'root-folder' : 'muted'}
                />
                <div className="root-copy">
                  <div>
                    <strong>{root.label}</strong>
                    <span className={`root-status ${root.status}`}>
                      {root.status === 'ready'
                        ? `${root.skillCount} Skills`
                        : root.status === 'partial'
                          ? `${root.skillCount} Skills · Partly read`
                          : root.status === 'missing'
                            ? 'Not found'
                            : root.status === 'scanning'
                              ? workspace.scanning
                                ? `${root.skillCount} Skills · Scanning`
                                : 'Search interrupted'
                              : 'Cannot read'}
                    </span>
                  </div>
                  <code title={root.path}>
                    {shortPath(root.path, workspace.host.homeDir)}
                  </code>
                  {root.error && <p className="error-text">{root.error}</p>}
                </div>
                {root.removable && (
                  <button
                    className="icon-button"
                    aria-label={`Remove ${root.label} from scan sources`}
                    title="Remove scan source"
                    disabled={mutationLoading || scanBusy}
                    onClick={() => void removeRoot(root.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            {!workspace?.roots.length && (
              <p className="muted">No scan folders configured.</p>
            )}
          </div>
          <form
            className="add-root-form"
            onSubmit={(event) => {
              event.preventDefault();
              void addRoot();
            }}
          >
            <label htmlFor="root-path">Add an extra folder</label>
            <p>
              Enter an absolute path on the service computer. Home already
              includes your repository Skills; extra folders can cover other
              locations.
            </p>
            <div>
              <input
                id="root-path"
                value={newRoot}
                onChange={(event) => setNewRoot(event.target.value)}
                placeholder="/Volumes/Work/skills"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="primary-button"
                type="submit"
                disabled={mutationLoading || scanBusy || !newRoot.trim()}
              >
                {mutationLoading ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Plus size={13} />
                )}
                Add folder
              </button>
            </div>
          </form>
          {modalError && (
            <div className="inline-error" role="alert">
              <CircleAlert size={14} />
              {modalError}
            </div>
          )}
          <div className="dialog-tip">
            <CircleHelp size={15} />
            <p>
              A Skill on disk may not be enabled in your agent. This workspace
              shows discovered files, not an agent's active configuration.
            </p>
          </div>
        </Dialog>
      )}
      {modal === 'editor' && (
        <Dialog
          title="Your editor"
          subtitle="Choose how to open Skills for editing."
          onClose={closeModal}
          footer={
            <>
              <span>Preferences are saved on the service computer.</span>
              <button className="primary-button" onClick={closeModal}>
                Done
              </button>
            </>
          }
        >
          <div className="editor-choices">
            {EDITORS.map(({ value, label, description, icon: Icon }) => (
              <button
                key={value}
                className={`editor-choice ${workspace?.editor.editor === value ? 'selected' : ''}`}
                onClick={() => void setEditor(value)}
                disabled={mutationLoading || !workspace}
                aria-pressed={workspace?.editor.editor === value}
              >
                <span className="editor-choice-icon">
                  <Icon size={20} />
                </span>
                <span>
                  <strong>{label}</strong>
                  <span>{description}</span>
                </span>
                <span className="radio-indicator">
                  {workspace?.editor.editor === value && <span />}
                </span>
              </button>
            ))}
          </div>
          {workspace && !workspace.editor.available && (
            <div className="inline-error">
              <CircleAlert size={14} />
              The selected editor is unavailable on this computer. Install it or
              choose another editor.
            </div>
          )}
          {modalError && (
            <div className="inline-error" role="alert">
              <CircleAlert size={14} />
              {modalError}
            </div>
          )}
          <div className="editor-host-note">
            <Laptop size={16} />
            <div>
              <strong>
                Opens on {workspace?.host.hostname || 'the service computer'}
              </strong>
              <p>
                When connected to a remote service, an editor must be available
                on that host. A remote computer without a desktop may not be
                able to open an app.
              </p>
            </div>
          </div>
          <div className="dialog-tip">
            <RefreshCw size={14} />
            <p>
              Save your changes in the editor, then reload the file in ZSkills
              to see the latest version.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
