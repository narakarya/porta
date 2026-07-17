//! SSH engine — connect / auth / shell state machine over `russh`.
//!
//! ## Verified `russh` API (pinned `russh = "0.54"`, resolved 0.54.5)
//!
//! Confirmed against the crate source in the registry cache before writing:
//!
//! - `russh::client::connect<H: Handler + Send + 'static, A: ToSocketAddrs>(
//!        Arc<Config>, A, H) -> Result<Handle<H>, H::Error>`
//! - `russh::client::Config: Default`
//! - `trait russh::client::Handler` (native async-fn-in-trait):
//!     `fn check_server_key(&mut self, &russh::keys::ssh_key::PublicKey)
//!          -> impl Future<Output = Result<bool, Self::Error>> + Send`
//!     `type Error: From<russh::Error> + Send + Debug` (we use `russh::Error`).
//! - `russh::keys::ssh_key::PublicKey::to_bytes() -> Result<Vec<u8>>`  (SSH wire
//!    blob; SHA-256 over it == OpenSSH fingerprint, matching `fingerprint_sha256`)
//!   and `.algorithm() -> russh::keys::Algorithm` (Display => "ssh-ed25519", ...).
//! - `russh::keys::load_secret_key(path, Option<&str>) -> Result<PrivateKey, keys::Error>`;
//!    encrypted keys yield `russh::keys::Error::KeyIsEncrypted`.
//! - `russh::keys::PrivateKeyWithHashAlg::new(Arc<PrivateKey>, Option<HashAlg>)`.
//! - `russh::keys::agent::client::AgentClient::connect_env() -> Result<Self, Error>`
//!    and `.request_identities() -> Result<Vec<PublicKey>, Error>`; `AgentClient<R>`
//!    implements `russh::auth::Signer`.
//! - `Handle::authenticate_password(user, pw) -> Result<AuthResult, russh::Error>`
//! - `Handle::authenticate_publickey(user, PrivateKeyWithHashAlg) -> Result<AuthResult, _>`
//! - `Handle::authenticate_publickey_with(user, ssh_key::PublicKey, Option<HashAlg>,
//!        &mut Signer) -> Result<AuthResult, Signer::Error>`  (agent auth)
//! - `russh::client::AuthResult::success() -> bool`
//! - `Handle::channel_open_session() -> Result<Channel<Msg>, russh::Error>`
//! - `Channel::request_pty(want_reply, term, cols, rows, pw, ph, &[(Pty,u32)])`,
//!    `request_shell(want_reply)`, `data<R: AsyncRead + Unpin>(R)`,
//!    `window_change(cols, rows, pw, ph)`, `eof()`, `wait() -> Option<ChannelMsg>`
//! - `russh::ChannelMsg::{Data { data: CryptoVec }, Eof, Close, ExitStatus{..}, ..}`
//!
//! ### Adaptations from the brief's representative code
//! 1. Auth calls return `russh::client::AuthResult` (not `bool`); we branch on
//!    `AuthResult::success()`.
//! 2. Public-key auth takes `PrivateKeyWithHashAlg` (wraps `Arc<PrivateKey>`),
//!    not a bare key; agent auth goes through `authenticate_publickey_with` +
//!    the `Signer` impl on `AgentClient`.
//! 3. The trust gate lives in `connect()`, not the handler. `check_server_key`
//!    cannot await the frontend, so `CaptureHandler` only records the presented
//!    key's fingerprint/type and accepts; `connect()` runs the verdict/trust
//!    logic afterwards (as the brief's own note recommends).
//! 4. The `Handle` is MOVED INTO the read/write pump task and kept alive there:
//!    the russh client run-loop exits the moment its last control sender drops,
//!    so dropping `handle` at the end of `connect()` (as the sketch did) would
//!    tear the session down. Keeping it in the task ties its lifetime to the shell.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::db::models::{SshAuth, SshHost, SshKnownHost};
use crate::db::{Database, HostKeyVerdict};
use crate::ssh::keychain::SecretStore;

use russh::keys::PrivateKeyWithHashAlg;

