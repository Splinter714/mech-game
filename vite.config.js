import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

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
  test: {
    // Agent worktrees are the default workflow here, and each is a full repo copy
    // containing its own `*.test.js` files. Without this, running tests from the main
    // checkout globs those copies too and inflates the reported counts. Keep vitest's
    // built-in excludes and add the worktree/.git trees.
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**', '**/.git/**'],
  },
}));
