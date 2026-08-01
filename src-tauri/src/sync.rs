//! Poison-tolerant mutex locking.
//!
//! The release profile sets `panic = "abort"`, so a panic anywhere is already
//! fatal — but a panic in a *debug* build, or any panic caught before abort,
//! leaves every `Mutex` that thread held permanently poisoned. With plain
//! `.lock().unwrap()` the next reader of that mutex panics too, and the whole
//! app dies instead of one feature failing.
//!
//! None of Porta's mutexes guard an invariant that spans more than one
//! statement — they hold `HashMap`s of process handles, sets of running app
//! ids, the SQLite connection. Recovering the guard from a poisoned lock hands
//! back data that is at worst slightly stale, which beats taking the process
//! down with it. `PoisonError::into_inner` is exactly that recovery.

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// Lock, recovering the guard if a previous holder panicked.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn locks_an_uncontended_mutex() {
        let m = Mutex::new(5);
        assert_eq!(*m.lock_or_recover(), 5);
    }

    #[test]
    fn recovers_after_a_holder_panicked() {
        let m = Arc::new(Mutex::new(vec![1, 2, 3]));
        let m2 = Arc::clone(&m);

        // Poison the mutex: panic while holding the guard.
        let _ = std::thread::spawn(move || {
            let mut guard = m2.lock().unwrap();
            guard.push(4);
            panic!("boom");
        })
        .join();

        assert!(m.lock().is_err(), "expected the mutex to be poisoned");
        // The plain `.lock().unwrap()` above would panic here; we recover the
        // data the panicking thread had already written.
        assert_eq!(*m.lock_or_recover(), vec![1, 2, 3, 4]);
    }

    #[test]
    fn stays_usable_for_writes_after_poisoning() {
        let m = Arc::new(Mutex::new(0u32));
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("boom");
        })
        .join();

        *m.lock_or_recover() += 1;
        assert_eq!(*m.lock_or_recover(), 1);
    }
}
