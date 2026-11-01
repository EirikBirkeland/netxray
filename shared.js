import { execFile } from 'node:child_process';

// Strings from the network or the OS go straight onto the screen, so only plain printable ASCII passes.
export const printable = string => String(string).replace(/[^\x20-\x7E]/g, '?').trim();

export function run(file, args, timeout, env) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout, env }, (error, stdout) => resolve({ error, stdout: stdout ?? '' }));
  });
}
