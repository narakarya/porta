import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask, message } from "@tauri-apps/plugin-dialog";

/**
 * Check GitHub Releases for a newer version. If one exists, prompt the user;
 * on confirm, download + install the signed update and relaunch.
 *
 * Endpoint + signature pubkey are configured in src-tauri/tauri.conf.json
 * (`plugins.updater`). Silent on network/no-update so it can run on startup.
 */
export async function checkForUpdate(opts: { silent?: boolean } = {}): Promise<void> {
  const { silent = true } = opts;

  let update;
  try {
    update = await check();
  } catch (e) {
    if (!silent) await message(`Could not check for updates:\n${e}`, { title: "Porta", kind: "error" });
    return;
  }

  if (!update) {
    if (!silent) await message("You're on the latest version.", { title: "Porta" });
    return;
  }

  const wantsInstall = await ask(
    `Porta ${update.version} is available (you have ${update.currentVersion}).\n\n${update.body ?? ""}\n\nDownload and install now?`,
    { title: "Update available", kind: "info", okLabel: "Update & Restart", cancelLabel: "Later" }
  );
  if (!wantsInstall) return;

  try {
    await update.downloadAndInstall();
  } catch (e) {
    await message(`Update failed:\n${e}`, { title: "Porta", kind: "error" });
    return;
  }

  await relaunch();
}
