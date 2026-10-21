import { beforeEach, vi } from "vitest";

// An agent run exports its own Paperclip credentials. The GitHub launcher
// prefers them over the broker token a test supplies, so a test that copies
// process.env would authenticate as the live run. Remove them for each test.
const RUN_CREDENTIAL_ENV = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_URL",
  "PAPERCLIP_GIT_TOKEN",
] as const;

export function isolateFromRunCredentials(): void {
  beforeEach(() => {
    for (const name of RUN_CREDENTIAL_ENV) vi.stubEnv(name, undefined);
  });
}
