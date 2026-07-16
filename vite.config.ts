import { defineConfig } from 'vite';

// Relative base so the built bundle works from any path — a domain root,
// a GitHub Pages project subpath, or file://. Deploy-anywhere is policy.
export default defineConfig({
  base: './',
  server: {
    // Honor an externally assigned port (e.g. preview harness); default off
    // the well-trodden 5173 to avoid colliding with other local dev servers.
    port: Number(process.env.PORT) || 5273,
    strictPort: false,
  },
});
