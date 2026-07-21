import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Short content hash of the generated app icons → a `?v=` cache-buster stamped onto every
// icon URL (manifest + apple-touch-icon). iOS caches the apple-touch-icon and the home-screen
// snapshot extremely hard, keyed by URL, so a same-name icon update never lands. Changing the
// query whenever the icon BYTES change forces Safari / Chrome / the OS installer to re-fetch.
// Regenerate the icons with `npm run icons`; the hash updates automatically. Falls back to a
// static token if the files aren't present (e.g. before the first `npm run icons`).
function iconVersion() {
  try {
    const h = createHash('sha256');
    for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
      h.update(readFileSync(resolve(ROOT, 'public/icons', f)));
    }
    return h.digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
}

export default defineConfig(({ command }) => {
  const iv = iconVersion();
  const q = `?v=${iv}`;
  // Production (GitHub Pages) is served under /mech-game/, but in dev serve at root
  // so the Claude Code preview — which health-checks `/` — gets a 200 instead of a
  // 302 redirect and actually attaches. The PWA manifest's start_url/scope/icon paths
  // are all relative so they resolve correctly under whichever base is active.
  const base = command === 'serve' ? '/' : '/mech-game/';
  return {
    base,
    plugins: [
      VitePWA({
        registerType: 'autoUpdate',
        // Match the game's dark UI (index.html body bg + Phaser backgroundColor).
        manifest: {
          name: 'Mech Game',
          short_name: 'Mech Game',
          description: 'A top-down real-time mech action game with deep customization.',
          display: 'standalone',
          orientation: 'landscape',
          theme_color: '#0d1014',
          background_color: '#0d1014',
          // Relative so they resolve under the active base ('/' dev, '/mech-game/' prod).
          start_url: '.',
          scope: '.',
          icons: [
            { src: `icons/icon-192.png${q}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: `icons/icon-512.png${q}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: `icons/icon-maskable-512.png${q}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // The game is fully client-side (procedural art + localStorage), so precaching
          // the built shell is all that's needed to play offline. No runtime API caching.
          globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
          navigateFallback: 'index.html',
          // The icon URLs carry a `?v=` cache-buster (see iconVersion). Strip it when matching
          // the precache so the SW still serves the freshly-precached icon offline; the query
          // is only there to bust the browser/OS HTTP cache, not the SW precache.
          ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
        },
        // Inject the theme-color / apple-touch-icon head tags for us.
        includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'],
      }),
      // Inject the iOS apple-touch-icon with the same ?v= content hash as the manifest icons,
      // so a changed icon gets a fresh URL Safari can't serve stale from its icon cache.
      {
        name: 'apple-touch-icon',
        transformIndexHtml: () => [
          { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `icons/icon-192.png${q}` }, injectTo: 'head' },
        ],
      },
    ],
    server: {
      host: true,
      // Honour the PORT env var the Claude Code preview assigns so Vite binds to the
      // SAME port the preview navigates to (it otherwise stays on 5173 → blank pane).
      // When PORT is set we bind exactly there (strictPort); otherwise fall back to
      // 5173 and let Vite increment for plain `npm run dev`.
      port: Number(process.env.PORT) || 5173,
      strictPort: !!process.env.PORT,
      open: false,
    },
    build: {
      outDir: 'dist',
      assetsInlineLimit: 0,
    },
    test: {
      // Agent worktrees are the default workflow here, and each is a full repo copy
      // containing its own `*.test.js` files. Without this, running tests from the main
      // checkout globs those copies too and inflates the reported counts. Keep vitest's
      // built-in excludes and add the worktree/.git trees.
      exclude: [...configDefaults.exclude, '**/.claude/worktrees/**', '**/.git/**'],
      // #325: the worldgen invariant sweeps (#288 wall sealing, #308 base spacing) each
      // generate dozens of full worlds and flood-fill them, running 1-3s on an idle machine.
      // Vitest's 5s default left almost no headroom, so whenever the box was busy — several
      // agent worktrees running tests at once, plus a live playtest — those tests blew the
      // wall clock and reported as failures. The assertions themselves are fully seeded and
      // deterministic (verified: identical output across repeated passes over the same seed
      // families), so the red was pure timing noise, and it poisoned every agent's merge
      // gate. Give the suite real headroom instead of trimming the sweeps or weakening the
      // invariants — a slow honest test beats a fast lenient one.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  };
});
