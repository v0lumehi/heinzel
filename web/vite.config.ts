import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` here serves the UI on :5173 and forwards API and sign-in calls to the admin server (ADMIN_PORT).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3080",
      "/auth": "http://localhost:3080",
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
