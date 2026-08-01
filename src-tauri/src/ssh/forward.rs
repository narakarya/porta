//! Local port forwarding (`ssh -L`).
//!
//! A forward is a `TcpListener` on loopback plus, per accepted connection, a
//! `direct-tcpip` channel to the far side and a bidirectional copy between the
//! two. Everything lives inside one listener task so a single `abort()` — from
//! the user, from the session ending, or from app quit — releases the socket
//! and kills whatever is still in flight.
//!
//! Runtime state is never persisted. A forward's listener cannot outlive the
//! process, so a stored "running" would be a lie after every crash; the UI is
//! fed entirely by `ssh:forward:{id}` events.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::task::JoinSet;

use crate::db::models::{SshForwardKind, SshPortForward};
use crate::ssh::engine::Transport;
use crate::sync::LockExt;

/// Live connections allowed per forward before new ones are refused.
///
/// Not arbitrary: russh's default per-channel window is 2 MiB with a 100-slot
/// message buffer, so an unbounded forward under load can push RSS into the
/// hundreds of MB. Refusing past the cap keeps a runaway client from taking the
/// app down with it.
const MAX_CONNS: usize = 64;

/// Minimum gap between connection-count events. A port scan or a client that
/// opens a connection per query would otherwise flood the WebView with one
/// event per socket.
const REPORT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Reject a rule before anything binds. Pure, so the whole matrix is testable
/// without a socket or an SSH session.
pub(crate) fn validate(f: &SshPortForward) -> Result<(), String> {
    if f.kind != SshForwardKind::Local {
        return Err(
            "Only local forwards are supported right now. Remote (-R) and dynamic (-D) \
             forwards aren't implemented yet."
                .into(),
        );
    }
    // Loopback-only for now. A wildcard bind would expose the remote network to
    // anything on the same wifi, which is not a thing to enable by accident.
    if f.bind_address != "127.0.0.1" {
        return Err(format!(
            "Local forwards can only bind 127.0.0.1 right now (got \"{}\").",
            f.bind_address
        ));
    }
    // macOS refuses <1024 for non-root with EACCES, which surfaces as a bare
    // "os error 13" — name it here instead.
    if f.local_port > 0 && f.local_port < 1024 {
        return Err(format!(
            "Local port {} is privileged; macOS won't let Porta bind below 1024. Use 1024 or \
             higher, or 0 to let the system pick.",
            f.local_port
        ));
    }
    if f.remote_host.trim().is_empty() {
        return Err("Pick a remote host for the forward to reach.".into());
    }
    if f.remote_port == 0 {
        return Err("Pick a remote port for the forward to reach.".into());
    }
    Ok(())
}

/// Bind the local listener for `f`.
///
/// Binds `Ipv4Addr::LOCALHOST` rather than the string `"localhost"` on purpose:
/// on dual-stack macOS getaddrinfo returns `::1` first, so a name-based bind
/// yields an IPv6-only listener and `psql -h 127.0.0.1` gets ECONNREFUSED
/// against a forward the UI is happily calling "listening".
///
/// There is no pre-flight port check. `check_port_available` probes only
/// loopback, fails open when `lsof` is missing, and would be a TOCTOU race
/// anyway — the bind itself is the atomic test. `lsof` is consulted only after
/// an `AddrInUse`, to name the process holding it.
async fn bind_listener(f: &SshPortForward) -> Result<TcpListener, String> {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, f.local_port)).await {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            let who = crate::commands::who_uses_port(f.local_port);
            Err(match who {
                Some(h) => format!(
                    "Port {} is already in use by {} (pid {}).",
                    f.local_port, h.process_name, h.pid
                ),
                None => format!("Port {} is already in use.", f.local_port),
            })
        }
        Err(e) => Err(format!("Couldn't bind 127.0.0.1:{}: {e}", f.local_port)),
    }
}

/// Runtime state pushed on `ssh:forward:{id}`.
fn emit(app: &AppHandle, id: &str, payload: serde_json::Value) {
    let _ = app.emit(&format!("ssh:forward:{id}"), payload);
}

