async function exists(runShell, path) {
  const r = await runShell(`test -f '${path}'`);
  return r.code === 0;
}

// runShell(cmd) → {code}. Returns the resolved config path or null.
export async function detectConfigPath(runShell, rootDir, override) {
  if (override && (await exists(runShell, override))) return override;
  const candidates = [`${rootDir}/config/deploy.yml`, `${rootDir}/deploy.yml`];
  for (const c of candidates) {
    if (await exists(runShell, c)) return c;
  }
  return null;
}
