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

use crate::sync::LockExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::db::models::{SshAuth, SshHost, SshKnownHost, SshPortForward};
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

/// How many `ProxyJump` hops we will follow before giving up. OpenSSH has no
/// hard limit, but a chain this deep is far more likely to be a misconfigured
/// loop than a real topology — and each hop costs a full handshake.
const MAX_JUMPS: usize = 8;

/// Returned when a forward is already listening — including on a *different*
/// session to the same host. Never surfaced as a per-forward error event: the
/// forward it names is healthy, and painting its row red would be a lie.
const ALREADY_RUNNING: &str = "That forward is already running.";

/// Shared client config for every hop.
///
/// `keepalive_interval` is the reason this exists: with russh's default
/// (`None`) a laptop that sleeps or roams between networks leaves a session
/// that looks alive — the pump never sees `Eof`, keystrokes vanish into a dead
/// socket, and the row keeps its green dot. Pinging every 30s with a 3-strike
/// budget turns that into a real `exit` event within ~90s, which the retry path
/// in the store can then act on.
fn client_config() -> Arc<russh::client::Config> {
    Arc::new(russh::client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    })
}

/// Resolve `host`'s ProxyJump chain into connect order: outermost bastion
/// first, `host` itself last. A chain that loops or runs past [`MAX_JUMPS`] is
/// an error rather than a hang — `jump_host_id` is user-editable and nothing
/// stops A→B→A.
fn resolve_chain(
    host: &SshHost,
    db: &Arc<std::sync::Mutex<Database>>,
) -> Result<Vec<SshHost>, String> {
    let mut chain = vec![host.clone()];
    let mut seen = std::collections::HashSet::from([host.id.clone()]);
    let mut next = host.jump_host_id.clone();

    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return Err(format!(
                "Jump host chain for \"{}\" loops back on itself. Fix the Jump host field on one \
                 of the hosts in the loop.",
                host.label
            ));
        }
        if chain.len() > MAX_JUMPS {
            return Err(format!(
                "Jump host chain for \"{}\" is more than {MAX_JUMPS} hops deep.",
                host.label
            ));
        }
        let jump = db
            .lock_or_recover()
            .get_ssh_host(&id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!(
                    "Jump host for \"{}\" no longer exists — it was deleted from the vault. Edit \
                     the host and pick another, or clear the Jump host field.",
                    chain.last().map(|h| h.label.as_str()).unwrap_or(&host.label)
                )
            })?;
        next = jump.jump_host_id.clone();
        chain.push(jump);
    }

    chain.reverse();
    Ok(chain)
}

/// Commands sent from the manager to a live session's read/write pump.
enum ChannelCmd {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// The live SSH transport behind one session, held behind an `Arc` so port
/// forwards can open their own channels without the shell pump owning it
/// exclusively.
///
/// Keeping these handles alive is load-bearing, not bookkeeping: dropping a
/// russh `Handle` drops the last `Sender<Msg>`, the run loop exits, and the
/// transport dies. That applies to the jump hops too — a forward on a
/// ProxyJump'd host is riding the bastion's transport, so if the pump owned
/// those and the shell exited, the forward would die with no event to explain
/// it.
pub(crate) struct Transport {
    target: russh::client::Handle<CaptureHandler>,
    /// Jump hops the target rides on. Never used directly — held to keep the
    /// tunnel underneath alive.
    _jumps: Vec<russh::client::Handle<CaptureHandler>>,
}

impl Transport {
    /// Open a `direct-tcpip` channel to `host:port` on the far side.
    ///
    /// The only way anything reaches the inner `Handle` — which keeps the field
    /// private, so the day remote forwards (`-R`) need `&mut` access this
    /// becomes one signature change rather than a rewrite of every caller.
    ///
    /// Time-boxed because `channel_open_direct_tcpip` has none of its own: a
    /// black-holed target would otherwise park forever, leaking one task and
    /// one server-side channel per connection attempt.
    pub(crate) async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
    ) -> Result<russh::Channel<russh::client::Msg>, String> {
        let open = self
            .target
            .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0);
        match tokio::time::timeout(std::time::Duration::from_secs(10), open).await {
            Err(_) => Err(format!("{host}:{port} did not answer within 10s")),
            // The server refuses opens for reasons the user can act on, but
            // russh renders them all as one Display string. Name the common
            // administrative case — it means sshd config, not a dead service.
            Ok(Err(russh::Error::ChannelOpenFailure(reason))) => Err(match reason {
                russh::ChannelOpenFailure::AdministrativelyProhibited => format!(
                    "The server refused to forward to {host}:{port}. Check AllowTcpForwarding \
                     and PermitOpen in its sshd config."
                ),
                russh::ChannelOpenFailure::ConnectFailed => {
                    format!("The server couldn't reach {host}:{port}.")
                }
                other => format!("The server refused to forward to {host}:{port} ({other:?})."),
            }),
            Ok(Err(e)) => Err(format!("open {host}:{port}: {e}")),
            Ok(Ok(ch)) => Ok(ch),
        }
    }
}

