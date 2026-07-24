// Global stub for @cloudflare/sandbox. Cloudflare Containers can't run under Miniflare, so
// every test drives a fake Mount instead:
//   - exec()      returns the /suspend payload (httpInMount parses the LAST stdout line as JSON);
//                 stopServe()/swapSnapshot() also call exec and ignore the result.
//   - createBackup()  returns a JSON-serializable DirectoryBackup handle.
//   - restoreBackup() returns a no-op RestoreBackupResult.
//   - startProcess()  returns a Process whose waitForPort() resolves immediately.
// The spies are exported so lifecycle/cron tests can assert call order + reset between cases.
import { vi } from "vitest";

const sdk = vi.hoisted(() => {
  const exec = vi.fn(async () => ({
    stdout: JSON.stringify({
      status: 200,
      body: {
        snapshot_path: "/workspace/koboi_memory.db.s.suspend.db",
        checkpoint: { ok: true, busy: 0, log: 0, checkpointed: 0 },
      },
    }),
    stderr: "",
    exitCode: 0,
  }));
  const startProcess = vi.fn(async () => ({ waitForPort: vi.fn(async () => {}) }));
  const createBackup = vi.fn(async (opts?: { dir?: string; name?: string }) => ({
    id: "bk-test",
    name: opts?.name ?? "s",
    dir: opts?.dir ?? "/workspace",
  }));
  const restoreBackup = vi.fn(async () => ({}));
  return { exec, startProcess, createBackup, restoreBackup, Sandbox: class MockSandbox {} };
});

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    exec: sdk.exec,
    startProcess: sdk.startProcess,
    createBackup: sdk.createBackup,
    restoreBackup: sdk.restoreBackup,
  }),
  Sandbox: sdk.Sandbox,
}));

export const sandboxSpy = sdk;
