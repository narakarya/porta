import { describe, it, expect } from "vitest";
import { isManifestUnreachable } from "./updater";

// A manual "Check for updates" during a beta publish used to render the
// plugin's own wording as a red "Update failed", which reads like the app
// broke when in fact `latest.json` is simply being rewritten by CI.
describe("isManifestUnreachable", () => {
  it("treats an unreachable release manifest as nothing-to-fetch", () => {
    for (const msg of [
      "Could not fetch a valid release JSON from the remote",
      "Network Error: http status: 404 Not Found",
      "Update check timed out",
      "error sending request for url (https://github.com/...)",
      "failed to lookup address information: nodename nor servname provided",
      "Connection refused (os error 61)",
    ]) {
      expect(isManifestUnreachable(msg), msg).toBe(true);
    }
  });

  it("leaves real faults as errors", () => {
    for (const msg of [
      "signature verification failed",
      "invalid semver in manifest",
      "the platform darwin-aarch64 was not found on the response",
      "permission denied while replacing the bundle",
    ]) {
      expect(isManifestUnreachable(msg), msg).toBe(false);
    }
  });
});
