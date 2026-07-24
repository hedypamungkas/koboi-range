import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The Outrider runs in Miniflare with REAL ephemeral KV + R2 -- no Cloudflare account, no
// deploy needed. The Sandbox SDK (@cloudflare/sandbox -> per-session Cloudflare Containers)
// cannot be emulated locally, so test/_sdk-mock.ts stubs it for every test (see setupFiles).
// Lifecycle + cron tests therefore drive a fake Mount while exercising the real registry
// state machine + the real scheduled() heartbeat.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "src/index.ts",
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["RANGE_KV"],
        r2Buckets: ["BACKUP_BUCKET"],
        bindings: {
          BACKUP_BUCKET_NAME: "range-saddlebags",
          CLOUDFLARE_ACCOUNT_ID: "test-account",
          MOUNT_CONFIG: "/app/config/finance.yaml",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/_sdk-mock.ts"],
  },
});
