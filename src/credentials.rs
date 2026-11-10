//! Credential storage with two selectable backends.
//!
//! * `EncryptedFile` (default): each secret is sealed with AES-256-GCM into
//!   `~/.coffee-cli/credentials.json`. The 32-byte master key is kept in the
//!   OS credential store, so the file contains only authenticated ciphertext
//!   plus a non-secret index of entry names.
//! * `Keychain`: each secret lives directly in the OS credential store
//!   (Windows Credential Manager, macOS Keychain, or the Linux Secret
//!   Service). The local file keeps only the entry-name index.
//!
//! Reads fall back to the other backend so an interrupted backend switch can
//! never make a saved secret unreachable. The legacy plain-text format is
//! upgraded on first access and is never written again.
//!
//! `Entry::at` injects a test vault: the master key and the keychain are both
//! local/in-memory, so the unit suite never touches the real OS store.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const AGENT_MODEL_SERVICE: &str = "coffee-cli-agent";
pub const AGENT_MODEL_ACCOUNT: &str = "model-api-key";

const VAULT_VERSION: u32 = 2;
const MASTER_KEY_SERVICE: &str = "com.coffeecli.desktop";
const MASTER_KEY_ACCOUNT: &str = "credentials-master-key";
const KEYCHAIN_PROBE_ACCOUNT: &str = "__coffee-cli-probe__";

static FILE_LOCK: Mutex<()> = Mutex::new(());
static TEST_KEYCHAIN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

#[derive(Debug)]
pub enum Error {
    NoEntry,
    Storage(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NoEntry => f.write_str("no saved value"),
            Error::Storage(message) => f.write_str(message),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Backend {
    #[default]
    #[serde(rename = "encrypted")]
    EncryptedFile,
    #[serde(rename = "keychain")]
    Keychain,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::EncryptedFile => "encrypted",
            Backend::Keychain => "keychain",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "encrypted" => Some(Backend::EncryptedFile),
            "keychain" => Some(Backend::Keychain),
            _ => None,
        }
    }
}

/// A sealed value. An empty `Sealed` is an index-only record used by the
/// keychain backend, where the value is not stored locally at all.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Sealed {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    ciphertext: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Vault {
    version: u32,
    #[serde(default)]
    backend: Backend,
    #[serde(default)]
    entries: BTreeMap<String, Sealed>,
}

impl Default for Vault {
    fn default() -> Self {
        Self { version: VAULT_VERSION, backend: Backend::default(), entries: BTreeMap::new() }
    }
}

// `Test` is constructed only by the unit suite; release builds never use it.
#[allow(dead_code)]
#[derive(Clone)]
enum Mode {
    Production,
    Test(PathBuf),
}

pub struct Entry {
    mode: Mode,
    service: String,
    account: String,
}

impl Entry {
    pub fn new(service: &str, account: &str) -> Result<Self, Error> {
        default_vault_path()?;
        Ok(Self { mode: Mode::Production, service: service.into(), account: account.into() })
    }

    /// Test-only vault at an explicit path, isolated from the OS credential store.
    #[allow(dead_code)]
    pub(crate) fn at(path: PathBuf, service: &str, account: &str) -> Self {
        Self { mode: Mode::Test(path), service: service.into(), account: account.into() }
    }

    fn vault_path(&self) -> Result<PathBuf, Error> {
        match &self.mode {
            Mode::Production => default_vault_path(),
            Mode::Test(path) => Ok(path.clone()),
        }
    }

    pub fn get_password(&self) -> Result<String, Error> {
        let _lock = lock()?;
        let path = self.vault_path()?;
        let vault = load_vault(&self.mode, &path)?;
        read_value(&self.mode, &vault, &key_id(&self.service, &self.account))
    }

    pub fn set_password(&self, value: &str) -> Result<(), Error> {
        let _lock = lock()?;
        let path = self.vault_path()?;
        let mut vault = load_vault(&self.mode, &path)?;
        write_value(&self.mode, &mut vault, &key_id(&self.service, &self.account), value)?;
        save_vault(&path, &vault)
    }

    pub fn delete_credential(&self) -> Result<(), Error> {
        let _lock = lock()?;
        let path = self.vault_path()?;
        let mut vault = load_vault(&self.mode, &path)?;
        remove_value(&self.mode, &mut vault, &key_id(&self.service, &self.account))?;
        save_vault(&path, &vault)
    }
}

