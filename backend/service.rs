use crate::{
    discovery::{discover, read_skill},
    models::*,
    preview,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[derive(Debug)]
pub struct ServiceError {
    pub status: u16,
    pub message: String,
}
impl ServiceError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}
impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ServiceError {}

#[derive(Clone)]
pub struct ServiceOptions {
    pub home_dir: PathBuf,
    pub config_dir: PathBuf,
    pub roots: Option<Vec<SourceRoot>>,
}
impl Default for ServiceOptions {
    fn default() -> Self {
        let home_dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let config_dir = std::env::var_os("ZSKILLS_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".config/zskills"));
        Self {
            home_dir,
            config_dir,
            roots: None,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    editor: String,
    roots: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            editor: "system".into(),
            roots: vec![],
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    version: u32,
    home_dir: String,
    completed_at: Option<String>,
    entries: Vec<CachedSkill>,
}
struct State {
    config: Config,
    snapshot: WorkspaceSnapshot,
    entries: Entries,
    anchors: Entries,
}
struct WatchState {
    watcher: Option<RecommendedWatcher>,
    watched: BTreeSet<String>,
    failures: BTreeSet<String>,
}

// On macOS, individual watch() calls restart the FSEvents stream. Commit all
// path changes together so thousands of discovered Skills use one restart.
fn update_watch_paths(
    watches: &mut WatchState,
    add: &[String],
    remove: &[String],
) -> Vec<(String, String)> {
    if add.is_empty() && remove.is_empty() {
        return vec![];
    }
    let mut results = vec![];
    let mut errors = vec![];
    if let Some(watcher) = watches.watcher.as_mut() {
        let mut batch = watcher.paths_mut();
        for path in remove {
            let _ = batch.remove(Path::new(path));
        }
        for path in add {
            results.push((
                path.clone(),
                batch.add(Path::new(path), RecursiveMode::NonRecursive),
            ));
        }
        if let Err(error) = batch.commit() {
            for path in add {
                errors.push((path.clone(), error.to_string()));
            }
        }
    } else {
        for path in add {
            errors.push((path.clone(), "File watching is unavailable.".into()));
        }
    }
    for path in remove {
        watches.watched.remove(path);
        watches.failures.remove(path);
    }
    for (path, result) in results {
        match result {
            Ok(()) => {
                watches.watched.insert(path.clone());
                watches.failures.remove(&path);
            }
            Err(error) => errors.push((path, error.to_string())),
        }
    }
    for (path, _) in &errors {
        watches.watched.remove(path);
        watches.failures.insert(path.clone());
    }
    errors
}
struct Inner {
    home: PathBuf,
    config_dir: PathBuf,
    defaults: Vec<SourceRoot>,
    state: Mutex<State>,
    mutation: Mutex<()>,
    persistence: Mutex<()>,
    revision: AtomicU64,
    running: AtomicBool,
    disposed: AtomicBool,
    watches: Mutex<WatchState>,
    events: mpsc::Sender<notify::Result<notify::Event>>,
}
#[derive(Clone)]
pub struct SkillsService {
    inner: Arc<Inner>,
}

fn normalized(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        && !path.as_os_str().as_encoded_bytes().contains(&0)
}
fn platform() -> String {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
    .into()
}
fn root(path: PathBuf, label: &str, kind: &str) -> SourceRoot {
    let path = path.to_string_lossy().into_owned();
    SourceRoot {
        id: stable_id(&path),
        path,
        label: label.into(),
        kind: kind.into(),
        status: "scanning".into(),
        skill_count: 0,
        error: None,
        removable: kind == "custom",
    }
}
fn definitions(defaults: &[SourceRoot], config: &Config) -> Vec<SourceRoot> {
    let mut roots: Vec<SourceRoot> = defaults
        .iter()
        .filter(|r| r.kind != "home")
        .cloned()
        .collect();
    roots.extend(config.roots.iter().map(|p| {
        root(
            PathBuf::from(p),
            Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(p),
            "custom",
        )
    }));
    roots.extend(defaults.iter().filter(|r| r.kind == "home").cloned());
    let mut seen = BTreeSet::new();
    roots.retain(|r| seen.insert(r.path.clone()));
    roots
}
fn rebuild(state: &mut State) {
    let mut skills: Vec<SkillRecord> = state
        .entries
        .values()
        .map(|entry| entry.record.clone())
        .collect();
    skills.sort_by_cached_key(|skill| (skill.name.to_lowercase(), skill.path.clone()));
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for skill in &skills {
        *counts.entry(skill.root_id.clone()).or_default() += 1;
    }
    for root in &mut state.snapshot.roots {
        root.skill_count = *counts.get(&root.id).unwrap_or(&0);
    }
    state.snapshot.skills = skills;
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, limit: u64) -> Option<T> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
fn atomic_json<T: Serialize>(directory: &Path, name: &str, value: &T) -> Result<(), ServiceError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .map_err(|e| ServiceError::new(500, format!("Could not create settings directory: {e}")))?;
    let temporary = directory.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join(name))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(ServiceError::new(
            500,
            format!("Could not save {name}: {error}"),
        ));
    }
    Ok(())
}

