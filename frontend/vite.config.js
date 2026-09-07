import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Without this plugin Vite compiles JSX with the classic runtime, which expects a
// `React` binding in every file. The plugin switches to the automatic runtime.
export default defineConfig({
  plugins: [react()],
});
