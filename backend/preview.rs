//! Read-only, bounded Skill previews and explicit editor handoff.
use crate::{models::*, service::ServiceError};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::HashSet,
    ffi::{CStr, CString, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStringExt, fs::OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_DEPTH: usize = 16;
const MAX_FILES: usize = 5_000;
const MAX_TEXT_SIZE: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_SIZE: u64 = 8 * 1024 * 1024;
const EXCLUDED: &[&str] = &[
    ".git",
    "node_modules",
    "vendor",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".Trash",
    "target",
    ".tox",
    "coverage",
];

fn io_error(error: io::Error) -> ServiceError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => {
            ServiceError::new(403, "This file cannot be read on the service host.")
        }
        _ => ServiceError::new(
            404,
            "File not found or no longer available. Reload the Skill to refresh its files.",
        ),
    }
}

fn validate_relative(relative: &str) -> Result<(), ServiceError> {
    if relative.is_empty()
        || (relative.contains('\0') || relative.contains('\\'))
        || Path::new(relative).is_absolute()
        || relative.split('/').any(|part| part == "..")
    {
        return Err(ServiceError::new(
            400,
            "Choose a relative file path within this Skill.",
        ));
    }
    Ok(())
}

pub fn resolve_file(skill: &SkillRecord, relative: &str) -> Result<PathBuf, ServiceError> {
    validate_relative(relative)?;
    let root = Path::new(&skill.path);
    let canonical = fs::canonicalize(root.join(relative)).map_err(io_error)?;
    if !within(root, &canonical) {
        return Err(ServiceError::new(
            403,
            "Symlinks outside this Skill cannot be opened.",
        ));
    }
    let root_handle = open_root(root)?;
    let file = open_beneath(
        &root_handle,
        canonical
            .strip_prefix(root)
            .map_err(|_| ServiceError::new(403, "The file is outside this Skill."))?,
    )
    .map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(ServiceError::new(400, "Choose a regular file."));
    }
    Ok(canonical)
}

// Canonical paths may race with filesystem changes. Opening every component
// relative to a directory descriptor prevents a swapped symlink from escaping.
fn open_root(root: &Path) -> Result<File, ServiceError> {
    if !root.is_absolute() || fs::canonicalize(root).map_err(io_error)? != root {
        return Err(ServiceError::new(
            403,
            "The Skill location changed. Rescan before opening it.",
        ));
    }
    let anchor = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open("/")
        .map_err(io_error)?;
    let directory = open_beneath(
        &anchor,
        root.strip_prefix("/")
            .map_err(|_| ServiceError::new(403, "The Skill location is invalid."))?,
    )
    .map_err(io_error)?;
    if !directory.metadata().map_err(io_error)?.is_dir() {
        return Err(ServiceError::new(
            404,
            "The Skill directory is no longer available.",
        ));
    }
    Ok(directory)
}

fn open_beneath(root: &File, relative: &Path) -> io::Result<File> {
    let components: Vec<_> = relative
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect();
    let mut current = root.try_clone()?;
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid anchored file path.",
            ));
        };
        use std::os::unix::ffi::OsStrExt;
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid file name."))?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if index + 1 < components.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // The parent descriptor stays alive until openat returns. A successful
        // descriptor is owned exclusively by the File constructed below.
        let descriptor = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        current = unsafe { File::from_raw_fd(descriptor) };
    }
    Ok(current)
}

#[cfg(target_os = "macos")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
#[cfg(not(target_os = "macos"))]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

struct DirectoryEntries {
    stream: *mut libc::DIR,
    finished: bool,
}
impl DirectoryEntries {
    fn new(directory: &File) -> io::Result<Self> {
        // fdopendir owns and closes its duplicate; the caller retains its anchor.
        let descriptor = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(descriptor);
            }
            return Err(error);
        }
        Ok(Self {
            stream,
            finished: false,
        })
    }
}
impl Iterator for DirectoryEntries {
    type Item = io::Result<OsString>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            unsafe {
                *errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(self.stream) };
            if entry.is_null() {
                self.finished = true;
                let error = unsafe { *errno_location() };
                return if error == 0 {
                    None
                } else {
                    Some(Err(io::Error::from_raw_os_error(error)))
                };
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name != b"." && name != b".." {
                return Some(Ok(OsString::from_vec(name.to_vec())));
            }
        }
    }
}
impl Drop for DirectoryEntries {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.stream);
        }
    }
}

