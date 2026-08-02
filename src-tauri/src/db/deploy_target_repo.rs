use anyhow::Result;
use rusqlite::params;

use super::models::AppDeployTarget;
use super::Database;

const COLS: &str = "id, app_id, host_id, env, created_at";

impl Database {
    /// Set (or replace) the target for one app + environment.
    ///
    /// Upsert on `(app_id, env)` rather than insert: re-pointing production at a
    /// different host is the ordinary edit, and making the caller delete first
    /// would leave a window where the app has no target at all.
    pub fn upsert_deploy_target(&self, t: &AppDeployTarget) -> Result<()> {
        self.conn.execute(
            "INSERT INTO app_deploy_targets (id, app_id, host_id, env, created_at)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(app_id, env) DO UPDATE SET host_id = excluded.host_id",
            params![t.id, t.app_id, t.host_id, t.env, t.created_at],
        )?;
        Ok(())
    }

    pub fn delete_deploy_target(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM app_deploy_targets WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn list_deploy_targets_for_app(&self, app_id: &str) -> Result<Vec<AppDeployTarget>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLS} FROM app_deploy_targets WHERE app_id=?1 ORDER BY env"
        ))?;
        let rows = stmt.query_map(params![app_id], row_to_target)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(anyhow::Error::from)
    }
}

fn row_to_target(row: &rusqlite::Row) -> rusqlite::Result<AppDeployTarget> {
    Ok(AppDeployTarget {
        id: row.get(0)?,
        app_id: row.get(1)?,
        host_id: row.get(2)?,
        env: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{SshAuth, SshHost};

    fn host(id: &str) -> SshHost {
        SshHost {
            id: id.into(),
            label: id.into(),
            group: None,
            hostname: format!("{id}.test"),
            port: 22,
            username: "deploy".into(),
            auth: SshAuth::Agent,
            jump_host_id: None,
            created_at: 0,
            last_used_at: None,
            workspace_ids: vec![],
            detected_os: None,
        }
    }

    fn target(id: &str, host_id: &str, env: &str) -> AppDeployTarget {
        AppDeployTarget {
            id: id.into(),
            app_id: "app-1".into(),
            host_id: host_id.into(),
            env: env.into(),
            created_at: 10,
        }
    }

    fn db() -> Database {
        let db = Database::open(":memory:".into()).unwrap();
        db.conn
            .execute(
                "INSERT INTO apps (id, name, root_dir, port) VALUES ('app-1','web','/tmp/web',3000)",
                [],
            )
            .unwrap();
        db.insert_ssh_host(&host("h1")).unwrap();
        db.insert_ssh_host(&host("h2")).unwrap();
        db
    }

    #[test]
    fn round_trip() {
        let db = db();
        db.upsert_deploy_target(&target("t1", "h1", "production")).unwrap();
        assert_eq!(
            db.list_deploy_targets_for_app("app-1").unwrap(),
            vec![target("t1", "h1", "production")]
        );
        db.delete_deploy_target("t1").unwrap();
        assert!(db.list_deploy_targets_for_app("app-1").unwrap().is_empty());
    }

    #[test]
    fn an_app_can_target_several_environments() {
        // The whole reason `env` is in the key: one app, many hosts.
        let db = db();
        db.upsert_deploy_target(&target("t1", "h1", "production")).unwrap();
        db.upsert_deploy_target(&target("t2", "h2", "staging")).unwrap();
        let envs: Vec<String> = db
            .list_deploy_targets_for_app("app-1")
            .unwrap()
            .into_iter()
            .map(|t| t.env)
            .collect();
        assert_eq!(envs, vec!["production", "staging"]);
    }

    #[test]
    fn re_pointing_an_environment_replaces_it_rather_than_duplicating() {
        let db = db();
        db.upsert_deploy_target(&target("t1", "h1", "production")).unwrap();
        db.upsert_deploy_target(&target("t2", "h2", "production")).unwrap();

        let got = db.list_deploy_targets_for_app("app-1").unwrap();
        assert_eq!(got.len(), 1, "one row per (app, env)");
        assert_eq!(got[0].host_id, "h2", "the newer host wins");
        // The row keeps its original id, so an extension's settings keyed off it
        // survive the host being changed.
        assert_eq!(got[0].id, "t1");
    }

    #[test]
    fn deleting_a_host_takes_the_targets_that_pointed_at_it() {
        // Foreign keys are off process-wide, so this asserts the explicit
        // delete in delete_ssh_host rather than a cascade.
        let db = db();
        db.upsert_deploy_target(&target("t1", "h1", "production")).unwrap();
        db.upsert_deploy_target(&target("t2", "h2", "staging")).unwrap();
        db.delete_ssh_host("h1").unwrap();

        let got = db.list_deploy_targets_for_app("app-1").unwrap();
        assert_eq!(got.len(), 1, "the target pointing at the deleted host is gone");
        assert_eq!(got[0].host_id, "h2");
    }
}
