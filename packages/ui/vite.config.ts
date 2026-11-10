import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';

const engine = process.env.ATLAS_ENGINE ?? 'http://127.0.0.1:4317';

/**
 * Excalidraw's fonts, served from our own origin at /fonts (main.tsx sets EXCALIDRAW_ASSET_PATH = '/'). Without this
 * Excalidraw downloads them from esm.sh: drawings and their previews break offline, and the desktop app phones out.
 */
function excalidrawFonts(): Plugin {
  // The package doesn't export package.json; its entry is dist/prod/index.js, next to dist/prod/fonts.
  const entry = createRequire(import.meta.url).resolve('@excalidraw/excalidraw');
  const fonts = join(dirname(entry), 'fonts');
  if (!existsSync(fonts)) throw new Error(`Excalidraw fonts not found at ${fonts}`);
  let outDir = 'dist';
  return {
    name: 'atlas-excalidraw-fonts',
    configResolved: (c) => void (outDir = c.build.outDir),
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const file = normalize(join(fonts, decodeURIComponent((req.url ?? '').split('?')[0]!)));
        if (!file.startsWith(fonts + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', 'font/woff2');
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle: () => cpSync(fonts, join(outDir, 'fonts'), { recursive: true }),
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  // One React for the app and for libraries (Excalidraw): two copies crash at render.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: engine, ws: true } },
  },
});
