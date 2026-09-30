import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const polling = process.env.WATCH_POLLING === "true";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // localhost はブラウザ、web は e2e のコンテナからの接続。DNS リバインディングを避けるため他は許可しない
    allowedHosts: ["localhost", "web"],
    watch: polling ? { usePolling: true, interval: 300 } : undefined,
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://api:3000" } },
  },
});
