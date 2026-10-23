use crate::models::{
    CachedSkill, Entries, FileSignature, ScanProgress, SkillRecord, SourceRoot, add_issue, now,
    stable_id, within,
};
use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions, ReadDir},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_METADATA_SIZE: u64 = 2 * 1024 * 1024;
const DIRECTORY_WORKERS: usize = 4;
const DIRECTORY_QUEUE_SIZE: usize = 64;
const PUBLISH_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug)]
pub struct ScanError {
    pub io: bool,
    pub message: String,
}

impl ScanError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            io: false,
            message: message.into(),
        }
    }
}

impl From<io::Error> for ScanError {
    fn from(error: io::Error) -> Self {
        Self {
            io: true,
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ScanError {}

fn signature(information: &fs::Metadata) -> FileSignature {
    FileSignature {
        mtime_ms: information.mtime() as f64 * 1000.0
            + information.mtime_nsec() as f64 / 1_000_000.0,
        ctime_ms: information.ctime() as f64 * 1000.0
            + information.ctime_nsec() as f64 / 1_000_000.0,
        size: information.len(),
        ino: information.ino(),
        dev: information.dev(),
    }
}

fn same_signature(a: &FileSignature, b: &FileSignature) -> bool {
    a.mtime_ms == b.mtime_ms
        && a.ctime_ms == b.ctime_ms
        && a.size == b.size
        && a.ino == b.ino
        && a.dev == b.dev
}

fn frontmatter(content: &str) -> Result<&str, ScanError> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (opening, body) = content
        .split_once('\n')
        .ok_or_else(|| ScanError::invalid("No YAML frontmatter found."))?;
    // Horizontal whitespace after a delimiter is presentation, not content.
    // Keep escaped, indented, or longer markers distinct from frontmatter.
    if opening
        .strip_suffix('\r')
        .unwrap_or(opening)
        .trim_end_matches([' ', '\t'])
        != "---"
    {
        return Err(ScanError::invalid("No YAML frontmatter found."));
    }
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if line
            .trim_end_matches(['\r', '\n'])
            .trim_end_matches([' ', '\t'])
            == "---"
        {
            return Ok(&body[..offset]);
        }
        offset += line.len();
    }
    Err(ScanError::invalid("No YAML frontmatter found."))
}

pub fn read_skill(
    directory: &Path,
    source_path: &Path,
    root: &SourceRoot,
    cached: Option<&CachedSkill>,
) -> Result<CachedSkill, ScanError> {
    let skill_path = fs::canonicalize(directory.join("SKILL.md"))?;
    if !within(directory, &skill_path) {
        return Err(ScanError::invalid(
            "SKILL.md links outside its Skill directory.",
        ));
    }
    // Resolve permitted internal links first, then reject a newly substituted
    // symlink and never block on a substituted pipe or other special file.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(skill_path)?;
    let information = file.metadata()?;
    if !information.is_file() {
        return Err(ScanError::invalid("SKILL.md is not a regular file."));
    }
    if information.len() > MAX_METADATA_SIZE {
        return Err(ScanError::invalid(
            "SKILL.md exceeds the 2 MB metadata limit.",
        ));
    }
    let signature = signature(&information);
    let (name, description) = if let Some(cached) = cached.filter(|entry| {
        entry.record.issue.is_none() && same_signature(&entry.signature, &signature)
    }) {
        // Restored cache entries retain an issue until validation, so only
        // metadata checked in this process can take the signature fast path.
        (
            cached.record.name.clone(),
            cached.record.description.clone(),
        )
    } else {
        let mut bytes = Vec::with_capacity(information.len() as usize);
        file.take(MAX_METADATA_SIZE + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_METADATA_SIZE {
            return Err(ScanError::invalid(
                "SKILL.md exceeds the 2 MB metadata limit.",
            ));
        }
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| ScanError::invalid("SKILL.md is not valid UTF-8."))?;
        let options = serde_saphyr::options! {
            duplicate_keys: serde_saphyr::options::DuplicateKeyPolicy::Error,
            merge_keys: serde_saphyr::options::MergeKeyPolicy::AsOrdinary,
            strict_booleans: true,
            with_snippet: false,
            budget: serde_saphyr::budget! {
                max_documents: 1,
                max_recorded_anchor_bytes: MAX_METADATA_SIZE as usize,
                max_total_scalar_bytes: MAX_METADATA_SIZE as usize,
            },
            alias_limits: serde_saphyr::alias_limits! {
                max_alias_expansions_per_anchor: 20,
                max_replay_stack_depth: 20,
                max_total_replayed_events: 20_000,
            },
        };
        let metadata: serde_json::Value =
            serde_saphyr::from_str_with_options(frontmatter(content)?, options)
                .map_err(|_| ScanError::invalid("Skill metadata contains invalid YAML."))?;
        let fields = metadata
            .as_object()
            .ok_or_else(|| ScanError::invalid("Skill metadata must be a mapping."))?;
        let name = fields
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ScanError::invalid("Skill metadata requires a nonempty name."))?;
        let description = fields
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ScanError::invalid("Skill metadata requires a nonempty description."))?;
        (name.to_owned(), description.to_owned())
    };
    let path = directory.to_string_lossy().into_owned();
    let modified_at = chrono::DateTime::<chrono::Utc>::from(information.modified()?)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(CachedSkill {
        record: SkillRecord {
            id: stable_id(&path),
            name,
            description,
            path,
            root_id: root.id.clone(),
            source: root.kind.clone(),
            modified_at,
            issue: None,
        },
        source_path: source_path.to_string_lossy().into_owned(),
        signature,
    })
}

