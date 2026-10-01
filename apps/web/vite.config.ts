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
    // no-referrer だとブラウザが同じオリジンの POST の Origin まで null にし、API の CSRF の確認で弾かれる(02-01 7章)
    headers: { "referrer-policy": "strict-origin" },
    // localhost はブラウザ、web・web-e2e は e2e のコンテナからの接続。DNS リバインディングを避けるため他は許可しない
    allowedHosts: ["localhost", "web", "web-e2e"],
    watch: polling ? { usePolling: true, interval: 300 } : undefined,
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://api:3000" } },
  },
});
