import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://localhost:5174",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  reporter: "list",
});