#[derive(Clone)]
struct Directory {
    canonical: PathBuf,
    source: PathBuf,
    boundary: PathBuf,
}

struct Frame {
    directory: Directory,
    entries: ReadDir,
}

struct ScanState {
    found: Entries,
    roots: Vec<SourceRoot>,
    progress: ScanProgress,
    visited: HashSet<PathBuf>,
    checked: HashMap<PathBuf, Arc<OnceLock<bool>>>,
    unreadable: HashSet<PathBuf>,
}

impl ScanState {
    fn unreadable(&mut self, root_index: usize, location: &Path, message: String) {
        if self.unreadable.insert(location.to_owned()) {
            self.progress.unreadable_directories += 1;
        }
        self.roots[root_index].error =
            Some("Some locations could not be read. See scan issues for details.".into());
        add_issue(
            &mut self.progress,
            location.to_string_lossy().into_owned(),
            message,
        );
    }

    fn candidate_error(&mut self, root_index: usize, location: &Path, error: ScanError) {
        if error.io {
            self.unreadable(root_index, location, error.message);
        } else {
            self.progress.invalid_skills += 1;
            add_issue(
                &mut self.progress,
                location.to_string_lossy().into_owned(),
                error.message,
            );
        }
    }

    fn external_link(&mut self, location: &Path, message: String) {
        self.progress.external_links_skipped += 1;
        add_issue(
            &mut self.progress,
            location.to_string_lossy().into_owned(),
            message,
        );
    }
}

fn enter(directory: Directory, state: &Mutex<ScanState>, root_index: usize) -> Option<Frame> {
    if state.lock().unwrap().visited.contains(&directory.canonical) {
        return None;
    }
    match fs::read_dir(&directory.canonical) {
        Ok(entries) => {
            let mut state = state.lock().unwrap();
            if !state.visited.insert(directory.canonical.clone()) {
                return None;
            }
            state.progress.directories_scanned += 1;
            state.progress.current_path = Some(directory.canonical.to_string_lossy().into_owned());
            Some(Frame { directory, entries })
        }
        Err(error) => {
            state
                .lock()
                .unwrap()
                .unreadable(root_index, &directory.source, error.to_string());
            None
        }
    }
}

