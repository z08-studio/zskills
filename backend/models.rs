use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub type Entries = BTreeMap<String, CachedSkill>;
pub const CACHED_ISSUE: &str = "Cached metadata; awaiting filesystem validation.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRoot {
    pub id: String,
    pub label: String,
    pub path: String,
    pub kind: String,
    pub status: String,
    pub skill_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub removable: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub root_id: String,
    pub source: String,
    pub modified_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSignature {
    pub mtime_ms: f64,
    pub ctime_ms: f64,
    pub size: u64,
    pub ino: u64,
    pub dev: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSkill {
    pub record: SkillRecord,
    pub source_path: String,
    pub signature: FileSignature,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanIssue {
    pub path: String,
    pub message: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub directories_scanned: usize,
    pub candidates_checked: usize,
    pub invalid_skills: usize,
    pub unreadable_directories: usize,
    pub external_links_skipped: usize,
    pub current_path: Option<String>,
    pub restored_from_cache: bool,
    pub watching: bool,
    pub issues: Vec<ScanIssue>,
}
impl Default for ScanProgress {
    fn default() -> Self {
        Self {
            phase: "quick".into(),
            started_at: now(),
            completed_at: None,
            directories_scanned: 0,
            candidates_checked: 0,
            invalid_skills: 0,
            unreadable_directories: 0,
            external_links_skipped: 0,
            current_path: None,
            restored_from_cache: false,
            watching: false,
            issues: vec![],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub hostname: String,
    pub platform: String,
    pub home_dir: String,
    pub editor_available: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditorSettings {
    pub editor: String,
    pub available: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub host: HostInfo,
    pub skills: Vec<SkillRecord>,
    pub roots: Vec<SourceRoot>,
    pub last_scanned_at: Option<String>,
    pub scanning: bool,
    pub scan_progress: ScanProgress,
    pub editor: EditorSettings,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub kind: String,
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SkillDetail {
    pub skill: SkillRecord,
    pub files: Vec<FileEntry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn stable_id(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..24].to_string()
}
pub fn within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}
pub fn add_issue(progress: &mut ScanProgress, path: String, message: String) {
    if progress.issues.len() < 50 {
        progress.issues.push(ScanIssue { path, message });
    }
}
