//! Voice model settings. Stored separately from the text chat model so the two
//! can point at different services, model IDs and API keys.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

/// Same credential service as the text model, with a distinct account name.
const KEY_SERVICE: &str = "coffee-cli-agent";
const KEY_ACCOUNT: &str = "voice-model-api-key";
const FILE_NAME: &str = "voice-model.json";

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceModelConfig {
    provider: crate::agent::Provider,
    base_url: String,
    model: String,
    /// Never serialised: the key lives in the credential store, not the settings file.
    #[serde(skip)]
    api_key: String,
}

impl Default for VoiceModelConfig {
    fn default() -> Self {
        Self {
            provider: crate::agent::Provider::Openai,
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
            api_key: String::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelView {
    provider: crate::agent::Provider,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVoiceModel {
    provider: crate::agent::Provider,
    base_url: String,
    model: String,
    /// Omission preserves the saved key; empty clears it.
    api_key: Option<String>,
}

impl SaveVoiceModel {
    fn apply(&self, previous: &VoiceModelConfig) -> VoiceModelConfig {
        let base_url = self.base_url.trim().trim_end_matches('/');
        VoiceModelConfig {
            provider: self.provider,
            base_url: base_url.into(),
            model: self.model.trim().into(),
            api_key: match &self.api_key {
                Some(key) => key.trim().into(),
                // A key is never carried over to a different service.
                None if self.provider == previous.provider && base_url == previous.base_url => {
                    previous.api_key.clone()
                }
                None => String::new(),
            },
        }
    }
}

fn voice_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::agent::data_dir(app)?.join(FILE_NAME))
}

fn read_file(path: &Path) -> Result<VoiceModelConfig, String> {
    if !path.exists() {
        return Ok(VoiceModelConfig::default());
    }
    let raw = fs::read_to_string(path).map_err(|_| "Could not read voice model settings")?;
    serde_json::from_str(&raw).map_err(|_| "Voice model settings are invalid".into())
}

fn read(app: &AppHandle) -> Result<VoiceModelConfig, String> {
    let mut config = read_file(&voice_path(app)?)?;
    config.api_key = crate::credentials::load_secret(KEY_SERVICE, KEY_ACCOUNT)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    Ok(config)
}

fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid voice model storage path")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create voice model data directory")?;
    let temp = path.with_extension("json.tmp");
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "Could not serialize voice model data")?;
    fs::write(&temp, bytes).map_err(|_| "Could not write voice model data")?;
    crate::agent::replace_file(&temp, path)
}

/// Mirrors the text model's URL rules: HTTPS, or plain HTTP for localhost only.
fn validate_base_url(base_url: &str) -> Result<(), String> {
    if base_url.len() > 2000 {
        return Err("Voice model service URL is too long".into());
    }
    let url = reqwest::Url::parse(base_url).map_err(|_| "Enter a valid voice model service URL")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Voice model URL must use HTTPS (HTTP is allowed for localhost) and contain no credentials or query".into());
    }
    Ok(())
}

fn validate(config: &VoiceModelConfig) -> Result<(), String> {
    if !config.base_url.is_empty() {
        validate_base_url(&config.base_url)?;
    }
    if config.model.len() > 200 {
        return Err("Voice model ID must be at most 200 characters".into());
    }
    Ok(())
}

#[tauri::command]
pub fn agent_get_voice_model(app: AppHandle) -> Result<VoiceModelView, String> {
    let _lock = STORAGE_LOCK
        .lock()
        .map_err(|_| "Voice model storage is unavailable")?;
    let config = read(&app)?;
    Ok(VoiceModelView {
        provider: config.provider,
        base_url: config.base_url,
        model: config.model,
        api_key: config.api_key,
    })
}

#[tauri::command]
pub fn agent_save_voice_model(app: AppHandle, config: SaveVoiceModel) -> Result<(), String> {
    let _lock = STORAGE_LOCK
        .lock()
        .map_err(|_| "Voice model storage is unavailable")?;
    let path = voice_path(&app)?;
    let next = config.apply(&read(&app)?);
    validate(&next)?;
    crate::credentials::save_secret(KEY_SERVICE, KEY_ACCOUNT, &next.api_key)
        .map_err(|error| error.to_string())?;
    save_json(&path, &next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn voice_api_key_is_never_written_to_the_settings_file() {
        let directory = std::env::temp_dir()
            .join(format!("coffee-voice-model-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join(FILE_NAME);
        let save = |value: Value| serde_json::from_value::<SaveVoiceModel>(value).unwrap();
        let config = save(json!({"provider":"openai","baseUrl":"http://localhost:11434/v1/","model":"whisper-1","apiKey":"  sk-voice \n"}))
            .apply(&read_file(&path).unwrap());
        assert_eq!(config.api_key, "sk-voice");
        assert_eq!(config.base_url, "http://localhost:11434/v1");
        save_json(&path, &config).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let stored: Value = serde_json::from_str(&raw).unwrap();
        assert!(stored.get("apiKey").is_none());
        assert!(!raw.contains("sk-voice"));
        assert!(!path.with_extension("json.tmp").exists());

        // The key comes from the credential store, never from the settings file.
        let reloaded = read_file(&path).unwrap();
        assert_eq!(reloaded.api_key, "");
        assert_eq!(reloaded.model, "whisper-1");
        let previous = VoiceModelConfig {
            api_key: "sk-voice".into(),
            ..reloaded.clone()
        };
        let same = save(json!({"provider":"openai","baseUrl":"http://localhost:11434/v1","model":"whisper-1"}))
            .apply(&previous);
        assert_eq!(same.api_key, "sk-voice");
        let moved = save(json!({"provider":"openai","baseUrl":"https://example.com/v1","model":"whisper-1"}))
            .apply(&previous);
        assert_eq!(moved.api_key, "");
        let cleared = save(json!({"provider":"openai","baseUrl":"http://localhost:11434/v1","model":"whisper-1","apiKey":""}))
            .apply(&previous);
        assert_eq!(cleared.api_key, "");
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn voice_service_url_is_validated() {
        assert!(validate(&VoiceModelConfig {
            base_url: "https://api.openai.com/v1".into(),
            ..VoiceModelConfig::default()
        })
        .is_ok());
        assert!(validate(&VoiceModelConfig {
            base_url: "http://example.com/v1".into(),
            ..VoiceModelConfig::default()
        })
        .is_err());
        assert!(validate(&VoiceModelConfig {
            model: "x".repeat(201),
            ..VoiceModelConfig::default()
        })
        .is_err());
    }
}
