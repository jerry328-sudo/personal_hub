import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_LOGIN_SECRET: "test-admin-secret-with-sufficient-entropy",
          AUTH_PEPPER: "test-auth-pepper-with-different-entropy",
          TEST_MIGRATIONS: await readD1Migrations(path.resolve(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