fn check_candidate(
    directory: &Directory,
    state: &Mutex<ScanState>,
    cached: &Entries,
    root: &SourceRoot,
    root_index: usize,
) -> bool {
    let (checked, owner) = {
        let mut state = state.lock().unwrap();
        if let Some(checked) = state.checked.get(&directory.canonical) {
            (Arc::clone(checked), false)
        } else {
            let checked = Arc::new(OnceLock::new());
            state
                .checked
                .insert(directory.canonical.clone(), Arc::clone(&checked));
            state.progress.candidates_checked += 1;
            (checked, true)
        }
    };
    if !owner {
        return *checked.wait();
    }
    let result = std::panic::catch_unwind(|| {
        read_skill(
            &directory.canonical,
            &directory.source,
            root,
            cached.get(directory.canonical.to_string_lossy().as_ref()),
        )
    });
    let result = match result {
        Ok(result) => result,
        Err(panic) => {
            // Release duplicate aliases before propagating an unexpected
            // parser failure to the service's failed-scan recovery path.
            checked.set(false).unwrap();
            std::panic::resume_unwind(panic);
        }
    };
    let mut state = state.lock().unwrap();
    let valid = match result {
        Ok(entry) => {
            if state
                .found
                .insert(entry.record.path.clone(), entry)
                .is_none()
            {
                state.roots[root_index].skill_count += 1;
            }
            true
        }
        Err(error) => {
            state.candidate_error(root_index, &directory.source.join("SKILL.md"), error);
            false
        }
    };
    checked.set(valid).unwrap();
    valid
}

struct Worker<'a, C> {
    state: &'a Mutex<ScanState>,
    cached: &'a Entries,
    root: &'a SourceRoot,
    root_index: usize,
    cancelled: &'a C,
    sender: &'a Sender<Directory>,
    receiver: &'a Receiver<Directory>,
    pending: &'a AtomicUsize,
}

struct JobCompletion<'a>(&'a AtomicUsize);

impl Drop for JobCompletion<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl<C: Fn() -> bool + Sync> Worker<'_, C> {
    fn run(&self) {
        while !(self.cancelled)() {
            match self.receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(directory) => {
                    let _completion = JobCompletion(self.pending);
                    self.walk(directory);
                }
                Err(_) if self.pending.load(Ordering::Acquire) == 0 => break,
                Err(_) => {}
            }
        }
    }

    fn schedule(&self, directory: Directory, stack: &mut Vec<Frame>) {
        if (self.cancelled)() {
            return;
        }
        self.pending.fetch_add(1, Ordering::AcqRel);
        match self.sender.try_send(directory) {
            Ok(()) => {}
            Err(TrySendError::Full(directory)) | Err(TrySendError::Disconnected(directory)) => {
                self.pending.fetch_sub(1, Ordering::AcqRel);
                if let Some(frame) = enter(directory, self.state, self.root_index) {
                    stack.push(frame);
                }
            }
        }
    }

    fn walk(&self, directory: Directory) {
        let mut stack = Vec::new();
        if let Some(frame) = enter(directory, self.state, self.root_index) {
            stack.push(frame);
        }
        // The bounded queue shares work across four readers. When it fills,
        // each reader continues with streaming DFS instead of collecting an
        // unbounded breadth-first frontier or every entry of a wide directory.
        while !stack.is_empty() && !(self.cancelled)() {
            let frame = stack.last_mut().unwrap();
            let entry = match frame.entries.next() {
                Some(Ok(entry)) => entry,
                Some(Err(error)) => {
                    self.state.lock().unwrap().unreadable(
                        self.root_index,
                        &frame.directory.source,
                        error.to_string(),
                    );
                    stack.pop();
                    continue;
                }
                None => {
                    stack.pop();
                    continue;
                }
            };
            let name = entry.file_name();
            if name == "SKILL.md" {
                check_candidate(
                    &frame.directory,
                    self.state,
                    self.cached,
                    self.root,
                    self.root_index,
                );
            }
            let entry_type = match entry.file_type() {
                Ok(entry_type) => entry_type,
                Err(error) => {
                    self.state.lock().unwrap().unreadable(
                        self.root_index,
                        &frame.directory.source.join(&name),
                        error.to_string(),
                    );
                    continue;
                }
            };
            if entry_type.is_dir() {
                let directory = Directory {
                    canonical: frame.directory.canonical.join(&name),
                    source: frame.directory.source.join(&name),
                    boundary: frame.directory.boundary.clone(),
                };
                self.schedule(directory, &mut stack);
            } else if entry_type.is_symlink() && name != "SKILL.md" {
                let source = frame.directory.source.join(&name);
                let linked = frame.directory.canonical.join(&name);
                let target = match fs::canonicalize(&linked).and_then(|target| {
                    fs::metadata(&target).map(|information| (target, information))
                }) {
                    Ok((target, information)) if information.is_dir() => target,
                    Ok(_) => continue,
                    Err(error) => {
                        self.state.lock().unwrap().unreadable(
                            self.root_index,
                            &source,
                            error.to_string(),
                        );
                        continue;
                    }
                };
                if self.state.lock().unwrap().visited.contains(&target) {
                    continue;
                }
                let external = !within(&frame.directory.boundary, &target);
                let directory = Directory {
                    boundary: if external {
                        target.clone()
                    } else {
                        frame.directory.boundary.clone()
                    },
                    canonical: target,
                    source,
                };
                if external {
                    // Only an exact installed Skill link can establish a new
                    // boundary; an external container must be added explicitly.
                    let metadata_path = directory.canonical.join("SKILL.md");
                    let readable_candidate = match fs::metadata(&metadata_path) {
                        Ok(_) => check_candidate(
                            &directory,
                            self.state,
                            self.cached,
                            self.root,
                            self.root_index,
                        ),
                        Err(error) => {
                            let mut state = self.state.lock().unwrap();
                            if error.kind() != io::ErrorKind::NotFound
                                && error.kind() != io::ErrorKind::NotADirectory
                            {
                                state.unreadable(
                                    self.root_index,
                                    &directory.source,
                                    error.to_string(),
                                );
                            }
                            false
                        }
                    };
                    if !readable_candidate {
                        self.state.lock().unwrap().external_link(
                            &directory.source,
                            "External directory link skipped: no valid readable Skill metadata at its root."
                                .into(),
                        );
                        continue;
                    }
                }
                self.schedule(directory, &mut stack);
            }
        }
    }
}

