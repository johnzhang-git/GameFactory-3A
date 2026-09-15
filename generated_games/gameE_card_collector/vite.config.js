import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Serving stays on loopback unless asked otherwise. A project
// on a remote dev box opts in with A3GAME_DEV_HOST=0.0.0.0,
// and allowedHosts stops Vite rejecting the forwarded Host
// header a tunnel or IDE port forward produces.
const server = {
  port: Number(process.env.A3GAME_DEV_PORT ?? 5199),
  strictPort: true,
  host: process.env.A3GAME_DEV_HOST ?? '127.0.0.1',
  allowedHosts: true,
};

// The game talks to the backend on same-origin paths (`/auth/*`, `/game/*`),
// so dev and preview need to forward those to the server. Hardcoding an
// absolute API URL in the client instead would bake a host into the bundle and
// lose same-origin cookie/CORS behaviour in production.
const apiTarget = process.env.A3GAME_API_URL ?? 'http://127.0.0.1:8787';
/**
 * Every server-owned prefix must be listed. A prefix that is missed does not
 * fail loudly: the dev server answers it with index.html and a 200, so the
 * client gets HTML where it expected JSON and the feature silently does
 * nothing. That is exactly what `/chain` did when claiming was added.
 */
const proxy = {
  '/auth': { target: apiTarget, changeOrigin: true },
  '/game': { target: apiTarget, changeOrigin: true },
  '/chain': { target: apiTarget, changeOrigin: true },
};

export default defineConfig({
  server: { ...server, proxy },
  preview: { ...server, proxy },
  resolve: {
    alias: {
      '@': resolve(process.cwd(), 'src'),
      '@a3game/playable': resolve(
        process.cwd(),
        'packages/a3game-playable/src/index.js',
      ),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
