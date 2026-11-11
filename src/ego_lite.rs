//! ego lite browser integration.
//!
//! ego lite ships its own Chromium and exposes it to agents through a Skill
//! plus the `ego-browser` command — it is not an MCP server. Coffee therefore
//! distributes that Skill to every CLI it launches, tells the agent to prefer
//! it, and can allow the command without touching the user's own rules.
//!
//! Three things make a CLI browser-capable, and all three are needed:
//!   1. the Skill is discoverable (a copy or a link in the CLI's skills root),
//!   2. the agent knows to prefer it (a marked block in the global instruction
//!      file),
//!   3. the command is not blocked by the CLI's approval policy (an explicit,
//!      opt-in allowance that covers the `ego-browser` prefix only).

use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, time::Duration};

const SKILL_NAME: &str = "ego-browser";
const INSTRUCTION_START: &str = "<!-- coffee-cli:ego-browser:start -->";
const INSTRUCTION_END: &str = "<!-- coffee-cli:ego-browser:end -->";
const INSTRUCTION_BODY: &str = "\
## Browser tasks (ego lite)

When a task needs the web — opening pages, clicking, filling forms, taking
screenshots, reading page content, or testing a web app — drive the browser
through ego lite:

1. Run `ego-browser skill` first and follow that guide; it matches the
   installed ego lite version.
2. Work in a single TaskSpace and drive it with `ego-browser nodejs` scripts.
3. On Windows PowerShell 5.1, write the script to a UTF-8 `.mjs` file and run
   `ego-browser nodejs < file.mjs`; `-e` arguments mangle quotes and
   non-ASCII text.

Prefer ego lite over any other browser automation route. Keep login, captcha,
payment and final submission to the user.";

/// The marked block that tells an agent ego lite is the default browser.
pub(crate) fn instruction_block() -> String {
    format!("{INSTRUCTION_START}\n{INSTRUCTION_BODY}\n{INSTRUCTION_END}\n")
}

/// Skill states reported per CLI.
const SKILL_INSTALLED: &str = "installed";
const SKILL_MANAGED: &str = "managed";
const SKILL_MODIFIED: &str = "modified";
const SKILL_FOREIGN: &str = "foreign";
const SKILL_MISSING: &str = "missing";
const SKILL_UNSUPPORTED: &str = "unsupported";

#[derive(Clone, Serialize, Deserialize, Default)]
struct EgoConfig {
    /// CLIs whose `ego-browser` command may run without a per-call approval.
    #[serde(default)]
    allow_command: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoAgent {
    tool: String,
    supported: bool,
    skill: String,
    instruction: bool,
    instruction_supported: bool,
    permission: String,
    issue: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoStatus {
    supported: bool,
    installed: bool,
    version: Option<String>,
    skill_path: Option<String>,
    skill_version: Option<String>,
    agents: Vec<EgoAgent>,
    /// CLIs that still carry the retired agent-browser MCP entry.
    legacy: Vec<String>,
}

fn home_dir() -> Result<PathBuf, String> { dirs::home_dir().ok_or_else(|| "ego_read".to_string()) }
fn abs_env(key: &str) -> Option<PathBuf> { std::env::var_os(key).map(PathBuf::from).filter(|path| path.is_absolute()) }

fn config_home(home: &Path) -> PathBuf { abs_env("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")) }

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.file_type().is_symlink()
            || {
                #[cfg(windows)]
                { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
                #[cfg(not(windows))]
                { false }
            }
    })
}

