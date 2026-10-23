import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { projectRoot, runCargo } from './rust.mjs';

const uiPort = Number(process.env.PORT ?? 4173);
const apiPort = Number(process.env.ZSKILLS_API_PORT ?? 4174);
for (const [name, port] of [
  ['PORT', uiPort],
  ['ZSKILLS_API_PORT', apiPort],
]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
}
if (uiPort === apiPort)
  throw new Error('PORT and ZSKILLS_API_PORT must be different.');

let backend;
let vite;
let closing = false;
let rebuilding = false;
let rebuildAgain = false;
let stoppingBackend = false;
let timer;
const watchers = [];
const buildAbort = new AbortController();

async function stopBackend() {
  if (!backend || backend.exitCode !== null || backend.signalCode !== null)
    return;
  const child = backend;
  stoppingBackend = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  force.unref();
  await exited;
  clearTimeout(force);
  backend = undefined;
  stoppingBackend = false;
}

async function rebuild() {
  if (closing) return;
  if (rebuilding) {
    rebuildAgain = true;
    return;
  }
  rebuilding = true;
  do {
    rebuildAgain = false;
    try {
      await runCargo(['build', '--locked'], { signal: buildAbort.signal });
      if (closing) break;
      await stopBackend();
      backend = spawn(
        path.join(projectRoot, 'target', 'debug', 'zskills'),
        [],
        {
          cwd: projectRoot,
          stdio: 'inherit',
          env: { ...process.env, PORT: String(apiPort) },
        },
      );
      const child = backend;
      backend.once('error', (error) => {
        if (backend === child) backend = undefined;
        console.error(error.message);
        process.exitCode = 1;
        void close();
      });
      backend.once('exit', (code) => {
        if (!closing && !stoppingBackend) {
          console.error(`The Rust service exited with ${code}.`);
          process.exitCode = 1;
          void close();
        }
      });
    } catch (error) {
      if (!closing) console.error(error.message);
    }
  } while (rebuildAgain && !closing);
  rebuilding = false;
}

async function close() {
  if (closing) return;
  closing = true;
  buildAbort.abort();
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  await Promise.all([stopBackend(), vite?.close()]);
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => void close());

try {
  await rebuild();
  if (!closing && backend) {
    vite = await createServer();
    if (!closing) await vite.listen();
    if (closing) {
      await vite.close();
    } else {
      vite.printUrls();
      const scheduleRebuild = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void rebuild(), 200);
      };
      watchers.push(
        watch(
          path.join(projectRoot, 'backend'),
          { recursive: true },
          scheduleRebuild,
        ),
      );
      watchers.push(
        watch(projectRoot, (_event, name) => {
          if (name === 'Cargo.toml' || name === 'Cargo.lock') scheduleRebuild();
        }),
      );
    }
  } else if (!closing) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await close();
}
