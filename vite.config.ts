import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: process.env.TAVERN_BASE || "/",
  plugins: [react()],
});