/// Every place the ego lite runtime may live. The installer registers
/// `ego-browser` on PATH; the version directory also carries the Skill.
fn executable_candidates(home: &Path, env: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = env("EGO_BROWSER_PATH") {
        out.push(if path.is_dir() { path.join(exe_name()) } else { path });
    }
    #[cfg(windows)]
    {
        if let Some(local) = env("LOCALAPPDATA") {
            out.push(local.join(".local/share/ego/active_version_dir").join(exe_name()));
            out.push(local.join("Programs/Citro Labs/ego lite/Application").join(exe_name()));
        }
        out.push(home.join(".local/share/ego/active_version_dir").join(exe_name()));
        out.push(home.join(".local/share/ego/active_version_dir").join("ego-browser"));
        for base in [env("ProgramFiles"), env("ProgramFiles(x86)")].into_iter().flatten() {
            let root = base.join("Citro Labs/ego lite/Application");
            if let Ok(entries) = fs::read_dir(&root) {
                let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
                versions.sort();
                versions.reverse();
                for version in versions {
                    out.push(version.join(exe_name()));
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        out.push(home.join(".local/share/ego/active_version_dir/ego-browser"));
        out.push(PathBuf::from("/Applications/ego lite.app/Contents/MacOS/ego-browser"));
    }
    out
}

fn exe_name() -> &'static str {
    #[cfg(windows)] { "ego-browser.exe" }
    #[cfg(not(windows))] { "ego-browser" }
}

fn find_executable() -> Option<PathBuf> {
    let home = home_dir().ok()?;
    let env = |key: &str| abs_env(key);
    executable_candidates(&home, &env).into_iter().find(|path| path.is_file())
}

/// Where the runtime keeps its Skill.
fn skill_candidates(home: &Path, executable: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(directory) = executable.and_then(|path| path.parent()) {
        out.push(directory.join("ego-skills").join(SKILL_NAME));
        out.push(directory.join("..").join("ego-skills").join(SKILL_NAME));
    }
    out.push(home.join(".local/share/ego/ego-skills"));
    out.push(home.join(".local/share/ego/active_version_dir/ego-skills").join(SKILL_NAME));
    out
}

fn find_skill_directory(home: &Path, executable: Option<&Path>) -> Option<PathBuf> {
    skill_candidates(home, executable)
        .into_iter()
        .find(|path| path.join("SKILL.md").is_file())
        .map(|path| dunce::canonicalize(&path).unwrap_or(path))
}

/// Version from the Skill's front matter (`metadata.version`).
fn skill_version(directory: &Path) -> Option<String> {
    let text = fs::read_to_string(directory.join("SKILL.md")).ok()?;
    for line in text.lines().take(40) {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("version:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() { return Some(value.to_string()); }
        }
    }
    None
}

/// Content digest of a Skill directory, so a copied Skill can be compared
/// with the runtime's copy and a user edit can be detected.
fn directory_digest(directory: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    fn walk(base: &Path, path: &Path, entries: &mut Vec<(String, Vec<u8>)>) -> Option<()> {
        for entry in fs::read_dir(path).ok()? {
            let entry = entry.ok()?;
            let child = entry.path();
            let meta = entry.metadata().ok()?;
            if meta.is_dir() { walk(base, &child, entries)?; }
            else if meta.is_file() {
                let mut bytes = Vec::new();
                fs::File::open(&child).ok()?.read_to_end(&mut bytes).ok()?;
                let relative = child.strip_prefix(base).ok()?.to_string_lossy().replace('\\', "/");
                entries.push((relative, bytes));
            }
        }
        Some(())
    }
    let mut entries = Vec::new();
    walk(directory, directory, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    for (path, bytes) in &entries {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(&(bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Some(format!("{:x}", hash.finalize()))
}

/// Ask the runtime for its version. A hung runtime must not block the UI.
fn probe_version(executable: &Path) -> Option<String> {
    let mut command = Command::new(executable);
    command.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::tool_control::hidden(&mut command);
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let mut text = String::new(); let _ = stdout.take(4096).read_to_string(&mut text); let _ = sender.send(text); });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(30)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
    let text = receiver.recv_timeout(Duration::from_millis(200)).ok()?;
    let line = text.lines().next()?.trim();
    if line.is_empty() { None } else { Some(line.to_string()) }
}

/// State of the ego Skill for one CLI.
fn skill_state(tool: &str, source: Option<&Path>) -> String {
    let roots = match crate::tool_skills::skill_roots(tool) { Ok(roots) => roots, Err(_) => return SKILL_UNSUPPORTED.into() };
    if roots.is_empty() { return SKILL_UNSUPPORTED.into(); }
    let source_digest = source.and_then(directory_digest);
    for root in roots {
        let candidate = root.join(SKILL_NAME);
        let Ok(meta) = fs::symlink_metadata(&candidate) else { continue };
        if is_link(&candidate) {
            let resolved = dunce::canonicalize(&candidate).unwrap_or_default();
            let source_resolved = source.map(|path| dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()));
            return if source_resolved.is_some_and(|path| path == resolved) { SKILL_MANAGED.into() } else { SKILL_FOREIGN.into() };
        }
        if !meta.is_dir() { continue; }
        let Some(digest) = directory_digest(&candidate) else { continue };
        return match source_digest {
            // Without a runtime copy to compare against, an existing copy is
            // simply reported as present.
            None => SKILL_INSTALLED.into(),
            Some(expected) if expected == digest => SKILL_INSTALLED.into(),
            _ => SKILL_MODIFIED.into(),
        };
    }
    SKILL_MISSING.into()
}

/// The CLI's global instruction file, when the CLI has a documented one.
fn instruction_file(tool: &str, home: &Path) -> Option<PathBuf> {
    match tool {
        "claude" => Some(home.join(".claude").join("CLAUDE.md")),
        "codex" => Some(abs_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex")).join("AGENTS.md")),
        "opencode" => Some(abs_env("OPENCODE_CONFIG_DIR").unwrap_or_else(|| config_home(home).join("opencode")).join("AGENTS.md")),
        _ => None,
    }
}

fn instruction_present(tool: &str, home: &Path) -> bool {
    instruction_file(tool, home)
        .and_then(|path| fs::read_to_string(path).ok())
        .is_some_and(|text| text.contains(INSTRUCTION_START))
}

/// Append or drop the marked block without touching the rest of the file.
fn compose_instruction(original: Option<&str>, enabled: bool) -> String {
    let mut content = original.unwrap_or_default().to_string();
    if enabled {
        if !content.contains(INSTRUCTION_START) {
            if !content.is_empty() && !content.ends_with('\n') { content.push('\n'); }
            if !content.is_empty() { content.push('\n'); }
            content.push_str(&instruction_block());
        }
    } else if let Some(start) = content.find(INSTRUCTION_START) {
        if let Some(end) = content[start..].find(INSTRUCTION_END) {
            let end = start + end + INSTRUCTION_END.len();
            let mut tail = content[end..].trim_start_matches('\n').to_string();
            if !tail.is_empty() { tail.insert(0, '\n'); }
            content = format!("{}{}", &content[..start], tail);
        }
    }
    content
}

fn config_path() -> Result<PathBuf, String> { Ok(home_dir()?.join(".coffee-cli/control/ego.json")) }

fn read_config() -> Result<EgoConfig, String> {
    let path = config_path()?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "ego_read".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EgoConfig::default()),
        Err(_) => Err("ego_read".into()),
    }
}

fn write_config(config: &EgoConfig) -> Result<(), String> {
    let path = config_path()?;
    crate::tool_control::plain_path(&path)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|_| "ego_write")?; }
    let temp = path.with_file_name(format!(".ego-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_| "ego_write")?;
        file.write_all(&serde_json::to_vec(config).map_err(|_| "ego_write")?).map_err(|_| "ego_write")?;
        file.sync_all().map_err(|_| "ego_write")?;
        crate::agent::replace_file(&temp, &path).map_err(|_| "ego_write".to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

/// Whether the CLI may run `ego-browser` without asking the user first.
pub(crate) fn command_allowed(tool: &str) -> bool {
    read_config().map(|config| config.allow_command.iter().any(|entry| entry == tool)).unwrap_or(false)
}

fn permission_state(tool: &str) -> &'static str {
    match tool {
        // Claude Code takes an explicit allowance list on the command line.
        "claude" => if command_allowed("claude") { "allowed" } else { "prompt" },
        _ => "unsupported",
    }
}

fn agent_row(tool: &str, home: &Path, source: Option<&Path>) -> EgoAgent {
    let skill = skill_state(tool, source);
    let supported = skill != SKILL_UNSUPPORTED;
    let instruction_supported = instruction_file(tool, home).is_some();
    let issue = match skill.as_str() {
        SKILL_MODIFIED => Some("modified"),
        SKILL_FOREIGN => Some("foreign"),
        _ => None,
    };
    EgoAgent {
        tool: tool.to_string(),
        supported,
        skill,
        instruction: instruction_supported && instruction_present(tool, home),
        instruction_supported,
        permission: permission_state(tool).to_string(),
        issue: issue.map(|value| value.to_string()),
    }
}

fn status() -> Result<EgoStatus, String> {
    let home = home_dir()?;
    let executable = find_executable();
    let installed = executable.is_some();
    let skill = if installed { find_skill_directory(&home, executable.as_deref()) } else { None };
    let mut agents = Vec::new();
    for tool in crate::tool_skills::skill_tools() {
        agents.push(agent_row(tool, &home, skill.as_deref()));
    }
    let mut legacy = Vec::new();
    for tool in crate::tools::TOOLS {
        if crate::tool_control::has_mcp_entry(tool.id, "coffee-browser-use").unwrap_or(false) { legacy.push(tool.id.to_string()); }
    }
    Ok(EgoStatus {
        // ego lite publishes an installer for Windows only; other platforms
        // have no supported way to install the runtime.
        supported: cfg!(windows),
        installed,
        version: executable.as_deref().and_then(probe_version),
        skill_path: skill.as_ref().map(|path| path.to_string_lossy().into_owned()),
        skill_version: skill.as_deref().and_then(skill_version),
        agents,
        legacy,
    })
}

#[tauri::command]
pub async fn get_ego_status() -> Result<EgoStatus, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|_| "ego_read")?
}

/// Install the ego Skill into one CLI or into every CLI that supports Skills.
#[tauri::command]
pub async fn install_ego_skill(tool: Option<String>) -> Result<EgoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home_dir()?;
        let executable = find_executable().ok_or("ego_missing")?;
        let source = find_skill_directory(&home, Some(&executable)).ok_or("ego_missing")?;
        let targets: Vec<String> = match tool {
            Some(tool) => vec![tool],
            None => crate::tool_skills::skill_tools().iter().map(|tool| tool.to_string()).collect(),
        };
        let mut last = String::new();
        for target in targets {
            match skill_state(&target, Some(&source)).as_str() {
                // The ego installer already linked the Skill; copying over a
                // link would replace the link with a stale copy.
                SKILL_MANAGED => continue,
                // A Skill the user edited or another Skill in the way stays
                // untouched; the per-agent issue explains why.
                SKILL_FOREIGN | SKILL_MODIFIED => continue,
                _ => {}
            }
            if let Err(error) = crate::tool_skills::install_local_skill(&target, &source, SKILL_NAME) {
                if error != "skills_unsupported" { last = error; }
            }
        }
        if !last.is_empty() { return Err(last); }
        status()
    }).await.map_err(|_| "ego_write")?
}

