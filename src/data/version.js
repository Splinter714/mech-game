// #523: the pause menu's new "version" row shows WHEN this bundle was built — vite.config.js
// injects a `define`, `__BUILD_TIME__`, at build time. For `npm run deploy` (`vite build` then
// `gh-pages -d dist`, see `.claude/memory/working-on-mech-game.md`) that define is stamped the
// moment `vite build` runs, immediately before publishing — the closest thing this project has
// to a real "deploy timestamp". `npm run dev` gets the dev-server's own start time (still a
// useful "which build am I looking at" signal); a raw import outside Vite's pipeline (shouldn't
// happen — vitest shares this project's Vite config too) falls back to 'dev' via the
// `typeof`-guard, which never throws even when the identifier was never declared.
export const BUILD_TIME = (() => {
  // eslint-disable-next-line no-undef
  return typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev';
})();

// Pure formatter — unit-tested directly against plain strings rather than the define/env
// plumbing above. '2026-07-25T18:51:00.000Z' -> '2026-07-25 18:51 UTC'; anything that isn't a
// recognizable ISO timestamp (including the 'dev' fallback) reads as a plain dev-build label.
export function formatBuildTime(raw) {
  if (typeof raw !== 'string') return 'DEV BUILD';
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]} UTC` : 'DEV BUILD';
}
