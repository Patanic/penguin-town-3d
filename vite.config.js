import { defineConfig } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVEL_PATH = resolve(__dirname, 'src/levels/town.json');

// Dev-only middleware: lets the in-game editor persist the map by POSTing
// the level JSON to /__save-level, which writes src/levels/town.json. The
// file is imported into the bundle, so committing + pushing ships the map to
// every player. This plugin only attaches in `serve` (dev) mode, never in the
// production build, so prod never exposes a filesystem write endpoint.
function levelSaver() {
  return {
    name: 'penguin-town-level-saver',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-level', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 5_000_000) req.destroy(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);                 // validate JSON
            await writeFile(LEVEL_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: data?.objects?.length ?? 0 }));
          } catch (e) {
            res.statusCode = 400;
            res.end('Invalid level payload: ' + e.message);
          }
        });
      });
    },
  };
}

// Relative base so the built site works no matter what subpath it's served
// from (e.g. https://<user>.github.io/<repo>/ on GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [levelSaver()],
});
