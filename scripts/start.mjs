import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './rust.mjs';

const binary = path.join(projectRoot, 'target', 'release', 'zskills');
if (!existsSync(binary)) {
  console.error('Build ZSkills first with npm run build.');
  process.exitCode = 1;
} else {
  const child = spawn(binary, [], { cwd: projectRoot, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}
