//! Down-detection for running apps.
//!
//! `check_all_health` already probes every running app and instance on a
//! schedule, but the result only ever painted a badge — nothing told you when
//! an app you were relying on stopped answering. The existing crash
//! notification only fires when the *process* exits; an app that is still
//! running but wedged (deadlocked, OOM-thrashing, stuck on a migration) is
//! exactly the case nobody was being told about.
//!
//! A single failed probe is not news — a 2s HTTP timeout trips on a slow
//! request, and an app restarting is briefly unreachable by design. So a down
//! alert needs N consecutive failures before it fires, and it fires once per
//! outage, not once per probe.
//!
//! The state machine is pure and lives here so the debouncing can be tested
//! without a notification permission, a network, or a running app.

use std::collections::{HashMap, HashSet};

use crate::health::HealthStatus;

pub const DEFAULT_THRESHOLD: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertEvent {
    /// Crossed the consecutive-failure threshold. Fires once per outage.
    Down { id: String, failures: u32 },
    /// Answered again after having been reported down.
    Recovered { id: String },
}

#[derive(Debug, Default)]
pub struct HealthAlerts {
    /// Consecutive failed probes per id, reset by any healthy probe.
    streaks: HashMap<String, u32>,
    /// Ids currently reported down, so we alert once per outage rather than
    /// once per probe round.
    down: HashSet<String>,
}

impl HealthAlerts {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one probe round — every id probed, with its status — and get back
    /// the transitions worth telling the user about.
    ///
    /// Ids missing from `round` were not probed at all (the app was stopped,
    /// deleted, or is mid-restart). They are forgotten rather than alerted on:
    /// a deliberate stop is not an outage, and keeping the id around would fire
    /// a spurious "recovered" the next time it starts.
    pub fn observe(&mut self, round: &[(String, HealthStatus)], threshold: u32) -> Vec<AlertEvent> {
        let threshold = threshold.max(1);
        let seen: HashSet<&str> = round.iter().map(|(id, _)| id.as_str()).collect();
        self.streaks.retain(|id, _| seen.contains(id.as_str()));
        self.down.retain(|id| seen.contains(id.as_str()));

        let mut events = Vec::new();
        for (id, status) in round {
            match status {
                HealthStatus::Unhealthy => {
                    let streak = self.streaks.entry(id.clone()).or_insert(0);
                    *streak += 1;
                    if *streak >= threshold && self.down.insert(id.clone()) {
                        events.push(AlertEvent::Down {
                            id: id.clone(),
                            failures: *streak,
                        });
                    }
                }
                HealthStatus::Healthy => {
                    self.streaks.remove(id);
                    if self.down.remove(id) {
                        events.push(AlertEvent::Recovered { id: id.clone() });
                    }
                }
                // `Unknown` means the probe itself could not run — we learned
                // nothing about the app. Treating it as a failure would alert
                // on our own transport problems, and treating it as healthy
                // would paper over a real outage, so it carries the streak
                // forward untouched.
                HealthStatus::Unknown => {}
            }
        }
        events
    }