/// Terminal event for a forward the manager tore down.
///
/// Aborting the listener task cannot emit anything itself (an aborted future is
/// simply dropped), so whoever does the aborting owns this event. That also
/// means there is no stale-terminal-event race to suppress: the only event the
/// task emits on its own is an accept failure, which ends it for good.
pub(crate) fn emit_stopped(app: &AppHandle, id: &str, error: Option<String>) {
    emit(
        app,
        id,
        serde_json::json!({
            "state": if error.is_some() { "failed" } else { "stopped" },
            "local_port": 0,
            "active_conns": 0,
            "capped": false,
            "error": error,
        }),
    );
}

fn listening_payload(
    local_port: u16,
    active: usize,
    capped: bool,
    error: Option<String>,
) -> serde_json::Value {
    serde_json::json!({
        "state": "listening",
        "local_port": local_port,
        "active_conns": active,
        "capped": capped,
        "error": error,
    })
}

/// One connection's slot against [`MAX_CONNS`], released on drop.
///
/// Drop rather than an explicit decrement at the end of the task: the task can
/// end at a failed dial, at the end of the copy, or by being aborted mid-copy
/// when the forward is torn down, and only `Drop` covers all three. A leaked
/// slot is permanent — the cap would ratchet down until the forward refused
/// every connection.
struct ConnSlot(Arc<AtomicUsize>);

impl Drop for ConnSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Take a slot if one is free. Atomic test-and-increment, not load-then-add:
/// the accept loop can be several connections ahead of the dials completing.
fn reserve(active: &Arc<AtomicUsize>) -> Option<ConnSlot> {
    active
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            (n < MAX_CONNS).then_some(n + 1)
        })
        .ok()
        .map(|_| ConnSlot(active.clone()))
}

/// Start `f` over `transport`. Returns the actually-bound local port (which
/// differs from `f.local_port` when that is 0) and the listener task.
///
/// The bind happens here, before the task is spawned, so a port conflict is a
/// synchronous error the caller can return to the UI rather than an event that
/// arrives after the row has already rendered as starting.
pub(crate) async fn spawn_local_forward(
    app: AppHandle,
    f: SshPortForward,
    transport: Arc<Transport>,
) -> Result<(u16, tokio::task::JoinHandle<()>), String> {
    validate(&f)?;
    let listener = bind_listener(&f).await?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("resolve bound port: {e}"))?
        .port();

    let id = f.id.clone();
    let report = move |payload: serde_json::Value| emit(&app, &id, payload);

    let handle = tokio::spawn(run_forward(
        report,
        f,
        local_port,
        listener,
        move |host, port| {
            let transport = transport.clone();
            async move { transport.open_direct_tcpip(&host, port).await.map(|c| c.into_stream()) }
        },
    ));

    Ok((local_port, handle))
}

