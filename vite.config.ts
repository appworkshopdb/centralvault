import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const api = (env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const socket = api.replace(/^https:/, "wss:");
  // Nur der eigene Ursprung und genau die eine Supabase-Domain – https für REST
  // und Auth, wss für Realtime. Ohne wss bleibt der Realtime-Kanal blockiert.
  const connectSrc = ["'self'", api, socket].filter(Boolean).join(" ");

  return {
    base: "./",
    build: {
      target: "es2022",
      sourcemap: false,
    },
    test: {
      environment: "node",
    },
    plugins: [
      {
        name: "central-vault-csp",
        transformIndexHtml(html: string) {
          return html.replace("__CONNECT_SRC__", connectSrc);
        },
      },
    ],
  };
});
