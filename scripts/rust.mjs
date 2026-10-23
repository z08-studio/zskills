import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const installedCargo = path.join(homedir(), '.cargo', 'bin', 'cargo');
export const cargo =
  process.env.CARGO ?? (existsSync(installedCargo) ? installedCargo : 'cargo');

export function runCargo(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cargo invocation cancelled.'));
      return;
    }
    const child = spawn(cargo, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      detached: Boolean(signal),
    });
    const abort = () => {
      if (!child.pid) return;
      try {
        // Stop compiler children along with Cargo during development shutdown.
        process.kill(-child.pid, 'SIGINT');
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`Cargo exited with ${signal ?? code}.`));
    });
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runCargo(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