pub fn get_skill(skill: SkillRecord) -> Result<SkillDetail, ServiceError> {
    let root = Path::new(&skill.path);
    let anchor = open_root(root)?;
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    let mut pending = vec![(root.to_path_buf(), PathBuf::new(), 0usize)];
    while let Some((directory, relative, depth)) = pending.pop() {
        if depth > MAX_DEPTH || !visited.insert(directory.clone()) {
            continue;
        }
        let directory_handle = open_beneath(
            &anchor,
            directory
                .strip_prefix(root)
                .map_err(|_| ServiceError::new(403, "The directory is outside this Skill."))?,
        )
        .map_err(io_error)?;
        let names = DirectoryEntries::new(&directory_handle).map_err(io_error)?;
        let mut entries = Vec::new();
        for name in names {
            let name = name.map_err(io_error)?;
            if EXCLUDED.iter().any(|excluded| name == *excluded) {
                continue;
            }
            let Ok(resolved) = fs::canonicalize(directory.join(&name)) else {
                continue;
            };
            let Ok(root_relative) = resolved.strip_prefix(root) else {
                continue;
            };
            let Ok(handle) = open_beneath(&anchor, root_relative) else {
                continue;
            };
            let Ok(metadata) = handle.metadata() else {
                continue;
            };
            if metadata.is_file() || metadata.is_dir() {
                entries.push((name, resolved, metadata));
                if files.len() + entries.len() > MAX_FILES {
                    return Err(ServiceError::new(
                        413,
                        "This Skill exceeds the 5,000 file listing limit.",
                    ));
                }
            }
        }
        entries.sort_by(|a, b| b.2.is_dir().cmp(&a.2.is_dir()).then_with(|| a.0.cmp(&b.0)));
        let mut children = Vec::new();
        for (name, resolved, metadata) in entries {
            let entry_relative = relative.join(name);
            files.push(FileEntry {
                path: entry_relative.to_string_lossy().into_owned(),
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                size: if metadata.is_dir() { 0 } else { metadata.len() },
            });
            if files.len() > MAX_FILES {
                return Err(ServiceError::new(
                    413,
                    "This Skill exceeds the 5,000 file listing limit.",
                ));
            }
            if metadata.is_dir() {
                children.push((resolved, entry_relative, depth + 1));
            }
        }
        pending.extend(children.into_iter().rev());
    }
    Ok(SkillDetail { skill, files })
}