/// The ordered list of auth methods to try for a host, most-preferred first.
/// Agent is always tried first when available; the host's configured method
/// is appended so an explicit choice still runs even if agent auth is offered.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthAttempt {
    Agent,
    KeyFile(String),
    Password,
}

pub fn auth_plan(auth: &SshAuth, agent_available: bool) -> Vec<AuthAttempt> {
    let mut plan = Vec::new();
    if agent_available {
        plan.push(AuthAttempt::Agent);
    }
    match auth {
        SshAuth::Agent => {}
        SshAuth::KeyFile { path } => plan.push(AuthAttempt::KeyFile(path.clone())),
        SshAuth::Password => plan.push(AuthAttempt::Password),
    }
    plan
}

/// Commands sent from the manager to a live session's read/write pump.
enum ChannelCmd {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// Per-session control the command layer resolves prompts through.
struct Session {
    /// Send keystrokes / resizes / close to the channel pump.
    input: mpsc::UnboundedSender<ChannelCmd>,
    /// Pending trust decision (`Some` while a trust-request is outstanding).
    trust_tx: Option<oneshot::Sender<bool>>,
    /// Pending secret entry (`Some` while a need-secret is outstanding).
    secret_tx: Option<oneshot::Sender<(String, bool)>>,
}

/// Owns the live-session registry and the secret store. Cloned into commands.
#[derive(Clone)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    secrets: Arc<dyn SecretStore>,
}

/// A `russh` client handler that records the presented server key so the
/// trust gate can run in `connect()`. It accepts every key at the transport
/// layer; the real verdict/trust decision happens afterwards against the DB.
struct CaptureHandler {
    captured: Arc<std::sync::Mutex<Option<(String, String)>>>,
}

impl russh::client::Handler for CaptureHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let bytes = server_public_key.to_bytes().unwrap_or_default();
        let fingerprint = crate::db::fingerprint_sha256(&bytes);
        let key_type = server_public_key.algorithm().to_string();
        *self.captured.lock().unwrap() = Some((fingerprint, key_type));
        Ok(true)
    }
}