/// Remove the Skill copy Coffee installed. Linked or user-edited Skills stay.
#[tauri::command]
pub async fn remove_ego_skill(tool: String) -> Result<EgoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::tool_skills::remove_skill(&tool, SKILL_NAME)?;
        status()
    }).await.map_err(|_| "ego_write")?
}

/// Add or remove the "use ego lite by default" block in the CLI's global
/// instruction file. The rest of the file is never touched.
#[tauri::command]
pub async fn set_ego_instruction(tool: String, enabled: bool) -> Result<EgoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home_dir()?;
        let path = instruction_file(&tool, &home).ok_or("ego_unsupported")?;
        let original = fs::read_to_string(&path).ok();
        let content = compose_instruction(original.as_deref(), enabled);
        if original.as_deref() != Some(content.as_str()) {
            crate::tool_control::save(&path, original.as_deref(), &content, &crate::tool_control::root()?)?;
        }
        status()
    }).await.map_err(|_| "ego_write")?
}

/// Allow the `ego-browser` command for one CLI without a per-call approval.
/// Only the ego-browser prefix is ever allowed.
#[tauri::command]
pub async fn set_ego_permission(tool: String, enabled: bool) -> Result<EgoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if permission_state(&tool) == "unsupported" { return Err("ego_unsupported".into()); }
        let mut config = read_config()?;
        config.allow_command.retain(|entry| entry != &tool);
        if enabled { config.allow_command.push(tool); }
        write_config(&config)?;
        status()
    }).await.map_err(|_| "ego_write")?
}

