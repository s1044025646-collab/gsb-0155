import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const pidFile = resolve('tmp', 'server.pid');
const portFile = resolve('tmp', 'server.port');

function stopWindows(port: number): void {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const pids = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      if (line.includes(`127.0.0.1:${port}`) && line.includes('LISTENING')) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    for (const pid of pids) {
      execFileSync('taskkill', ['/PID', String(pid), '/F', '/T']);
      console.log(`Stopped project server PID ${pid} on port ${port}.`);
    }
  } catch (error) {
    console.log('No matching project listener found.', error instanceof Error ? error.message : '');
  }
}

function stopPosix(pid: number): void {
  try {
    process.kill(pid, 'TERM');
    console.log(`Stopped project server PID ${pid}.`);
  } catch {
    console.log(`PID ${pid} was not running.`);
  }
}

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (process.platform === 'win32') {
    stopWindows(existsSync(portFile) ? Number(readFileSync(portFile, 'utf8')) : 0);
  } else {
    stopPosix(pid);
  }
} else if (existsSync(portFile)) {
  stopWindows(Number(readFileSync(portFile, 'utf8')));
} else {
  console.log('No project server is registered (tmp/server.pid missing).');
}
rmSync(pidFile, { force: true });
rmSync(portFile, { force: true });
