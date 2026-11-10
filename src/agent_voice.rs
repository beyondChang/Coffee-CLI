//! Voice model settings. Stored separately from the text chat model so the two
//! can point at different services, model IDs and API keys.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
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

/// Endpoint for audio transcription. Mirrors the text model's URL rules.
fn transcribe_endpoint(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/audio/transcriptions") {
        base.into()
    } else {
        format!("{base}/audio/transcriptions")
    }
}

/// Map a recorded audio MIME type to a file suffix acceptable in a
/// multipart transcription upload. Unknown types (e.g. WebM, the default
/// MediaRecorder output on browsers) fall back to webm.
fn file_extension(mime: &str) -> &'static str {
    match mime {
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp3" | "audio/mpeg" => "mp3",
        "audio/aac" | "audio/mp4" | "audio/m4a" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => "webm",
    }
}

/// Transcribe recorded audio to text using the configured voice model.
/// The audio arrives as a base64-encoded blob (the frontend captures it via
/// MediaRecorder — typically WebM, sometimes WAV), so no copy on the disk is
/// needed; only the chosen MIME type hints the file suffix for the request.
#[tauri::command]
pub async fn agent_transcribe(
    app: AppHandle,
    audio_base64: String,
    mime_type: Option<String>,
) -> Result<String, String> {
    let (config, key) = tokio::task::spawn_blocking(move || {
        let _lock = STORAGE_LOCK
            .lock()
            .map_err(|_| "Voice model storage is unavailable")?;
        let config = read(&app)?;
        validate(&config)?;
        let key = crate::credentials::load_secret(KEY_SERVICE, KEY_ACCOUNT)
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        Ok::<_, String>((config, key))
    })
    .await
    .map_err(|_| "Could not load voice model configuration")??;

    if config.base_url.is_empty() {
        return Err("No voice model service is configured".into());
    }

    // Limit the payload so a multiply-selected or overlong recording can't
    // exhaust memory. 25 MB of base64 is plenty for a voice note.
    use base64::{engine::general_purpose::STANDARD, Engine};
    const MAX_BASE64_BYTES: usize = 35 * 1024 * 1024;
    if audio_base64.len() > MAX_BASE64_BYTES {
        return Err("Audio recording is too large".into());
    }
    let bytes = STANDARD
        .decode(audio_base64)
        .map_err(|_| "Audio recording is not valid base64")?;
    if bytes.is_empty() {
        return Err("No audio was recorded".into());
    }

    // Derive a plausible file name from the MIME type. Whisper-compatible
    // endpoints branch on the extension in multipart form data.
    let mime = mime_type.unwrap_or_else(|| "audio/webm".into());
    let file_name = format!("recording.{}", file_extension(&mime));

    let url = transcribe_endpoint(&config.base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create transcription client")?;

    let body = reqwest::multipart::Form::new()
        .text("model", config.model.clone())
        .text("response_format", "json")
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name)
                .mime_str(&mime)
                .map_err(|_| "Unsupported audio MIME type")?,
        );

    let request = client.post(url);
    let request = if key.is_empty() {
        request
    } else {
        request.bearer_auth(key)
    };

    let response = request
        .multipart(body)
        .send()
        .await
        .map_err(|_| "Could not reach the voice model service")?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Voice model service returned HTTP {}",
            status.as_u16()
        ));
    }
    let raw = response
        .text()
        .await
        .map_err(|_| "Could not read the voice model response")?;
    log::warn!("[CoffeeVoice] transcription raw response: {}", &raw.chars().take(500).collect::<String>());
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        format!("Voice model returned invalid JSON: {}", &raw.chars().take(200).collect::<String>())
    })?;
    let text = value
        .get("text")
        .and_then(|text| text.as_str())
        .ok_or_else(|| {
            format!("Voice model response has no text field: {}", &raw.chars().take(200).collect::<String>())
        })?;
    let cleaned = strip_segment_prefixes(text);
    if cleaned.is_empty() {
        return Err(format!(
            "Voice model returned empty transcription (raw: {})",
            &raw.chars().take(200).collect::<String>()
        ));
    }
    Ok(cleaned)
}

/// Some transcription backends emit per-segment numbering (SRT/VTT-ish) like
/// `1: 喂，你好` or `2. hello there` before each line. That's output noise the
/// user doesn't want pasted into their prompt, so strip a leading
/// `digits + [：:.、]` from each non-empty line. Content that genuinely starts
/// with a number (e.g. "3 apples") is preserved because it needs a separator
/// after the number; only `1:` / `1.` / `1、` style numbering is removed.
fn strip_segment_prefixes(text: &str) -> String {
    let mut out = Vec::with_capacity(text.lines().count());
    let prefix = regex::Regex::new(r"^\s*\d+[：:.、]\s*").expect("segment prefix regex compiles");
    for line in text.lines() {
        if line.trim().is_empty() {
            out.push(line.to_owned());
            continue;
        }
        // The separator must be ASCII colon/dot (which str::lines won't drop),
        // so the regex strips it. A plain number with no separator or a number
        // followed by text (e.g. "3 apples") is left untouched.
        if prefix.is_match(line) {
            out.push(prefix.replace(line, "").trim().to_owned());
        } else {
            out.push(line.to_owned());
        }
    }
    out.join("\n")
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

    #[test]
    fn transcription_endpoint_appends_the_audio_path() {
        assert_eq!(
            transcribe_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        // A trailing slash is trimmed for the match+format.
        assert_eq!(
            transcribe_endpoint("https://api.openai.com/v1/audio/transcriptions/"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(
            transcribe_endpoint("http://localhost:11434/v1/audio/transcriptions"),
            "http://localhost:11434/v1/audio/transcriptions"
        );
    }

    #[test]
    fn recorded_audio_mime_maps_to_a_whisper_friendly_suffix() {
        // WebM is the default MediaRecorder container in browsers.
        assert_eq!(file_extension("audio/webm"), "webm");
        assert_eq!(file_extension("audio/webm;codecs=opus"), "webm");
        assert_eq!(file_extension("audio/wav"), "wav");
        assert_eq!(file_extension("audio/mpeg"), "mp3");
        assert_eq!(file_extension("audio/m4a"), "m4a");
        assert_eq!(file_extension("audio/ogg"), "ogg");
        assert_eq!(file_extension(""), "webm");
    }

    #[test]
    fn segment_number_prefixes_are_stripped_from_transcripts() {
        // The user's reported case: three sentences each prefixed with "1:".
        assert_eq!(
            strip_segment_prefixes("1: 喂，你好听得到吗？\n1: 你是什么大？\n1: 你是什么大模型？"),
            "喂，你好听得到吗？\n你是什么大？\n你是什么大模型？"
        );
        // ASCII variants too.
        assert_eq!(strip_segment_prefixes("1. hello there\n2. world"), "hello there\nworld");
        assert_eq!(strip_segment_prefixes("1、 你好"), "你好");
        assert_eq!(strip_segment_prefixes("12: 按数字编号"), "按数字编号");
        // Content that genuinely starts with a number must survive.
        assert_eq!(strip_segment_prefixes("3 apples and 2 pears"), "3 apples and 2 pears");
        assert_eq!(strip_segment_prefixes("2026 is coming"), "2026 is coming");
        // A stripped line is trimmed; empty lines are preserved.
        assert_eq!(strip_segment_prefixes("  1:  hi  "), "hi");
        assert_eq!(strip_segment_prefixes("line one\n\n 2: line two\n"), "line one\n\nline two");
        // No prefix -> unchanged.
        assert_eq!(strip_segment_prefixes("just text"), "just text");
    }
}