/// Retire the removed agent-browser MCP entries from every CLI configuration.
#[tauri::command]
pub async fn cleanup_legacy_browser() -> Result<EgoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut failed = false;
        for tool in crate::tools::TOOLS {
            if crate::tool_control::remove_mcp_entry(tool.id, "coffee-browser-use").is_err() { failed = true; }
        }
        if failed { return Err("ego_conflict".into()); }
        status()
    }).await.map_err(|_| "ego_write")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_candidates_cover_the_registered_install_locations() {
        let home = Path::new("C:/home/tester");
        let local = PathBuf::from("C:/Users/tester/AppData/Local");
        let candidates = executable_candidates(home, &|key| match key {
            "LOCALAPPDATA" => Some(local.clone()),
            _ => None,
        });
        assert!(candidates.iter().any(|path| path.ends_with("active_version_dir/ego-browser.exe") || path.to_string_lossy().contains("active_version_dir")));
        assert!(candidates.iter().any(|path| path.to_string_lossy().contains("Citro Labs")));
    }

    #[test]
    fn the_instruction_block_is_appended_once_and_removed_again() {
        let original = "# My rules\n\nKeep this line.\n";
        let added = compose_instruction(Some(original), true);
        assert!(added.contains("Keep this line."));
        assert!(added.contains(INSTRUCTION_START) && added.contains(INSTRUCTION_END));
        assert_eq!(compose_instruction(Some(&added), true), added, "a second run must not duplicate the block");
        let removed = compose_instruction(Some(&added), false);
        assert!(!removed.contains(INSTRUCTION_START));
        assert!(removed.contains("Keep this line."));
    }

    #[test]
    fn an_empty_instruction_file_still_receives_the_block() {
        let added = compose_instruction(Some(""), true);
        assert!(added.starts_with(INSTRUCTION_START));
        let removed = compose_instruction(Some(&added), false);
        assert!(removed.trim().is_empty());
    }

    #[test]
    fn skill_state_detects_a_missing_copy() {
        // A CLI without a skills root cannot receive the Skill at all.
        assert_eq!(skill_state("aider", None), SKILL_UNSUPPORTED);
        // A CLI with a skills root reports its copy, never "unsupported".
        assert_ne!(skill_state("grok", None), SKILL_UNSUPPORTED);
    }
}
