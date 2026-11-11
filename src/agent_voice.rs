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

/// Connectivity probe for the voice model form. Unisound has no key-check
/// endpoint, so reaching the service root proves connectivity; OpenAI-compatible
/// transcription services answer GET /models, which also verifies the API key.
#[tauri::command]
pub async fn agent_test_voice_model(config: SaveVoiceModel) -> Result<(), String> {
    let base_url = config.base_url.trim().trim_end_matches('/').to_owned();
    if base_url.is_empty() {
        return Err("请先在 Agent 配置中填写服务地址".into());
    }
    validate_base_url(&base_url)?;
    let key = config.api_key.unwrap_or_default().trim().to_owned();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create voice model client")?;
    if is_u2_asr_host(&base_url) {
        let root = u2_service_root(&base_url).ok_or("Invalid u2-asr service URL")?;
        client
            .get(root)
            .send()
            .await
            .map_err(|_| "Could not reach the voice model service")?;
        // Any HTTP answer (even 404) proves the service is reachable.
        return Ok(());
    }
    let request = if key.is_empty() {
        client.get(format!("{base_url}/models"))
    } else {
        client.get(format!("{base_url}/models")).bearer_auth(&key)
    };
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the voice model service")?;
    let status = response.status();
    if matches!(status, reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
        return Err(format!("Voice model service returned HTTP {}", status.as_u16()));
    }
    Ok(())
}

/// Unisound MaaS: an asynchronous, task-based ASR service (model `u2-asr`)
/// that is not OpenAI compatible. Uploading and task creation live under
/// different paths, so the service URL alone is the base:
/// `/v1/files/upload`, `/v1/audio/asr/tasks` and `/v1/audio/asr/tasks/{id}`.
const U2_ASR_HOST: &str = "unisound.com";

fn is_u2_asr_host(base_url: &str) -> bool {
    reqwest::Url::parse(base_url.trim_end_matches('/'))
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == U2_ASR_HOST || host.ends_with(&format!(".{U2_ASR_HOST}")))
}

/// Unisound's upload path sits on the service root, not under a version
/// prefix. Users naturally paste the documented base
/// `https://maas-api.unisound.com/v1`; been appended as-is it becomes
/// `/v1/v1/files/upload`, which the service answers with a 404. Strip a
/// trailing `/v1` once so both forms reach the same endpoints.
fn u2_service_root(base_url: &str) -> Option<&str> {
    let base = base_url.trim().trim_end_matches('/');
    Some(base.strip_suffix("/v1").unwrap_or(base))
}

/// Speech MIME type whose content unisound's `format` field accepts. The
/// recording is already 16 kHz mono WAV, so only the suffix is needed.
fn u2_audio_format(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim() {
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/mp3" | "audio/mpeg" => Some("mp3"),
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => Some("m4a"),
        "audio/ogg" => Some("ogg"),
        "audio/amr" => Some("amr"),
        "audio/opus" => Some("opus"),
        _ => None,
    }
}

// 16 kHz, mono, 16-bit PCM: 32 000 bytes per second of audio, plus a 44-byte
// header. Anything bigger would never finish inside the polling budget.
const U2_MAX_WAV_BYTES: usize = 32_000 * 180;

/// Unisound answers 200 even for failures; `base_resp.status_code` 0 means
/// success. Any other code is reported with the raw body.
fn u2_check(value: &serde_json::Value, step: &str) -> Result<(), String> {
    let status = value
        .get("base_resp")
        .and_then(|resp| resp.get("status_code"))
        .and_then(|code| code.as_i64());
    if status == Some(0) {
        return Ok(());
    }
    let message = value
        .get("base_resp")
        .and_then(|resp| resp.get("status_msg"))
        .and_then(|msg| msg.as_str())
        .unwrap_or("unknown error");
    Err(format!("u2-asr {step} failed ({status:?}): {message}"))
}

async fn u2_json(response: reqwest::Response, step: &str) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("u2-asr {step} returned HTTP {}", status.as_u16()));
    }
    let raw = response
        .bytes()
        .await
        .map_err(|_| format!("Could not read the u2-asr {step} response"))?;
    serde_json::from_slice(&raw).map_err(|_| {
        format!(
            "u2-asr {step} returned invalid JSON: {}",
            String::from_utf8_lossy(&raw[..raw.len().min(200)])
        )
    })
}