// Cache provenance must follow the same boundary transitions as discovery. A
// valid nested Skill cannot authorize its parent external container link.
fn validate_cached_source(entry: &CachedSkill, root: &SourceRoot) -> Result<(), ServiceError> {
    let reject = || {
        ServiceError::new(
            403,
            "The cached Skill source cannot be verified. Rescan before opening it.",
        )
    };
    let mut current = fs::canonicalize(&root.path).map_err(|_| reject())?;
    let mut boundary = current.clone();
    let relative = Path::new(&entry.source_path)
        .strip_prefix(&root.path)
        .map_err(|_| reject())?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(reject());
        };
        current = fs::canonicalize(current.join(name)).map_err(|_| reject())?;
        if !within(&boundary, &current) {
            read_skill(&current, &current, root, None).map_err(|_| reject())?;
            boundary = current.clone();
        }
    }
    if current != Path::new(&entry.record.path) {
        return Err(reject());
    }
    Ok(())
}

fn anchor_present(entry: &CachedSkill) -> bool {
    let directory = Path::new(&entry.record.path);
    match fs::canonicalize(&entry.source_path) {
        Ok(current) if current != directory => return false,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return false;
        }
        _ => {}
    }
    match fs::metadata(directory) {
        Ok(metadata) => metadata.is_dir(),
        Err(error) => !matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        ),
    }
}

