// [voice input disabled] //! Voice model settings. Stored separately from the text chat model so the two
// [voice input disabled] //! can point at different services, model IDs and API keys.
// [voice input disabled]
// [voice input disabled] use serde::{Deserialize, Serialize};
// [voice input disabled] use std::fs;
// [voice input disabled] use std::path::{Path, PathBuf};
// [voice input disabled] use std::sync::Mutex;
// [voice input disabled] use std::time::Duration;
// [voice input disabled] use tauri::AppHandle;
// [voice input disabled]
// [voice input disabled] /// Same credential service as the text model, with a distinct account name.
// [voice input disabled] const KEY_SERVICE: &str = "coffee-cli-agent";
// [voice input disabled] const KEY_ACCOUNT: &str = "voice-model-api-key";
// [voice input disabled] const FILE_NAME: &str = "voice-model.json";
// [voice input disabled]
// [voice input disabled] static STORAGE_LOCK: Mutex<()> = Mutex::new(());
// [voice input disabled]
// [voice input disabled] #[derive(Clone, Deserialize, Serialize)]
// [voice input disabled] #[serde(rename_all = "camelCase")]
// [voice input disabled] struct VoiceModelConfig {
// [voice input disabled]     provider: crate::agent::Provider,
// [voice input disabled]     base_url: String,
// [voice input disabled]     model: String,
// [voice input disabled]     /// Never serialised: the key lives in the credential store, not the settings file.
// [voice input disabled]     #[serde(skip)]
// [voice input disabled]     api_key: String,
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] impl Default for VoiceModelConfig {
// [voice input disabled]     fn default() -> Self {
// [voice input disabled]         Self {
// [voice input disabled]             provider: crate::agent::Provider::Openai,
// [voice input disabled]             base_url: "https://api.openai.com/v1".into(),
// [voice input disabled]             model: String::new(),
// [voice input disabled]             api_key: String::new(),
// [voice input disabled]         }
// [voice input disabled]     }
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] #[derive(Serialize)]
// [voice input disabled] #[serde(rename_all = "camelCase")]
// [voice input disabled] pub struct VoiceModelView {
// [voice input disabled]     provider: crate::agent::Provider,
// [voice input disabled]     base_url: String,
// [voice input disabled]     model: String,
// [voice input disabled]     api_key: String,
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] #[derive(Deserialize)]
// [voice input disabled] #[serde(rename_all = "camelCase")]
// [voice input disabled] pub struct SaveVoiceModel {
// [voice input disabled]     provider: crate::agent::Provider,
// [voice input disabled]     base_url: String,
// [voice input disabled]     model: String,
// [voice input disabled]     /// Omission preserves the saved key; empty clears it.
// [voice input disabled]     api_key: Option<String>,
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] impl SaveVoiceModel {
// [voice input disabled]     fn apply(&self, previous: &VoiceModelConfig) -> VoiceModelConfig {
// [voice input disabled]         let base_url = self.base_url.trim().trim_end_matches('/');
// [voice input disabled]         VoiceModelConfig {
// [voice input disabled]             provider: self.provider,
// [voice input disabled]             base_url: base_url.into(),
// [voice input disabled]             model: self.model.trim().into(),
// [voice input disabled]             api_key: match &self.api_key {
// [voice input disabled]                 Some(key) => key.trim().into(),
// [voice input disabled]                 // A key is never carried over to a different service.
// [voice input disabled]                 None if self.provider == previous.provider && base_url == previous.base_url => {
// [voice input disabled]                     previous.api_key.clone()
// [voice input disabled]                 }
// [voice input disabled]                 None => String::new(),
// [voice input disabled]             },
// [voice input disabled]         }
// [voice input disabled]     }
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] fn voice_path(app: &AppHandle) -> Result<PathBuf, String> {
// [voice input disabled]     Ok(crate::agent::data_dir(app)?.join(FILE_NAME))
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] fn read_file(path: &Path) -> Result<VoiceModelConfig, String> {
// [voice input disabled]     if !path.exists() {
// [voice input disabled]         return Ok(VoiceModelConfig::default());
// [voice input disabled]     }
// [voice input disabled]     let raw = fs::read_to_string(path).map_err(|_| "Could not read voice model settings")?;
// [voice input disabled]     serde_json::from_str(&raw).map_err(|_| "Voice model settings are invalid".into())
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] fn read(app: &AppHandle) -> Result<VoiceModelConfig, String> {
// [voice input disabled]     let mut config = read_file(&voice_path(app)?)?;
// [voice input disabled]     config.api_key = crate::credentials::load_secret(KEY_SERVICE, KEY_ACCOUNT)
// [voice input disabled]         .map_err(|error| error.to_string())?
// [voice input disabled]         .unwrap_or_default();
// [voice input disabled]     Ok(config)
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
// [voice input disabled]     let parent = path.parent().ok_or("Invalid voice model storage path")?;
// [voice input disabled]     fs::create_dir_all(parent).map_err(|_| "Could not create voice model data directory")?;
// [voice input disabled]     let temp = path.with_extension("json.tmp");
// [voice input disabled]     let bytes =
// [voice input disabled]         serde_json::to_vec_pretty(value).map_err(|_| "Could not serialize voice model data")?;
// [voice input disabled]     fs::write(&temp, bytes).map_err(|_| "Could not write voice model data")?;
// [voice input disabled]     crate::agent::replace_file(&temp, path)
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Mirrors the text model's URL rules: HTTPS, or plain HTTP for localhost only.
// [voice input disabled] fn validate_base_url(base_url: &str) -> Result<(), String> {
// [voice input disabled]     if base_url.len() > 2000 {
// [voice input disabled]         return Err("Voice model service URL is too long".into());
// [voice input disabled]     }
// [voice input disabled]     let url = reqwest::Url::parse(base_url).map_err(|_| "Enter a valid voice model service URL")?;
// [voice input disabled]     let local = matches!(
// [voice input disabled]         url.host_str(),
// [voice input disabled]         Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
// [voice input disabled]     );
// [voice input disabled]     if (url.scheme() != "https" && !(url.scheme() == "http" && local))
// [voice input disabled]         || url.host_str().is_none()
// [voice input disabled]         || !url.username().is_empty()
// [voice input disabled]         || url.password().is_some()
// [voice input disabled]         || url.query().is_some()
// [voice input disabled]         || url.fragment().is_some()
// [voice input disabled]     {
// [voice input disabled]         return Err("Voice model URL must use HTTPS (HTTP is allowed for localhost) and contain no credentials or query".into());
// [voice input disabled]     }
// [voice input disabled]     Ok(())
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] fn validate(config: &VoiceModelConfig) -> Result<(), String> {
// [voice input disabled]     if !config.base_url.is_empty() {
// [voice input disabled]         validate_base_url(&config.base_url)?;
// [voice input disabled]     }
// [voice input disabled]     if config.model.len() > 200 {
// [voice input disabled]         return Err("Voice model ID must be at most 200 characters".into());
// [voice input disabled]     }
// [voice input disabled]     Ok(())
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] #[tauri::command]
// [voice input disabled] pub fn agent_get_voice_model(app: AppHandle) -> Result<VoiceModelView, String> {
// [voice input disabled]     let _lock = STORAGE_LOCK
// [voice input disabled]         .lock()
// [voice input disabled]         .map_err(|_| "Voice model storage is unavailable")?;
// [voice input disabled]     let config = read(&app)?;
// [voice input disabled]     Ok(VoiceModelView {
// [voice input disabled]         provider: config.provider,
// [voice input disabled]         base_url: config.base_url,
// [voice input disabled]         model: config.model,
// [voice input disabled]         api_key: config.api_key,
// [voice input disabled]     })
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] #[tauri::command]
// [voice input disabled] pub fn agent_save_voice_model(app: AppHandle, config: SaveVoiceModel) -> Result<(), String> {
// [voice input disabled]     let _lock = STORAGE_LOCK
// [voice input disabled]         .lock()
// [voice input disabled]         .map_err(|_| "Voice model storage is unavailable")?;
// [voice input disabled]     let path = voice_path(&app)?;
// [voice input disabled]     let next = config.apply(&read(&app)?);
// [voice input disabled]     validate(&next)?;
// [voice input disabled]     crate::credentials::save_secret(KEY_SERVICE, KEY_ACCOUNT, &next.api_key)
// [voice input disabled]         .map_err(|error| error.to_string())?;
// [voice input disabled]     save_json(&path, &next)
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Connectivity probe for the voice model form. Unisound has no key-check
// [voice input disabled] /// endpoint, so reaching the service root proves connectivity; OpenAI-compatible
// [voice input disabled] /// transcription services answer GET /models, which also verifies the API key.
// [voice input disabled] #[tauri::command]
// [voice input disabled] pub async fn agent_test_voice_model(config: SaveVoiceModel) -> Result<(), String> {
// [voice input disabled]     let base_url = config.base_url.trim().trim_end_matches('/').to_owned();
// [voice input disabled]     if base_url.is_empty() {
// [voice input disabled]         return Err("请先在 Agent 配置中填写服务地址".into());
// [voice input disabled]     }
// [voice input disabled]     validate_base_url(&base_url)?;
// [voice input disabled]     let key = config.api_key.unwrap_or_default().trim().to_owned();
// [voice input disabled]     let client = reqwest::Client::builder().timeout(Duration::from_secs(30))
// [voice input disabled]         .redirect(reqwest::redirect::Policy::none())
// [voice input disabled]         .build()
// [voice input disabled]         .map_err(|_| "Could not create voice model client")?;
// [voice input disabled]     if is_u2_asr_host(&base_url) {
// [voice input disabled]         let root = u2_service_root(&base_url).ok_or("Invalid u2-asr service URL")?;
// [voice input disabled]         client
// [voice input disabled]             .get(root)
// [voice input disabled]             .send()
// [voice input disabled]             .await
// [voice input disabled]             .map_err(|_| "Could not reach the voice model service")?;
// [voice input disabled]         // Any HTTP answer (even 404) proves the service is reachable.
// [voice input disabled]         return Ok(());
// [voice input disabled]     }
// [voice input disabled]     let request = if key.is_empty() {
// [voice input disabled]         client.get(format!("{base_url}/models"))
// [voice input disabled]     } else {
// [voice input disabled]         client.get(format!("{base_url}/models")).bearer_auth(&key)
// [voice input disabled]     };
// [voice input disabled]     let response = request
// [voice input disabled]         .send()
// [voice input disabled]         .await
// [voice input disabled]         .map_err(|_| "Could not reach the voice model service")?;
// [voice input disabled]     let status = response.status();
// [voice input disabled]     if matches!(status, reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
// [voice input disabled]         return Err(format!("Voice model service returned HTTP {}", status.as_u16()));
// [voice input disabled]     }
// [voice input disabled]     Ok(())
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Unisound MaaS: an asynchronous, task-based ASR service (model `u2-asr`)
// [voice input disabled] /// that is not OpenAI compatible. Uploading and task creation live under
// [voice input disabled] /// different paths, so the service URL alone is the base:
// [voice input disabled] /// `/v1/files/upload`, `/v1/audio/asr/tasks` and `/v1/audio/asr/tasks/{id}`.
// [voice input disabled] const U2_ASR_HOST: &str = "unisound.com";
// [voice input disabled]
// [voice input disabled] fn is_u2_asr_host(base_url: &str) -> bool {
// [voice input disabled]     reqwest::Url::parse(base_url.trim_end_matches('/'))
// [voice input disabled]         .ok()
// [voice input disabled]         .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
// [voice input disabled]         .is_some_and(|host| host == U2_ASR_HOST || host.ends_with(&format!(".{U2_ASR_HOST}")))
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Unisound's upload path sits on the service root, not under a version
// [voice input disabled] /// prefix. Users naturally paste the documented base
// [voice input disabled] /// `https://maas-api.unisound.com/v1`; been appended as-is it becomes
// [voice input disabled] /// `/v1/v1/files/upload`, which the service answers with a 404. Strip a
// [voice input disabled] /// trailing `/v1` once so both forms reach the same endpoints.
// [voice input disabled] fn u2_service_root(base_url: &str) -> Option<&str> {
// [voice input disabled]     let base = base_url.trim().trim_end_matches('/');
// [voice input disabled]     Some(base.strip_suffix("/v1").unwrap_or(base))
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Speech MIME type whose content unisound's `format` field accepts. The
// [voice input disabled] /// recording is already 16 kHz mono WAV, so only the suffix is needed.
// [voice input disabled] fn u2_audio_format(mime: &str) -> Option<&'static str> {
// [voice input disabled]     match mime.split(';').next().unwrap_or("").trim() {
// [voice input disabled]         "audio/wav" | "audio/x-wav" => Some("wav"),
// [voice input disabled]         "audio/mp3" | "audio/mpeg" => Some("mp3"),
// [voice input disabled]         "audio/mp4" | "audio/m4a" | "audio/x-m4a" => Some("m4a"),
// [voice input disabled]         "audio/ogg" => Some("ogg"),
// [voice input disabled]         "audio/amr" => Some("amr"),
// [voice input disabled]         "audio/opus" => Some("opus"),
// [voice input disabled]         _ => None,
// [voice input disabled]     }
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] // 16 kHz, mono, 16-bit PCM: 32 000 bytes per second of audio, plus a 44-byte
// [voice input disabled] // header. Anything bigger would never finish inside the polling budget.
// [voice input disabled] const U2_MAX_WAV_BYTES: usize = 32_000 * 180;
// [voice input disabled]
// [voice input disabled] /// Unisound answers 200 even for failures; `base_resp.status_code` 0 means
// [voice input disabled] /// success. Any other code is reported with the raw body.
// [voice input disabled] fn u2_check(value: &serde_json::Value, step: &str) -> Result<(), String> {
// [voice input disabled]     let status = value
// [voice input disabled]         .get("base_resp")
// [voice input disabled]         .and_then(|resp| resp.get("status_code"))
// [voice input disabled]         .and_then(|code| code.as_i64());
// [voice input disabled]     if status == Some(0) {
// [voice input disabled]         return Ok(());
// [voice input disabled]     }
// [voice input disabled]     let message = value
// [voice input disabled]         .get("base_resp")
// [voice input disabled]         .and_then(|resp| resp.get("status_msg"))
// [voice input disabled]         .and_then(|msg| msg.as_str())
// [voice input disabled]         .unwrap_or("unknown error");
// [voice input disabled]     Err(format!("u2-asr {step} failed ({status:?}): {message}"))
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] async fn u2_json(response: reqwest::Response, step: &str) -> Result<serde_json::Value, String> {
// [voice input disabled]     let status = response.status();
// [voice input disabled]     if !status.is_success() {
// [voice input disabled]         return Err(format!("u2-asr {step} returned HTTP {}", status.as_u16()));
// [voice input disabled]     }
// [voice input disabled]     let raw = response
// [voice input disabled]         .bytes()
// [voice input disabled]         .await
// [voice input disabled]         .map_err(|_| format!("Could not read the u2-asr {step} response"))?;
// [voice input disabled]     serde_json::from_slice(&raw).map_err(|_| {
// [voice input disabled]         format!(
// [voice input disabled]             "u2-asr {step} returned invalid JSON: {}",
// [voice input disabled]             String::from_utf8_lossy(&raw[..raw.len().min(200)])
// [voice input disabled]         )
// [voice input disabled]     })
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// The task `status` read-out is not monotonic: the service is served by
// [voice input disabled] /// several back ends, so a poll can regress from `Success` to `Waiting`.
// [voice input disabled] /// Only terminal states count; every other state (Waiting, Processing, …)
// [voice input disabled] /// means keep polling.
// [voice input disabled] fn u2_task_state(task: &serde_json::Value) -> Result<(bool, bool), String> {
// [voice input disabled]     let status = task
// [voice input disabled]         .get("status")
// [voice input disabled]         .and_then(|status| status.as_str())
// [voice input disabled]         .map(str::to_ascii_lowercase)
// [voice input disabled]         .unwrap_or_default();
// [voice input disabled]     match status.as_str() {
// [voice input disabled]         "success" | "succeeded" | "completed" | "done" | "finished" => Ok((true, false)),
// [voice input disabled]         "failed" | "error" | "cancelled" | "canceled" => Ok((true, true)),
// [voice input disabled]         _ => Ok((false, false)),
// [voice input disabled]     }
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] fn u2_transcript(task: &serde_json::Value) -> String {
// [voice input disabled]     task.get("results")
// [voice input disabled]         .and_then(|results| results.as_array())
// [voice input disabled]         .map(|results| {
// [voice input disabled]             results
// [voice input disabled]                 .iter()
// [voice input disabled]                 .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
// [voice input disabled]                 .map(str::trim)
// [voice input disabled]                 .filter(|text| !text.is_empty())
// [voice input disabled]                 .collect::<Vec<_>>()
// [voice input disabled]                 .join(" ")
// [voice input disabled]         })
// [voice input disabled]         .unwrap_or_default()
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Run the unisound asynchronous workflow: upload → create task → poll.
// [voice input disabled] /// Every step is bounded by the per-request `timeout`.
// [voice input disabled] async fn u2_transcribe(
// [voice input disabled]     client: &reqwest::Client,
// [voice input disabled]     base_url: &str,
// [voice input disabled]     key: &str,
// [voice input disabled]     model: String,
// [voice input disabled]     bytes: Vec<u8>,
// [voice input disabled]     mime: String,
// [voice input disabled]     audio_format: &'static str,
// [voice input disabled] ) -> Result<String, String> {
// [voice input disabled]     let base = u2_service_root(base_url).ok_or("Invalid u2-asr service URL")?;
// [voice input disabled]     let authorize = |request: reqwest::RequestBuilder| {
// [voice input disabled]         if key.is_empty() {
// [voice input disabled]             request
// [voice input disabled]         } else {
// [voice input disabled]             request.bearer_auth(key)
// [voice input disabled]         }
// [voice input disabled]     };
// [voice input disabled]
// [voice input disabled]     let form = reqwest::multipart::Form::new()
// [voice input disabled]         .text("purpose", "a2t_async_input")
// [voice input disabled]         .part(
// [voice input disabled]             "file",
// [voice input disabled]             reqwest::multipart::Part::bytes(bytes)
// [voice input disabled]                 .file_name(format!("recording.{audio_format}"))
// [voice input disabled]                 .mime_str(&mime)
// [voice input disabled]                 .map_err(|_| "Unsupported audio MIME type")?,
// [voice input disabled]         );
// [voice input disabled]     let upload = authorize(client.post(format!("{base}/v1/files/upload")).multipart(form))
// [voice input disabled]         .send()
// [voice input disabled]         .await
// [voice input disabled]         .map_err(|_| "Could not reach the voice model service")?;
// [voice input disabled]     let upload = u2_json(upload, "upload").await?;
// [voice input disabled]     u2_check(&upload, "upload")?;
// [voice input disabled]     let file_id = upload
// [voice input disabled]         .get("file")
// [voice input disabled]         .and_then(|file| file.get("file_id"))
// [voice input disabled]         .and_then(|id| id.as_i64())
// [voice input disabled]         .ok_or("u2-asr upload response has no file_id")?;
// [voice input disabled]
// [voice input disabled]     let task_url = format!("{base}/v1/audio/asr/tasks");
// [voice input disabled]     let create = authorize(
// [voice input disabled]         client
// [voice input disabled]             .post(&task_url)
// [voice input disabled]             .json(&serde_json::json!({
// [voice input disabled]                 "file_id": file_id,
// [voice input disabled]                 "model": model,
// [voice input disabled]                 "format": audio_format,
// [voice input disabled]                 "sample_rate": 16000,
// [voice input disabled]                 "enable_itn": true,
// [voice input disabled]                 "channel": 1,
// [voice input disabled]                 "enable_speaker": false,
// [voice input disabled]                 "word_info": false,
// [voice input disabled]             })),
// [voice input disabled]     )
// [voice input disabled]     .send()
// [voice input disabled]     .await
// [voice input disabled]     .map_err(|_| "Could not reach the voice model service")?;
// [voice input disabled]     let create = u2_json(create, "task creation").await?;
// [voice input disabled]     u2_check(&create, "task creation")?;
// [voice input disabled]     let task_id = create
// [voice input disabled]         .get("task_id")
// [voice input disabled]         .and_then(|id| id.as_str())
// [voice input disabled]         .filter(|id| !id.is_empty())
// [voice input disabled]         .ok_or("u2-asr task creation response has no task_id")?
// [voice input disabled]         .to_owned();
// [voice input disabled]
// [voice input disabled]     let poll_url = format!("{task_url}/{task_id}");
// [voice input disabled]     let deadline = tokio::time::Instant::now() + U2_POLL_BUDGET;
// [voice input disabled]     let mut interval = tokio::time::interval(Duration::from_millis(500));
// [voice input disabled]     let last = loop {
// [voice input disabled]         interval.tick().await;
// [voice input disabled]         let response = authorize(client.get(&poll_url))
// [voice input disabled]             .send()
// [voice input disabled]             .await
// [voice input disabled]             .map_err(|_| "Could not reach the voice model service")?;
// [voice input disabled]         let task = u2_json(response, "task status").await?;
// [voice input disabled]         u2_check(&task, "task status")?;
// [voice input disabled]         let (terminal, failed) = u2_task_state(&task)?;
// [voice input disabled]         if failed {
// [voice input disabled]             return Err(format!(
// [voice input disabled]                 "u2-asr transcription failed: {}",
// [voice input disabled]                 &task.to_string().chars().take(200).collect::<String>()
// [voice input disabled]             ));
// [voice input disabled]         }
// [voice input disabled]         if terminal {
// [voice input disabled]             break task;
// [voice input disabled]         }
// [voice input disabled]         if tokio::time::Instant::now() >= deadline {
// [voice input disabled]             return Err("u2-asr transcription timed out".into());
// [voice input disabled]         }
// [voice input disabled]     };
// [voice input disabled]     let text = u2_transcript(&last);
// [voice input disabled]     if text.is_empty() {
// [voice input disabled]         return Err("u2-asr returned an empty transcription".into());
// [voice input disabled]     }
// [voice input disabled]     Ok(text)
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Stop looking for the finished task after this long. The 5-hour API limit
// [voice input disabled] /// keeps real jobs well inside it.
// [voice input disabled] const U2_POLL_BUDGET: Duration = Duration::from_secs(180);
// [voice input disabled]
// [voice input disabled] /// Endpoint for audio transcription. Mirrors the text model's URL rules.
// [voice input disabled] fn transcribe_endpoint(base_url: &str) -> String {
// [voice input disabled]     let base = base_url.trim_end_matches('/');
// [voice input disabled]     if base.ends_with("/audio/transcriptions") {
// [voice input disabled]         base.into()
// [voice input disabled]     } else {
// [voice input disabled]         format!("{base}/audio/transcriptions")
// [voice input disabled]     }
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Map a recorded audio MIME type to a file suffix acceptable in a
// [voice input disabled] /// multipart transcription upload. Unknown types (e.g. WebM, the default
// [voice input disabled] /// MediaRecorder output on browsers) fall back to webm.
// [voice input disabled] fn file_extension(mime: &str) -> &'static str {
// [voice input disabled]     match mime {
// [voice input disabled]         "audio/wav" | "audio/x-wav" => "wav",
// [voice input disabled]         "audio/mp3" | "audio/mpeg" => "mp3",
// [voice input disabled]         "audio/aac" | "audio/mp4" | "audio/m4a" => "m4a",
// [voice input disabled]         "audio/ogg" => "ogg",
// [voice input disabled]         "audio/flac" => "flac",
// [voice input disabled]         _ => "webm",
// [voice input disabled]     }
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Transcribe recorded audio to text using the configured voice model.
// [voice input disabled] /// The audio arrives as a base64-encoded blob (the frontend captures it via
// [voice input disabled] /// MediaRecorder — typically WebM, sometimes WAV), so no copy on the disk is
// [voice input disabled] /// needed; only the chosen MIME type hints the file suffix for the request.
// [voice input disabled] #[tauri::command]
// [voice input disabled] pub async fn agent_transcribe(
// [voice input disabled]     app: AppHandle,
// [voice input disabled]     audio_base64: String,
// [voice input disabled]     mime_type: Option<String>,
// [voice input disabled] ) -> Result<String, String> {
// [voice input disabled]     let (config, key) = tokio::task::spawn_blocking(move || {
// [voice input disabled]         let _lock = STORAGE_LOCK
// [voice input disabled]             .lock()
// [voice input disabled]             .map_err(|_| "Voice model storage is unavailable")?;
// [voice input disabled]         let config = read(&app)?;
// [voice input disabled]         validate(&config)?;
// [voice input disabled]         let key = crate::credentials::load_secret(KEY_SERVICE, KEY_ACCOUNT)
// [voice input disabled]             .map_err(|error| error.to_string())?
// [voice input disabled]             .unwrap_or_default();
// [voice input disabled]         Ok::<_, String>((config, key))
// [voice input disabled]     })
// [voice input disabled]     .await
// [voice input disabled]     .map_err(|_| "Could not load voice model configuration")??;
// [voice input disabled]
// [voice input disabled]     if config.base_url.is_empty() {
// [voice input disabled]         return Err("No voice model service is configured".into());
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     // Limit the payload so a multiply-selected or overlong recording can't
// [voice input disabled]     // exhaust memory. 25 MB of base64 is plenty for a voice note.
// [voice input disabled]     use base64::{engine::general_purpose::STANDARD, Engine};
// [voice input disabled]     const MAX_BASE64_BYTES: usize = 35 * 1024 * 1024;
// [voice input disabled]     if audio_base64.len() > MAX_BASE64_BYTES {
// [voice input disabled]         return Err("Audio recording is too large".into());
// [voice input disabled]     }
// [voice input disabled]     let bytes = STANDARD
// [voice input disabled]         .decode(audio_base64)
// [voice input disabled]         .map_err(|_| "Audio recording is not valid base64")?;
// [voice input disabled]     if bytes.is_empty() {
// [voice input disabled]         return Err("No audio was recorded".into());
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     // Derive a plausible file name from the MIME type. Whisper-compatible
// [voice input disabled]     // endpoints branch on the extension in multipart form data.
// [voice input disabled]     let mime = mime_type.unwrap_or_else(|| "audio/webm".into());
// [voice input disabled]
// [voice input disabled]     if is_u2_asr_host(&config.base_url) {
// [voice input disabled]         // Unisound: asynchronous tasks under fixed paths; no multipart
// [voice input disabled]         // transcription endpoint exists there, hence the dedicated branch.
// [voice input disabled]         let audio_format = u2_audio_format(&mime)
// [voice input disabled]             .ok_or_else(|| format!("u2-asr does not accept {mime} audio"))?;
// [voice input disabled]         if bytes.len() > U2_MAX_WAV_BYTES {
// [voice input disabled]             return Err("Audio recording is too long for u2-asr".into());
// [voice input disabled]         }
// [voice input disabled]         let client = reqwest::Client::builder()
// [voice input disabled]             .timeout(Duration::from_secs(60))
// [voice input disabled]             .redirect(reqwest::redirect::Policy::none())
// [voice input disabled]             .build()
// [voice input disabled]             .map_err(|_| "Could not create transcription client")?;
// [voice input disabled]         let model = if config.model.is_empty() { "u2-asr".into() } else { config.model.clone() };
// [voice input disabled]         return u2_transcribe(&client, &config.base_url, &key, model, bytes, mime, audio_format).await;
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     let file_name = format!("recording.{}", file_extension(&mime));
// [voice input disabled]
// [voice input disabled]     let url = transcribe_endpoint(&config.base_url);
// [voice input disabled]     let client = reqwest::Client::builder()
// [voice input disabled]         .timeout(Duration::from_secs(120))
// [voice input disabled]         .redirect(reqwest::redirect::Policy::none())
// [voice input disabled]         .build()
// [voice input disabled]         .map_err(|_| "Could not create transcription client")?;
// [voice input disabled]
// [voice input disabled]     let body = reqwest::multipart::Form::new()
// [voice input disabled]         .text("model", config.model.clone())
// [voice input disabled]         .text("response_format", "json")
// [voice input disabled]         .part(
// [voice input disabled]             "file",
// [voice input disabled]             reqwest::multipart::Part::bytes(bytes)
// [voice input disabled]                 .file_name(file_name)
// [voice input disabled]                 .mime_str(&mime)
// [voice input disabled]                 .map_err(|_| "Unsupported audio MIME type")?,
// [voice input disabled]         );
// [voice input disabled]
// [voice input disabled]     let request = client.post(url);
// [voice input disabled]     let request = if key.is_empty() {
// [voice input disabled]         request
// [voice input disabled]     } else {
// [voice input disabled]         request.bearer_auth(key)
// [voice input disabled]     };
// [voice input disabled]
// [voice input disabled]     let response = request
// [voice input disabled]         .multipart(body)
// [voice input disabled]         .send()
// [voice input disabled]         .await
// [voice input disabled]         .map_err(|_| "Could not reach the voice model service")?;
// [voice input disabled]     let status = response.status();
// [voice input disabled]     if !status.is_success() {
// [voice input disabled]         return Err(format!(
// [voice input disabled]             "Voice model service returned HTTP {}",
// [voice input disabled]             status.as_u16()
// [voice input disabled]         ));
// [voice input disabled]     }
// [voice input disabled]     let raw = response
// [voice input disabled]         .text()
// [voice input disabled]         .await
// [voice input disabled]         .map_err(|_| "Could not read the voice model response")?;
// [voice input disabled]     log::warn!("[CoffeeVoice] transcription raw response: {}", &raw.chars().take(500).collect::<String>());
// [voice input disabled]     let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
// [voice input disabled]         format!("Voice model returned invalid JSON: {}", &raw.chars().take(200).collect::<String>())
// [voice input disabled]     })?;
// [voice input disabled]     let text = value
// [voice input disabled]         .get("text")
// [voice input disabled]         .and_then(|text| text.as_str())
// [voice input disabled]         .ok_or_else(|| {
// [voice input disabled]             format!("Voice model response has no text field: {}", &raw.chars().take(200).collect::<String>())
// [voice input disabled]         })?;
// [voice input disabled]     let cleaned = strip_segment_prefixes(text);
// [voice input disabled]     if cleaned.is_empty() {
// [voice input disabled]         return Err(format!(
// [voice input disabled]             "Voice model returned empty transcription (raw: {})",
// [voice input disabled]             &raw.chars().take(200).collect::<String>()
// [voice input disabled]         ));
// [voice input disabled]     }
// [voice input disabled]     Ok(cleaned)
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] /// Some transcription backends emit per-segment numbering (SRT/VTT-ish) like
// [voice input disabled] /// `1: 喂，你好` or `2. hello there` before each line. That's output noise the
// [voice input disabled] /// user doesn't want pasted into their prompt, so strip a leading
// [voice input disabled] /// `digits + [：:.、]` from each non-empty line. Content that genuinely starts
// [voice input disabled] /// with a number (e.g. "3 apples") is preserved because it needs a separator
// [voice input disabled] /// after the number; only `1:` / `1.` / `1、` style numbering is removed.
// [voice input disabled] fn strip_segment_prefixes(text: &str) -> String {
// [voice input disabled]     let mut out = Vec::with_capacity(text.lines().count());
// [voice input disabled]     let prefix = regex::Regex::new(r"^\s*\d+[：:.、]\s*").expect("segment prefix regex compiles");
// [voice input disabled]     for line in text.lines() {
// [voice input disabled]         if line.trim().is_empty() {
// [voice input disabled]             out.push(line.to_owned());
// [voice input disabled]             continue;
// [voice input disabled]         }
// [voice input disabled]         // The separator must be ASCII colon/dot (which str::lines won't drop),
// [voice input disabled]         // so the regex strips it. A plain number with no separator or a number
// [voice input disabled]         // followed by text (e.g. "3 apples") is left untouched.
// [voice input disabled]         if prefix.is_match(line) {
// [voice input disabled]             out.push(prefix.replace(line, "").trim().to_owned());
// [voice input disabled]         } else {
// [voice input disabled]             out.push(line.to_owned());
// [voice input disabled]         }
// [voice input disabled]     }
// [voice input disabled]     out.join("\n")
// [voice input disabled] }
// [voice input disabled]
// [voice input disabled] #[cfg(test)]
// [voice input disabled] mod tests {
// [voice input disabled]     use super::*;
// [voice input disabled]     use serde_json::{json, Value};
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn voice_api_key_is_never_written_to_the_settings_file() {
// [voice input disabled]         let directory = std::env::temp_dir()
// [voice input disabled]             .join(format!("coffee-voice-model-test-{}", uuid::Uuid::new_v4()));
// [voice input disabled]         let path = directory.join(FILE_NAME);
// [voice input disabled]         let save = |value: Value| serde_json::from_value::<SaveVoiceModel>(value).unwrap();
// [voice input disabled]         let config = save(json!({"provider":"openai","baseUrl":"http://localhost:11434/v1/","model":"whisper-1","apiKey":"  sk-voice \n"}))
// [voice input disabled]             .apply(&read_file(&path).unwrap());
// [voice input disabled]         assert_eq!(config.api_key, "sk-voice");
// [voice input disabled]         assert_eq!(config.base_url, "http://localhost:11434/v1");
// [voice input disabled]         save_json(&path, &config).unwrap();
// [voice input disabled]         let raw = fs::read_to_string(&path).unwrap();
// [voice input disabled]         let stored: Value = serde_json::from_str(&raw).unwrap();
// [voice input disabled]         assert!(stored.get("apiKey").is_none());
// [voice input disabled]         assert!(!raw.contains("sk-voice"));
// [voice input disabled]         assert!(!path.with_extension("json.tmp").exists());
// [voice input disabled]
// [voice input disabled]         // The key comes from the credential store, never from the settings file.
// [voice input disabled]         let reloaded = read_file(&path).unwrap();
// [voice input disabled]         assert_eq!(reloaded.api_key, "");
// [voice input disabled]         assert_eq!(reloaded.model, "whisper-1");
// [voice input disabled]         let previous = VoiceModelConfig {
// [voice input disabled]             api_key: "sk-voice".into(),
// [voice input disabled]             ..reloaded.clone()
// [voice input disabled]         };
// [voice input disabled]         let same = save(json!({"provider":"openai","baseUrl":"http://localhost:11434/v1","model":"whisper-1"}))
// [voice input disabled]             .apply(&previous);
// [voice input disabled]         assert_eq!(same.api_key, "sk-voice");
// [voice input disabled]         let moved = save(json!({"provider":"openai","baseUrl":"https://example.com/v1","model":"whisper-1"}))
// [voice input disabled]             .apply(&previous);
// [voice input disabled]         assert_eq!(moved.api_key, "");
// [voice input disabled]         let cleared = save(json!({"provider":"openai","baseUrl":"http://localhost:11434/v1","model":"whisper-1","apiKey":""}))
// [voice input disabled]             .apply(&previous);
// [voice input disabled]         assert_eq!(cleared.api_key, "");
// [voice input disabled]         fs::remove_file(&path).unwrap();
// [voice input disabled]         fs::remove_dir(&directory).unwrap();
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn voice_service_url_is_validated() {
// [voice input disabled]         assert!(validate(&VoiceModelConfig {
// [voice input disabled]             base_url: "https://api.openai.com/v1".into(),
// [voice input disabled]             ..VoiceModelConfig::default()
// [voice input disabled]         })
// [voice input disabled]         .is_ok());
// [voice input disabled]         assert!(validate(&VoiceModelConfig {
// [voice input disabled]             base_url: "http://example.com/v1".into(),
// [voice input disabled]             ..VoiceModelConfig::default()
// [voice input disabled]         })
// [voice input disabled]         .is_err());
// [voice input disabled]         assert!(validate(&VoiceModelConfig {
// [voice input disabled]             model: "x".repeat(201),
// [voice input disabled]             ..VoiceModelConfig::default()
// [voice input disabled]         })
// [voice input disabled]         .is_err());
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn transcription_endpoint_appends_the_audio_path() {
// [voice input disabled]         assert_eq!(
// [voice input disabled]             transcribe_endpoint("https://api.openai.com/v1"),
// [voice input disabled]             "https://api.openai.com/v1/audio/transcriptions"
// [voice input disabled]         );
// [voice input disabled]         // A trailing slash is trimmed for the match+format.
// [voice input disabled]         assert_eq!(
// [voice input disabled]             transcribe_endpoint("https://api.openai.com/v1/audio/transcriptions/"),
// [voice input disabled]             "https://api.openai.com/v1/audio/transcriptions"
// [voice input disabled]         );
// [voice input disabled]         assert_eq!(
// [voice input disabled]             transcribe_endpoint("http://localhost:11434/v1/audio/transcriptions"),
// [voice input disabled]             "http://localhost:11434/v1/audio/transcriptions"
// [voice input disabled]         );
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn unisound_urls_use_the_async_asr_workflow_instead() {
// [voice input disabled]         // The service the user reported: OpenAI-style transcription 404s here.
// [voice input disabled]         for url in [
// [voice input disabled]             "https://maas-api.unisound.com",
// [voice input disabled]             "https://maas-api.unisound.com/v1",
// [voice input disabled]             "https://maas-api.unisound.com/v1/",
// [voice input disabled]             "https://MAAS-API.Unisound.com/v1",
// [voice input disabled]             "https://unisound.com",
// [voice input disabled]         ] {
// [voice input disabled]             assert!(is_u2_asr_host(url), "{url}");
// [voice input disabled]         }
// [voice input disabled]         for url in [
// [voice input disabled]             "https://api.openai.com/v1",
// [voice input disabled]             "https://notunisound.com/v1",
// [voice input disabled]             "https://unisound.com.example.com/v1",
// [voice input disabled]             "http://localhost:11434/v1",
// [voice input disabled]         ] {
// [voice input disabled]             assert!(!is_u2_asr_host(url), "{url}");
// [voice input disabled]         }
// [voice input disabled]         // Every unisound URL above is routed away from transcribe_endpoint, so
// [voice input disabled]         // the OpenAI multipart path (100301 "path error" there) is never hit.
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn unisound_service_root_drops_a_single_v1_prefix() {
// [voice input disabled]         // Regression: the documented base /v1 used to yield /v1/v1/files/upload (404).
// [voice input disabled]         assert_eq!(u2_service_root("https://maas-api.unisound.com/v1"), Some("https://maas-api.unisound.com"));
// [voice input disabled]         assert_eq!(u2_service_root("https://maas-api.unisound.com/v1/"), Some("https://maas-api.unisound.com"));
// [voice input disabled]         assert_eq!(u2_service_root("https://maas-api.unisound.com"), Some("https://maas-api.unisound.com"));
// [voice input disabled]         assert_eq!(u2_service_root("https://maas-api.unisound.com/"), Some("https://maas-api.unisound.com"));
// [voice input disabled]         assert_eq!(
// [voice input disabled]             format!("{}/v1/audio/asr/tasks", u2_service_root("https://maas-api.unisound.com/v1").unwrap()),
// [voice input disabled]             "https://maas-api.unisound.com/v1/audio/asr/tasks"
// [voice input disabled]         );
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn unisound_accepts_only_its_declared_audio_formats() {
// [voice input disabled]         assert_eq!(u2_audio_format("audio/wav"), Some("wav"));
// [voice input disabled]         assert_eq!(u2_audio_format("audio/wav;codecs=1"), Some("wav"));
// [voice input disabled]         assert_eq!(u2_audio_format("audio/mpeg"), Some("mp3"));
// [voice input disabled]         assert_eq!(u2_audio_format("audio/m4a"), Some("m4a"));
// [voice input disabled]         assert_eq!(u2_audio_format("audio/ogg"), Some("ogg"));
// [voice input disabled]         assert_eq!(u2_audio_format("audio/amr"), Some("amr"));
// [voice input disabled]         assert_eq!(u2_audio_format("audio/opus"), Some("opus"));
// [voice input disabled]         // WebM is the recorder's native container and unisound rejects it.
// [voice input disabled]         assert_eq!(u2_audio_format("audio/webm"), None);
// [voice input disabled]         assert_eq!(u2_audio_format("audio/flac"), None);
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn unisound_task_state_is_not_monotonic() {
// [voice input disabled]         let state = |value: Value| u2_task_state(&json!({ "status": value }));
// [voice input disabled]         // A poll that went back to Waiting after Success must keep polling.
// [voice input disabled]         assert_eq!(state(json!("Waiting")), Ok((false, false)));
// [voice input disabled]         assert_eq!(state(json!("Processing")), Ok((false, false)));
// [voice input disabled]         assert_eq!(state(json!("Success")), Ok((true, false)));
// [voice input disabled]         assert_eq!(state(json!("Succeeded")), Ok((true, false)));
// [voice input disabled]         assert_eq!(state(json!("Failed")), Ok((true, true)));
// [voice input disabled]         assert_eq!(state(json!("CANCELLED")), Ok((true, true)));
// [voice input disabled]         assert_eq!(state(Value::Null), Ok((false, false)));
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn unisound_status_codes_are_checked() {
// [voice input disabled]         assert!(u2_check(&json!({"base_resp": {"status_code": 0}}), "upload").is_ok());
// [voice input disabled]         let error = u2_check(
// [voice input disabled]             &json!({"base_resp": {"status_code": 100101, "status_msg": "auth error"}}),
// [voice input disabled]             "upload",
// [voice input disabled]         )
// [voice input disabled]         .unwrap_err();
// [voice input disabled]         assert!(error.contains("100101") && error.contains("auth error"), "{error}");
// [voice input disabled]         assert!(u2_check(&json!({}), "upload").is_err());
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn unisound_segments_are_joined_in_order() {
// [voice input disabled]         let task = json!({"results": [
// [voice input disabled]             {"text": "你好，"},
// [voice input disabled]             {"text": "  "},
// [voice input disabled]             {"text": "这是一段语音识别测试 hello world."}
// [voice input disabled]         ]});
// [voice input disabled]         assert_eq!(u2_transcript(&task), "你好， 这是一段语音识别测试 hello world.");
// [voice input disabled]         assert_eq!(u2_transcript(&json!({"results": []})), "");
// [voice input disabled]         assert_eq!(u2_transcript(&json!({})), "");
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn recorded_audio_mime_maps_to_a_whisper_friendly_suffix() {
// [voice input disabled]         // WebM is the default MediaRecorder container in browsers.
// [voice input disabled]         assert_eq!(file_extension("audio/webm"), "webm");
// [voice input disabled]         assert_eq!(file_extension("audio/webm;codecs=opus"), "webm");
// [voice input disabled]         assert_eq!(file_extension("audio/wav"), "wav");
// [voice input disabled]         assert_eq!(file_extension("audio/mpeg"), "mp3");
// [voice input disabled]         assert_eq!(file_extension("audio/m4a"), "m4a");
// [voice input disabled]         assert_eq!(file_extension("audio/ogg"), "ogg");
// [voice input disabled]         assert_eq!(file_extension(""), "webm");
// [voice input disabled]     }
// [voice input disabled]
// [voice input disabled]     #[test]
// [voice input disabled]     fn segment_number_prefixes_are_stripped_from_transcripts() {
// [voice input disabled]         // The user's reported case: three sentences each prefixed with "1:".
// [voice input disabled]         assert_eq!(
// [voice input disabled]             strip_segment_prefixes("1: 喂，你好听得到吗？\n1: 你是什么大？\n1: 你是什么大模型？"),
// [voice input disabled]             "喂，你好听得到吗？\n你是什么大？\n你是什么大模型？"
// [voice input disabled]         );
// [voice input disabled]         // ASCII variants too.
// [voice input disabled]         assert_eq!(strip_segment_prefixes("1. hello there\n2. world"), "hello there\nworld");
// [voice input disabled]         assert_eq!(strip_segment_prefixes("1、 你好"), "你好");
// [voice input disabled]         assert_eq!(strip_segment_prefixes("12: 按数字编号"), "按数字编号");
// [voice input disabled]         // Content that genuinely starts with a number must survive.
// [voice input disabled]         assert_eq!(strip_segment_prefixes("3 apples and 2 pears"), "3 apples and 2 pears");
// [voice input disabled]         assert_eq!(strip_segment_prefixes("2026 is coming"), "2026 is coming");
// [voice input disabled]         // A stripped line is trimmed; empty lines are preserved.
// [voice input disabled]         assert_eq!(strip_segment_prefixes("  1:  hi  "), "hi");
// [voice input disabled]         assert_eq!(strip_segment_prefixes("line one\n\n 2: line two\n"), "line one\n\nline two");
// [voice input disabled]         // No prefix -> unchanged.
// [voice input disabled]         assert_eq!(strip_segment_prefixes("just text"), "just text");
// [voice input disabled]     }
// [voice input disabled] }
