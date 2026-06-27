// Resolve the URL of a running mech-game dev server (mirrors the horse game's helper).
//
// Vite auto-increments the port when 5173 is busy (common with multiple worktrees /
// Claude Code previews), and `autoPort` in .claude/launch.json hands the preview an
// arbitrary free port. So we first look for the Vite process whose working directory
// IS this project and use ITS port; only then fall back to a port scan. Override
// everything with SMOKE_URL.

import { execSync } from 'node:child_process';

// Dev serves at root (base '/'); a built/previewed app serves under /mech-game/.
const PATHS = ['/?canvas', '/mech-game/?canvas'];
const PORTS = Array.from({ length: 20 }, (_, i) => 5173 + i);

async function servesGame(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('mech-game') || html.includes('main.js');
  } catch {
    return false;
  }
}

function ownProjectPort() {
  try {
    const cwd = process.cwd();
    const pids = execSync('pgrep -f "node_modules/.bin/vite"', { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) {
      let pcwd = '';
      try {
        pcwd = execSync(`lsof -a -d cwd -p ${pid} -Fn`, { encoding: 'utf8' })
          .split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
      } catch { /* ignore */ }
      if (pcwd !== cwd) continue;
      const out = execSync(`lsof -a -p ${pid} -iTCP -sTCP:LISTEN -P -n -Fn`, { encoding: 'utf8' });
      const m = out.match(/n.*:(\d+)\s*$/m);
      if (m) return Number(m[1]);
    }
  } catch { /* lsof/pgrep unavailable — fall back */ }
  return null;
}

export async function resolveDevServerUrl() {
  if (process.env.SMOKE_URL) return process.env.SMOKE_URL + (process.env.SMOKE_URL.includes('?') ? '' : '?canvas');

  const ownPort = ownProjectPort();
  if (ownPort) {
    for (const path of PATHS) {
      const url = `http://localhost:${ownPort}${path}`;
      if (await servesGame(url)) return url;
    }
  }
  for (const port of PORTS) {
    for (const path of PATHS) {
      const url = `http://localhost:${port}${path}`;
      if (await servesGame(url)) return url;
    }
  }
  throw new Error(
    `No mech-game dev server found on ports ${PORTS[0]}-${PORTS.at(-1)}. ` +
      'Start one with `npm run dev`, or set SMOKE_URL.',
  );
}