impl SkillsService {
    pub fn new(options: ServiceOptions) -> Result<Self, ServiceError> {
        if !normalized(&options.home_dir) || !normalized(&options.config_dir) {
            return Err(ServiceError::new(
                400,
                "Home and configuration directories must be absolute paths.",
            ));
        }
        let home = fs::canonicalize(&options.home_dir).map_err(|e| {
            ServiceError::new(500, format!("Could not resolve the Home directory: {e}"))
        })?;
        let defaults = options.roots.unwrap_or_else(|| {
            vec![
                root(home.join(".codex/skills"), "Codex skills", "personal"),
                root(home.join(".agents/skills"), "Agent skills", "personal"),
                root(home.join(".claude/skills"), "Claude skills", "personal"),
                root(home.join(".gemini/skills"), "Gemini skills", "personal"),
                root(
                    home.join(".codex/plugins/cache"),
                    "Plugin packages",
                    "cache",
                ),
                root(home.clone(), "Home directory", "home"),
            ]
        });
        let mut config =
            read_json::<Config>(&options.config_dir.join("settings.json"), 1024 * 1024)
                .unwrap_or_default();
        if !["system", "vscode", "zed"].contains(&config.editor.as_str()) {
            config.editor = "system".into();
        }
        let mut seen = BTreeSet::new();
        config.roots.retain(|p| {
            normalized(Path::new(p))
                && fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p)) != home
                && seen.insert(p.clone())
        });
        config.roots.truncate(64);
        let roots = definitions(&defaults, &config);
        let cache = read_json::<Cache>(
            &options.config_dir.join("discovery-cache.json"),
            32 * 1024 * 1024,
        );
        let mut entries = Entries::new();
        let mut last = None;
        if let Some(cache) =
            cache.filter(|c| c.version == 1 && c.home_dir == home.to_string_lossy())
        {
            let valid = cache.entries.iter().all(|entry| {
                let record = &entry.record;
                roots.iter().any(|r| {
                    r.id == record.root_id
                        && r.kind == record.source
                        && within(Path::new(&r.path), Path::new(&entry.source_path))
                }) && normalized(Path::new(&record.path))
                    && normalized(Path::new(&entry.source_path))
                    && record.id == stable_id(&record.path)
                    && !record.name.trim().is_empty()
                    && !record.description.trim().is_empty()
                    && chrono::DateTime::parse_from_rfc3339(&record.modified_at).is_ok()
                    && entry.signature.mtime_ms.is_finite()
                    && entry.signature.ctime_ms.is_finite()
            });
            if valid {
                for mut entry in cache.entries {
                    entry.record.issue = Some(CACHED_ISSUE.into());
                    entries.insert(entry.record.path.clone(), entry);
                }
                last = cache
                    .completed_at
                    .filter(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok());
            }
        }
        let editor = preview::editor_settings(&config.editor, &home);
        let progress = ScanProgress {
            restored_from_cache: !entries.is_empty(),
            ..ScanProgress::default()
        };
        let mut state = State {
            config,
            snapshot: WorkspaceSnapshot {
                host: HostInfo {
                    hostname: hostname::get()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    platform: platform(),
                    home_dir: home.to_string_lossy().into_owned(),
                    editor_available: editor.available,
                },
                skills: vec![],
                roots,
                last_scanned_at: last,
                scanning: false,
                scan_progress: progress,
                editor,
            },
            entries,
            anchors: Entries::new(),
        };
        rebuild(&mut state);
        let (events, rx) = mpsc::channel();
        let output = events.clone();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = output.send(event);
        })
        .ok();
        let inner = Arc::new(Inner {
            home,
            config_dir: options.config_dir,
            defaults,
            state: Mutex::new(state),
            mutation: Mutex::new(()),
            persistence: Mutex::new(()),
            revision: AtomicU64::new(0),
            running: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
            watches: Mutex::new(WatchState {
                watcher,
                watched: BTreeSet::new(),
                failures: BTreeSet::new(),
            }),
            events,
        });
        let weak = Arc::downgrade(&inner);
        thread::Builder::new()
            .name("zskills-watch".into())
            .spawn(move || {
                let mut pending = BTreeSet::<String>::new();
                let mut last_refresh = std::time::Instant::now();
                loop {
                    let event = rx.recv_timeout(Duration::from_millis(200));
                    let Some(inner) = weak.upgrade() else { break };
                    if inner.disposed.load(Ordering::Acquire) {
                        break;
                    }
                    match event {
                        Ok(Ok(event)) => {
                            let state = inner.state.lock().unwrap();
                            for path in event.paths {
                                for candidate in
                                    [Some(path.as_path()), path.parent()].into_iter().flatten()
                                {
                                    if let Some(key) = candidate.to_str()
                                        && state.anchors.contains_key(key)
                                    {
                                        pending.insert(key.into());
                                    }
                                }
                            }
                        }
                        Ok(Err(error)) => {
                            let mut state = inner.state.lock().unwrap();
                            state.snapshot.scan_progress.watching = false;
                            add_issue(
                                &mut state.snapshot.scan_progress,
                                "File watcher".into(),
                                error.to_string(),
                            );
                            let mut watches = inner.watches.lock().unwrap();
                            let affected: Vec<_> = if error.paths.is_empty() {
                                watches.watched.iter().cloned().collect()
                            } else {
                                error
                                    .paths
                                    .iter()
                                    .map(|p| p.to_string_lossy().into_owned())
                                    .collect()
                            };
                            update_watch_paths(&mut watches, &[], &affected);
                            watches.failures.extend(affected);
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if !inner.running.load(Ordering::Acquire)
                        && !pending.is_empty()
                        && last_refresh.elapsed() >= Duration::from_millis(200)
                    {
                        let paths = std::mem::take(&mut pending);
                        SkillsService { inner }.refresh(paths);
                        last_refresh = std::time::Instant::now();
                    }
                }
            })
            .map_err(|e| ServiceError::new(500, format!("Could not start file watcher: {e}")))?;
        Ok(Self { inner })
    }
    pub fn workspace(&self) -> WorkspaceSnapshot {
        let mut state = self.inner.state.lock().unwrap();
        if self.inner.revision.load(Ordering::Acquire) == 0 {
            self.reset_scan(&mut state);
            self.ensure_worker(&mut state);
        }
        state.snapshot.clone()
    }
    pub fn start_scan(&self) -> WorkspaceSnapshot {
        let mut state = self.inner.state.lock().unwrap();
        self.reset_scan(&mut state);
        self.ensure_worker(&mut state);
        state.snapshot.clone()
    }
    fn reset_scan(&self, state: &mut State) {
        self.inner.revision.fetch_add(1, Ordering::AcqRel);
        let previous = &state.snapshot.roots;
        let mut roots = definitions(&self.inner.defaults, &state.config);
        for root in &mut roots {
            if let Some(old) = previous.iter().find(|r| r.id == root.id) {
                root.skill_count = old.skill_count;
            }
        }
        let allowed: BTreeSet<_> = roots.iter().map(|r| r.id.clone()).collect();
        state
            .entries
            .retain(|_, entry| allowed.contains(&entry.record.root_id));
        state
            .anchors
            .retain(|_, entry| allowed.contains(&entry.record.root_id));
        self.remove_obsolete_watches(state);
        state.snapshot.roots = roots;
        state.snapshot.scanning = true;
        state.snapshot.scan_progress = ScanProgress {
            restored_from_cache: state.snapshot.scan_progress.restored_from_cache,
            watching: state.snapshot.scan_progress.watching,
            ..ScanProgress::default()
        };
        rebuild(state);
    }
    fn ensure_worker(&self, state: &mut State) {
        if self.inner.disposed.load(Ordering::Acquire)
            || self.inner.running.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let service = self.clone();
        if let Err(error) = thread::Builder::new()
            .name("zskills-discovery".into())
            .spawn(move || service.scan_loop())
        {
            self.inner.running.store(false, Ordering::Release);
            state.snapshot.scanning = false;
            state.snapshot.scan_progress.phase = "failed".into();
            add_issue(
                &mut state.snapshot.scan_progress,
                "Discovery coordinator".into(),
                format!("Could not start discovery: {error}"),
            );
        }
    }
    fn scan_loop(&self) {
        loop {
            if self.inner.disposed.load(Ordering::Acquire) {
                self.inner.running.store(false, Ordering::Release);
                return;
            }
            let revision = self.inner.revision.load(Ordering::Acquire);
            let (roots, cached, restored) = {
                let state = self.inner.state.lock().unwrap();
                (
                    state.snapshot.roots.clone(),
                    state.entries.clone(),
                    state.snapshot.scan_progress.restored_from_cache,
                )
            };
            let cancelled = || {
                self.inner.disposed.load(Ordering::Acquire)
                    || self.inner.revision.load(Ordering::Acquire) != revision
            };
            let publish = |found: &Entries, roots: &[SourceRoot], progress: &ScanProgress| {
                if cancelled() {
                    return;
                }
                let mut state = self.inner.state.lock().unwrap();
                if cancelled() {
                    return;
                }
                let mut changed = false;
                for (path, entry) in found {
                    if state.entries.get(path) != Some(entry) {
                        state.entries.insert(path.clone(), entry.clone());
                        changed = true;
                    }
                }
                let counts: BTreeMap<_, _> = state
                    .snapshot
                    .roots
                    .iter()
                    .map(|r| (r.id.clone(), r.skill_count))
                    .collect();
                state.snapshot.roots = roots.to_vec();
                for root in &mut state.snapshot.roots {
                    root.skill_count = *counts.get(&root.id).unwrap_or(&0);
                }
                state.snapshot.scan_progress = progress.clone();
                state.snapshot.scan_progress.restored_from_cache = restored;
                if changed {
                    rebuild(&mut state);
                }
            };
            let scanned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                discover(roots, cached, cancelled, publish)
            }));
            let mut state = self.inner.state.lock().unwrap();
            if cancelled() {
                drop(state);
                continue;
            }
            match scanned {
                Ok((found, roots, mut progress)) => {
                    state.entries = found;
                    state.snapshot.roots = roots;
                    rebuild(&mut state);
                    progress.phase = "complete".into();
                    progress.completed_at = Some(now());
                    progress.current_path = None;
                    progress.restored_from_cache = false;
                    state.snapshot.last_scanned_at = progress.completed_at.clone();
                    state.snapshot.scan_progress = progress;
                    self.sync_watches(&mut state);
                }
                Err(_) => {
                    state.snapshot.scan_progress.phase = "failed".into();
                    add_issue(&mut state.snapshot.scan_progress,self.inner.home.to_string_lossy().into_owned(),"Discovery worker failed. Existing results remain available; try rescanning.".into());
                }
            }
            state.snapshot.scanning = false;
            self.inner.running.store(false, Ordering::Release);
            drop(state);
            self.save_cache();
            return;
        }
    }
    fn remove_obsolete_watches(&self, state: &mut State) {
        let mut watches = self.inner.watches.lock().unwrap();
        let obsolete: Vec<_> = watches
            .watched
            .iter()
            .filter(|p| !state.anchors.contains_key(*p))
            .cloned()
            .collect();
        update_watch_paths(&mut watches, &[], &obsolete);
        watches.failures.retain(|p| state.anchors.contains_key(p));
        state.snapshot.scan_progress.watching = !state.anchors.is_empty()
            && watches.watched.len() == state.anchors.len()
            && watches.failures.is_empty();
    }
    fn sync_watches(&self, state: &mut State) {
        let allowed: BTreeSet<_> = state.snapshot.roots.iter().map(|r| r.id.clone()).collect();
        state
            .anchors
            .retain(|_, e| allowed.contains(&e.record.root_id) && anchor_present(e));
        state.anchors.extend(state.entries.clone());
        self.remove_obsolete_watches(state);
        let mut watches = self.inner.watches.lock().unwrap();
        let added: Vec<_> = state
            .anchors
            .keys()
            .filter(|p| !watches.watched.contains(*p))
            .cloned()
            .collect();
        for (path, error) in update_watch_paths(&mut watches, &added, &[]) {
            add_issue(
                &mut state.snapshot.scan_progress,
                path,
                format!("Live metadata updates unavailable: {error}"),
            );
        }
        state.snapshot.scan_progress.watching = !state.anchors.is_empty()
            && watches.watched.len() == state.anchors.len()
            && watches.failures.is_empty();
        // Reconcile after installing watches to close the discovery/watch race.
        if !state.anchors.is_empty() {
            let event = notify::Event::new(notify::EventKind::Any);
            let mut event = event;
            event.paths = state.anchors.keys().map(PathBuf::from).collect();
            let _ = self.inner.events.send(Ok(event));
        }
    }
    fn save_cache(&self) {
        let _persistence = self.inner.persistence.lock().unwrap();
        let cache = {
            let state = self.inner.state.lock().unwrap();
            Cache {
                version: 1,
                home_dir: self.inner.home.to_string_lossy().into_owned(),
                completed_at: state.snapshot.last_scanned_at.clone(),
                entries: state.entries.values().cloned().collect(),
            }
        };
        if let Err(error) = atomic_json(&self.inner.config_dir, "discovery-cache.json", &cache) {
            let mut state = self.inner.state.lock().unwrap();
            add_issue(
                &mut state.snapshot.scan_progress,
                self.inner.config_dir.to_string_lossy().into_owned(),
                error.message,
            );
        }
    }
    fn refresh(&self, paths: BTreeSet<String>) {
        let revision = self.inner.revision.load(Ordering::Acquire);
        let work = {
            let state = self.inner.state.lock().unwrap();
            paths
                .into_iter()
                .filter_map(|path| {
                    let anchor = state.anchors.get(&path)?.clone();
                    let root = state
                        .snapshot
                        .roots
                        .iter()
                        .find(|r| r.id == anchor.record.root_id)?
                        .clone();
                    Some((path, anchor, root))
                })
                .collect::<Vec<_>>()
        };
        let mut updates = vec![];
        for (path, anchor, root) in work {
            let result = if fs::canonicalize(&anchor.source_path).ok().as_deref()
                == Some(Path::new(&path))
            {
                read_skill(
                    Path::new(&path),
                    Path::new(&anchor.source_path),
                    &root,
                    Some(&anchor),
                )
            } else {
                Err(crate::discovery::ScanError {
                    io: true,
                    message: "The Skill location changed. Rescan to update it.".into(),
                })
            };
            updates.push((path, result));
        }
        let mut state = self.inner.state.lock().unwrap();
        if self.inner.running.load(Ordering::Acquire)
            || self.inner.revision.load(Ordering::Acquire) != revision
        {
            return;
        }
        let mut changed = false;
        for (path, result) in updates {
            match result {
                Ok(entry) => {
                    if state.entries.get(&path) != Some(&entry) {
                        state.entries.insert(path.clone(), entry.clone());
                        state.anchors.insert(path, entry);
                        changed = true;
                    }
                }
                Err(error) => {
                    if state.entries.remove(&path).is_some() {
                        changed = true;
                        add_issue(
                            &mut state.snapshot.scan_progress,
                            path.clone(),
                            format!("Skill metadata changed: {}", error.message),
                        );
                    }
                    if state
                        .anchors
                        .get(&path)
                        .is_some_and(|anchor| !anchor_present(anchor))
                    {
                        state.anchors.remove(&path);
                    }
                }
            }
        }
        self.remove_obsolete_watches(&mut state);
        if changed {
            rebuild(&mut state);
        }
        drop(state);
        if changed {
            self.save_cache();
        }
    }
    pub fn add_root(&self, input: &str) -> Result<WorkspaceSnapshot, ServiceError> {
        let _mutation = self.inner.mutation.lock().unwrap();
        let expanded = if input == "~" {
            self.inner.home.clone()
        } else if let Some(rest) = input.strip_prefix("~/") {
            self.inner.home.join(rest)
        } else {
            PathBuf::from(input)
        };
        if input.trim().is_empty() || !expanded.is_absolute() || input.contains('\0') {
            return Err(ServiceError::new(400, "Enter an absolute directory path."));
        }
        let canonical = fs::canonicalize(&expanded).map_err(|_| {
            ServiceError::new(
                400,
                "This directory does not exist or cannot be read on the service host.",
            )
        })?;
        if !canonical.is_dir() || fs::read_dir(&canonical).is_err() {
            return Err(ServiceError::new(
                400,
                "This directory does not exist or cannot be read on the service host.",
            ));
        }
        let mut config = self.inner.state.lock().unwrap().config.clone();
        if definitions(&self.inner.defaults, &config).iter().any(|r| {
            fs::canonicalize(&r.path).unwrap_or_else(|_| PathBuf::from(&r.path)) == canonical
        }) {
            return Ok(self.workspace());
        }
        if config.roots.len() >= 64 {
            return Err(ServiceError::new(
                400,
                "The maximum of 64 custom scan roots has been reached.",
            ));
        }
        config.roots.push(canonical.to_string_lossy().into_owned());
        self.change_config(config)
    }
    pub fn remove_root(&self, id: &str) -> Result<WorkspaceSnapshot, ServiceError> {
        let _mutation = self.inner.mutation.lock().unwrap();
        let mut config = self.inner.state.lock().unwrap().config.clone();
        let Some(index) = config.roots.iter().position(|p| stable_id(p) == id) else {
            return Err(ServiceError::new(
                400,
                "Only custom scan roots can be removed.",
            ));
        };
        config.roots.remove(index);
        self.change_config(config)
    }
    fn change_config(&self, config: Config) -> Result<WorkspaceSnapshot, ServiceError> {
        {
            let _persistence = self.inner.persistence.lock().unwrap();
            atomic_json(&self.inner.config_dir, "settings.json", &config)?;
        }
        let mut state = self.inner.state.lock().unwrap();
        state.config = config;
        self.reset_scan(&mut state);
        self.ensure_worker(&mut state);
        Ok(state.snapshot.clone())
    }
    pub fn set_editor(&self, editor: &str) -> Result<EditorSettings, ServiceError> {
        if !["system", "vscode", "zed"].contains(&editor) {
            return Err(ServiceError::new(400, "Choose system, vscode, or zed."));
        }
        let _mutation = self.inner.mutation.lock().unwrap();
        let mut config = self.inner.state.lock().unwrap().config.clone();
        config.editor = editor.into();
        {
            let _persistence = self.inner.persistence.lock().unwrap();
            atomic_json(&self.inner.config_dir, "settings.json", &config)?;
        }
        let settings = preview::editor_settings(editor, &self.inner.home);
        let mut state = self.inner.state.lock().unwrap();
        state.config = config;
        state.snapshot.editor = settings.clone();
        state.snapshot.host.editor_available = settings.available;
        Ok(settings)
    }
    fn resolve_skill(&self, id: &str) -> Result<SkillRecord, ServiceError> {
        let _ = self.workspace();
        let (entry, root) = {
            let state = self.inner.state.lock().unwrap();
            let entry = state
                .entries
                .values()
                .find(|e| e.record.id == id)
                .cloned()
                .ok_or_else(|| {
                    ServiceError::new(404, "Skill not found. Rescan to refresh the library.")
                })?;
            let root = state
                .snapshot
                .roots
                .iter()
                .find(|r| r.id == entry.record.root_id)
                .cloned()
                .ok_or_else(|| {
                    ServiceError::new(403, "The Skill source is no longer configured.")
                })?;
            (entry, root)
        };
        let directory = Path::new(&entry.record.path);
        if fs::canonicalize(directory).ok().as_deref() != Some(directory)
            || fs::canonicalize(&entry.source_path).ok().as_deref() != Some(directory)
        {
            return Err(ServiceError::new(
                403,
                "The Skill location changed. Rescan before opening it.",
            ));
        }
        let verified = if entry.record.issue.as_deref() == Some(CACHED_ISSUE) {
            validate_cached_source(&entry, &root)?;
            Some(
                read_skill(directory, Path::new(&entry.source_path), &root, None).map_err(
                    |_| {
                        ServiceError::new(
                            404,
                            "The Skill is no longer available. Rescan to refresh the library.",
                        )
                    },
                )?,
            )
        } else {
            None
        };
        let mut state = self.inner.state.lock().unwrap();
        if !state.snapshot.roots.iter().any(|r| r.id == root.id)
            || !state
                .entries
                .values()
                .any(|e| e.record.id == id && e.record.root_id == root.id)
        {
            return Err(ServiceError::new(
                403,
                "The Skill source is no longer configured.",
            ));
        }
        if let Some(verified) = verified {
            state
                .entries
                .insert(verified.record.path.clone(), verified.clone());
            rebuild(&mut state);
            Ok(verified.record)
        } else {
            Ok(entry.record)
        }
    }
    pub fn get_skill(&self, id: &str) -> Result<SkillDetail, ServiceError> {
        preview::get_skill(self.resolve_skill(id)?)
    }
    pub fn get_file(&self, id: &str, path: &str) -> Result<FileContent, ServiceError> {
        preview::get_file(&self.resolve_skill(id)?, path)
    }
    pub fn open_editor(
        &self,
        id: &str,
        scope: &str,
        path: Option<&str>,
    ) -> Result<serde_json::Value, ServiceError> {
        if !["skill", "file"].contains(&scope) {
            return Err(ServiceError::new(400, "Choose a Skill or file to open."));
        }
        let skill = self.resolve_skill(id)?;
        let editor = self.inner.state.lock().unwrap().config.editor.clone();
        preview::open_editor(&skill, &editor, scope, path, &self.inner.home)
    }
    pub fn dispose(&self) {
        self.inner.disposed.store(true, Ordering::Release);
        self.inner.revision.fetch_add(1, Ordering::AcqRel);
        let mut watches = self.inner.watches.lock().unwrap();
        watches.watcher.take();
        watches.watched.clear();
    }
}
