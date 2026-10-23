export type SourceKind = 'personal' | 'project' | 'cache' | 'custom';
export type EditorChoice = 'system' | 'vscode' | 'zed';

export interface SourceRoot {
  id: string;
  label: string;
  path: string;
  kind: SourceKind;
  status: 'ready' | 'missing' | 'error' | 'scanning';
  skillCount: number;
  error?: string;
  removable: boolean;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  rootId: string;
  source: SourceKind;
  modifiedAt: string;
  issue?: string;
}

export interface EditorSettings {
  editor: EditorChoice;
  available: boolean;
}

export interface WorkspaceSnapshot {
  host: {
    hostname: string;
    platform: string;
    homeDir: string;
    editorAvailable: boolean;
  };
  skills: SkillRecord[];
  roots: SourceRoot[];
  lastScannedAt: string | null;
  scanning: boolean;
  editor: EditorSettings;
}

export interface FileEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number;
}

export interface SkillDetail {
  skill: SkillRecord;
  files: FileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  kind: 'markdown' | 'text' | 'image' | 'unsupported';
  size: number;
  mimeType?: string;
  modifiedAt: string;
}
