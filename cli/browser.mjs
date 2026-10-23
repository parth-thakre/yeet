import { spawn } from 'node:child_process';

export function browserCommand(url, platform = process.platform) {
  // Never interpolate a server-supplied URL into a shell command.
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}
export function launch(command, args) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }); }
    catch { resolve(false); return; }
    // A browser that was not running yet keeps this process alive; let it outlive the CLI.
    const timer = setTimeout(() => { child.unref(); resolve(true); }, 1500);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
export function openBrowser(url) {
  return launch(...browserCommand(url));
}