/// Agent model keys go through the same backends as every other secret.
pub fn load_secret(service: &str, account: &str) -> Result<Option<String>, Error> {
    match Entry::new(service, account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn save_secret(service: &str, account: &str, value: &str) -> Result<(), Error> {
    let entry = Entry::new(service, account)?;
    if value.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        entry.set_password(value)
    }
}

pub fn current_backend() -> Result<Backend, Error> {
    let _lock = lock()?;
    let path = default_vault_path()?;
    Ok(load_vault(&Mode::Production, &path)?.backend)
}

pub fn switch_backend(next: Backend) -> Result<(), Error> {
    let _lock = lock()?;
    let path = default_vault_path()?;
    switch_backend_with(&Mode::Production, &path, next)
}

fn switch_backend_with(mode: &Mode, path: &Path, next: Backend) -> Result<(), Error> {
    let vault = load_vault(mode, path)?;
    if vault.backend == next {
        return Ok(());
    }
    probe_backend(mode, next)?;
    let keys: Vec<String> = vault.entries.keys().cloned().collect();
    let mut values: Vec<(String, String)> = Vec::new();
    let mut stale: Vec<String> = Vec::new();
    for key in keys {
        match read_value(mode, &vault, &key) {
            Ok(value) => values.push((key, value)),
            Err(Error::NoEntry) => stale.push(key),
            Err(error) => return Err(error),
        }
    }
    let mut staged = vault.clone();
    staged.backend = next;
    for key in stale {
        staged.entries.remove(&key);
    }
    // Stage every value in the new backend without removing the source copy,
    // commit the backend change atomically, then clean up the source. An
    // interrupted migration can therefore never make a secret unreachable.
    for (key, value) in &values {
        write_value_only(mode, &mut staged, key, value)?;
    }
    save_vault(path, &staged)?;
    if next == Backend::EncryptedFile {
        // Switching to the vault leaves the old keychain entries behind;
        // the index-only records in `staged` already dropped the inverse case.
        for (key, _) in &values {
            let _ = keychain_delete(mode, key);
        }
    }
    Ok(())
}

fn probe_backend(mode: &Mode, backend: Backend) -> Result<(), Error> {
    match backend {
        Backend::EncryptedFile => master_key(mode).map(|_| ()),
        Backend::Keychain => {
            let probe = key_id(MASTER_KEY_SERVICE, KEYCHAIN_PROBE_ACCOUNT);
            keychain_set(mode, &probe, "ok")?;
            keychain_delete(mode, &probe)?;
            Ok(())
        }
    }
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, Error> {
    FILE_LOCK.lock().map_err(|_| Error::Storage("Saved credentials are unavailable".into()))
}

fn default_vault_path() -> Result<PathBuf, Error> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Storage("Cannot find the user home directory".into()))?;
    Ok(home.join(".coffee-cli").join("credentials.json"))
}

/// NUL cannot appear in a service or account name, so this is unambiguous
/// while keeping the on-disk index readable.
fn key_id(service: &str, account: &str) -> String {
    format!("{service}\u{0}{account}")
}

fn split_key(key: &str) -> Result<(&str, &str), Error> {
    key.split_once('\u{0}')
        .ok_or_else(|| Error::Storage("Invalid credential identifier".into()))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    bytes
}

fn decode_key(encoded: &str) -> Result<Vec<u8>, Error> {
    let bytes = BASE64.decode(encoded.trim())
        .map_err(|_| Error::Storage("Saved master key is damaged".into()))?;
    if bytes.len() != 32 {
        return Err(Error::Storage("Saved master key has the wrong length".into()));
    }
    Ok(bytes)
}