/// Discover every readable directory beneath the configured sources. Roots are
/// intentionally processed in order so tool installations retain ownership when
/// the final Home pass overlaps them. Callbacks run only on this coordinator.
pub fn discover<C, P>(
    roots: Vec<SourceRoot>,
    cached: Entries,
    cancelled: C,
    publish: P,
) -> (Entries, Vec<SourceRoot>, ScanProgress)
where
    C: Fn() -> bool + Sync,
    P: Fn(&Entries, &[SourceRoot], &ScanProgress) + Sync,
{
    let state = Mutex::new(ScanState {
        found: Entries::new(),
        roots,
        progress: ScanProgress::default(),
        visited: HashSet::new(),
        checked: HashMap::new(),
        unreadable: HashSet::new(),
    });
    let root_count = state.lock().unwrap().roots.len();
    for root_index in 0..root_count {
        if cancelled() {
            break;
        }
        let root = {
            let mut state = state.lock().unwrap();
            let root = &mut state.roots[root_index];
            root.status = "scanning".into();
            root.skill_count = 0;
            root.error = None;
            let root = root.clone();
            state.progress.phase = if root.kind == "home" { "home" } else { "quick" }.into();
            publish(&state.found, &state.roots, &state.progress);
            root
        };
        let canonical = match fs::canonicalize(&root.path).and_then(|path| {
            let information = fs::metadata(&path)?;
            if information.is_dir() {
                Ok(path)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "The scan root is not a directory.",
                ))
            }
        }) {
            Ok(path) => path,
            Err(error) => {
                let mut state = state.lock().unwrap();
                let missing = error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::NotADirectory;
                state.roots[root_index].status = if missing { "missing" } else { "error" }.into();
                if !missing {
                    state.unreadable(root_index, Path::new(&root.path), error.to_string());
                }
                publish(&state.found, &state.roots, &state.progress);
                continue;
            }
        };
        let (sender, receiver) = bounded(DIRECTORY_QUEUE_SIZE);
        let pending = AtomicUsize::new(1);
        sender
            .send(Directory {
                boundary: canonical.clone(),
                canonical,
                source: PathBuf::from(&root.path),
            })
            .unwrap();
        thread::scope(|scope| {
            let mut workers = Vec::with_capacity(DIRECTORY_WORKERS);
            for _ in 0..DIRECTORY_WORKERS {
                let worker = Worker {
                    state: &state,
                    cached: &cached,
                    root: &root,
                    root_index,
                    cancelled: &cancelled,
                    sender: &sender,
                    receiver: &receiver,
                    pending: &pending,
                };
                workers.push(scope.spawn(move || worker.run()));
            }
            let mut last_publish = Instant::now();
            while pending.load(Ordering::Acquire) > 0 && !cancelled() {
                if workers.iter().all(thread::ScopedJoinHandle::is_finished) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
                if last_publish.elapsed() >= PUBLISH_INTERVAL {
                    let state = state.lock().unwrap();
                    publish(&state.found, &state.roots, &state.progress);
                    last_publish = Instant::now();
                }
            }
            for worker in workers {
                worker.join().expect("A discovery worker panicked");
            }
        });
        let mut state = state.lock().unwrap();
        if !cancelled() {
            state.roots[root_index].status = if state.roots[root_index].error.is_some() {
                "partial"
            } else {
                "ready"
            }
            .into();
        }
        publish(&state.found, &state.roots, &state.progress);
    }
    let mut state = state.into_inner().unwrap();
    if !cancelled() {
        state.progress.phase = "complete".into();
        state.progress.completed_at = Some(now());
        state.progress.current_path = None;
    }
    (state.found, state.roots, state.progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tempfile::{TempDir, tempdir};

    fn fixture() -> (TempDir, PathBuf) {
        let directory = tempdir().unwrap();
        let home = fs::canonicalize(directory.path()).unwrap().join("home");
        fs::create_dir(&home).unwrap();
        (directory, home)
    }

    fn root(path: &Path, kind: &str) -> SourceRoot {
        SourceRoot {
            id: stable_id(&path.to_string_lossy()),
            label: kind.into(),
            path: path.to_string_lossy().into_owned(),
            kind: kind.into(),
            status: "scanning".into(),
            skill_count: 0,
            error: None,
            removable: kind == "custom",
        }
    }

    fn write_skill(directory: &Path, name: &str) {
        fs::create_dir_all(directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: A useful Skill.\n---\n# Source only\n"),
        )
        .unwrap();
    }

    #[test]
    fn covers_hidden_dependencies_caches_deep_paths_and_prioritizes_known_roots() {
        let (_fixture, home) = fixture();
        let known = home.join(".agents/skills");
        let mut locations = vec![
            known.join("known"),
            home.join("Work/repository/.claude/skills/hidden"),
            home.join("node_modules/package/skills/dependency"),
            home.join("Library/Caches/examples/.nested/cached"),
            home.join(".git/extracted/teaching"),
        ];
        let mut deep = home.join("Archive");
        for index in 0..48 {
            deep.push(format!("level-{index}"));
        }
        locations.push(deep);
        for (index, location) in locations.iter().enumerate() {
            write_skill(location, &format!("skill-{index}"));
        }
        let known_root = root(&known, "agents");
        let known_id = known_root.id.clone();
        let (entries, roots, progress) = discover(
            vec![known_root, root(&home, "home")],
            Entries::new(),
            || false,
            |_, _, _| {},
        );
        assert_eq!(entries.len(), locations.len());
        assert_eq!(
            entries[&locations[0].to_string_lossy().into_owned()]
                .record
                .root_id,
            known_id
        );
        assert_eq!(roots[0].skill_count, 1);
        assert_eq!(roots[1].skill_count, locations.len() - 1);
        assert_eq!(progress.phase, "complete");
        assert_eq!(progress.candidates_checked, locations.len());
        assert!(progress.directories_scanned > 48);
        assert_eq!(progress.unreadable_directories, 0);
    }

    #[test]
    fn validates_yaml_and_regular_bounded_utf8_metadata_without_executing_sources() {
        let (fixture, home) = fixture();
        let valid = home.join("valid");
        write_skill(&valid, "valid");
        let marker = fixture.path().join("executed");
        let script = format!("#!/bin/sh\ntouch '{}'\n", marker.display());
        fs::write(valid.join("run.sh"), &script).unwrap();
        fs::set_permissions(valid.join("run.sh"), fs::Permissions::from_mode(0o700)).unwrap();
        let invalid: Vec<&[u8]> = vec![
            b"# Missing metadata\n",
            b"---\nname: [broken\n---\n",
            b"---\n- list\n- metadata\n---\n",
            b"---\nname: duplicate\nname: repeated\ndescription: Invalid.\n---\n",
            b"---\nname: '  '\ndescription: Invalid.\n---\n",
            b"---\nname: empty-description\ndescription: '  '\n---\n",
            b"---\nname: 123\ndescription: Invalid.\n---\n",
            b"---\nname: wrong-description\ndescription: [invalid]\n---\n",
            b"---\nname: true\ndescription: Invalid.\n---\n",
            b"---\nname: True\ndescription: Invalid.\n---\n",
            b"---\nname: FALSE\ndescription: Invalid.\n---\n",
            b"---\nname: invalid-utf8\ndescription: \xff\n---\n",
        ];
        for (index, source) in invalid.iter().enumerate() {
            let candidate = home.join(format!("invalid-{index}"));
            fs::create_dir(&candidate).unwrap();
            fs::write(candidate.join("SKILL.md"), source).unwrap();
        }
        let oversized = home.join("oversized");
        fs::create_dir(&oversized).unwrap();
        fs::write(
            oversized.join("SKILL.md"),
            vec![b'a'; MAX_METADATA_SIZE as usize + 1],
        )
        .unwrap();
        fs::create_dir_all(home.join("not-a-file/SKILL.md")).unwrap();
        let (entries, _, progress) = discover(
            vec![root(&home, "home")],
            Entries::new(),
            || false,
            |_, _, _| {},
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(progress.invalid_skills, invalid.len() + 2);
        assert_eq!(progress.unreadable_directories, 0);
        assert!(!marker.exists());
        assert_eq!(fs::read_to_string(valid.join("run.sh")).unwrap(), script);
        for (index, source) in invalid.iter().enumerate() {
            assert_eq!(
                fs::read(home.join(format!("invalid-{index}/SKILL.md"))).unwrap(),
                *source
            );
        }
    }

    #[test]
    fn resolves_cycles_and_exact_installed_links_but_skips_external_containers() {
        let (fixture, home) = fixture();
        let local = home.join("nested/local");
        let installed = fixture.path().join("external/installed");
        let container = fixture.path().join("external/container");
        write_skill(&local, "local");
        write_skill(&installed, "installed");
        write_skill(&container.join("nested"), "must-not-be-found");
        symlink(&home, home.join("cycle")).unwrap();
        symlink(&installed, home.join("installed")).unwrap();
        symlink(&installed, home.join("duplicate")).unwrap();
        symlink(&container, home.join("container")).unwrap();
        let (entries, _, progress) = discover(
            vec![root(&home, "home")],
            Entries::new(),
            || false,
            |_, _, _| {},
        );
        assert_eq!(entries.len(), 2);
        assert!(
            entries
                .values()
                .all(|entry| entry.record.name != "must-not-be-found")
        );
        assert_eq!(progress.candidates_checked, 2);
        assert_eq!(progress.invalid_skills, 0);
        assert_eq!(progress.external_links_skipped, 1);
        assert!(
            progress
                .issues
                .iter()
                .any(|issue| issue.path == home.join("container").to_string_lossy())
        );
    }

    #[test]
    fn blocks_external_metadata_links_and_does_not_trust_restored_cache_names() {
        let (fixture, home) = fixture();
        let valid = home.join("valid");
        write_skill(&valid, "real-name");
        let source_root = root(&home, "home");
        let canonical = fs::canonicalize(&valid).unwrap();
        let mut cached = read_skill(&canonical, &valid, &source_root, None).unwrap();
        cached.record.name = "forged-cache-name".into();
        cached.record.issue = Some(crate::models::CACHED_ISSUE.into());
        assert_eq!(
            read_skill(&canonical, &valid, &source_root, Some(&cached))
                .unwrap()
                .record
                .name,
            "real-name"
        );
        let external = fixture.path().join("external.md");
        fs::write(
            &external,
            "---\nname: escaped\ndescription: Invalid.\n---\n",
        )
        .unwrap();
        fs::remove_file(valid.join("SKILL.md")).unwrap();
        symlink(&external, valid.join("SKILL.md")).unwrap();
        let error = read_skill(&canonical, &valid, &source_root, None).unwrap_err();
        assert!(!error.io);
        assert!(error.message.contains("outside"));
    }

    #[test]
    fn discovers_padded_frontmatter_delimiters_without_rewriting_source() {
        let (_fixture, home) = fixture();
        let variants = [
            ("---  ", "---", "\n", ""),
            ("---\t", "--- \t", "\n", ""),
            ("--- \t ", "---\t ", "\r\n", "\u{feff}"),
            ("---", "---  ", "\r\n", ""),
        ];
        let mut originals = vec![];
        for (index, (opening, closing, newline, bom)) in variants.iter().enumerate() {
            let candidate = home.join(format!("padded-{index}"));
            fs::create_dir(&candidate).unwrap();
            let content = format!(
                "{bom}{opening}{newline}name: padded-{index}  {newline}description: A readable Skill.  {newline}{closing}{newline}# Body{newline}"
            );
            let metadata_path = candidate.join("SKILL.md");
            fs::write(&metadata_path, &content).unwrap();
            originals.push((metadata_path, content));
        }
        let (entries, _, progress) = discover(
            vec![root(&home, "home")],
            Entries::new(),
            || false,
            |_, _, _| {},
        );
        assert_eq!(entries.len(), variants.len());
        assert_eq!(progress.invalid_skills, 0);
        for (index, (metadata_path, original)) in originals.iter().enumerate() {
            assert_eq!(fs::read_to_string(metadata_path).unwrap(), *original);
            let entry = entries
                .values()
                .find(|entry| entry.record.name == format!("padded-{index}"))
                .unwrap();
            assert_eq!(entry.record.description, "A readable Skill.");
        }
    }

    #[test]
    fn padded_delimiters_do_not_accept_escaped_indented_or_non_marker_lines() {
        let metadata = "name: example\ndescription: A readable Skill.\n";
        for opening in ["\\---", " ---", "\t---", "----", "--- suffix", "---\u{a0}"] {
            assert!(
                frontmatter(&format!("{opening}\n{metadata}---\n# Body\n")).is_err(),
                "Unexpected opening marker: {opening:?}"
            );
        }
        for closing in ["\\---", " ---", "----", "--- suffix", "---\u{a0}"] {
            assert!(
                frontmatter(&format!("--- \t\n{metadata}{closing}\n# Body\n")).is_err(),
                "Unexpected closing marker: {closing:?}"
            );
        }
        assert_eq!(
            frontmatter(&format!("--- \t\n{metadata}--- \t")).unwrap(),
            metadata
        );
    }

    #[test]
    fn accepts_core_yaml_strings_aliases_bom_and_crlf_without_including_files() {
        let (_fixture, home) = fixture();
        let candidate = home.join("valid");
        fs::create_dir(&candidate).unwrap();
        fs::write(
            candidate.join("SKILL.md"),
            "\u{feff}---\r\nname: on\r\ndescription: &description A useful Skill.\r\nother: *description\r\n---\r\n# Source\r\n",
        )
        .unwrap();
        let source_root = root(&home, "home");
        let entry = read_skill(&candidate, &candidate, &source_root, None).unwrap();
        assert_eq!(entry.record.name, "on");
        assert_eq!(entry.record.description, "A useful Skill.");
        fs::write(
            candidate.join("SKILL.md"),
            "---\nname: included\ndescription: !include /etc/passwd\n---\n",
        )
        .unwrap();
        // No include resolver or filesystem include feature is enabled. The
        // tag may be treated as plain data, but can never read another file.
        if let Ok(entry) = read_skill(&candidate, &candidate, &source_root, None) {
            assert_eq!(entry.record.description, "/etc/passwd");
        }
    }

    #[test]
    fn completes_wide_parallel_discovery_without_dropping_queued_directories() {
        let (_fixture, home) = fixture();
        for index in 0..300 {
            write_skill(
                &home.join(format!("branch-{index}/nested/skill")),
                &format!("skill-{index}"),
            );
        }
        let (entries, roots, progress) = discover(
            vec![root(&home, "home")],
            Entries::new(),
            || false,
            |_, _, _| {},
        );
        assert_eq!(entries.len(), 300);
        assert_eq!(roots[0].skill_count, 300);
        assert_eq!(progress.candidates_checked, 300);
        assert_eq!(progress.directories_scanned, 901);
        assert_eq!(progress.unreadable_directories, 0);
        assert_eq!(progress.phase, "complete");
    }

    #[test]
    fn allows_distinct_aliases_but_limits_repeated_alias_expansion() {
        let (_fixture, home) = fixture();
        let candidate = home.join("candidate");
        fs::create_dir(&candidate).unwrap();
        let mut content = String::from("---\nname: aliases\ndescription: A useful Skill.\n");
        for index in 0..30 {
            content.push_str(&format!("a{index}: &a{index} value\nb{index}: *a{index}\n"));
        }
        content.push_str("---\n");
        fs::write(candidate.join("SKILL.md"), content).unwrap();
        let source_root = root(&home, "home");
        assert!(read_skill(&candidate, &candidate, &source_root, None).is_ok());
        let mut content = String::from("---\nname: aliases\ndescription: &value A useful Skill.\n");
        for index in 0..30 {
            content.push_str(&format!("alias{index}: *value\n"));
        }
        content.push_str("---\n");
        fs::write(candidate.join("SKILL.md"), content).unwrap();
        let error = read_skill(&candidate, &candidate, &source_root, None).unwrap_err();
        assert!(!error.io);
        assert!(error.message.contains("YAML"));
    }

    #[test]
    fn unreadable_metadata_is_a_coverage_gap_and_issues_are_bounded() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_fixture, home) = fixture();
        for index in 0..56 {
            let candidate = home.join(format!("unreadable-{index}"));
            write_skill(&candidate, "unreadable");
            fs::set_permissions(candidate.join("SKILL.md"), fs::Permissions::from_mode(0o0))
                .unwrap();
        }
        let (entries, roots, progress) = discover(
            vec![root(&home, "home")],
            Entries::new(),
            || false,
            |_, _, _| {},
        );
        assert!(entries.is_empty());
        assert_eq!(progress.invalid_skills, 0);
        assert_eq!(progress.unreadable_directories, 56);
        assert_eq!(progress.issues.len(), 50);
        assert_eq!(roots[0].status, "partial");
    }

    #[test]
    fn cancellation_stops_workers_and_never_reports_a_completed_pass() {
        let (_fixture, home) = fixture();
        for index in 0..1000 {
            fs::create_dir(home.join(format!("directory-{index}"))).unwrap();
        }
        let probes = AtomicUsize::new(0);
        let calls = AtomicUsize::new(0);
        let (_, _, progress) = discover(
            vec![root(&home, "home")],
            Entries::new(),
            || probes.fetch_add(1, Ordering::AcqRel) > 100,
            |_, _, _| {
                calls.fetch_add(1, Ordering::AcqRel);
            },
        );
        assert!(progress.completed_at.is_none());
        assert_ne!(progress.phase, "complete");
        assert!(progress.directories_scanned > 0);
        assert!(progress.directories_scanned < 1001);
        assert!(calls.load(Ordering::Acquire) >= 1);
    }
}
