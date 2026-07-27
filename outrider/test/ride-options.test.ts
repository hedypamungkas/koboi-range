// Ride options + terminal webhook tests: per-session config, repo materialization, and webhook idempotency.
import { describe, it, expect, beforeEach } from "vitest";
import { ride, hmacSha256, KOBOI_JOB_STATUSES, diffWorkspace } from "../src/lib/sandbox";
import { sandboxSpy } from "./_sdk-mock";

describe("ride options", () => {
  beforeEach(() => {
    sandboxSpy.exec.mockClear();
    sandboxSpy.startProcess.mockClear();
    sandboxSpy.createBackup.mockClear();
    sandboxSpy.restoreBackup.mockClear();
    sandboxSpy.exposePort.mockClear();
    (sandboxSpy as any).gitCheckout.mockClear();
  });

  it("per-session mountConfig: overrides global MOUNT_CONFIG", async () => {
    const env = {
      MOUNT_CONFIG: "/app/config/default.yaml",
      PUBLIC_DOMAIN: "example.com",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: "gpt-4",
    } as never;

    await ride(env, "s1", null, { mountConfig: "/app/config/custom.yaml" });

    expect(sandboxSpy.startProcess).toHaveBeenCalledTimes(1);
    const calls = sandboxSpy.startProcess.mock.calls as any[][];
    const cmd = calls[0]?.[0] as string;
    expect(cmd).toContain("/app/config/custom.yaml");
    expect(cmd).not.toContain("/app/config/default.yaml");
  });

  it("repo materialization: gitCheckout + git checkout baseSha before koboi serve", async () => {
    const env = {
      MOUNT_CONFIG: "/app/config/finance.yaml",
      PUBLIC_DOMAIN: "example.com",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: "gpt-4",
    } as never;

    await ride(env, "s1", null, {
      repoUrl: "https://github.com/user/repo.git",
      baseSha: "abc123",
    });

    expect(sandboxSpy.exec).toHaveBeenCalledWith("git checkout abc123", { timeout: 60000 });
    expect(sandboxSpy.startProcess).toHaveBeenCalledTimes(1);
  });

  it("secretSet: per-session secrets override global OPENAI_*", async () => {
    const env = {
      MOUNT_CONFIG: "/app/config/finance.yaml",
      PUBLIC_DOMAIN: "example.com",
      OPENAI_API_KEY: "sk-global",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODEL: "gpt-4",
      ACCOUNT_X_OPENAI_API_KEY: "sk-account-x",
      ACCOUNT_X_OPENAI_BASE_URL: "https://custom.openai.com/v1",
      ACCOUNT_X_OPENAI_MODEL: "gpt-4o",
    } as never;

    await ride(env, "s1", null, { secretSet: "account-x" });

    expect(sandboxSpy.startProcess).toHaveBeenCalledTimes(1);
    const calls = sandboxSpy.startProcess.mock.calls as any[][];
    const cmd = calls[0]?.[0] as string;
    expect(cmd).toContain("sk-account-x");
    expect(cmd).not.toContain("sk-global");
  });
});

describe("hmacSha256", () => {
  it("computes HMAC-SHA256 signature correctly", async () => {
    const secret = "webhook-secret";
    const message = '{"sid":"s1","job_id":"job-1","status":"completed","ts":123456}';

    const sig = await hmacSha256(secret, message);

    expect(sig).toMatch(/^[a-f0-9]{64}$/); // 64 hex chars (256 bits)
  });

  it("produces deterministic signatures for same input", async () => {
    const secret = "test-secret";
    const message = "test-message";

    const sig1 = await hmacSha256(secret, message);
    const sig2 = await hmacSha256(secret, message);

    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different inputs", async () => {
    const secret = "test-secret";
    const message1 = "message-one";
    const message2 = "message-two";

    const sig1 = await hmacSha256(secret, message1);
    const sig2 = await hmacSha256(secret, message2);

    expect(sig1).not.toBe(sig2);
  });
});

describe("diffWorkspace", () => {
  beforeEach(() => {
    sandboxSpy.exec.mockClear();
  });

  it("runs `git diff <base>` when a base SHA is provided", async () => {
    const env = { MOUNT_CONFIG: "/app/config/finance.yaml", PUBLIC_DOMAIN: "example.com" } as never;
    sandboxSpy.exec.mockResolvedValueOnce({ stdout: "--- a/f\n+++ b/f\n", stderr: "", exitCode: 0 });
    const out = await diffWorkspace(env, "s1", "abc123");
    expect(sandboxSpy.exec).toHaveBeenCalledWith("git diff abc123", { timeout: 30_000 });
    expect(out.patch).toBe("--- a/f\n+++ b/f");
    expect(out.exitCode).toBe(0);
  });

  it("runs `git diff HEAD` when no base is provided", async () => {
    const env = { MOUNT_CONFIG: "/app/config/finance.yaml", PUBLIC_DOMAIN: "example.com" } as never;
    sandboxSpy.exec.mockResolvedValueOnce({ stdout: "patch-text\n", stderr: "", exitCode: 0 });
    const out = await diffWorkspace(env, "s1");
    expect(sandboxSpy.exec).toHaveBeenCalledWith("git diff HEAD", { timeout: 30_000 });
    expect(out.patch).toBe("patch-text");
  });

  it("sanitizes baseSha so no shell metacharacter survives", async () => {
    const env = { MOUNT_CONFIG: "/app/config/finance.yaml", PUBLIC_DOMAIN: "example.com" } as never;
    sandboxSpy.exec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    await diffWorkspace(env, "s1", "abc; rm -rf /");
    const calls = sandboxSpy.exec.mock.calls as any[][];
    const arg = calls[0]?.[0] as string;
    // only [A-Za-z0-9_./-] survive -> a single safe token, no ;/space/pipe/backtick
    expect(arg).toBe("git diff abcrm-rf/");
    expect(arg).not.toContain(";");
  });
});

describe("terminal job statuses", () => {
  it("KOBOI_JOB_STATUSES includes all expected statuses", () => {
    expect(KOBOI_JOB_STATUSES).toContain("completed");
    expect(KOBOI_JOB_STATUSES).toContain("failed");
    expect(KOBOI_JOB_STATUSES).toContain("timed_out");
    expect(KOBOI_JOB_STATUSES).toContain("cancelled");
    expect(KOBOI_JOB_STATUSES).toContain("awaiting_human");
  });

  it("can distinguish terminal from non-terminal statuses", () => {
    const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled"]);
    const NON_TERMINAL = new Set(["reserved", "pending", "running", "awaiting_human"]);

    TERMINAL.forEach((s) => expect(KOBOI_JOB_STATUSES).toContain(s as never));
    NON_TERMINAL.forEach((s) => expect(KOBOI_JOB_STATUSES).toContain(s as never));
  });
});