/// The master key never touches the vault file. In production it is protected
/// by the OS credential store; the test mode keeps it in a sibling file.
fn master_key(mode: &Mode) -> Result<Vec<u8>, Error> {
    match mode {
        Mode::Production => {
            let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT)
                .map_err(|error| Error::Storage(format!("OS credential store is unavailable: {error}")))?;
            match entry.get_password() {
                Ok(encoded) => decode_key(&encoded),
                Err(keyring::Error::NoEntry) => {
                    let key = random_bytes::<32>();
                    entry.set_password(&BASE64.encode(key))
                        .map_err(|error| Error::Storage(format!("Cannot store the master key: {error}")))?;
                    Ok(key.to_vec())
                }
                Err(error) => Err(Error::Storage(format!("Cannot read the master key: {error}"))),
            }
        }
        Mode::Test(vault) => {
            let path = vault.with_extension("master-key");
            match std::fs::read(&path) {
                Ok(bytes) => decode_key(&String::from_utf8_lossy(&bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let key = random_bytes::<32>();
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent).map_err(|error| {
                            Error::Storage(format!("Cannot create the test credential directory: {error}"))
                        })?;
                    }
                    std::fs::write(&path, BASE64.encode(key))
                        .map_err(|error| Error::Storage(format!("Cannot save the test master key: {error}")))?;
                    Ok(key.to_vec())
                }
                Err(error) => Err(Error::Storage(format!("Cannot read the test master key: {error}"))),
            }
        }
    }
}

