import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Without the react plugin Vite compiles JSX with the classic runtime, which expects a
// `React` binding in every file. The plugin switches to the automatic runtime.
// The `@` alias matches jsconfig.json, which is what shadcn components import through.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