/// Per-session control the command layer resolves prompts through.
struct Session {
    /// Send keystrokes / resizes / close to the channel pump.
    input: mpsc::UnboundedSender<ChannelCmd>,
    /// Pending trust decision (`Some` while a trust-request is outstanding).
    trust_tx: Option<oneshot::Sender<bool>>,
    /// Pending secret entry (`Some` while a need-secret is outstanding).
    secret_tx: Option<oneshot::Sender<(String, bool)>>,
    /// `None` on a placeholder entry parked for a prompt — the transport only
    /// exists once `connect()` has authenticated. Starting a forward against a
    /// placeholder is a real error, not a panic.
    transport: Option<Arc<Transport>>,
}

/// A forward's listener task plus the session whose transport it rides on.
/// Aborting the task releases the local socket and, because the per-connection
/// tasks live in a `JoinSet` owned by that task's future, kills everything in
/// flight.
struct RunningForward {
    session_id: String,
    task: tokio::task::JoinHandle<()>,
}

/// Owns the live-session registry and the secret store. Cloned into commands.
#[derive(Clone)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// Running forwards keyed by FORWARD id — deliberately global rather than a
    /// field on `Session`.
    ///
    /// A forward rule belongs to a host and has exactly one UI row and one
    /// `ssh:forward:{id}` event channel, but a host can have several sessions
    /// open at once. With a per-session map the duplicate guard couldn't see
    /// the other session's copy, so opening a second tab to the same host
    /// bound every auto-start forward a second time (on a different ephemeral
    /// port, invisible to the UI), and Stop only ever killed one of them.
    forwards: Arc<Mutex<HashMap<String, RunningForward>>>,
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
        *self.captured.lock_or_recover() = Some((fingerprint, key_type));
        Ok(true)
    }
}