    /// Whether an id is currently in the alerted-down state.
    pub fn is_down(&self, id: &str) -> bool {
        self.down.contains(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(entries: &[(&str, HealthStatus)]) -> Vec<(String, HealthStatus)> {
        entries
            .iter()
            .map(|(id, s)| (id.to_string(), s.clone()))
            .collect()
    }

    #[test]
    fn one_failure_is_not_an_alert() {
        let mut a = HealthAlerts::new();
        let ev = a.observe(&round(&[("app", HealthStatus::Unhealthy)]), 3);
        assert!(ev.is_empty(), "a single blip must stay quiet");
        assert!(!a.is_down("app"));
    }

    #[test]
    fn fires_once_the_streak_reaches_the_threshold() {
        let mut a = HealthAlerts::new();
        let r = round(&[("app", HealthStatus::Unhealthy)]);
        assert!(a.observe(&r, 3).is_empty());
        assert!(a.observe(&r, 3).is_empty());
        assert_eq!(
            a.observe(&r, 3),
            vec![AlertEvent::Down { id: "app".into(), failures: 3 }]
        );
        assert!(a.is_down("app"));
    }

    #[test]
    fn does_not_re_alert_while_it_stays_down() {
        let mut a = HealthAlerts::new();
        let r = round(&[("app", HealthStatus::Unhealthy)]);
        for _ in 0..3 {
            a.observe(&r, 3);
        }
        // Ten more failing rounds must not produce ten more notifications.
        for _ in 0..10 {
            assert!(a.observe(&r, 3).is_empty(), "one alert per outage");
        }
    }

    #[test]
    fn recovery_fires_only_if_it_had_alerted() {
        let mut a = HealthAlerts::new();
        let bad = round(&[("app", HealthStatus::Unhealthy)]);
        let good = round(&[("app", HealthStatus::Healthy)]);

        // Two failures then a recovery — never crossed the threshold, so the
        // user was never told it was down and must not be told it came back.
        a.observe(&bad, 3);
        a.observe(&bad, 3);
        assert!(a.observe(&good, 3).is_empty());

        for _ in 0..3 {
            a.observe(&bad, 3);
        }
        assert_eq!(a.observe(&good, 3), vec![AlertEvent::Recovered { id: "app".into() }]);
        assert!(!a.is_down("app"));
    }

    #[test]
    fn a_healthy_probe_resets_the_streak() {
        let mut a = HealthAlerts::new();
        let bad = round(&[("app", HealthStatus::Unhealthy)]);
        let good = round(&[("app", HealthStatus::Healthy)]);

        a.observe(&bad, 3);
        a.observe(&bad, 3);
        a.observe(&good, 3);
        // Streak restarted from zero: two more failures is still not three.
        a.observe(&bad, 3);
        assert!(a.observe(&bad, 3).is_empty());
        assert_eq!(
            a.observe(&bad, 3),
            vec![AlertEvent::Down { id: "app".into(), failures: 3 }]
        );
    }

    #[test]
    fn unknown_neither_advances_nor_resets_the_streak() {
        let mut a = HealthAlerts::new();
        let bad = round(&[("app", HealthStatus::Unhealthy)]);
        let unknown = round(&[("app", HealthStatus::Unknown)]);

        a.observe(&bad, 3);
        a.observe(&bad, 3);
        assert!(a.observe(&unknown, 3).is_empty(), "unknown alone can't trip it");
        assert_eq!(
            a.observe(&bad, 3),
            vec![AlertEvent::Down { id: "app".into(), failures: 3 }],
            "the streak survived the unknown round"
        );
    }

    #[test]
    fn stopping_an_app_clears_its_state_without_alerting() {
        let mut a = HealthAlerts::new();
        let bad = round(&[("app", HealthStatus::Unhealthy)]);
        for _ in 0..3 {
            a.observe(&bad, 3);
        }
        assert!(a.is_down("app"));

        // The user stops the app: it drops out of the probe set entirely.
        assert!(a.observe(&round(&[]), 3).is_empty(), "a deliberate stop is not a recovery");
        assert!(!a.is_down("app"));

        // Starting it again begins from a clean streak.
        assert!(a.observe(&bad, 3).is_empty());
    }

    #[test]
    fn tracks_each_app_independently() {
        let mut a = HealthAlerts::new();
        let r = round(&[("up", HealthStatus::Healthy), ("down", HealthStatus::Unhealthy)]);
        a.observe(&r, 2);
        assert_eq!(
            a.observe(&r, 2),
            vec![AlertEvent::Down { id: "down".into(), failures: 2 }]
        );
        assert!(!a.is_down("up"));
    }

    #[test]
    fn threshold_of_zero_is_clamped_to_one() {
        // A 0 out of a malformed settings file would otherwise alert on an
        // empty streak before any probe had failed.
        let mut a = HealthAlerts::new();
        assert_eq!(
            a.observe(&round(&[("app", HealthStatus::Unhealthy)]), 0),
            vec![AlertEvent::Down { id: "app".into(), failures: 1 }]
        );
    }
}