impl SshManager {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            secrets,
        }
    }

    fn emit(app: &AppHandle, id: &str, suffix: &str, payload: serde_json::Value) {
        let _ = app.emit(&format!("ssh:{suffix}:{id}"), payload);
    }

    /// Resolve an outstanding `ssh:trust-request` (called by the command layer).
    pub async fn trust(&self, session_id: &str) -> Result<(), String> {
        let tx = {
            self.sessions
                .lock()
                .await
                .get_mut(session_id)
                .and_then(|s| s.trust_tx.take())
        };
        tx.ok_or_else(|| "no pending trust request".to_string())?
            .send(true)
            .map_err(|_| "trust receiver gone".to_string())
    }

    /// Resolve an outstanding `ssh:need-secret` (called by the command layer).
    pub async fn provide_secret(
        &self,
        session_id: &str,
        value: String,
        remember: bool,
    ) -> Result<(), String> {
        let tx = {
            self.sessions
                .lock()
                .await
                .get_mut(session_id)
                .and_then(|s| s.secret_tx.take())
        };
        tx.ok_or_else(|| "no pending secret request".to_string())?
            .send((value, remember))
            .map_err(|_| "secret receiver gone".to_string())
    }

    /// Queue bytes to be written to the remote shell.
    pub async fn write(&self, session_id: &str, data: Vec<u8>) {
        if let Some(s) = self.sessions.lock().await.get(session_id) {
            let _ = s.input.send(ChannelCmd::Data(data));
        }
    }

    /// Resize the remote PTY.
    pub async fn resize(&self, session_id: &str, rows: u16, cols: u16) {
        if let Some(s) = self.sessions.lock().await.get(session_id) {
            let _ = s.input.send(ChannelCmd::Resize(rows, cols));
        }
    }

    /// Close a session, tearing down its pump (and the SSH transport with it).
    pub async fn close(&self, session_id: &str) {
        if let Some(s) = self.sessions.lock().await.remove(session_id) {
            let _ = s.input.send(ChannelCmd::Close);
        }
    }

    /// Park a `secret_tx` for `session_id`, emit `ssh:need-secret`, and await
    /// the value + remember flag the command layer feeds back.
    async fn prompt_secret(
        &self,
        app: &AppHandle,
        session_id: &str,
        kind: &str,
    ) -> Result<(String, bool), String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.sessions.lock().await;
            map.entry(session_id.to_string())
                .or_insert_with(placeholder_session)
                .secret_tx = Some(tx);
        }
        Self::emit(app, session_id, "need-secret", serde_json::json!({ "kind": kind }));
        rx.await.map_err(|_| "secret request cancelled".to_string())
    }

    async fn try_password_auth(
        &self,
        app: &AppHandle,
        session_id: &str,
        handle: &mut russh::client::Handle<CaptureHandler>,
        host: &SshHost,
    ) -> Result<bool, String> {
        // Try a remembered password before prompting.
        if let Some(pw) = self.secrets.get(&host.id)? {
            let r = handle
                .authenticate_password(&host.username, pw)
                .await
                .map_err(|e| e.to_string())?;
            if r.success() {
                return Ok(true);
            }
        }
        let (value, remember) = self.prompt_secret(app, session_id, "password").await?;
        let r = handle
            .authenticate_password(&host.username, value.clone())
            .await
            .map_err(|e| e.to_string())?;
        if r.success() {
            if remember {
                let _ = self.secrets.set(&host.id, &value);
            }
            return Ok(true);
        }
        Ok(false)
    }

    async fn try_key_auth(
        &self,
        app: &AppHandle,
        session_id: &str,
        handle: &mut russh::client::Handle<CaptureHandler>,
        host: &SshHost,
        path: &str,
    ) -> Result<bool, String> {
        let expanded = expand_tilde(path);
        let key = match russh::keys::load_secret_key(&expanded, None) {
            Ok(k) => k,
            Err(russh::keys::Error::KeyIsEncrypted) => {
                return self
                    .try_encrypted_key_auth(app, session_id, handle, host, &expanded)
                    .await;
            }
            Err(e) => return Err(format!("load key {}: {e}", expanded.display())),
        };
        let pk = PrivateKeyWithHashAlg::new(Arc::new(key), None);
        let r = handle
            .authenticate_publickey(&host.username, pk)
            .await
            .map_err(|e| e.to_string())?;
        Ok(r.success())
    }

    async fn try_encrypted_key_auth(
        &self,
        app: &AppHandle,
        session_id: &str,
        handle: &mut russh::client::Handle<CaptureHandler>,
        host: &SshHost,
        path: &Path,
    ) -> Result<bool, String> {
        // Try a remembered passphrase before prompting.
        if let Some(pass) = self.secrets.get(&host.id)? {
            if let Ok(key) = russh::keys::load_secret_key(path, Some(&pass)) {
                let pk = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                let r = handle
                    .authenticate_publickey(&host.username, pk)
                    .await
                    .map_err(|e| e.to_string())?;
                if r.success() {
                    return Ok(true);
                }
            }
        }
        let (value, remember) = self.prompt_secret(app, session_id, "passphrase").await?;
        let key = russh::keys::load_secret_key(path, Some(&value))
            .map_err(|e| format!("decrypt key: {e}"))?;
        let pk = PrivateKeyWithHashAlg::new(Arc::new(key), None);
        let r = handle
            .authenticate_publickey(&host.username, pk)
            .await
            .map_err(|e| e.to_string())?;
        if r.success() {
            if remember {
                let _ = self.secrets.set(&host.id, &value);
            }
            return Ok(true);
        }
        Ok(false)
    }

    /// Connect, run the host-key + auth gates, open a shell, and spawn the pump.
    pub async fn connect(
        &self,
        app: AppHandle,
        session_id: String,
        host: SshHost,
        db: Arc<std::sync::Mutex<Database>>,
    ) -> Result<(), String> {
        Self::emit(&app, &session_id, "status", serde_json::json!({ "phase": "connecting" }));

        // 1. TCP + SSH handshake with a handler that records the server key.
        let config = Arc::new(russh::client::Config::default());
        let captured = Arc::new(std::sync::Mutex::new(None::<(String, String)>));
        let handler = CaptureHandler {
            captured: captured.clone(),
        };
        let mut handle = russh::client::connect(
            config,
            (host.hostname.as_str(), host.port),
            handler,
        )
        .await
        .map_err(|e| {
            Self::emit(&app, &session_id, "status", serde_json::json!({ "phase": "error" }));
            format!("connect: {e}")
        })?;

        // 2. Host-key gate. Extract owned values so no DB guard crosses an await.
        let (fingerprint, key_type) = captured
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "server presented no host key".to_string())?;

        let verdict = {
            db.lock()
                .unwrap()
                .verify_host_key(&host.hostname, host.port, &fingerprint)
                .map_err(|e| e.to_string())?
        };
        match verdict {
            HostKeyVerdict::Trusted => {}
            HostKeyVerdict::Mismatch => {
                Self::emit(
                    &app,
                    &session_id,
                    "host-key-changed",
                    serde_json::json!({ "fingerprint": fingerprint }),
                );
                return Err("host key changed".into());
            }
            HostKeyVerdict::Unknown => {
                let (tx, rx) = oneshot::channel();
                {
                    let mut map = self.sessions.lock().await;
                    map.entry(session_id.clone())
                        .or_insert_with(placeholder_session)
                        .trust_tx = Some(tx);
                }
                Self::emit(
                    &app,
                    &session_id,
                    "trust-request",
                    serde_json::json!({
                        "fingerprint": fingerprint,
                        "hostname": host.hostname,
                        "key_type": key_type,
                    }),
                );
                let ok = rx.await.map_err(|_| "trust request cancelled".to_string())?;
                if !ok {
                    return Err("host key not trusted".into());
                }
                {
                    db.lock()
                        .unwrap()
                        .trust_known_host(&SshKnownHost {
                            host: host.hostname.clone(),
                            port: host.port,
                            fingerprint: fingerprint.clone(),
                            key_type: key_type.clone(),
                            added_at: now_epoch(),
                        })
                        .map_err(|e| e.to_string())?;
                }
            }
        }

        // 3. Authenticate per auth_plan() ordering.
        Self::emit(
            &app,
            &session_id,
            "status",
            serde_json::json!({ "phase": "authenticating" }),
        );
        let agent_available = std::env::var_os("SSH_AUTH_SOCK").is_some();
        let mut authed = false;
        for attempt in auth_plan(&host.auth, agent_available) {
            let ok = match attempt {
                AuthAttempt::Agent => try_agent_auth(&mut handle, &host.username).await,
                AuthAttempt::KeyFile(path) => {
                    self.try_key_auth(&app, &session_id, &mut handle, &host, &path)
                        .await?
                }
                AuthAttempt::Password => {
                    self.try_password_auth(&app, &session_id, &mut handle, &host)
                        .await?
                }
            };
            if ok {
                authed = true;
                break;
            }
        }
        if !authed {
            Self::emit(
                &app,
                &session_id,
                "auth-failed",
                serde_json::json!({ "message": "all authentication methods failed" }),
            );
            return Err("authentication failed".into());
        }

        // 4. Open channel, request a PTY + shell.
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| e.to_string())?;

        // 5. Register the live session (replacing any placeholder from prompts).
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<ChannelCmd>();
        {
            let mut map = self.sessions.lock().await;
            map.insert(
                session_id.clone(),
                Session {
                    input: input_tx,
                    trust_tx: None,
                    secret_tx: None,
                },
            );
        }
        {
            let _ = db.lock().unwrap().touch_ssh_host(&host.id, now_epoch());
        }
        Self::emit(
            &app,
            &session_id,
            "status",
            serde_json::json!({ "phase": "connected", "keyType": key_type }),
        );

        // 6. Spawn the read/write pump. The `Handle` is moved in and kept alive
        //    for the session's lifetime (dropping it would close the transport).
        let app2 = app.clone();
        let sid2 = session_id.clone();
        let sessions2 = self.sessions.clone();
        tokio::spawn(async move {
            let _handle = handle;
            loop {
                tokio::select! {
                    msg = channel.wait() => match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            Self::emit(&app2, &sid2, "data", serde_json::json!(data.to_vec()));
                        }
                        Some(russh::ChannelMsg::Eof)
                        | Some(russh::ChannelMsg::Close)
                        | None => break,
                        _ => {}
                    },
                    cmd = input_rx.recv() => match cmd {
                        Some(ChannelCmd::Data(bytes)) => {
                            let _ = channel.data(&bytes[..]).await;
                        }
                        Some(ChannelCmd::Resize(rows, cols)) => {
                            let _ = channel
                                .window_change(cols as u32, rows as u32, 0, 0)
                                .await;
                        }
                        Some(ChannelCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
            sessions2.lock().await.remove(&sid2);
            Self::emit(&app2, &sid2, "exit", serde_json::json!(null));
        });

        Ok(())
    }
}