/// The task `status` read-out is not monotonic: the service is served by
/// several back ends, so a poll can regress from `Success` to `Waiting`.
/// Only terminal states count; every other state (Waiting, Processing, …)
/// means keep polling.
fn u2_task_state(task: &serde_json::Value) -> Result<(bool, bool), String> {
    let status = task
        .get("status")
        .and_then(|status| status.as_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match status.as_str() {
        "success" | "succeeded" | "completed" | "done" | "finished" => Ok((true, false)),
        "failed" | "error" | "cancelled" | "canceled" => Ok((true, true)),
        _ => Ok((false, false)),
    }
}

fn u2_transcript(task: &serde_json::Value) -> String {
    task.get("results")
        .and_then(|results| results.as_array())
        .map(|results| {
            results
                .iter()
                .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// Run the unisound asynchronous workflow: upload → create task → poll.
/// Every step is bounded by the per-request `timeout`.
async fn u2_transcribe(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: String,
    bytes: Vec<u8>,
    mime: String,
    audio_format: &'static str,
) -> Result<String, String> {
    let base = u2_service_root(base_url).ok_or("Invalid u2-asr service URL")?;
    let authorize = |request: reqwest::RequestBuilder| {
        if key.is_empty() {
            request
        } else {
            request.bearer_auth(key)
        }
    };

    let form = reqwest::multipart::Form::new()
        .text("purpose", "a2t_async_input")
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("recording.{audio_format}"))
                .mime_str(&mime)
                .map_err(|_| "Unsupported audio MIME type")?,
        );
    let upload = authorize(client.post(format!("{base}/v1/files/upload")).multipart(form))
        .send()
        .await
        .map_err(|_| "Could not reach the voice model service")?;
    let upload = u2_json(upload, "upload").await?;
    u2_check(&upload, "upload")?;
    let file_id = upload
        .get("file")
        .and_then(|file| file.get("file_id"))
        .and_then(|id| id.as_i64())
        .ok_or("u2-asr upload response has no file_id")?;

    let task_url = format!("{base}/v1/audio/asr/tasks");
    let create = authorize(
        client
            .post(&task_url)
            .json(&serde_json::json!({
                "file_id": file_id,
                "model": model,
                "format": audio_format,
                "sample_rate": 16000,
                "enable_itn": true,
                "channel": 1,
                "enable_speaker": false,
                "word_info": false,
            })),
    )
    .send()
    .await
    .map_err(|_| "Could not reach the voice model service")?;
    let create = u2_json(create, "task creation").await?;
    u2_check(&create, "task creation")?;
    let task_id = create
        .get("task_id")
        .and_then(|id| id.as_str())
        .filter(|id| !id.is_empty())
        .ok_or("u2-asr task creation response has no task_id")?
        .to_owned();

    let poll_url = format!("{task_url}/{task_id}");
    let deadline = tokio::time::Instant::now() + U2_POLL_BUDGET;
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    let last = loop {
        interval.tick().await;
        let response = authorize(client.get(&poll_url))
            .send()
            .await
            .map_err(|_| "Could not reach the voice model service")?;
        let task = u2_json(response, "task status").await?;
        u2_check(&task, "task status")?;
        let (terminal, failed) = u2_task_state(&task)?;
        if failed {
            return Err(format!(
                "u2-asr transcription failed: {}",
                &task.to_string().chars().take(200).collect::<String>()
            ));
        }
        if terminal {
            break task;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("u2-asr transcription timed out".into());
        }
    };
    let text = u2_transcript(&last);
    if text.is_empty() {
        return Err("u2-asr returned an empty transcription".into());
    }
    Ok(text)
}

/// Stop looking for the finished task after this long. The 5-hour API limit
/// keeps real jobs well inside it.
const U2_POLL_BUDGET: Duration = Duration::from_secs(180);

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

    if is_u2_asr_host(&config.base_url) {
        // Unisound: asynchronous tasks under fixed paths; no multipart
        // transcription endpoint exists there, hence the dedicated branch.
        let audio_format = u2_audio_format(&mime)
            .ok_or_else(|| format!("u2-asr does not accept {mime} audio"))?;
        if bytes.len() > U2_MAX_WAV_BYTES {
            return Err("Audio recording is too long for u2-asr".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not create transcription client")?;
        let model = if config.model.is_empty() { "u2-asr".into() } else { config.model.clone() };
        return u2_transcribe(&client, &config.base_url, &key, model, bytes, mime, audio_format).await;
    }

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
    fn unisound_urls_use_the_async_asr_workflow_instead() {
        // The service the user reported: OpenAI-style transcription 404s here.
        for url in [
            "https://maas-api.unisound.com",
            "https://maas-api.unisound.com/v1",
            "https://maas-api.unisound.com/v1/",
            "https://MAAS-API.Unisound.com/v1",
            "https://unisound.com",
        ] {
            assert!(is_u2_asr_host(url), "{url}");
        }
        for url in [
            "https://api.openai.com/v1",
            "https://notunisound.com/v1",
            "https://unisound.com.example.com/v1",
            "http://localhost:11434/v1",
        ] {
            assert!(!is_u2_asr_host(url), "{url}");
        }
        // Every unisound URL above is routed away from transcribe_endpoint, so
        // the OpenAI multipart path (100301 "path error" there) is never hit.
    }

    #[test]
    fn unisound_service_root_drops_a_single_v1_prefix() {
        // Regression: the documented base /v1 used to yield /v1/v1/files/upload (404).
        assert_eq!(u2_service_root("https://maas-api.unisound.com/v1"), Some("https://maas-api.unisound.com"));
        assert_eq!(u2_service_root("https://maas-api.unisound.com/v1/"), Some("https://maas-api.unisound.com"));
        assert_eq!(u2_service_root("https://maas-api.unisound.com"), Some("https://maas-api.unisound.com"));
        assert_eq!(u2_service_root("https://maas-api.unisound.com/"), Some("https://maas-api.unisound.com"));
        assert_eq!(
            format!("{}/v1/audio/asr/tasks", u2_service_root("https://maas-api.unisound.com/v1").unwrap()),
            "https://maas-api.unisound.com/v1/audio/asr/tasks"
        );
    }

    #[test]
    fn unisound_accepts_only_its_declared_audio_formats() {
        assert_eq!(u2_audio_format("audio/wav"), Some("wav"));
        assert_eq!(u2_audio_format("audio/wav;codecs=1"), Some("wav"));
        assert_eq!(u2_audio_format("audio/mpeg"), Some("mp3"));
        assert_eq!(u2_audio_format("audio/m4a"), Some("m4a"));
        assert_eq!(u2_audio_format("audio/ogg"), Some("ogg"));
        assert_eq!(u2_audio_format("audio/amr"), Some("amr"));
        assert_eq!(u2_audio_format("audio/opus"), Some("opus"));
        // WebM is the recorder's native container and unisound rejects it.
        assert_eq!(u2_audio_format("audio/webm"), None);
        assert_eq!(u2_audio_format("audio/flac"), None);
    }

    #[test]
    fn unisound_task_state_is_not_monotonic() {
        let state = |value: Value| u2_task_state(&json!({ "status": value }));
        // A poll that went back to Waiting after Success must keep polling.
        assert_eq!(state(json!("Waiting")), Ok((false, false)));
        assert_eq!(state(json!("Processing")), Ok((false, false)));
        assert_eq!(state(json!("Success")), Ok((true, false)));
        assert_eq!(state(json!("Succeeded")), Ok((true, false)));
        assert_eq!(state(json!("Failed")), Ok((true, true)));
        assert_eq!(state(json!("CANCELLED")), Ok((true, true)));
        assert_eq!(state(Value::Null), Ok((false, false)));
    }

    #[test]
    fn unisound_status_codes_are_checked() {
        assert!(u2_check(&json!({"base_resp": {"status_code": 0}}), "upload").is_ok());
        let error = u2_check(
            &json!({"base_resp": {"status_code": 100101, "status_msg": "auth error"}}),
            "upload",
        )
        .unwrap_err();
        assert!(error.contains("100101") && error.contains("auth error"), "{error}");
        assert!(u2_check(&json!({}), "upload").is_err());
    }

    #[test]
    fn unisound_segments_are_joined_in_order() {
        let task = json!({"results": [
            {"text": "你好，"},
            {"text": "  "},
            {"text": "这是一段语音识别测试 hello world."}
        ]});
        assert_eq!(u2_transcript(&task), "你好， 这是一段语音识别测试 hello world.");
        assert_eq!(u2_transcript(&json!({"results": []})), "");
        assert_eq!(u2_transcript(&json!({})), "");
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