impl SshManager {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            forwards: Arc::new(Mutex::new(HashMap::new())),
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
        self.abort_session_forwards(session_id).await;
        if let Some(s) = self.sessions.lock().await.remove(session_id) {
            let _ = s.input.send(ChannelCmd::Close);
        }
    }

    /// Abort every forward riding on one session's transport. Returns the ids,
    /// so the caller can tell the UI they are gone — an aborted task cannot
    /// emit its own terminal event.
    pub async fn abort_session_forwards(&self, session_id: &str) -> Vec<String> {
        let mut map = self.forwards.lock().await;
        let doomed: Vec<String> = map
            .iter()
            .filter(|(_, r)| r.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &doomed {
            if let Some(r) = map.remove(id) {
                r.task.abort();
            }
        }
        doomed
    }

    /// Start `forward` on a live session. Returns the actually-bound local port
    /// (which differs from the rule's when that is 0).
    pub async fn start_forward(
        &self,
        app: AppHandle,
        session_id: &str,
        forward: SshPortForward,
    ) -> Result<u16, String> {
        let transport = {
            let map = self.sessions.lock().await;
            let sess = map
                .get(session_id)
                .ok_or("That session isn't connected any more.")?;
            sess.transport
                .clone()
                .ok_or("That session hasn't finished connecting yet.")?
        };
        // Global check: the rule is already listening somewhere, possibly on
        // another session to the same host.
        if self.forwards.lock().await.contains_key(&forward.id) {
            return Err(ALREADY_RUNNING.into());
        }

        // The locks are released across the bind + spawn on purpose — binding
        // can block on `lsof` when the port is taken, and holding either map
        // through that would stall every other session's keystrokes.
        let (port, task) =
            crate::ssh::forward::spawn_local_forward(app, forward.clone(), transport).await?;

        // Re-check both facts that could have changed while the bind was in
        // flight: the session may have ended (the listener would then accept
        // into a dead tunnel), and a concurrent start may have won the race.
        let session_gone = !self.sessions.lock().await.contains_key(session_id);
        let mut running = self.forwards.lock().await;
        if session_gone || running.contains_key(&forward.id) {
            task.abort();
            return Err(if session_gone {
                "The session closed while the forward was starting.".into()
            } else {
                ALREADY_RUNNING.to_string()
            });
        }
        running.insert(
            forward.id,
            RunningForward {
                session_id: session_id.to_string(),
                task,
            },
        );
        Ok(port)
    }

    /// Stop one forward by id. Aborting the listener task releases the local
    /// socket and kills every connection still running through it.
    ///
    /// Keyed by forward id alone: the caller (a row in the sidebar) knows which
    /// rule it is stopping, but not which of the host's sessions happens to own
    /// it, and guessing wrong used to return "that forward isn't running" while
    /// the port stayed bound.
    pub async fn stop_forward(&self, app: &AppHandle, forward_id: &str) -> Result<(), String> {
        let running = self.forwards.lock().await.remove(forward_id);
        running.ok_or("That forward isn't running.")?.task.abort();
        crate::ssh::forward::emit_stopped(app, forward_id, None);
        Ok(())
    }

    /// Like [`Self::stop_forward`] but silent when it wasn't running — for the
    /// edit/delete paths, where stopping is a side effect rather than the ask.
    pub async fn stop_forward_if_running(&self, app: &AppHandle, forward_id: &str) {
        let _ = self.stop_forward(app, forward_id).await;
    }

    /// Ids of the forwards currently running on a session, so the UI can
    /// reconcile after a window reload without waiting for the next event.
    pub async fn running_forwards(&self, session_id: &str) -> Vec<String> {
        self.forwards
            .lock()
            .await
            .iter()
            .filter(|(_, r)| r.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Abort every forward. Called on app quit: a listener that survives the
    /// process is exactly the "port already in use" ghost that is miserable to
    /// diagnose later.
    pub async fn stop_all_forwards(&self) {
        for (_, r) in self.forwards.lock().await.drain() {
            r.task.abort();
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

    /// Run the host-key gate and the auth ladder against one hop's transport.
    /// Returns the hop's server key type (the target's feeds the `connected`
    /// payload). `hop` names the host being gated when the session is going
    /// through a jump chain, so the overlay can say *which* box is prompting.
    #[allow(clippy::too_many_arguments)]
    async fn gate_and_auth(
        &self,
        app: &AppHandle,
        session_id: &str,
        handle: &mut russh::client::Handle<CaptureHandler>,
        host: &SshHost,
        db: &Arc<std::sync::Mutex<Database>>,
        captured: &Arc<std::sync::Mutex<Option<(String, String)>>>,
        hop: Option<&str>,
    ) -> Result<String, String> {
        // Host-key gate. Extract owned values so no DB guard crosses an await.
        // The frontend renders one step per phase, so every gate that can block
        // (host key, auth, shell) announces itself before it starts — otherwise a
        // host parked on the trust prompt looks identical to a stalled handshake.
        Self::emit(app, session_id, "status", phase("verifying", hop));
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
                    app,
                    session_id,
                    "host-key-changed",
                    serde_json::json!({ "fingerprint": fingerprint, "hostname": host.hostname }),
                );
                return Err(format!("host key changed for {}", host.hostname));
            }
            HostKeyVerdict::Unknown => {
                let (tx, rx) = oneshot::channel();
                {
                    let mut map = self.sessions.lock().await;
                    map.entry(session_id.to_string())
                        .or_insert_with(placeholder_session)
                        .trust_tx = Some(tx);
                }
                Self::emit(
                    app,
                    session_id,
                    "trust-request",
                    serde_json::json!({
                        "fingerprint": fingerprint,
                        "hostname": host.hostname,
                        "key_type": key_type,
                        "hop": hop,
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

        // Authenticate per auth_plan() ordering.
        Self::emit(app, session_id, "status", phase("authenticating", hop));
        let agent_available = std::env::var_os("SSH_AUTH_SOCK").is_some();
        let plan = auth_plan(&host.auth, agent_available);
        // `auth_plan(Agent, false)` is empty by design — but running zero
        // attempts and reporting "all authentication methods failed" hid the
        // real cause (no agent) behind a generic auth error.
        if plan.is_empty() {
            let msg = "SSH agent auth is selected but no agent is available (SSH_AUTH_SOCK is \
                       unset). Load a key with `ssh-add`, or switch this host to a key file or \
                       password.";
            Self::emit(
                app,
                session_id,
                "auth-failed",
                serde_json::json!({ "message": msg, "hop": hop }),
            );
            return Err(msg.into());
        }
        let tried = plan
            .iter()
            .map(|a| match a {
                AuthAttempt::Agent => "agent".to_string(),
                AuthAttempt::KeyFile(p) => format!("key file {p}"),
                AuthAttempt::Password => "password".to_string(),
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut authed = false;
        for attempt in plan {
            let ok = match attempt {
                AuthAttempt::Agent => try_agent_auth(handle, &host.username).await,
                AuthAttempt::KeyFile(path) => {
                    self.try_key_auth(app, session_id, handle, host, &path).await?
                }
                AuthAttempt::Password => {
                    self.try_password_auth(app, session_id, handle, host).await?
                }
            };
            if ok {
                authed = true;
                break;
            }
        }
        if !authed {
            // Name the user and the methods tried — the server rejects the
            // username as readily as the credential, and a bare "auth failed"
            // gives no way to tell those apart.
            let msg = format!(
                "Authentication failed for user \"{}\"{} (tried: {tried}). Check the username and \
                 that the server accepts this credential.",
                host.username,
                hop.map(|h| format!(" on {h}")).unwrap_or_default()
            );
            Self::emit(
                app,
                session_id,
                "auth-failed",
                serde_json::json!({ "message": msg, "hop": hop }),
            );
            return Err(msg);
        }

        Ok(key_type)
    }

    /// Build the transport for `host`, hopping through its `ProxyJump` chain.
    ///
    /// Returns the authenticated handle for `host`, the handles of every
    /// intermediate hop, and the target's server key type. The intermediate
    /// handles are not optional bookkeeping: each one owns the transport the
    /// *next* hop's tunnel rides on, so dropping one collapses the chain. The
    /// caller parks them in the pump task for the session's lifetime.
    async fn open_transport(
        &self,
        app: &AppHandle,
        session_id: &str,
        host: &SshHost,
        db: &Arc<std::sync::Mutex<Database>>,
    ) -> Result<
        (
            russh::client::Handle<CaptureHandler>,
            Vec<russh::client::Handle<CaptureHandler>>,
            String,
        ),
        String,
    > {
        let chain = resolve_chain(host, db)?;
        let direct = chain.len() == 1;
        let mut hops: Vec<russh::client::Handle<CaptureHandler>> = Vec::new();
        let mut key_type = String::new();

        for node in &chain {
            // Only name the hop when there is more than one — a plain host
            // shouldn't gain "on prod-web" noise in every status line.
            let hop = (!direct).then_some(node.label.as_str());
            Self::emit(app, session_id, "status", phase("connecting", hop));

            let captured = Arc::new(std::sync::Mutex::new(None::<(String, String)>));
            let handler = CaptureHandler {
                captured: captured.clone(),
            };
            let mut handle = match hops.last() {
                // Tunnel this hop's TCP connection through the previous hop's
                // transport — `direct-tcpip` is what OpenSSH's ProxyJump uses.
                // The originator fields are advisory; sshd logs them and
                // otherwise ignores them.
                Some(prev) => {
                    let channel = prev
                        .channel_open_direct_tcpip(
                            node.hostname.clone(),
                            node.port as u32,
                            "127.0.0.1",
                            0,
                        )
                        .await
                        .map_err(|e| {
                            Self::emit(app, session_id, "status", phase("error", hop));
                            format!(
                                "open tunnel to {}:{} through the jump host: {e}",
                                node.hostname, node.port
                            )
                        })?;
                    russh::client::connect_stream(
                        client_config(),
                        channel.into_stream(),
                        handler,
                    )
                    .await
                    .map_err(|e| {
                        Self::emit(app, session_id, "status", phase("error", hop));
                        format!("connect {} through the jump host: {e}", node.label)
                    })?
                }
                None => russh::client::connect(
                    client_config(),
                    (node.hostname.as_str(), node.port),
                    handler,
                )
                .await
                .map_err(|e| {
                    Self::emit(app, session_id, "status", phase("error", hop));
                    format!("connect: {e}")
                })?,
            };

            key_type = self
                .gate_and_auth(app, session_id, &mut handle, node, db, &captured, hop)
                .await?;
            hops.push(handle);
        }

        // `resolve_chain` always ends with the target itself, so this is total.
        let target = hops.pop().ok_or("empty jump chain")?;
        Ok((target, hops, key_type))
    }

    /// Connect, run the host-key + auth gates, open a shell, and spawn the pump.
    pub async fn connect(
        &self,
        app: AppHandle,
        session_id: String,
        host: SshHost,
        db: Arc<std::sync::Mutex<Database>>,
    ) -> Result<(), String> {
        // 1-3. Transport + host-key gate + auth, once per hop in the chain.
        let (handle, jumps, key_type) = self
            .open_transport(&app, &session_id, &host, &db)
            .await?;

        // 4. Open channel, request a PTY + shell.
        Self::emit(
            &app,
            &session_id,
            "status",
            serde_json::json!({ "phase": "opening-shell" }),
        );
        let transport = Arc::new(Transport {
            target: handle,
            _jumps: jumps,
        });
        let mut channel = transport
            .target
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
                    transport: Some(transport.clone()),
                },
            );
        }
        {
            let _ = db.lock_or_recover().touch_ssh_host(&host.id, now_epoch());
        }
        Self::emit(
            &app,
            &session_id,
            "status",
            serde_json::json!({ "phase": "connected", "keyType": key_type }),
        );

        // 5b. Best-effort remote OS detection (Termius-style badge). Non-fatal and
        //     time-boxed so a slow/quiet host never holds up the shell.
        {
            let probe = detect_remote_os(&transport.target);
            if let Ok(Ok(os)) = tokio::time::timeout(std::time::Duration::from_secs(4), probe).await {
                let os = os.trim().to_string();
                if !os.is_empty() {
                    let _ = db.lock_or_recover().set_detected_os(&host.id, &os);
                    Self::emit(&app, &session_id, "host-os", serde_json::json!({ "os": os }));
                }
            }
        }

        // 5c. Open the host's auto-start forwards. Failures are per-forward and
        //     never fail the session — a port conflict on a saved forward must
        //     not cost the user their shell.
        {
            let saved = db
                .lock_or_recover()
                .list_ssh_forwards_for_host(&host.id)
                .unwrap_or_default();
            for f in saved.into_iter().filter(|f| f.auto_start) {
                let id = f.id.clone();
                match self.start_forward(app.clone(), &session_id, f).await {
                    Ok(_) => {}
                    // A second session to the same host re-runs this loop. The
                    // rule is already listening on the first one, so this is
                    // nothing to report — emitting on the shared per-forward
                    // channel would repaint a healthy row as failed.
                    Err(e) if e == ALREADY_RUNNING => {}
                    Err(e) => crate::ssh::forward::emit_stopped(&app, &id, Some(e)),
                }
            }
        }

        // 6. Spawn the read/write pump. It holds an `Arc<Transport>` purely as
        //    keep-alive — the registry entry holds the other one, so the SSH
        //    connection lives exactly as long as the session does.
        let app2 = app.clone();
        let sid2 = session_id.clone();
        let sessions2 = self.sessions.clone();
        let manager2 = self.clone();
        tokio::spawn(async move {
            let _keepalive = transport;
            loop {
                tokio::select! {
                    msg = channel.wait() => match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            // base64 string, not a JSON int-array: ~1/4 the payload
                            // size and far cheaper to serialize/parse per chunk.
                            use base64::Engine as _;
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                            Self::emit(&app2, &sid2, "data", serde_json::json!(b64));
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
            // Forwards die with the shell they ride on. A listener left running
            // would keep accepting into a dead tunnel — the worst possible
            // diagnostic, since the client connects and then hangs forever
            // instead of failing. Their rows are told explicitly: an aborted
            // task can't emit its own terminal event.
            for id in manager2.abort_session_forwards(&sid2).await {
                crate::ssh::forward::emit_stopped(&app2, &id, None);
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

/// Build a `ssh:status` payload. `hop` is the label of the host the phase
/// applies to, present only while walking a jump chain — the overlay uses it to
/// distinguish "authenticating on the bastion" from "authenticating on the box
/// you actually asked for".
fn phase(name: &str, hop: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "phase": name, "hop": hop })
}

/// A placeholder session entry used only to park a `trust_tx`/`secret_tx`
/// before the live channel exists. Its input receiver is dropped immediately,
/// so any stray write is a no-op; `connect()` overwrites it on success.
fn placeholder_session() -> Session {
    Session {
        input: dummy_sender(),
        trust_tx: None,
        secret_tx: None,
        transport: None,
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

/// Probe the remote OS over a throwaway exec channel. Returns the distro
/// PRETTY_NAME (Linux) or `uname -sr` (macOS/BSD/other). Best-effort.
async fn detect_remote_os(
    handle: &russh::client::Handle<CaptureHandler>,
) -> Result<String, String> {
    let mut ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(
        true,
        "sh -c '. /etc/os-release 2>/dev/null && printf %s \"$PRETTY_NAME\" || uname -sr'",
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string())
}

fn now_epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::SshAuth;

    fn host(id: &str, jump: Option<&str>) -> SshHost {
        SshHost {
            id: id.into(),
            label: id.into(),
            group: None,
            hostname: format!("{id}.test"),
            port: 22,
            username: "u".into(),
            auth: SshAuth::Agent,
            jump_host_id: jump.map(str::to_string),
            created_at: 0,
            last_used_at: None,
            workspace_ids: vec![],
            detected_os: None,
        }
    }

    /// An in-memory DB seeded with `hosts`, wrapped the way `connect()` gets it.
    fn db_with(hosts: &[SshHost]) -> Arc<std::sync::Mutex<Database>> {
        let db = Database::open(":memory:".into()).unwrap();
        for h in hosts {
            db.insert_ssh_host(h).unwrap();
        }
        Arc::new(std::sync::Mutex::new(db))
    }

    #[test]
    fn chain_is_outermost_first() {
        // target -> mid -> edge, so dialling order must be edge, mid, target.
        let target = host("target", Some("mid"));
        let db = db_with(&[host("edge", None), host("mid", Some("edge")), target.clone()]);
        let chain = resolve_chain(&target, &db).unwrap();
        let ids: Vec<&str> = chain.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, vec!["edge", "mid", "target"]);
    }

    #[test]
    fn direct_host_is_a_one_element_chain() {
        let h = host("solo", None);
        let db = db_with(&[h.clone()]);
        assert_eq!(resolve_chain(&h, &db).unwrap().len(), 1);
    }

    #[test]
    fn chain_loop_is_rejected_not_hung() {
        // a -> b -> a. Both rows are user-editable, so this is reachable via the
        // form; without the cycle guard resolve_chain would never terminate.
        let a = host("a", Some("b"));
        let db = db_with(&[a.clone(), host("b", Some("a"))]);
        let err = resolve_chain(&a, &db).unwrap_err();
        assert!(err.contains("loops"), "unexpected error: {err}");
    }

    #[test]
    fn self_jump_is_rejected() {
        let a = host("a", Some("a"));
        let db = db_with(&[a.clone()]);
        assert!(resolve_chain(&a, &db).is_err());
    }

    #[test]
    fn deleted_jump_host_names_the_problem() {
        let a = host("a", Some("ghost"));
        let db = db_with(&[a.clone()]);
        let err = resolve_chain(&a, &db).unwrap_err();
        assert!(err.contains("no longer exists"), "unexpected error: {err}");
    }

    #[test]
    fn chain_deeper_than_the_cap_is_rejected() {
        // A straight line longer than MAX_JUMPS — no cycle, so only the depth
        // guard can stop it.
        let mut hosts = vec![host("h0", None)];
        for i in 1..=MAX_JUMPS + 2 {
            hosts.push(host(&format!("h{i}"), Some(&format!("h{}", i - 1))));
        }
        let target = hosts.last().unwrap().clone();
        let db = db_with(&hosts);
        let err = resolve_chain(&target, &db).unwrap_err();
        assert!(err.contains("hops deep"), "unexpected error: {err}");
    }

    #[test]
    fn keepalive_is_configured() {
        // The whole point of client_config(): russh defaults this to None, which
        // leaves a slept-laptop session looking alive forever.
        let c = client_config();
        assert_eq!(c.keepalive_interval, Some(std::time::Duration::from_secs(30)));
        assert!(c.keepalive_max > 0);
    }

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
