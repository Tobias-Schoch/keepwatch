import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard only talks to its own origin (/api). In the dev server this proxy
// forwards to the backend through an SSH tunnel (the server binds 9004 to 127.0.0.1 only):
//   ./keepwatch tunnel            # or: ssh -L 9004:127.0.0.1:9004 root@<your-server>
//   npm run dev
// Backend on another local port (e.g. the tunnel of the macOS app):
//   DASH_API=http://localhost:19004 npm run dev
// Without a server: npm run mock (http://localhost:5173/?mock)
const remote = process.env.DASH_API;
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": remote
        ? { target: remote, changeOrigin: true, secure: true }
        : {
            target: "http://127.0.0.1:9004",
            // The backend checks the Host header (protection against DNS rebinding).
            headers: { Host: "localhost:9004" },
          },
    },
  },
});