fn image_type(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

pub fn get_file(skill: &SkillRecord, relative: &str) -> Result<FileContent, ServiceError> {
    let canonical = resolve_file(skill, relative)?;
    let root = Path::new(&skill.path);
    let anchor = open_root(root)?;
    let file = open_beneath(
        &anchor,
        canonical
            .strip_prefix(root)
            .map_err(|_| ServiceError::new(403, "The file is outside this Skill."))?,
    )
    .map_err(io_error)?;
    let information = file.metadata().map_err(io_error)?;
    if !information.is_file() {
        return Err(ServiceError::new(400, "Choose a regular file."));
    }
    let modified: chrono::DateTime<chrono::Utc> = information.modified().map_err(io_error)?.into();
    let mut result = FileContent {
        path: relative.into(),
        content: String::new(),
        kind: "unsupported".into(),
        size: information.len(),
        modified_at: modified.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        mime_type: None,
    };
    let extension = Path::new(relative)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = image_type(&extension);
    let limit = if mime.is_some() {
        MAX_IMAGE_SIZE
    } else {
        MAX_TEXT_SIZE
    };
    if information.len() > limit {
        return Ok(result);
    }
    let mut bytes = Vec::with_capacity((information.len().min(limit) + 1) as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > limit {
        return Ok(result);
    }
    if let Some(mime) = mime {
        result.kind = "image".into();
        result.content = format!("data:{mime};base64,{}", STANDARD.encode(bytes));
        result.mime_type = Some(mime.into());
    } else if !bytes.contains(&0)
        && let Ok(mut text) = String::from_utf8(bytes)
    {
        if text.starts_with('\u{feff}') {
            text.remove(0);
        }
        result.kind = if ["md", "markdown", "mdx"].contains(&extension.as_str()) {
            "markdown"
        } else {
            "text"
        }
        .into();
        result.content = text;
    }
    Ok(result)
}

#[derive(Debug, PartialEq)]
struct EditorLaunch {
    command: PathBuf,
    args: Vec<OsString>,
}

struct EditorContext {
    platform: String,
    home: PathBuf,
    path: OsString,
    graphical_session: bool,
}
impl EditorContext {
    fn current(home: &Path) -> Self {
        Self {
            platform: std::env::consts::OS.into(),
            home: home.into(),
            path: std::env::var_os("PATH").unwrap_or_default(),
            graphical_session: ["DISPLAY", "WAYLAND_DISPLAY"]
                .iter()
                .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty())),
        }
    }
    fn command(&self, editor: &str, target: &Path) -> Option<EditorLaunch> {
        if !["system", "vscode", "zed"].contains(&editor)
            || (self.platform == "linux" && !self.graphical_session)
        {
            return None;
        }
        if self.platform == "macos" {
            if !executable(Path::new("/usr/bin/open")) {
                return None;
            }
            if editor == "system" {
                return Some(EditorLaunch {
                    command: "/usr/bin/open".into(),
                    args: vec![target.into()],
                });
            }
            let application = if editor == "vscode" {
                "Visual Studio Code.app"
            } else {
                "Zed.app"
            };
            for applications in [
                PathBuf::from("/Applications"),
                self.home.join("Applications"),
            ] {
                let candidate = applications.join(application);
                if candidate.is_dir() {
                    return Some(EditorLaunch {
                        command: "/usr/bin/open".into(),
                        args: vec!["-a".into(), candidate.into_os_string(), target.into()],
                    });
                }
            }
        }
        if self.platform != "macos" && self.platform != "linux" {
            return None;
        }
        let name = match editor {
            "system" => "xdg-open",
            "vscode" => "code",
            _ => "zed",
        };
        std::env::split_paths(&self.path)
            .filter(|directory| !directory.as_os_str().is_empty())
            .map(|directory| directory.join(name))
            .find(|candidate| executable(candidate))
            .map(|command| EditorLaunch {
                command,
                args: vec![target.into()],
            })
    }
}

fn executable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        && unsafe { libc::access(name.as_ptr(), libc::X_OK) } == 0
}

pub fn editor_settings(editor: &str, home: &Path) -> EditorSettings {
    EditorSettings {
        editor: editor.into(),
        available: EditorContext::current(home)
            .command(editor, Path::new(""))
            .is_some(),
    }
}

fn launch_process(launch: &EditorLaunch) -> Result<(), ServiceError> {
    let failure = || {
        ServiceError::new(
            503,
            "The editor could not be opened. Check that it is installed and available on this host.",
        )
    };
    let mut child = Command::new(&launch.command)
        .args(&launch.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failure())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(failure())
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failure());
            }
        }
    }
}

fn open_editor_with(
    skill: &SkillRecord,
    editor: &str,
    scope: &str,
    relative: Option<&str>,
    context: &EditorContext,
    launch: impl FnOnce(&EditorLaunch) -> Result<(), ServiceError>,
) -> Result<serde_json::Value, ServiceError> {
    if !["skill", "file"].contains(&scope) {
        return Err(ServiceError::new(400, "Choose a Skill or file to open."));
    }
    let target = if scope == "file" {
        resolve_file(
            skill,
            relative.ok_or_else(|| ServiceError::new(400, "Choose a file to open."))?,
        )?
    } else if editor == "system" {
        resolve_file(skill, "SKILL.md")?
    } else {
        let _ = open_root(Path::new(&skill.path))?;
        PathBuf::from(&skill.path)
    };
    let command = context.command(editor, &target).ok_or_else(|| ServiceError::new(503, "The selected editor is unavailable on this host. Choose an installed editor or open the path on the host computer."))?;
    launch(&command)?;
    Ok(
        serde_json::json!({"message": "Editor open request sent. Save your changes, then reload the file."}),
    )
}

