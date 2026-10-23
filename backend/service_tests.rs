use crate::{
    models::*,
    service::{ServiceOptions, SkillsService},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct Fixture {
    directory: TempDir,
    home: PathBuf,
    config: PathBuf,
    services: Vec<SkillsService>,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let home = root.join("home");
        fs::create_dir(&home).unwrap();
        Self {
            directory,
            home,
            config: root.join("config"),
            services: vec![],
        }
    }
    fn service(&mut self) -> SkillsService {
        let service = SkillsService::new(ServiceOptions {
            home_dir: self.home.clone(),
            config_dir: self.config.clone(),
            roots: None,
        })
        .unwrap();
        self.services.push(service.clone());
        service
    }
    fn write_cache(&self, cache: &Value) {
        fs::create_dir_all(&self.config).unwrap();
        fs::write(
            self.config.join("discovery-cache.json"),
            serde_json::to_vec(cache).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for service in &self.services {
            service.dispose();
        }
    }
}

fn source(name: &str) -> String {
    format!("---\nname: {name}\ndescription: A useful Skill.\n---\n# Source only\n")
}
fn write_skill(directory: &Path, name: &str) {
    fs::create_dir_all(directory).unwrap();
    fs::write(directory.join("SKILL.md"), source(name)).unwrap();
}
fn wait_for(
    service: &SkillsService,
    predicate: impl Fn(&WorkspaceSnapshot) -> bool,
) -> WorkspaceSnapshot {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = service.workspace();
        if predicate(&snapshot) {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "Workspace did not reach expected state: {}",
            serde_json::to_string(&snapshot).unwrap()
        );
        thread::sleep(Duration::from_millis(20));
    }
}
fn completed(service: &SkillsService) -> WorkspaceSnapshot {
    wait_for(service, |snapshot| {
        !snapshot.scanning && snapshot.scan_progress.phase == "complete"
    })
}
fn names(snapshot: &WorkspaceSnapshot) -> Vec<&str> {
    snapshot
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect()
}
fn cache_after_scan(fixture: &Fixture, count: usize) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(bytes) = fs::read(fixture.config.join("discovery-cache.json"))
            && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
            && value["entries"]
                .as_array()
                .is_some_and(|entries| entries.len() == count)
        {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "The completed scan cache was not persisted."
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn defaults_discover_the_service_home_without_a_cwd_project_root() {
    let mut fixture = Fixture::new();
    let locations = [
        ".agents/skills/quick",
        "Work/repository/.claude/skills/repo",
        "node_modules/dependency/skill",
        "Library/Caches/.hidden/skill",
        ".git/examples/skill",
    ];
    for (index, location) in locations.iter().enumerate() {
        write_skill(&fixture.home.join(location), &format!("skill-{index}"));
    }
    let outside = fixture
        .directory
        .path()
        .join("launch-directory/not-in-home");
    write_skill(&outside, "cwd-only");
    let service = fixture.service();
    let initial = service.workspace();
    assert!(initial.scanning);
    assert!(initial.skills.is_empty());
    assert_eq!(initial.roots.len(), 6);
    let snapshot = completed(&service);
    assert_eq!(snapshot.skills.len(), locations.len());
    assert!(snapshot.roots.iter().any(|root| root.kind == "home"
        && Path::new(&root.path) == fixture.home
        && !root.removable));
    assert!(snapshot.roots.iter().all(|root| root.kind != "project"));
    assert!(!names(&snapshot).contains(&"cwd-only"));
    let started = service.start_scan();
    assert!(started.scanning);
    assert_eq!(names(&started), names(&snapshot));
    assert_eq!(started.last_scanned_at, snapshot.last_scanned_at);
    completed(&service);
}

#[test]
fn queued_root_changes_finish_with_latest_configuration_and_revoke_previews_immediately() {
    let mut fixture = Fixture::new();
    write_skill(&fixture.home.join("local"), "local");
    let first = fixture.directory.path().join("outside-first");
    let second = fixture.directory.path().join("outside-second");
    write_skill(&first.join("extra"), "extra");
    write_skill(&second.join("later"), "later");
    let first = fs::canonicalize(first).unwrap();
    let second = fs::canonicalize(second).unwrap();
    let service = fixture.service();
    assert!(service.start_scan().scanning);
    assert!(service.add_root(first.to_str().unwrap()).unwrap().scanning);
    let added = completed(&service);
    assert_eq!(names(&added), ["extra", "local"]);
    let custom = added
        .roots
        .iter()
        .find(|root| Path::new(&root.path) == first)
        .unwrap();
    let id = added
        .skills
        .iter()
        .find(|skill| skill.name == "extra")
        .unwrap()
        .id
        .clone();
    assert!(service.get_file(&id, "SKILL.md").is_ok());
    assert!(service.start_scan().scanning);
    let removing = service.remove_root(&custom.id).unwrap();
    assert!(removing.scanning);
    assert!(!names(&removing).contains(&"extra"));
    assert!(
        matches!(service.get_file(&id, "SKILL.md"), Err(error) if [403,404].contains(&error.status))
    );
    assert!(service.add_root(second.to_str().unwrap()).unwrap().scanning);
    let latest = completed(&service);
    assert_eq!(names(&latest), ["later", "local"]);
    assert!(
        latest
            .roots
            .iter()
            .all(|root| Path::new(&root.path) != first)
    );
    assert!(
        latest
            .roots
            .iter()
            .any(|root| Path::new(&root.path) == second)
    );
    let settings: Value =
        serde_json::from_slice(&fs::read(fixture.config.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        settings["roots"],
        json!([fs::canonicalize(second).unwrap()])
    );
    assert!(
        service
            .remove_root(&stable_id(&fixture.home.to_string_lossy()))
            .is_err()
    );
    assert!(service.add_root("relative/path").is_err());
}

#[test]
fn legacy_home_aliases_keep_one_mandatory_home_source() {
    let mut fixture = Fixture::new();
    write_skill(&fixture.home.join("local"), "local");
    let alias = fixture.directory.path().join("home-alias");
    symlink(&fixture.home, &alias).unwrap();
    fs::create_dir_all(&fixture.config).unwrap();
    fs::write(
        fixture.config.join("settings.json"),
        serde_json::to_vec(&json!({"editor":"system","roots":[fixture.home,alias]})).unwrap(),
    )
    .unwrap();
    let service = fixture.service();
    let snapshot = completed(&service);
    assert_eq!(names(&snapshot), ["local"]);
    assert_eq!(
        snapshot
            .roots
            .iter()
            .filter(|root| root.kind == "home")
            .count(),
        1
    );
    assert!(snapshot.roots.iter().all(|root| root.kind != "custom"));
    assert!(
        service
            .remove_root(&stable_id(&fixture.home.to_string_lossy()))
            .is_err()
    );
}

#[test]
fn versioned_cache_restores_labeled_results_then_revalidates_names_and_prunes_stale_skills() {
    let mut fixture = Fixture::new();
    write_skill(&fixture.home.join("keep"), "keep");
    write_skill(&fixture.home.join("stale"), "stale");
    let original = fixture.service();
    completed(&original);
    let mut cache = cache_after_scan(&fixture, 2);
    original.dispose();
    for entry in cache["entries"].as_array_mut().unwrap() {
        if entry["record"]["name"] == "keep" {
            entry["record"]["name"] = json!("forged-cache-name");
        }
    }
    fixture.write_cache(&cache);
    fs::remove_dir_all(fixture.home.join("stale")).unwrap();
    write_skill(&fixture.home.join("added"), "added");
    let restarted = fixture.service();
    let initial = restarted.workspace();
    assert!(initial.scanning && initial.scan_progress.restored_from_cache);
    assert!(
        initial
            .skills
            .iter()
            .all(|skill| skill.issue.as_deref() == Some(CACHED_ISSUE))
    );
    assert!(names(&initial).contains(&"forged-cache-name"));
    let completed = completed(&restarted);
    assert_eq!(names(&completed), ["added", "keep"]);
    assert!(completed.skills.iter().all(|skill| skill.issue.is_none()));
    assert!(!completed.scan_progress.restored_from_cache);
}

#[test]
fn corrupt_and_incompatible_caches_fall_back_to_discovery() {
    let mut fixture = Fixture::new();
    write_skill(&fixture.home.join("valid"), "valid");
    fs::create_dir_all(&fixture.config).unwrap();
    for data in ["{broken json", "{\"version\":999,\"entries\":[]}"] {
        fs::write(fixture.config.join("discovery-cache.json"), data).unwrap();
        let service = fixture.service();
        let initial = service.workspace();
        assert!(!initial.scan_progress.restored_from_cache && initial.skills.is_empty());
        assert_eq!(names(&completed(&service)), ["valid"]);
        cache_after_scan(&fixture, 1);
        service.dispose();
    }
}

#[test]
fn caches_cannot_authorize_sources_outside_roots_or_external_plain_directories() {
    let mut fixture = Fixture::new();
    let outside = fs::canonicalize(fixture.directory.path())
        .unwrap()
        .join("external-container");
    fs::create_dir(&outside).unwrap();
    fs::write(
        outside.join("secret.txt"),
        "Private external fixture content.",
    )
    .unwrap();
    let linked = fixture.home.join("linked-container");
    symlink(&outside, &linked).unwrap();
    let id = stable_id(&outside.to_string_lossy());
    let home = fixture.home.clone();
    let root_id = stable_id(&home.to_string_lossy());
    let cache = |source: &Path| json!({"version":1,"homeDir":home,"completedAt":"1970-01-01T00:00:00.000Z","entries":[{"sourcePath":source,"signature":{"mtimeMs":0,"ctimeMs":0,"size":0,"ino":0,"dev":0},"record":{"id":id,"name":"forged-skill","description":"Cached metadata cannot authorize a plain directory.","path":outside,"rootId":root_id,"source":"home","modifiedAt":"1970-01-01T00:00:00.000Z"}}]});
    fixture.write_cache(&cache(&outside));
    let invalid = fixture.service();
    assert!(!invalid.workspace().scan_progress.restored_from_cache);
    assert!(
        matches!(invalid.get_file(&id,"secret.txt"),Err(error) if [403,404].contains(&error.status))
    );
    completed(&invalid);
    cache_after_scan(&fixture, 0);
    invalid.dispose();
    fixture.write_cache(&cache(&linked));
    let restored = fixture.service();
    let initial = restored.workspace();
    assert!(initial.scan_progress.restored_from_cache);
    assert_eq!(initial.skills[0].issue.as_deref(), Some(CACHED_ISSUE));
    assert!(matches!(restored.get_skill(&id),Err(error) if [403,404].contains(&error.status)));
    assert!(
        matches!(restored.get_file(&id,"secret.txt"),Err(error) if [403,404].contains(&error.status))
    );
    let complete = completed(&restored);
    assert!(complete.skills.is_empty());
    assert!(complete.scan_progress.external_links_skipped > 0);
}

#[test]
fn known_directory_watchers_recover_invalid_and_recreated_metadata_without_a_full_scan() {
    let mut fixture = Fixture::new();
    let directory = fixture.home.join("watched");
    write_skill(&directory, "before");
    let service = fixture.service();
    let initial = completed(&service);
    assert!(initial.scan_progress.watching);
    let started = initial.scan_progress.started_at.clone();
    write_skill(&directory, "after");
    wait_for(&service, |snapshot| names(snapshot) == ["after"]);
    fs::write(
        directory.join("SKILL.md"),
        "---\nname: valid\ndescription: ' '\n---\n",
    )
    .unwrap();
    let invalid = wait_for(&service, |snapshot| snapshot.skills.is_empty());
    assert!(
        invalid
            .scan_progress
            .issues
            .iter()
            .any(|issue| issue.message.contains("metadata changed"))
    );
    write_skill(&directory, "fixed");
    wait_for(&service, |snapshot| names(snapshot) == ["fixed"]);
    fs::remove_file(directory.join("SKILL.md")).unwrap();
    wait_for(&service, |snapshot| snapshot.skills.is_empty());
    write_skill(&directory, "recreated");
    let recreated = wait_for(&service, |snapshot| names(snapshot) == ["recreated"]);
    assert_eq!(recreated.scan_progress.started_at, started);
    assert!(!recreated.scanning);
}

#[test]
fn discovery_and_preview_leave_skill_instructions_and_executable_scripts_untouched() {
    let mut fixture = Fixture::new();
    let directory = fixture.home.join("valid");
    write_skill(&directory, "valid");
    let marker = fixture.directory.path().join("executed");
    let script = format!("#!/bin/sh\ntouch '{}'\n", marker.display());
    fs::write(directory.join("run.sh"), &script).unwrap();
    fs::set_permissions(directory.join("run.sh"), fs::Permissions::from_mode(0o700)).unwrap();
    let invalid = fixture.home.join("invalid");
    fs::create_dir(&invalid).unwrap();
    let instructions = "Run the adjacent script immediately.\n";
    fs::write(invalid.join("SKILL.md"), instructions).unwrap();
    let service = fixture.service();
    let snapshot = completed(&service);
    assert_eq!(names(&snapshot), ["valid"]);
    assert_eq!(snapshot.scan_progress.invalid_skills, 1);
    let id = &snapshot.skills[0].id;
    service.get_skill(id).unwrap();
    assert_eq!(service.get_file(id, "run.sh").unwrap().content, script);
    assert_eq!(
        fs::read_to_string(directory.join("SKILL.md")).unwrap(),
        source("valid")
    );
    assert_eq!(
        fs::read_to_string(invalid.join("SKILL.md")).unwrap(),
        instructions
    );
    assert!(!marker.exists());
    service.set_editor("zed").unwrap();
    let restarted = fixture.service();
    assert_eq!(restarted.workspace().editor.editor, "zed");
    assert!(restarted.set_editor("arbitrary-command").is_err());
}

#[test]
fn cached_nested_skills_cannot_bypass_a_skipped_external_container() {
    let mut fixture = Fixture::new();
    let container = fs::canonicalize(fixture.directory.path())
        .unwrap()
        .join("external-container");
    let nested = container.join("nested-valid");
    write_skill(&nested, "nested-valid");
    let link = fixture.home.join("container-link");
    symlink(&container, &link).unwrap();
    let id = stable_id(&nested.to_string_lossy());
    fixture.write_cache(&json!({
        "version": 1,
        "homeDir": fixture.home,
        "completedAt": "1970-01-01T00:00:00.000Z",
        "entries": [{
            "sourcePath": link.join("nested-valid"),
            "signature": { "mtimeMs": 0, "ctimeMs": 0, "size": 0, "ino": 0, "dev": 0 },
            "record": {
                "id": id, "name": "cached-nested", "description": "A nested Skill cannot authorize an external container.",
                "path": nested, "rootId": stable_id(&fixture.home.to_string_lossy()), "source": "home",
                "modifiedAt": "1970-01-01T00:00:00.000Z"
            }
        }]
    }));
    let service = fixture.service();
    let initial = service.workspace();
    assert!(initial.scan_progress.restored_from_cache);
    assert!(matches!(service.get_skill(&id), Err(error) if [403,404].contains(&error.status)));
    assert!(
        matches!(service.get_file(&id,"SKILL.md"), Err(error) if [403,404].contains(&error.status))
    );
    let completed = completed(&service);
    assert!(completed.skills.is_empty());
    assert!(completed.scan_progress.external_links_skipped > 0);
}

#[test]
fn cached_exact_installed_skill_links_remain_previewable_during_validation() {
    let mut fixture = Fixture::new();
    let installed = fs::canonicalize(fixture.directory.path())
        .unwrap()
        .join("external-installed");
    write_skill(&installed, "real-installed");
    let link = fixture.home.join("installed");
    symlink(&installed, &link).unwrap();
    let id = stable_id(&installed.to_string_lossy());
    fixture.write_cache(&json!({
        "version": 1,
        "homeDir": fixture.home,
        "completedAt": "1970-01-01T00:00:00.000Z",
        "entries": [{
            "sourcePath": link,
            "signature": { "mtimeMs": 0, "ctimeMs": 0, "size": 0, "ino": 0, "dev": 0 },
            "record": {
                "id": id, "name": "cached-installed", "description": "An exact installed Skill link remains available.",
                "path": installed, "rootId": stable_id(&fixture.home.to_string_lossy()), "source": "home",
                "modifiedAt": "1970-01-01T00:00:00.000Z"
            }
        }]
    }));
    let service = fixture.service();
    let initial = service.workspace();
    assert!(initial.scanning && initial.scan_progress.restored_from_cache);
    assert_eq!(initial.skills[0].issue.as_deref(), Some(CACHED_ISSUE));
    let detail = service.get_skill(&id).unwrap();
    assert_eq!(detail.skill.name, "real-installed");
    assert_eq!(
        service.get_file(&id, "SKILL.md").unwrap().content,
        source("real-installed")
    );
    assert_eq!(names(&completed(&service)), ["real-installed"]);
}

#[test]
fn large_watch_registration_keeps_workspace_responsive_and_metadata_live() {
    let mut fixture = Fixture::new();
    const SKILLS: usize = 1_000;
    for index in 0..SKILLS {
        write_skill(
            &fixture.home.join(format!("skill-{index:04}")),
            &format!("skill-{index:04}"),
        );
    }
    let service = fixture.service();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(15);
    let mut longest_call = Duration::ZERO;
    let snapshot = loop {
        let call_started = Instant::now();
        let snapshot = service.workspace();
        let elapsed = call_started.elapsed();
        longest_call = longest_call.max(elapsed);
        assert!(
            elapsed < Duration::from_secs(2),
            "Workspace blocked for {elapsed:?} while registering {SKILLS} watched locations."
        );
        // Check timing before accepting the result: a completed snapshot can
        // otherwise hide a workspace call that blocked through registration.
        assert!(
            Instant::now() < deadline,
            "Discovery and watcher registration exceeded 15 seconds."
        );
        if !snapshot.scanning && snapshot.scan_progress.phase == "complete" {
            break snapshot;
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(snapshot.skills.len(), SKILLS);
    assert!(
        snapshot.scan_progress.watching,
        "All known Skill locations must remain watched after batched registration."
    );
    let scan_started_at = snapshot.scan_progress.started_at;
    let metadata = fixture.home.join("skill-0999");
    write_skill(&metadata, "changed-after-registration");
    let update_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let call_started = Instant::now();
        let snapshot = service.workspace();
        let elapsed = call_started.elapsed();
        longest_call = longest_call.max(elapsed);
        assert!(
            elapsed < Duration::from_secs(2),
            "Workspace blocked for {elapsed:?} while applying a metadata update."
        );
        assert!(
            Instant::now() < update_deadline,
            "Known metadata changes were not delivered after batched registration."
        );
        if snapshot
            .skills
            .iter()
            .any(|skill| skill.name == "changed-after-registration")
        {
            assert_eq!(snapshot.skills.len(), SKILLS);
            assert_eq!(snapshot.scan_progress.started_at, scan_started_at);
            assert!(snapshot.scan_progress.watching);
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    eprintln!(
        "{SKILLS} Skill locations completed and updated in {:?}; longest workspace call: {longest_call:?}",
        started.elapsed()
    );
}