/// Try every identity offered by the SSH agent. Returns `true` on first success.
async fn try_agent_auth(
    handle: &mut russh::client::Handle<CaptureHandler>,
    username: &str,
) -> bool {
    let mut agent = match russh::keys::agent::client::AgentClient::connect_env().await {
        Ok(a) => a,
        Err(_) => return false,
    };
    let identities = match agent.request_identities().await {
        Ok(ids) => ids,
        Err(_) => return false,
    };
    for id in identities {
        if let Ok(r) = handle
            .authenticate_publickey_with(username, id, None, &mut agent)
            .await
        {
            if r.success() {
                return true;
            }
        }
    }
    false
}

/// A placeholder session entry used only to park a `trust_tx`/`secret_tx`
/// before the live channel exists. Its input receiver is dropped immediately,
/// so any stray write is a no-op; `connect()` overwrites it on success.
fn placeholder_session() -> Session {
    Session {
        input: dummy_sender(),
        trust_tx: None,
        secret_tx: None,
    }
}

/// An mpsc sender whose receiver is dropped — see [`placeholder_session`].
fn dummy_sender() -> mpsc::UnboundedSender<ChannelCmd> {
    let (tx, _rx) = mpsc::unbounded_channel();
    tx
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn now_epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::SshAuth;

    #[test]
    fn plan_prefers_agent_then_configured() {
        assert_eq!(
            auth_plan(&SshAuth::Password, true),
            vec![AuthAttempt::Agent, AuthAttempt::Password]
        );
        assert_eq!(auth_plan(&SshAuth::Password, false), vec![AuthAttempt::Password]);
        assert_eq!(
            auth_plan(&SshAuth::KeyFile { path: "k".into() }, false),
            vec![AuthAttempt::KeyFile("k".into())]
        );
        assert_eq!(auth_plan(&SshAuth::Agent, true), vec![AuthAttempt::Agent]);
        assert_eq!(auth_plan(&SshAuth::Agent, false), Vec::<AuthAttempt>::new());
    }

    /// Manual smoke seam — NOT run by `cargo test` (needs a local sshd + a
    /// loaded ssh-agent). Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml connect_to_localhost -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires local sshd on 127.0.0.1:22 + a loaded ssh-agent"]
    async fn connect_to_localhost() {
        let config = Arc::new(russh::client::Config::default());
        let captured = Arc::new(std::sync::Mutex::new(None));
        let handler = CaptureHandler {
            captured: captured.clone(),
        };
        let mut handle = russh::client::connect(config, ("127.0.0.1", 22), handler)
            .await
            .expect("tcp/ssh handshake");
        let user = std::env::var("USER").unwrap_or_else(|_| "root".into());
        assert!(
            try_agent_auth(&mut handle, &user).await,
            "agent authentication failed"
        );

        let mut channel = handle.channel_open_session().await.expect("open session");
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .expect("request pty");
        channel.request_shell(true).await.expect("request shell");
        channel
            .data(&b"echo porta-ok\n"[..])
            .await
            .expect("write");

        let mut seen = Vec::new();
        while let Some(msg) = channel.wait().await {
            if let russh::ChannelMsg::Data { data } = msg {
                seen.extend_from_slice(&data);
                if String::from_utf8_lossy(&seen).contains("porta-ok") {
                    return;
                }
            }
        }
        panic!("never saw porta-ok in shell output");
    }
}