fn keychain_set(mode: &Mode, key: &str, value: &str) -> Result<(), Error> {
    match mode {
        Mode::Production => {
            let (service, account) = split_key(key)?;
            let entry = keyring::Entry::new(service, account)
                .map_err(|error| Error::Storage(format!("OS credential store is unavailable: {error}")))?;
            entry.set_password(value)
                .map_err(|error| Error::Storage(format!("Cannot save an OS credential: {error}")))
        }
        Mode::Test(_) => {
            TEST_KEYCHAIN.lock()
                .map_err(|_| Error::Storage("Test credential store is unavailable".into()))?
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
    }
}

fn keychain_get(mode: &Mode, key: &str) -> Result<String, Error> {
    match mode {
        Mode::Production => {
            let (service, account) = split_key(key)?;
            let entry = keyring::Entry::new(service, account)
                .map_err(|error| Error::Storage(format!("OS credential store is unavailable: {error}")))?;
            match entry.get_password() {
                Ok(value) => Ok(value),
                Err(keyring::Error::NoEntry) => Err(Error::NoEntry),
                Err(error) => Err(Error::Storage(format!("Cannot read an OS credential: {error}"))),
            }
        }
        Mode::Test(_) => TEST_KEYCHAIN.lock()
            .map_err(|_| Error::Storage("Test credential store is unavailable".into()))?
            .get(key)
            .cloned()
            .ok_or(Error::NoEntry),
    }
}

/// Returns whether an entry existed; a missing entry is not an error.
fn keychain_delete(mode: &Mode, key: &str) -> Result<bool, Error> {
    match mode {
        Mode::Production => {
            let (service, account) = split_key(key)?;
            let entry = keyring::Entry::new(service, account)
                .map_err(|error| Error::Storage(format!("OS credential store is unavailable: {error}")))?;
            match entry.delete_credential() {
                Ok(()) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(error) => Err(Error::Storage(format!("Cannot remove an OS credential: {error}"))),
            }
        }
        Mode::Test(_) => Ok(TEST_KEYCHAIN.lock()
            .map_err(|_| Error::Storage("Test credential store is unavailable".into()))?
            .remove(key)
            .is_some()),
    }
}

fn cipher(mode: &Mode) -> Result<Aes256Gcm, Error> {
    let key = master_key(mode)?;
    Aes256Gcm::new_from_slice(&key)
        .map_err(|_| Error::Storage("Saved master key is invalid".into()))
}

fn seal(mode: &Mode, key: &str, plaintext: &str) -> Result<Sealed, Error> {
    let nonce_bytes = random_bytes::<12>();
    let nonce = GenericArray::from_slice(&nonce_bytes);
    let ciphertext = cipher(mode)?
        .encrypt(nonce, Payload { msg: plaintext.as_bytes(), aad: key.as_bytes() })
        .map_err(|_| Error::Storage("Could not encrypt a credential".into()))?;
    Ok(Sealed {
        nonce: Some(BASE64.encode(nonce_bytes)),
        ciphertext: Some(BASE64.encode(ciphertext)),
    })
}

fn open_sealed(mode: &Mode, key: &str, sealed: &Sealed) -> Result<String, Error> {
    let nonce = sealed.nonce.as_deref()
        .ok_or_else(|| Error::Storage("Saved credential has no nonce".into()))?;
    let ciphertext = sealed.ciphertext.as_deref()
        .ok_or_else(|| Error::Storage("Saved credential has no ciphertext".into()))?;
    let nonce = BASE64.decode(nonce)
        .map_err(|_| Error::Storage("Saved credential nonce is damaged".into()))?;
    let ciphertext = BASE64.decode(ciphertext)
        .map_err(|_| Error::Storage("Saved credential ciphertext is damaged".into()))?;
    if nonce.len() != 12 {
        return Err(Error::Storage("Saved credential nonce has the wrong length".into()));
    }
    let plaintext = cipher(mode)?
        .decrypt(
            GenericArray::from_slice(&nonce),
            Payload { msg: &ciphertext, aad: key.as_bytes() },
        )
        .map_err(|_| Error::Storage("Saved credential is damaged or was tampered with".into()))?;
    String::from_utf8(plaintext)
        .map_err(|_| Error::Storage("Saved credential is not valid text".into()))
}

fn read_value(mode: &Mode, vault: &Vault, key: &str) -> Result<String, Error> {
    let from_vault = || -> Result<String, Error> {
        let sealed = vault.entries.get(key).ok_or(Error::NoEntry)?;
        if sealed.nonce.is_none() || sealed.ciphertext.is_none() {
            // Index-only record: the value is held by the keychain backend.
            return Err(Error::NoEntry);
        }
        open_sealed(mode, key, sealed)
    };
    match vault.backend {
        Backend::EncryptedFile => match from_vault() {
            Ok(value) => Ok(value),
            // The local vault is authoritative for this backend. A missing OS
            // store must not turn "no saved secret" into a hard failure (local
            // model services need no API key at all).
            Err(Error::NoEntry) => match keychain_get(mode, key) {
                Ok(value) => Ok(value),
                Err(Error::NoEntry) | Err(Error::Storage(_)) => Err(Error::NoEntry),
            },
            Err(error) => Err(error),
        },
        Backend::Keychain => match keychain_get(mode, key) {
            Ok(value) => Ok(value),
            Err(Error::NoEntry) => from_vault(),
            Err(error) => Err(error),
        },
    }
}

/// Write into the active backend without touching the other backend's copy.
/// Backend switches use this so the source stays readable until the new vault
/// is committed to disk.
fn write_value_only(mode: &Mode, vault: &mut Vault, key: &str, value: &str) -> Result<(), Error> {
    match vault.backend {
        Backend::EncryptedFile => {
            let sealed = seal(mode, key, value)?;
            vault.entries.insert(key.to_string(), sealed);
        }
        Backend::Keychain => {
            keychain_set(mode, key, value)?;
            vault.entries.insert(key.to_string(), Sealed::default());
        }
    }
    Ok(())
}

fn write_value(mode: &Mode, vault: &mut Vault, key: &str, value: &str) -> Result<(), Error> {
    write_value_only(mode, vault, key, value)?;
    if vault.backend == Backend::EncryptedFile {
        // Best effort: an unreachable OS store must not block local writes.
        let _ = keychain_delete(mode, key);
    }
    Ok(())
}

fn remove_value(mode: &Mode, vault: &mut Vault, key: &str) -> Result<(), Error> {
    let had_local = vault.entries.remove(key).is_some();
    let had_remote = keychain_delete(mode, key).unwrap_or(false);
    if had_local || had_remote { Ok(()) } else { Err(Error::NoEntry) }
}

fn load_vault(mode: &Mode, path: &Path) -> Result<Vault, Error> {
    let data = match std::fs::read(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vault::default()),
        Err(error) => return Err(Error::Storage(format!("Cannot read saved credentials: {error}"))),
    };
    let value: serde_json::Value = serde_json::from_slice(&data)
        .map_err(|_| Error::Storage("Saved credentials file is damaged".into()))?;
    if let Some(version) = value.get("version").and_then(|value| value.as_u64()) {
        if version != VAULT_VERSION as u64 {
            return Err(Error::Storage("Saved credentials use an unsupported format version".into()));
        }
        return serde_json::from_value(value)
            .map_err(|_| Error::Storage("Saved credentials file is invalid".into()));
    }
    // Version 1 was a plain-text service -> account map. Seal every value and
    // replace the file before returning, so plain text is never written again.
    let legacy: BTreeMap<String, BTreeMap<String, String>> = serde_json::from_value(value)
        .map_err(|_| Error::Storage("Saved credentials file is damaged".into()))?;
    let mut vault = Vault::default();
    for (service, accounts) in legacy {
        for (account, secret) in accounts {
            let id = key_id(&service, &account);
            let sealed = seal(mode, &id, &secret)?;
            vault.entries.insert(id, sealed);
        }
    }
    save_vault(path, &vault)?;
    Ok(vault)
}

