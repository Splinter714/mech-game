import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => {
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
          short_name: 'Mech',
          description: 'A top-down real-time mech action game with deep customization.',
          display: 'standalone',
          orientation: 'landscape',
          theme_color: '#0d1014',
          background_color: '#0d1014',
          // Relative so they resolve under the active base ('/' dev, '/mech-game/' prod).
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // The game is fully client-side (procedural art + localStorage), so precaching
          // the built shell is all that's needed to play offline. No runtime API caching.
          globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
          navigateFallback: 'index.html',
        },
        // Inject the theme-color / apple-touch-icon head tags for us.
        includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'],
      }),
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
    },
  };
});
