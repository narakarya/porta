import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

const { version } = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8")
);

// Separate from vite.config.ts on purpose: that config is an async factory and
// loads the Tidewave dev plugin, neither of which belongs in a test run.
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TAG__: JSON.stringify(version),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // src-tauri is Rust; scripts/ has its own `node --test` suite.
    exclude: ["node_modules/**", "src-tauri/**", "scripts/**"],
  },
});
