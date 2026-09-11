import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: process.env.TAVERN_BASE || "/",
  server: { proxy: { "/tavern-api": process.env.TAVERN_API_PROXY || "http://127.0.0.1:8787" } },
  plugins: [react()],
});
