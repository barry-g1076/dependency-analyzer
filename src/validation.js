import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

export function parseNpmConflict(log) {
  const clean = log.replace(/\x1b\[[0-9;]*m/g, '');
  const peer = /peer(?:Optional)?\s+([^\s]+)\s+from\s+([^\s]+)/i.exec(clean);
  const found = /Found:\s+([^\s]+)/i.exec(clean);
  if (peer) return `${peer[2]} requires peer ${peer[1]}${found ? `; npm found ${found[1]}` : ''}`;
  const code = /npm error code\s+(\w+)/i.exec(clean);
  return code?.[1] ?? clean.split('\n').find(x => /error/i.test(x))?.trim() ?? 'npm exited without a clear conflict';
}

export async function validateWithNpm(manifest, { timeoutMs = 120000, npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm', onDirectory } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-analyzer-'));
  onDirectory?.(directory);
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
    const args = ['install', '--package-lock-only', '--ignore-scripts', '--strict-peer-deps', '--engine-strict', '--no-audit', '--no-fund', '--no-progress', '--no-update-notifier'];
    const result = await new Promise(done => {
      const executable = process.platform === 'win32' ? 'cmd.exe' : npmCommand;
      const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `${npmCommand} ${args.join(' ')}`] : args;
      const child = spawn(executable, commandArgs, { cwd: directory, windowsHide: true, env: { ...process.env, npm_config_user_agent: 'dependency-analyzer-validation' } });
      let log = '', settled = false;
      const finish = value => { if (!settled) { settled = true; done(value); } };
      const timer = setTimeout(() => child.kill(), timeoutMs);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data.toString()).slice(-60000); });
      child.on('error', error => { clearTimeout(timer); finish({ passed: false, exitCode: null, log: error.message, summary: error.message }); });
      child.on('close', code => { clearTimeout(timer); finish({ passed: code === 0, exitCode: code, log, summary: code === 0 ? 'npm resolved the dependency tree' : parseNpmConflict(log), conflict: code === 0 ? null : parseNpmConflict(log) }); });
    });
    result.warnings = result.log.split(/\r?\n/).filter(line => /npm warn\b/i.test(line)).slice(0, 50);
    result.errors = result.log.split(/\r?\n/).filter(line => /npm error\b/i.test(line)).slice(0, 50);
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
