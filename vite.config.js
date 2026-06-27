import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Production (GitHub Pages) is served under /mech-game/, but in dev serve at root
  // so the Claude Code preview — which health-checks `/` — gets a 200 instead of a
  // 302 redirect and actually attaches.
  base: command === 'serve' ? '/' : '/mech-game/',
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
}));
