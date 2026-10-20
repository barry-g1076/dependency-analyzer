import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolveCandidates } from './src/resolver.js';

const flags = process.argv.slice(2);
const validate = flags.includes('--validate');
const pathArg = flags.find(x => !x.startsWith('--')) ?? 'output/dependency-metadata.json';
const source = resolve(pathArg);
const report = JSON.parse(await readFile(source,'utf8'));
const result = resolveCandidates(report, { nodeVersion:process.version });
const out = join(process.cwd(),'output');
await mkdir(out,{recursive:true});

function runNpm(cwd) {
  return new Promise(done => {
    const proc = spawn(process.platform === 'win32' ? 'npm.cmd':'npm',
      ['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund','--strict-peer-deps'],
      { cwd, shell:process.platform === 'win32', windowsHide:true });
    let log='';
    for (const s of [proc.stdout,proc.stderr]) s.on('data',d=>{
      log += d.toString();
      if(log.length > 100000) log=log.slice(-100000);
    });
    proc.on('error',e=>done({passed:false,log:e.message}));
    proc.on('close',code=>done({passed:code===0,exitCode:code,log}));
  });
}

if (result.status === 'peer-compatible-candidate' && validate) {
  const directory = await mkdtemp(join(tmpdir(),'dep-analyzer-'));
  try {
    const pkg = {name:'dependency-analyzer-validation',private:true,version:'0.0.0',
      dependencies:{},devDependencies:{}};
    for (const r of result.recommendations) {
      const bucket = r.type === 'development' ? pkg.devDependencies : pkg.dependencies;
      bucket[r.name] = r.version;
    }
    await writeFile(join(directory,'package.json'),JSON.stringify(pkg,null,2));
    console.log('Validating with npm in an isolated temporary directory...');
    result.validation = await runNpm(directory);
  } finally { await rm(directory,{recursive:true,force:true}); }
}

await writeFile(join(out,'recommended-dependencies.json'),JSON.stringify(result,null,2));
const lines = [
  'DEPENDENCY COMPATIBILITY REPORT',
  `Generated: ${new Date().toISOString()}`,
  `Node: ${process.version}`,
  `Status: ${result.status}`,
  `Search nodes: ${result.searchedNodes}`,
  '',
  ...(result.recommendations ?? []).map(r =>
    `${r.name}: ${r.original} -> ${r.version}${r.isLatest ? ' [latest]' : ' [alternative]'}`),
  '', 'EXTERNAL PEERS (not evaluated as direct dependencies)',
  ...(result.externalPeers ?? []).map(p=>`${p.source} -> ${p.peer} ${p.range}${p.optional ? ' (optional)':''}`),
  '', 'WARNINGS',...(result.errors??[]),
  result.caveat ?? '',
  '', 'NPM VALIDATION',
  result.validation ? `Passed: ${result.validation.passed}; exit: ${result.validation.exitCode ?? 'unknown'}` : 'Not run (use --validate)',
  result.validation?.log ?? '',
  '', 'A clean npm resolution does not guarantee application compatibility. Run build/tests and review migration guides.'
];
await writeFile(join(out,'compatibility-report.txt'),lines.join('\n'));
console.log(`Status: ${result.status} | search nodes: ${result.searchedNodes}`);
if (result.validation) console.log(`npm validation: ${result.validation.passed ? 'PASSED' : 'FAILED'}`);
console.log(`Reports: ${out}`);
if (result.status !== 'peer-compatible-candidate' || (validate && !result.validation?.passed)) process.exitCode=1;