fn save_vault(path: &Path, vault: &Vault) -> Result<(), Error> {
    let storage = |error: std::io::Error| Error::Storage(format!("Cannot save credentials: {error}"));
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(storage)?; }
    let temporary = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(vault)
        .map_err(|error| Error::Storage(error.to_string()))?;
    std::fs::write(&temporary, data).map_err(storage)?;
    restrict_permissions(&temporary);
    crate::agent::replace_file(&temporary, path).map_err(Error::Storage)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let directory = std::env::temp_dir()
            .join(format!("coffee-credentials-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("credentials.json")
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn encrypted_values_round_trip_and_never_appear_in_plain_text() {
        let path = fixture();
        let service = format!("svc-{}", uuid::Uuid::new_v4());
        let first = Entry::at(path.clone(), &service, "telegram-a");
        let second = Entry::at(path.clone(), &service, "root@example.com");
        assert!(matches!(first.get_password(), Err(Error::NoEntry)));
        assert!(matches!(first.delete_credential(), Err(Error::NoEntry)));
        first.set_password("123:token").unwrap();
        second.set_password("pass word").unwrap();
        assert_eq!(first.get_password().unwrap(), "123:token");
        assert_eq!(second.get_password().unwrap(), "pass word");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("123:token"), "secret leaked into the vault file");
        assert!(!on_disk.contains("pass word"), "secret leaked into the vault file");
        let stored: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(stored["version"], VAULT_VERSION);
        assert_eq!(stored["backend"], "encrypted");
        let entries = stored["entries"].as_object().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.values().all(|entry| entry["ciphertext"].is_string()));
        first.set_password("456:new").unwrap();
        assert_eq!(first.get_password().unwrap(), "456:new");
        assert_eq!(second.get_password().unwrap(), "pass word");
        first.delete_credential().unwrap();
        assert!(matches!(first.get_password(), Err(Error::NoEntry)));
        assert_eq!(second.get_password().unwrap(), "pass word");
        assert!(!path.with_extension("json.tmp").exists());
        cleanup(&path);
    }

    #[test]
    fn legacy_plain_text_is_upgraded_on_first_read() {
        let path = fixture();
        let service = format!("legacy-{}", uuid::Uuid::new_v4());
        std::fs::write(&path, serde_json::to_string(&serde_json::json!({
            (service.clone()): { "telegram": "plain-secret" }
        })).unwrap()).unwrap();
        let entry = Entry::at(path.clone(), &service, "telegram");
        assert_eq!(entry.get_password().unwrap(), "plain-secret");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("plain-secret"), "legacy plain text was not removed");
        assert!(on_disk.contains("\"version\""));
        assert_eq!(entry.get_password().unwrap(), "plain-secret");
        cleanup(&path);
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let path = fixture();
        let service = format!("tamper-{}", uuid::Uuid::new_v4());
        let entry = Entry::at(path.clone(), &service, "token");
        entry.set_password("secret").unwrap();
        let mut stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let id = key_id(&service, "token");
        let sealed = stored["entries"].get_mut(id.as_str()).unwrap();
        let mut bytes = BASE64.decode(sealed["ciphertext"].as_str().unwrap()).unwrap();
        bytes[0] ^= 0x01;
        sealed["ciphertext"] = serde_json::Value::String(BASE64.encode(bytes));
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        assert!(matches!(entry.get_password(), Err(Error::Storage(_))));
        cleanup(&path);
    }

    #[test]
    fn switching_backends_migrates_every_entry_both_ways() {
        let path = fixture();
        let service = format!("switch-{}", uuid::Uuid::new_v4());
        let mode = Mode::Test(path.clone());
        let first = Entry::at(path.clone(), &service, "alpha");
        let second = Entry::at(path.clone(), &service, "beta");
        first.set_password("first-secret").unwrap();
        second.set_password("second-secret").unwrap();

        switch_backend_with(&mode, &path, Backend::Keychain).unwrap();
        assert_eq!(load_vault(&mode, &path).unwrap().backend, Backend::Keychain);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("ciphertext"), "ciphertext survived the switch to the keychain");
        assert_eq!(first.get_password().unwrap(), "first-secret");
        assert_eq!(second.get_password().unwrap(), "second-secret");

        first.set_password("first-changed").unwrap();
        assert_eq!(first.get_password().unwrap(), "first-changed");
        assert_eq!(second.get_password().unwrap(), "second-secret");

        switch_backend_with(&mode, &path, Backend::EncryptedFile).unwrap();
        assert_eq!(load_vault(&mode, &path).unwrap().backend, Backend::EncryptedFile);
        // The keychain copies are cleared only after the vault is committed.
        let prefix = key_id(&service, "");
        assert!(TEST_KEYCHAIN.lock().unwrap().keys().all(|key| !key.starts_with(&prefix)));
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("first-changed"), "secret leaked into the vault file");
        assert_eq!(first.get_password().unwrap(), "first-changed");
        assert_eq!(second.get_password().unwrap(), "second-secret");

        first.delete_credential().unwrap();
        assert!(matches!(first.get_password(), Err(Error::NoEntry)));
        cleanup(&path);
    }

    #[test]
    fn a_migration_keeps_the_source_readable_until_it_is_committed() {
        let path = fixture();
        let service = format!("atomic-{}", uuid::Uuid::new_v4());
        let mode = Mode::Test(path.clone());
        let entry = Entry::at(path.clone(), &service, "token");
        entry.set_password("original").unwrap();
        let mut vault = load_vault(&mode, &path).unwrap();
        let key = key_id(&service, "token");
        // First half of a switch: values are staged in the new backend but the
        // vault file has not been committed yet. The source must still work.
        vault.backend = Backend::Keychain;
        write_value_only(&mode, &mut vault, &key, "original").unwrap();
        let on_disk = load_vault(&mode, &path).unwrap();
        assert_eq!(on_disk.backend, Backend::EncryptedFile);
        assert_eq!(read_value(&mode, &on_disk, &key).unwrap(), "original");
        cleanup(&path);
    }

    #[test]
    fn a_legacy_service_named_version_is_still_migrated() {
        let path = fixture();
        // A v1 file could legitimately use "version" as a service name. The
        // format check must look at the value type, not just the key.
        std::fs::write(&path, r#"{"version":{"token":"legacy-value"}}"#).unwrap();
        let entry = Entry::at(path.clone(), "version", "token");
        assert_eq!(entry.get_password().unwrap(), "legacy-value");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("legacy-value"), "legacy plain text was not removed");
        assert_eq!(entry.get_password().unwrap(), "legacy-value");
        cleanup(&path);
    }

    #[test]
    fn a_missing_vault_directory_is_created_on_first_write() {
        let directory = std::env::temp_dir()
            .join(format!("coffee-credentials-{}", uuid::Uuid::new_v4()));
        let path = directory.join("credentials.json");
        // Deliberately do not create `directory`: every caller of Entry::at
        // must work even when the parent folder does not exist yet.
        let service = format!("newdir-{}", uuid::Uuid::new_v4());
        let entry = Entry::at(path.clone(), &service, "token");
        entry.set_password("value").unwrap();
        assert_eq!(entry.get_password().unwrap(), "value");
        assert!(path.exists());
        cleanup(&path);
    }

    #[test]
    fn damaged_vault_is_reported() {
        let path = fixture();
        let service = format!("damaged-{}", uuid::Uuid::new_v4());
        let entry = Entry::at(path.clone(), &service, "token");
        std::fs::write(&path, "damaged").unwrap();
        assert!(matches!(entry.get_password(), Err(Error::Storage(_))));
        assert!(entry.set_password("value").is_err());
        cleanup(&path);
    }

    #[test]
    fn backend_names_are_stable() {
        assert_eq!(Backend::EncryptedFile.as_str(), "encrypted");
        assert_eq!(Backend::Keychain.as_str(), "keychain");
        assert_eq!(Backend::parse("keychain"), Some(Backend::Keychain));
        assert_eq!(Backend::parse("encrypted"), Some(Backend::EncryptedFile));
        assert_eq!(Backend::parse("unknown"), None);
    }
}