pub fn open_editor(
    skill: &SkillRecord,
    editor: &str,
    scope: &str,
    relative: Option<&str>,
    home: &Path,
) -> Result<serde_json::Value, ServiceError> {
    open_editor_with(
        skill,
        editor,
        scope,
        relative,
        &EditorContext::current(home),
        launch_process,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tempfile::TempDir;

    fn fixture() -> (TempDir, SkillRecord) {
        let temp = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(temp.path())
            .unwrap()
            .join("a $(ignored); skill");
        fs::create_dir(&path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            "---\nname: Example\ndescription: A safe preview\n---\n# Example\n",
        )
        .unwrap();
        (
            temp,
            SkillRecord {
                id: "example".into(),
                name: "Example".into(),
                description: "A safe preview".into(),
                path: path.to_string_lossy().into_owned(),
                root_id: "root".into(),
                source: "home".into(),
                modified_at: now(),
                issue: None,
            },
        )
    }

    #[test]
    fn previews_preserve_types_and_reject_binary_and_large_files() {
        let (_temp, skill) = fixture();
        let root = Path::new(&skill.path);
        fs::write(root.join("source.ts"), "console.log('source only');").unwrap();
        fs::write(root.join("nul.bin"), [0, 1, 2]).unwrap();
        fs::write(root.join("invalid.txt"), [0xff, 0xfe]).unwrap();
        fs::write(root.join("image.PNG"), [137, 80, 78, 71]).unwrap();
        File::create(root.join("large.txt"))
            .unwrap()
            .set_len(MAX_TEXT_SIZE + 1)
            .unwrap();
        File::create(root.join("large.png"))
            .unwrap()
            .set_len(MAX_IMAGE_SIZE + 1)
            .unwrap();
        assert_eq!(get_file(&skill, "SKILL.md").unwrap().kind, "markdown");
        assert_eq!(get_file(&skill, "source.ts").unwrap().kind, "text");
        for path in ["nul.bin", "invalid.txt", "large.txt", "large.png"] {
            assert_eq!(get_file(&skill, path).unwrap().kind, "unsupported");
        }
        let image = get_file(&skill, "image.PNG").unwrap();
        assert_eq!(image.kind, "image");
        assert_eq!(image.content, "data:image/png;base64,iVBORw==");
        assert_eq!(image.mime_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn previews_block_traversal_external_links_and_special_files() {
        let (temp, skill) = fixture();
        let root = Path::new(&skill.path);
        fs::write(temp.path().join("outside.txt"), "private external text").unwrap();
        symlink(temp.path().join("outside.txt"), root.join("escape.txt")).unwrap();
        symlink(root.join("SKILL.md"), root.join("internal.md")).unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        fs::write(
            root.join("scripts/example.sh"),
            "#!/bin/sh\ntouch should-never-exist\n",
        )
        .unwrap();
        for invalid in [
            "../outside.txt",
            "/etc/passwd",
            "..\\outside.txt",
            "escape.txt",
            "x\0y",
            "",
        ] {
            assert!(
                matches!(get_file(&skill, invalid), Err(error) if [400,403].contains(&error.status))
            );
        }
        assert_eq!(get_file(&skill, "internal.md").unwrap().kind, "markdown");
        let fifo = CString::new(root.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(matches!(get_file(&skill, "pipe"), Err(error) if error.status == 400));
        let files = get_skill(skill.clone()).unwrap().files;
        assert!(
            !files
                .iter()
                .any(|file| file.path == "escape.txt" || file.path == "pipe")
        );
        assert!(files.iter().any(|file| file.path == "scripts/example.sh"));
        assert!(!root.join("should-never-exist").exists());
    }

    #[test]
    fn anchored_open_refuses_replaced_directory_components() {
        let (temp, skill) = fixture();
        let root = Path::new(&skill.path);
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/file.txt"), "inside").unwrap();
        let resolved = resolve_file(&skill, "nested/file.txt").unwrap();
        let anchor = open_root(root).unwrap();
        fs::rename(root.join("nested"), root.join("old")).unwrap();
        fs::create_dir(temp.path().join("outside")).unwrap();
        fs::write(temp.path().join("outside/file.txt"), "outside").unwrap();
        symlink(temp.path().join("outside"), root.join("nested")).unwrap();
        assert!(open_beneath(&anchor, resolved.strip_prefix(root).unwrap()).is_err());
    }

    #[test]
    fn listing_limits_are_preview_only_and_cycles_terminate() {
        let (_temp, skill) = fixture();
        let root = Path::new(&skill.path);
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules/hidden.txt"),
            "still directly readable",
        )
        .unwrap();
        symlink(root, root.join("cycle")).unwrap();
        let mut deep = root.to_path_buf();
        for _ in 0..18 {
            deep = deep.join("nested");
            fs::create_dir(&deep).unwrap();
        }
        fs::write(deep.join("deep.txt"), "direct preview").unwrap();
        let detail = get_skill(skill.clone()).unwrap();
        assert!(
            detail
                .files
                .iter()
                .all(|file| !file.path.starts_with("node_modules")
                    && !file.path.ends_with("deep.txt"))
        );
        assert_eq!(
            get_file(&skill, "node_modules/hidden.txt").unwrap().content,
            "still directly readable"
        );
        assert_eq!(
            get_file(
                &skill,
                deep.join("deep.txt")
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
            )
            .unwrap()
            .content,
            "direct preview"
        );
        assert!(detail.files.len() < 30);
    }

    #[test]
    fn listing_rejects_excessive_file_counts() {
        let (_temp, skill) = fixture();
        for index in 0..MAX_FILES {
            File::create(Path::new(&skill.path).join(format!("file-{index}"))).unwrap();
        }
        assert!(matches!(get_skill(skill), Err(error) if error.status == 413));
    }

    #[test]
    fn editor_arguments_remain_literal_and_launch_only_after_explicit_request() {
        let (temp, skill) = fixture();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        for name in ["code", "xdg-open"] {
            fs::write(bin.join(name), "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let context = EditorContext {
            platform: "linux".into(),
            home: temp.path().into(),
            path: bin.clone().into_os_string(),
            graphical_session: true,
        };
        get_skill(skill.clone()).unwrap();
        get_file(&skill, "SKILL.md").unwrap();
        let mut launches = Vec::new();
        open_editor_with(&skill, "vscode", "skill", None, &context, |launch| {
            launches.push(EditorLaunch {
                command: launch.command.clone(),
                args: launch.args.clone(),
            });
            Ok(())
        })
        .unwrap();
        open_editor_with(&skill, "system", "skill", None, &context, |launch| {
            launches.push(EditorLaunch {
                command: launch.command.clone(),
                args: launch.args.clone(),
            });
            Ok(())
        })
        .unwrap();
        assert_eq!(
            launches[0],
            EditorLaunch {
                command: bin.join("code"),
                args: vec![PathBuf::from(&skill.path).into_os_string()]
            }
        );
        assert_eq!(
            launches[1],
            EditorLaunch {
                command: bin.join("xdg-open"),
                args: vec![Path::new(&skill.path).join("SKILL.md").into_os_string()]
            }
        );
        assert!(
            open_editor_with(
                &skill,
                "vscode",
                "file",
                Some("../outside.txt"),
                &context,
                |_| panic!("Invalid paths must never launch an editor.")
            )
            .is_err()
        );
        let headless = EditorContext {
            graphical_session: false,
            ..context
        };
        assert!(
            matches!(open_editor_with(&skill, "vscode", "skill", None, &headless, |_| panic!("Unavailable editors must never launch.")), Err(error) if error.status == 503)
        );
        assert_eq!(launches.len(), 2);
    }

    #[test]
    fn editor_launcher_checks_exit_status_without_using_a_shell() {
        let temp = tempfile::tempdir().unwrap();
        let successful = temp.path().join("success");
        let failed = temp.path().join("failure");
        for (path, script) in [
            (&successful, "#!/bin/sh\nexit 0\n"),
            (&failed, "#!/bin/sh\nexit 3\n"),
        ] {
            fs::write(path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let marker = temp.path().join("should-not-execute");
        let argument = format!("$(touch '{}'); literal", marker.display());
        launch_process(&EditorLaunch {
            command: successful,
            args: vec![argument.into()],
        })
        .unwrap();
        assert!(!marker.exists());
        assert!(
            matches!(launch_process(&EditorLaunch { command: failed, args: vec![] }), Err(error) if error.status == 503)
        );
    }
}
