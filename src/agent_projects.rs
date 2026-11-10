//! Bounded project evidence and identity-scoped project notes for Super Assistant.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

const MAX_FILES: usize = 12;
const MAX_BYTES: usize = 65_536;
const MAX_OVERVIEW: usize = 6_000;
static PROJECT_LOCK: Mutex<()> = Mutex::new(());
const CANDIDATES: &[&str] = &[
    "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "README.md", "readme.md", "README",
    "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Makefile", "CMakeLists.txt",
    "requirements.txt", "composer.json", "Gemfile", "pom.xml", "build.gradle", "deno.json",
    "src/main.rs", "src/main.ts", "src/index.ts", "src/App.tsx", "app.py", "main.py",
];

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    identity: String,
    cwd: String,
    fingerprint: String,
    updated_at: u64,
    sources: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn key(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() { hash = (hash ^ *byte as u64).wrapping_mul(0x100000001b3); }
    format!("{hash:016x}")
}

fn cwd_key(path: &Path) -> String {
    let value = dunce::simplified(path).to_string_lossy().into_owned();
    #[cfg(windows)]
    let value = value.to_ascii_lowercase();
    value
}

fn storage(root: &Path, route: &str, cwd: &str) -> Result<PathBuf, String> {
    if route.is_empty() || route.len() > 1_000 { return Err("Invalid project identity".into()); }
    fs::create_dir_all(root).map_err(|_| "Could not create Agent storage")?;
    let canonical_root = root.canonicalize().map_err(|_| "Agent storage unavailable")?;
    let mut directory = root.to_path_buf();
    for segment in ["projects".to_string(), key(route), key(cwd)] {
        directory.push(segment);
        if !directory.exists() { fs::create_dir(&directory).map_err(|_| "Could not create project storage")?; }
        if !directory.canonicalize().map_err(|_| "Project storage unavailable")?.starts_with(&canonical_root) {
            return Err("Project storage resolves outside Agent storage".into());
        }
    }
    for name in ["metadata.json", "overview.md"] {
        if fs::symlink_metadata(directory.join(name)).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("Project storage cannot use symlink files".into());
        }
    }
    Ok(directory)
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "File could not be read")?.take(limit as u64 + 1)
        .read_to_end(&mut bytes).map_err(|_| "File could not be read")?;
    if bytes.len() > limit { return Err("File exceeds scan budget".into()); }
    Ok(bytes)
}

fn ignored_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".env") || lower.ends_with(".pem") || lower.ends_with(".key")
        || ["secret", "credential", "password", "token"].iter().any(|part| lower.contains(part))
        || matches!(lower.as_str(), ".git" | "node_modules" | "target" | "dist" | "build" | "vendor" | ".venv" | "venv" | "__pycache__")
}

pub(super) fn ignored_by_rules(relative: &str, rules: &str) -> bool {
    let mut ignored = false;
    for rule in rules.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).take(200) {
        let (negated, rule) = match rule.strip_prefix('!') { Some(value) => (true, value), None => (false, rule) };
        let rule = rule.trim_start_matches('/').trim_end_matches('/');
        if rule.is_empty() { continue; }
        let pattern = regex::escape(rule).replace("\\*\\*", ".*").replace("\\*", "[^/]*").replace("\\?", "[^/]");
        let pattern = if rule.contains('/') { format!("^{pattern}(?:/|$)") } else { format!("(?:^|/){pattern}(?:/|$)") };
        if regex::Regex::new(&pattern).is_ok_and(|pattern| pattern.is_match(relative)) { ignored = !negated; }
    }
    ignored
}

