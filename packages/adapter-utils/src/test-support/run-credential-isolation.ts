import { afterEach, beforeEach } from "vitest";

// An agent run exports its own Paperclip credentials. The GitHub launcher
// prefers them over the broker token a test supplies, so a test that copies
// process.env would authenticate as the live run. Remove them for each test
// and restore them afterwards. Plain env edits keep vi.unstubAllEnvs() in a
// test from restoring the live values.
const RUN_CREDENTIAL_ENV = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_URL",
  "PAPERCLIP_GIT_TOKEN",
] as const;

export function isolateFromRunCredentials(): void {
  const saved = new Map<string, string>();
  beforeEach(() => {
    for (const name of RUN_CREDENTIAL_ENV) {
      const value = process.env[name];
      if (value !== undefined) saved.set(name, value);
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of RUN_CREDENTIAL_ENV) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });
}
