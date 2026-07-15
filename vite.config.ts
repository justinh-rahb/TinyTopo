import { defineConfig } from 'vite';

// Relative base so the built bundle works from any path — a domain root,
// a GitHub Pages project subpath, or file://. Deploy-anywhere is policy.
export default defineConfig({
  base: './',
});
