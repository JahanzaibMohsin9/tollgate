import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The public REST API sends no CORS headers, so the browser reaches it through /lcd-testnet:
// the dev and preview servers forward it here, and vercel.json does the same in production.
const proxy = {
  "/lcd-testnet": {
    target: "https://api-testnet.qore.host",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/lcd-testnet/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE ?? "/",
  server: { port: 5174, proxy },
  preview: { port: 5174, proxy },
});