/// The accept loop, generic over how it reaches the far side *and* over where
/// state is reported.
///
/// Neither Tauri nor russh appears here on purpose: the whole lifecycle — the
/// cap, the reaping, what an aborted task releases — is then testable with a
/// plain TCP echo server and a `Vec` sink, which is the only way to cover it
/// without a live sshd.
async fn run_forward<R, D, Fut, S>(
    report: R,
    f: SshPortForward,
    local_port: u16,
    listener: TcpListener,
    dial: D,
) where
    R: Fn(serde_json::Value) + Send + Sync + 'static,
    D: Fn(String, u16) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<S, String>> + Send,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let report = Arc::new(report);
    let dial = Arc::new(dial);
    let active = Arc::new(AtomicUsize::new(0));
    // Last per-connection failure, kept sticky. The count heartbeat below
    // re-sends the whole payload, so an error carried on a one-off event would
    // be wiped within 250ms — which is exactly the message ("the server refused
    // to forward to …") the user needs in order to fix anything.
    let last_error: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
    // Per-connection tasks live here, and a `JoinSet` aborts everything it owns
    // when dropped. That is what makes a single `abort()` on this task enough to
    // tear the whole forward down — no cancellation tokens to thread through.
    let mut conns: JoinSet<()> = JoinSet::new();

    report(listening_payload(local_port, 0, false, None));

    // Coalesced count reporter, owned by the same JoinSet so it dies with the
    // forward. Emitting straight from the accept path would put one event per
    // socket on the WebView bus.
    {
        let (report2, active2, err2) = (report.clone(), active.clone(), last_error.clone());
        conns.spawn(async move {
            let mut last = usize::MAX;
            loop {
                tokio::time::sleep(REPORT_INTERVAL).await;
                let now = active2.load(Ordering::Relaxed);
                if now != last {
                    last = now;
                    let err = err2.lock_or_recover().clone();
                    report2(listening_payload(local_port, now, false, err));
                }
            }
        });
    }

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let sock = match accepted {
                    Ok((sock, _peer)) => sock,
                    // The listener itself failed — not a per-connection problem.
                    // Report and stop; leaving a dead loop spinning on an error
                    // would peg a core.
                    Err(e) => {
                        report(serde_json::json!({
                            "state": "failed",
                            "local_port": local_port,
                            "active_conns": active.load(Ordering::Relaxed),
                            "capped": false,
                            "error": format!("Stopped accepting on :{local_port}: {e}"),
                        }));
                        return;
                    }
                };

                // Reserve BEFORE dialling. The dial is a full channel-open
                // round-trip to the server (up to 10s against a black-holed
                // target), so counting only established connections would let
                // an unbounded number pile up inside that window — the exact
                // case the cap exists for.
                let Some(slot) = reserve(&active) else {
                    // Drop the socket: the client sees a closed connection,
                    // which is a far better signal than being accepted into a
                    // queue that never drains.
                    drop(sock);
                    report(listening_payload(local_port, MAX_CONNS, true, None));
                    continue;
                };

                let (host, port) = (f.remote_host.clone(), f.remote_port);
                let (dial2, active2, report2) = (dial.clone(), active.clone(), report.clone());
                let err2 = last_error.clone();
                conns.spawn(async move {
                    // Held for the connection's whole life; releases the slot
                    // on every exit path, including an abort mid-copy.
                    let _slot = slot;
                    let mut far = match dial2(host, port).await {
                        Ok(s) => s,
                        Err(e) => {
                            // One connection failing must not take the listener
                            // down — the target may just be restarting.
                            *err2.lock_or_recover() = Some(e.clone());
                            report2(serde_json::json!({
                                "state": "listening",
                                "local_port": local_port,
                                "active_conns": active2.load(Ordering::Relaxed),
                                "capped": false,
                                "error": e,
                            }));
                            return;
                        }
                    };
                    // A dial that works clears the last failure — otherwise the
                    // row would keep showing a stale error from a target that
                    // has since come back.
                    *err2.lock_or_recover() = None;
                    let mut sock = sock;
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut far).await;
                });
            }
            // Reap finished connections so the JoinSet doesn't grow for the
            // life of the forward. Disabled while the set is empty.
            Some(_) = conns.join_next() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    fn local(port: u16) -> SshPortForward {
        SshPortForward {
            id: "f1".into(),
            host_id: "h1".into(),
            kind: SshForwardKind::Local,
            label: None,
            bind_address: "127.0.0.1".into(),
            local_port: port,
            remote_host: "127.0.0.1".into(),
            remote_port: 5432,
            auto_start: false,
            created_at: 0,
        }
    }

    #[test]
    fn validate_accepts_a_sane_local_rule() {
        assert!(validate(&local(15432)).is_ok());
        // 0 means "kernel picks" and must stay allowed.
        assert!(validate(&local(0)).is_ok());
    }

    #[test]
    fn validate_rejects_unimplemented_kinds() {
        for kind in [SshForwardKind::Remote, SshForwardKind::Dynamic] {
            let mut f = local(15432);
            f.kind = kind;
            let err = validate(&f).unwrap_err();
            assert!(err.contains("aren't implemented"), "got: {err}");
        }
    }

    #[test]
    fn validate_rejects_non_loopback_bind() {
        let mut f = local(15432);
        f.bind_address = "0.0.0.0".into();
        assert!(validate(&f).unwrap_err().contains("127.0.0.1"));
    }

    #[test]
    fn validate_names_the_privileged_port_rule() {
        let mut f = local(80);
        f.local_port = 80;
        let err = validate(&f).unwrap_err();
        assert!(err.contains("privileged"), "got: {err}");
        assert!(!err.contains("os error"), "must not leak the raw errno");
    }

    #[test]
    fn validate_rejects_empty_target() {
        let mut f = local(15432);
        f.remote_host = "  ".into();
        assert!(validate(&f).is_err());

        let mut f = local(15432);
        f.remote_port = 0;
        assert!(validate(&f).is_err());
    }

    #[tokio::test]
    async fn bind_reports_the_kernel_picked_port_for_zero() {
        let l = bind_listener(&local(0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        assert_ne!(port, 0, "a bound listener must resolve to a real port");
    }

    #[tokio::test]
    async fn bind_is_ipv4_loopback_not_localhost() {
        // Regression guard: binding the *name* "localhost" yields an IPv6-only
        // listener on dual-stack macOS, and every client dialling 127.0.0.1
        // then gets ECONNREFUSED against a forward the UI calls healthy.
        let l = bind_listener(&local(0)).await.unwrap();
        let addr = l.local_addr().unwrap();
        assert!(addr.is_ipv4(), "expected IPv4 loopback, got {addr}");
        assert_eq!(addr.ip().to_string(), "127.0.0.1");
    }

    #[tokio::test]
    async fn bind_conflict_is_a_clear_error() {
        let held = bind_listener(&local(0)).await.unwrap();
        let port = held.local_addr().unwrap().port();
        let err = bind_listener(&local(port)).await.unwrap_err();
        assert!(err.contains("already in use"), "got: {err}");
    }

    /// A local echo server standing in for the far side of the SSH channel.
    async fn echo_server() -> u16 {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = sock.read(&mut buf).await {
                        if n == 0 || sock.write_all(&buf[..n]).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        port
    }

    type Events = Arc<std::sync::Mutex<Vec<serde_json::Value>>>;

    /// Start `run_forward` against a dialer, returning (bound port, task,
    /// captured events).
    async fn start<D, Fut, S>(dial: D) -> (u16, tokio::task::JoinHandle<()>, Events)
    where
        D: Fn(String, u16) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<S, String>> + Send + 'static,
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let listener = bind_listener(&local(0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let events: Events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let task = tokio::spawn(run_forward(
            move |p| sink.lock().unwrap().push(p),
            local(0),
            port,
            listener,
            dial,
        ));
        (port, task, events)
    }

    #[tokio::test]
    async fn copies_bytes_end_to_end() {
        let far = echo_server().await;
        let (port, task, _events) = start(move |_h, _p| async move {
            TcpStream::connect((Ipv4Addr::LOCALHOST, far))
                .await
                .map_err(|e| e.to_string())
        })
        .await;

        let mut c = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        c.write_all(b"porta-forward").await.unwrap();
        let mut buf = [0u8; 13];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"porta-forward");
        task.abort();
    }

    #[tokio::test]
    async fn a_failed_dial_drops_one_connection_but_keeps_listening() {
        let far = echo_server().await;
        // Fail the first dial, succeed afterwards — the listener must survive
        // the failure, which is the whole point (a restarting target should not
        // kill the forward).
        let n = Arc::new(AtomicUsize::new(0));
        let (port, task, _events) = start(move |_h, _p| {
            let n = n.clone();
            async move {
                if n.fetch_add(1, Ordering::Relaxed) == 0 {
                    return Err("connection refused".into());
                }
                TcpStream::connect((Ipv4Addr::LOCALHOST, far))
                    .await
                    .map_err(|e| e.to_string())
            }
        })
        .await;

        // First connection: dial fails, our socket gets closed.
        let mut dead = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        let mut sink = Vec::new();
        let _ = dead.read_to_end(&mut sink).await;

        // Second connection still works.
        let mut ok = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        ok.write_all(b"alive").await.unwrap();
        let mut buf = [0u8; 5];
        ok.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"alive");
        task.abort();
    }

    #[tokio::test]
    async fn the_cap_counts_dials_still_in_flight() {
        // The bug this locks: the slot used to be taken only after the dial
        // resolved, so against a slow or black-holed target every connection
        // sailed past the cap — unbounded tasks and unbounded server-side
        // channels, which is precisely what the cap exists to prevent.
        let gate = Arc::new(tokio::sync::Notify::new());
        let dialing = Arc::new(AtomicUsize::new(0));
        let (d2, g2) = (dialing.clone(), gate.clone());

        let (port, task, _events) = start(move |_h, _p| {
            let (d, g) = (d2.clone(), g2.clone());
            async move {
                d.fetch_add(1, Ordering::Relaxed);
                // Park here: every one of these is an in-flight dial.
                g.notified().await;
                Err::<tokio::net::TcpStream, String>("never resolves".into())
            }
        })
        .await;

        let mut held = Vec::new();
        for _ in 0..MAX_CONNS + 8 {
            if let Ok(s) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
                held.push(s);
            }
        }
        // Let the parked dials register.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let started = dialing.load(Ordering::Relaxed);
        assert!(
            started <= MAX_CONNS,
            "{started} dials in flight — the cap must apply before the dial, not after it"
        );

        gate.notify_waiters();
        task.abort();
    }

    #[tokio::test]
    async fn a_failed_dial_gives_its_slot_back() {
        // The slot is released by ConnSlot::drop. A plain decrement at the end
        // of the happy path would leak one slot per failed dial, ratcheting the
        // cap down to zero on a target that is simply down.
        let far = echo_server().await;
        let n = Arc::new(AtomicUsize::new(0));
        let (port, task, _events) = start(move |_h, _p| {
            let n = n.clone();
            async move {
                // Fail far more times than the cap allows.
                if n.fetch_add(1, Ordering::Relaxed) < MAX_CONNS * 2 {
                    return Err("connection refused".into());
                }
                TcpStream::connect((Ipv4Addr::LOCALHOST, far))
                    .await
                    .map_err(|e| e.to_string())
            }
        })
        .await;

        for _ in 0..MAX_CONNS * 2 {
            if let Ok(mut s) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
                let mut sink = Vec::new();
                let _ = s.read_to_end(&mut sink).await;
            }
        }

        // Capacity must still be there for a connection that can succeed.
        let mut ok = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        ok.write_all(b"back").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(std::time::Duration::from_secs(5), ok.read_exact(&mut buf))
            .await
            .expect("cap leaked: no slots left after failed dials")
            .unwrap();
        assert_eq!(&buf, b"back");
        task.abort();
    }

    #[tokio::test]
    async fn abort_releases_the_port_and_kills_live_connections() {
        let far = echo_server().await;
        let (port, task, _events) = start(move |_h, _p| async move {
            TcpStream::connect((Ipv4Addr::LOCALHOST, far))
                .await
                .map_err(|e| e.to_string())
        })
        .await;

        let mut live = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        live.write_all(b"x").await.unwrap();
        let mut one = [0u8; 1];
        live.read_exact(&mut one).await.unwrap();

        task.abort();
        let _ = task.await;
        // Give the runtime a moment to drop the JoinSet and close the socket.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // The port is free again — this is what "disconnect releases the
        // forward" means in practice.
        TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .expect("port should be released after abort");

        // And the connection that was in flight is gone, not orphaned onto a
        // dead tunnel where it would hang forever.
        let mut rest = Vec::new();
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            live.read_to_end(&mut rest),
        )
        .await;
        assert!(read.is_ok(), "live connection should have been torn down");
    }
}