fn collect(cwd: &Path) -> Result<Value, String> {
    let git = crate::git::project_snapshot(&dunce::simplified(cwd).to_string_lossy());
    let git_ignored = if git["state"] == "ok" {
        Some(crate::git::project_ignored(&dunce::simplified(cwd).to_string_lossy(), CANDIDATES)?)
    } else { None };
    let rules = if cwd.join(".gitignore").symlink_metadata().is_ok_and(|metadata| metadata.is_file()) {
        read_bounded(&cwd.join(".gitignore"), 8_192).ok().and_then(|value| String::from_utf8(value).ok()).unwrap_or_default()
    } else { String::new() };
    let mut sources = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut fingerprint = format!("{}:{}:{}:{}", cwd_key(cwd), git["state"], git["branch"], git["head"]);
    fingerprint.push_str(&key(&rules));
    let mut total = 0usize;
    for relative in CANDIDATES {
        let path = cwd.join(relative);
        if !path.exists() { fingerprint.push_str(&format!("|{relative}:missing")); continue; }
        let blocked = Path::new(relative).components().any(|part| ignored_name(&part.as_os_str().to_string_lossy()));
        if blocked || git_ignored.as_ref().map_or_else(|| ignored_by_rules(relative, &rules), |paths| paths.contains(*relative)) {
            skipped.push(json!({"path":relative,"reason":"ignored"})); continue;
        }
        let mut cursor = cwd.to_path_buf();
        let mut safe = true;
        for part in Path::new(relative).components() {
            cursor.push(part);
            if fs::symlink_metadata(&cursor).is_ok_and(|metadata| metadata.file_type().is_symlink()) { safe = false; break; }
        }
        let canonical = path.canonicalize().map_err(|_| "Project file unavailable")?;
        if !safe || !canonical.starts_with(cwd) {
            skipped.push(json!({"path":relative,"reason":"symlink or outside workspace"})); continue;
        }
        if !seen.insert(cwd_key(&canonical)) { continue; }
        let metadata = path.metadata().map_err(|_| "Project file unavailable")?;
        fingerprint.push_str(&format!("|{relative}:{}:{:?}", metadata.len(), metadata.modified().ok()));
        if sources.len() >= MAX_FILES || metadata.len() as usize > MAX_BYTES.saturating_sub(total) {
            skipped.push(json!({"path":relative,"reason":"scan budget"})); continue;
        }
        match read_bounded(&path, MAX_BYTES - total).and_then(|bytes| {
            if bytes.contains(&0) { return Err("Not UTF-8 text".into()); }
            String::from_utf8(bytes).map_err(|_| "Not UTF-8 text".into())
        }) {
            Ok(content) => {
                total += content.len();
                fingerprint.push_str(&key(&content));
                sources.push(json!({"path":relative,"bytes":content.len(),"content":content}));
            }
            Err(reason) => skipped.push(json!({"path":relative,"reason":reason})),
        }
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for (index, entry) in fs::read_dir(cwd).map_err(|_| "Project directory could not be listed")?.take(201).enumerate() {
        if index == 200 { truncated = true; break; }
        let entry = entry.map_err(|_| "Project directory could not be listed")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignored_name(&name) || ignored_by_rules(&name, &rules) { continue; }
        if entries.len() == 200 { truncated = true; break; }
        let kind = entry.file_type().map_err(|_| "Project entry unavailable")?;
        entries.push(json!({"name":name,"kind":if kind.is_symlink() {"link"} else if kind.is_dir() {"directory"} else {"file"}}));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    fingerprint.push_str(&serde_json::to_string(&entries).map_err(|_| "Invalid project entries")?);
    Ok(json!({"fingerprint":key(&fingerprint),"sources":sources,"entries":entries,"skipped":skipped,"truncated":truncated||!skipped.is_empty(),"scannedBytes":total,"git":git}))
}

fn collect_with_graph(root: &Path, route: &str, cwd: &Path) -> Result<Value, String> {
    let mut facts = collect(cwd)?;
    let graph = crate::agent_graphify::inspect(root, route, &dunce::simplified(cwd).to_string_lossy())
        .unwrap_or_else(|error| json!({"state":"unavailable","error":error}));
    facts["fingerprint"] = json!(key(&format!("{}:{}",facts["fingerprint"],graph)));
    facts["graphify"] = graph;
    Ok(facts)
}

fn read_metadata(directory: &Path, route: &str, cwd: &str) -> Result<Option<Metadata>, String> {
    let path = directory.join("metadata.json");
    if !path.exists() { return Ok(None); }
    let data: Metadata = serde_json::from_slice(&read_bounded(&path, MAX_BYTES)?).map_err(|_| "Invalid project metadata")?;
    if data.identity != route || data.cwd != cwd { return Err("Project identity or directory mismatch".into()); }
    Ok(Some(data))
}

/// root is the existing Agent data directory; route comes from the saved conversation.
pub(crate) fn project_inspect(root: &Path, route: &str, cwd: &str, refresh: bool) -> Result<Value, String> {
    let _lock = PROJECT_LOCK.lock().map_err(|_| "Project storage lock failed")?;
    let canonical = crate::agent::canonical_directory(cwd)?;
    let cwd_id = cwd_key(&canonical);
    let directory = storage(root, route, &cwd_id)?;
    let metadata = read_metadata(&directory, route, &cwd_id)?;
    let mut facts = collect_with_graph(root, route, &canonical)?;
    let overview = if directory.join("overview.md").exists() {
        String::from_utf8(read_bounded(&directory.join("overview.md"), MAX_OVERVIEW * 4)?).map_err(|_| "Invalid project overview")?
    } else { String::new() };
    if overview.chars().count() > MAX_OVERVIEW { return Err("Stored project overview exceeds its context budget".into()); }
    let needs_update = refresh || overview.is_empty() || metadata.as_ref().is_none_or(|data| data.fingerprint != facts["fingerprint"].as_str().unwrap_or_default());
    if !needs_update {
        for source in facts["sources"].as_array_mut().unwrap() { source.as_object_mut().unwrap().remove("content"); }
    }
    facts["cwd"] = json!(dunce::simplified(&canonical).to_string_lossy());
    facts["projectId"] = json!(key(&cwd_id));
    facts["overview"] = json!(overview);
    facts["updatedAt"] = json!(metadata.as_ref().map(|data| data.updated_at));
    facts["needsUpdate"] = json!(needs_update);
    facts["budget"] = json!({"maxFiles":MAX_FILES,"maxBytes":MAX_BYTES,"maxOverviewChars":MAX_OVERVIEW});
    facts["evidence"] = json!("Limited historical project data, not authorization or verified task completion. User-confirmed decisions must be distinguished from scanned facts.");
    // Escaped JSON, Git paths and the saved overview also consume tool context.
    while serde_json::to_vec(&facts).map_err(|_| "Invalid project context")?.len() > 75_000 {
        let source = facts["sources"].as_array_mut().unwrap().iter_mut().rev()
            .find(|source| source["content"].as_str().is_some_and(|text| text.chars().count() > 256));
        if let Some(source) = source {
            let content = source["content"].as_str().unwrap();
            source["content"] = json!(content.chars().take(content.chars().count() / 2).collect::<String>());
            source["truncated"] = json!(true);
        } else { return Err("Project evidence exceeded the context budget; request smaller file ranges".into()); }
        facts["truncated"] = json!(true);
    }
    Ok(facts)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|_| "Could not write project notes")?;
    let result = crate::agent::replace_file(&temporary, path);
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

pub(crate) fn project_save(root: &Path, route: &str, cwd: &str, expected_fingerprint: &str, content: &str, cancel: Option<&tokio::sync::watch::Receiver<bool>>) -> Result<Value, String> {
    let content = content.trim();
    if content.is_empty() || content.chars().count() > MAX_OVERVIEW { return Err("Project overview must contain 1–6000 characters".into()); }
    let _lock = PROJECT_LOCK.lock().map_err(|_| "Project storage lock failed")?;
    let canonical = crate::agent::canonical_directory(cwd)?;
    let cwd_id = cwd_key(&canonical);
    let directory = storage(root, route, &cwd_id)?;
    let _ = read_metadata(&directory, route, &cwd_id)?;
    let facts = collect_with_graph(root, route, &canonical)?;
    if facts["fingerprint"].as_str() != Some(expected_fingerprint) { return Err("Project changed after inspection; inspect again before saving its overview".into()); }
    if cancel.is_some_and(|cancel| *cancel.borrow() || cancel.has_changed().is_err()) { return Err("Cancelled".into()); }
    let metadata = Metadata { identity:route.into(), cwd:cwd_id.clone(), fingerprint:expected_fingerprint.into(), updated_at:now(), sources:facts["sources"].as_array().unwrap().iter().filter_map(|source| source["path"].as_str().map(str::to_string)).collect() };
    write_atomic(&directory.join("overview.md"), content.as_bytes())?;
    write_atomic(&directory.join("metadata.json"), &serde_json::to_vec_pretty(&metadata).map_err(|_| "Invalid project notes")?)?;
    Ok(json!({"saved":true,"projectId":key(&cwd_id),"cwd":dunce::simplified(&canonical).to_string_lossy(),"fingerprint":expected_fingerprint,"updatedAt":metadata.updated_at}))
}

/// Historical notes only; these never choose or authorize a current workspace.
pub(crate) fn recent_overviews(root: &Path, route: &str) -> Result<Vec<Value>, String> {
    let _lock = PROJECT_LOCK.lock().map_err(|_| "Project storage lock failed")?;
    if route.is_empty() || route.len() > 1_000 { return Err("Invalid project identity".into()); }
    if !root.exists() { return Ok(Vec::new()); }
    let canonical_root = root.canonicalize().map_err(|_| "Agent storage unavailable")?;
    let mut directory = root.to_path_buf();
    for segment in ["projects".to_string(), key(route)] {
        directory.push(segment);
        if !directory.exists() { return Ok(Vec::new()); }
        if fs::symlink_metadata(&directory).map_err(|_| "Project storage unavailable")?.file_type().is_symlink()
            || !directory.canonicalize().map_err(|_| "Project storage unavailable")?.starts_with(&canonical_root) {
            return Err("Project storage resolves outside Agent storage".into());
        }
    }
    let mut notes = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| "Project storage could not be listed")? {
        let entry = entry.map_err(|_| "Project storage unavailable")?;
        if !entry.file_type().map_err(|_| "Project storage unavailable")?.is_dir() { continue; }
        let path = entry.path();
        if !path.canonicalize().map_err(|_| "Project storage unavailable")?.starts_with(&canonical_root) { continue; }
        let files = [path.join("metadata.json"), path.join("overview.md")];
        if files.iter().any(|file| !fs::symlink_metadata(file).is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())) { continue; }
        let Ok(metadata) = read_bounded(&files[0], MAX_BYTES).and_then(|bytes| serde_json::from_slice::<Metadata>(&bytes).map_err(|_| "Invalid project metadata".into())) else { continue; };
        if metadata.identity != route || entry.file_name().to_string_lossy() != key(&metadata.cwd) { continue; }
        let Ok(overview) = read_bounded(&files[1], MAX_OVERVIEW * 4).and_then(|bytes| String::from_utf8(bytes).map_err(|_| "Invalid project overview".into())) else { continue; };
        if overview.is_empty() || overview.chars().count() > MAX_OVERVIEW { continue; }
        notes.push((metadata, overview));
        notes.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at).then_with(|| a.0.cwd.cmp(&b.0.cwd)));
        notes.truncate(3);
    }
    let mut result = Vec::new();
    for (metadata, overview) in notes {
        let mut note = json!({"cwd":metadata.cwd,"updatedAt":metadata.updated_at,"overview":"","historical":true,"truncated":false});
        let used = serde_json::to_string(&result).map_err(|_| "Invalid project history")?.chars().count();
        let overhead = note.to_string().chars().count() + 1;
        if used + overhead >= MAX_OVERVIEW { break; }
        let text = overview.chars().take(2_000.min(MAX_OVERVIEW - used - overhead)).collect::<String>();
        note["overview"] = json!(text);
        // JSON escaping also counts toward the model's historical context budget.
        while used + note.to_string().chars().count() + 1 > MAX_OVERVIEW {
            let text = note["overview"].as_str().unwrap();
            note["overview"] = json!(text.chars().take(text.chars().count() / 2).collect::<String>());
        }
        note["truncated"] = json!(note["overview"].as_str().unwrap().chars().count() < overview.chars().count());
        result.push(note);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf { std::env::temp_dir().join(format!("coffee-projects-{}", uuid::Uuid::new_v4())) }
    #[test]
    fn notes_are_isolated_and_refresh_when_sources_change() {
        let root = root(); let cwd = root.join("workspace"); fs::create_dir_all(&cwd).unwrap(); fs::write(cwd.join("README.md"), "First project").unwrap();
        let first = project_inspect(&root.join("agent"), "telegram-a", cwd.to_str().unwrap(), false).unwrap();
        project_save(&root.join("agent"), "telegram-a", cwd.to_str().unwrap(), first["fingerprint"].as_str().unwrap(), "Project A; source README.md", None).unwrap();
        let cached = project_inspect(&root.join("agent"), "telegram-a", cwd.to_str().unwrap(), false).unwrap();
        assert_eq!(cached["needsUpdate"], false); assert!(cached["sources"][0].get("content").is_none());
        assert_eq!(project_inspect(&root.join("agent"), "telegram-b", cwd.to_str().unwrap(), false).unwrap()["overview"], "");
        assert_eq!(project_inspect(&root.join("agent"), "telegram-a", cwd.to_str().unwrap(), true).unwrap()["needsUpdate"], true);
        fs::write(cwd.join("README.md"), "Other project content").unwrap();
        assert_eq!(project_inspect(&root.join("agent"), "telegram-a", cwd.to_str().unwrap(), false).unwrap()["needsUpdate"], true);
        assert!(project_save(&root.join("agent"), "telegram-a", cwd.to_str().unwrap(), first["fingerprint"].as_str().unwrap(), "stale", None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn scans_are_bounded_and_ignored_files_are_not_read() {
        let root = root(); fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "x".repeat(MAX_BYTES + 1)).unwrap();
        fs::write(root.join("AGENTS.md"), "private data").unwrap(); fs::write(root.join(".gitignore"), "AGENTS.md\n").unwrap();
        fs::write(root.join(".env"), "API_KEY=secret").unwrap(); fs::write(root.join("package.json"), "{}").unwrap();
        let result = collect(&root.canonicalize().unwrap()).unwrap();
        assert!(result["scannedBytes"].as_u64().unwrap() <= MAX_BYTES as u64);
        assert!(result["sources"].as_array().unwrap().len() <= MAX_FILES);
        assert!(!result.to_string().contains("private data")); assert!(!result.to_string().contains("API_KEY"));
        assert!(result["skipped"].as_array().unwrap().iter().any(|item| item["reason"] == "scan budget"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn same_named_projects_do_not_share_notes_and_summary_limit_is_enforced() {
        let root = root(); let first = root.join("one/demo"); let second = root.join("two/demo"); fs::create_dir_all(&first).unwrap(); fs::create_dir_all(&second).unwrap();
        let info = project_inspect(&root.join("agent"), "desktop", first.to_str().unwrap(), false).unwrap();
        project_save(&root.join("agent"), "desktop", first.to_str().unwrap(), info["fingerprint"].as_str().unwrap(), "First project", None).unwrap();
        assert_eq!(project_inspect(&root.join("agent"), "desktop", second.to_str().unwrap(), false).unwrap()["overview"], "");
        assert!(project_save(&root.join("agent"), "desktop", first.to_str().unwrap(), info["fingerprint"].as_str().unwrap(), &"x".repeat(MAX_OVERVIEW+1), None).is_err());
        assert!(project_inspect(&root.join("agent"), "desktop", "relative", false).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn historical_notes_are_recent_bounded_and_identity_checked_after_reopen() {
        let root = root(); let agent = root.join("agent");
        for index in 0..4 {
            let cwd = root.join(format!("workspace-{index}")); fs::create_dir_all(&cwd).unwrap();
            let info = project_inspect(&agent, "desktop", cwd.to_str().unwrap(), false).unwrap();
            let overview = format!("Project {index}\n{}", "项目\n\"quoted\"".repeat(500)).chars().take(MAX_OVERVIEW).collect::<String>();
            project_save(&agent, "desktop", cwd.to_str().unwrap(), info["fingerprint"].as_str().unwrap(), &overview, None).unwrap();
            let directory = storage(&agent, "desktop", &cwd_key(&cwd.canonicalize().unwrap())).unwrap();
            let mut metadata = read_metadata(&directory, "desktop", &cwd_key(&cwd.canonicalize().unwrap())).unwrap().unwrap();
            metadata.updated_at = index + 1;
            fs::write(directory.join("metadata.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
            fs::remove_dir_all(cwd).unwrap();
        }
        let notes = recent_overviews(&agent, "desktop").unwrap();
        assert_eq!(notes.len(), 3);
        assert_eq!(notes[0]["updatedAt"], 4);
        assert!(notes[0]["overview"].as_str().unwrap().starts_with("Project 3"));
        assert!(notes.iter().all(|note| note["historical"] == true));
        assert!(serde_json::to_string(&notes).unwrap().chars().count() <= MAX_OVERVIEW);
        assert!(recent_overviews(&agent, "weixin-owner").unwrap().is_empty());
        let directory = storage(&agent, "desktop", notes[0]["cwd"].as_str().unwrap()).unwrap();
        let mut metadata = read_metadata(&directory, "desktop", notes[0]["cwd"].as_str().unwrap()).unwrap().unwrap();
        metadata.identity = "weixin-owner".into();
        fs::write(directory.join("metadata.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(!recent_overviews(&agent, "desktop").unwrap().iter().any(|note| note["updatedAt"] == 4));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_project_updates_do_not_overwrite_saved_understanding() {
        let root = root(); let cwd = root.join("workspace"); fs::create_dir_all(&cwd).unwrap();
        let agent = root.join("agent");
        let info = project_inspect(&agent, "desktop", cwd.to_str().unwrap(), false).unwrap();
        let fingerprint = info["fingerprint"].as_str().unwrap();
        project_save(&agent, "desktop", cwd.to_str().unwrap(), fingerprint, "Original understanding", None).unwrap();
        let (sender, cancel) = tokio::sync::watch::channel(false); sender.send(true).unwrap();
        assert_eq!(project_save(&agent, "desktop", cwd.to_str().unwrap(), fingerprint, "Cancelled update", Some(&cancel)).unwrap_err(), "Cancelled");
        assert_eq!(project_inspect(&agent, "desktop", cwd.to_str().unwrap(), false).unwrap()["overview"], "Original understanding");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn project_symlinks_cannot_read_outside_workspaces() {
        let root = root(); let workspace = root.join("project"); fs::create_dir_all(&workspace).unwrap(); fs::write(root.join("secret.txt"), "outside-private-text").unwrap();
        std::os::unix::fs::symlink(root.join("secret.txt"), workspace.join("README.md")).unwrap();
        let result = collect(&workspace.canonicalize().unwrap()).unwrap(); assert!(!result.to_string().contains("outside-private-text"));
        fs::remove_dir_all(root).unwrap();
    }
}
