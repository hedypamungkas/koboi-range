// Lifecycle functions (ride/dismount/remount) against the mocked Mount: assert the SDK call
// sequence + the returned handles, proving the suspend/resume wiring without a real container.
import { describe, it, expect, beforeEach } from "vitest";
import { ride, dismount, remount } from "../src/lib/sandbox";
import { sandboxSpy } from "./_sdk-mock";

// Lifecycle fns only touch env.MOUNT_CONFIG (env.Sandbox is consumed by the mocked getSandbox).
const env = { MOUNT_CONFIG: "/app/config/finance.yaml" } as never;

const saddlebag = { id: "bk-1", name: "s1", dir: "/workspace" } as never;

beforeEach(() => {
  sandboxSpy.exec.mockClear();
  sandboxSpy.startProcess.mockClear();
  sandboxSpy.createBackup.mockClear();
  sandboxSpy.restoreBackup.mockClear();
});

describe("ride", () => {
  it("fresh ride (no saddlebag): starts serve, never restores or backs up", async () => {
    await ride(env, "s1", null);
    expect(sandboxSpy.startProcess).toHaveBeenCalledTimes(1);
    expect(sandboxSpy.restoreBackup).not.toHaveBeenCalled();
    expect(sandboxSpy.createBackup).not.toHaveBeenCalled();
  });

  it("resume ride (saddlebag): restores the snapshot, then starts serve", async () => {
    await ride(env, "s1", saddlebag);
    expect(sandboxSpy.restoreBackup).toHaveBeenCalledTimes(1);
    expect(sandboxSpy.startProcess).toHaveBeenCalledTimes(1);
  });
});

describe("dismount", () => {
  it("/suspend (exec) -> createBackup(/workspace) -> stopServe (exec), returns the handles", async () => {
    const res = await dismount(env, "s1", "koboi-sid");
    expect(sandboxSpy.createBackup).toHaveBeenCalledTimes(1);
    expect(sandboxSpy.createBackup.mock.calls[0][0]).toMatchObject({ dir: "/workspace", name: "s1" });
    expect(res.backup.id).toBe("bk-test");
    expect(res.checkpoint.ok).toBe(true);
    expect(res.snapshotPath).toContain("suspend.db");
  });
});

describe("remount", () => {
  it("stop -> restore -> swap -> start serve", async () => {
    await remount(env, "s1", saddlebag);
    expect(sandboxSpy.restoreBackup).toHaveBeenCalledTimes(1);
    expect(sandboxSpy.startProcess).toHaveBeenCalledTimes(1);
  });
});
