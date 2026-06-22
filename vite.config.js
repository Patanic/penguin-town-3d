import { defineConfig } from 'vite';

// Relative base so the built site works no matter what subpath it's served
// from (e.g. https://<user>.github.io/<repo>/ on GitHub Pages).
export default defineConfig({
  base: './',
});
