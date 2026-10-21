import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import semver from 'semver';
import { readProject } from './reader.js';
import { classifySpec, matchSpec } from './spec.js';
import { getPackageMetadata } from './registry.js';
import { resolveRecommendations, makeRecommendedManifest } from './resolver.js';
import { validateWithNpm } from './validation.js';

const defaults = { output: 'output', initialCandidates: 10, maxCandidates: 60, maxNodes: 5000, maxValidations: 8, concurrency: 6, timeoutMs: 15000 };
export function parseArgs(argv) {
  const options = { ...defaults, positionals: [] };
  const names = { '--project': 'project', '--output': 'output', '--metadata': 'metadata', '--node-version': 'nodeVersion', '--candidate-limit': 'initialCandidates', '--max-candidates': 'maxCandidates', '--max-nodes': 'maxNodes', '--max-validations': 'maxValidations', '--concurrency': 'concurrency', '--timeout': 'timeoutMs' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--validate') options.validate = true;
    else if (arg === '--include-prerelease') options.includePrerelease = true;
    else if (arg === '--verbose' || arg === '--debug') options.verbose = true;
    else if (arg in names) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[names[arg]] = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else options.positionals.push(arg);
  }
  for (const key of ['initialCandidates', 'maxCandidates', 'maxNodes', 'maxValidations', 'concurrency', 'timeoutMs']) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (options.initialCandidates > options.maxCandidates) throw new Error('candidate limit cannot exceed max candidates');
  if (options.nodeVersion && !semver.valid(semver.coerce(options.nodeVersion))) throw new Error('Invalid Node.js version');
  if (options.validate && options.nodeVersion && semver.coerce(options.nodeVersion).version !== semver.coerce(process.version).version)
    throw new Error('npm validation must run under the requested Node.js version; switch Node versions or omit --validate');
  return options;
}

export const help = `Dependency Compatibility Analyzer
Usage:
  npm run analyze -- <project-directory> [options]
  npm run resolve -- [metadata-file] [options]
  npm run resolve:validate -- [metadata-file] [options]
  node index.js --project <directory> --output <directory>
  node resolve.js --project <directory> --validate

Options:
  --project DIR           Target project (resolve analyzes it first)
  --output DIR            Report directory (default: output)
  --metadata FILE         Existing metadata file for resolve
  --node-version VERSION  Target Node.js version (default: current)
  --candidate-limit N     Initial releases per package (default: 10)
  --max-candidates N      Maximum release history per package (default: 60)
  --max-nodes N           Search node limit (default: 5000)
  --max-validations N     npm resolution attempts (default: 8)
  --concurrency N         Concurrent registry requests (default: 6)
  --timeout MS            Registry request timeout (default: 15000)
  --include-prerelease    Include prerelease versions
  --validate              Resolve candidates with npm in a temporary directory
  --verbose, --debug      Print progress
  --help                  Show this help`;

async function mapBounded(items, concurrency, fn) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await fn(items[index], index);
    }
  }));
  return result;
}

export async function analyze(projectPath, options) {
  const { manifest, dependencies } = await readProject(projectPath);
  const packages = await mapBounded(dependencies, options.concurrency, async (dependency, index) => {
    if (options.verbose) process.stderr.write(`[${index + 1}/${dependencies.length}] ${dependency.name}\n`);
    const spec = classifySpec(dependency.requestedRange);
    if (spec.type !== 'semver') return { ...dependency, status: 'unsupported-specification', specificationType: spec.type, message: spec.diagnostic ?? `${spec.type} specification preserved`, candidates: [] };
    try {
      const metadata = await getPackageMetadata(dependency.name, { limit: options.initialCandidates, maxCandidates: options.maxCandidates, includePrerelease: options.includePrerelease, timeoutMs: options.timeoutMs });
      return { ...dependency, status: 'analyzed', ...metadata,
        latestPermitted: metadata.candidateHistory.find(c => matchSpec(c.version, spec, { includePrerelease: options.includePrerelease }) === true)?.version ?? null };
    } catch (error) { return { ...dependency, status: 'error', error: error.message, candidates: [] }; }
  });
  return { projectPath, generatedAt: new Date().toISOString(), nodeVersion: options.nodeVersion ?? process.version,
    npmVersion: (await import('node:child_process')).execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm --version'] : ['--version'], { encoding: 'utf8' }).trim(),
    totalDependencies: dependencies.length, manifest, packages };
}

function renderText(report, result) {
  const lines = [
    'DEPENDENCY COMPATIBILITY REPORT',
    `Project: ${report.manifest?.name ?? '(unnamed)'} (${report.projectPath})`,
    `Generated: ${new Date().toISOString()}`,
    `Node: ${report.nodeVersion} | npm: ${report.npmVersion ?? 'unknown'}`,
    `Direct dependencies analyzed: ${report.totalDependencies}`,
    `Status: ${result.status}`,
    `Search: ${result.searchedNodes}/${result.maxNodes} nodes; ${result.validations}/${result.maxValidations} npm attempts; ${result.candidateDepth} release depth`,
    `Optimality proven: ${result.optimalityProven ? 'yes, within collected metadata' : 'no'}`,
    '', 'RECOMMENDATIONS',
    ...result.recommendations.map(r => `${r.name} [${r.section}]: ${r.original} -> ${r.version ?? '(preserved)'} | published: ${r.latestPublished ?? 'unknown'} | permitted: ${r.latestPermitted ?? 'unknown in collected history'}${r.deprecated ? ` | DEPRECATED: ${r.deprecated}` : ''}`),
    '', 'CANNOT USE NEWEST PUBLISHED RELEASE',
    ...result.recommendations.filter(r => r.version && r.latestPublished && r.version !== r.latestPublished).map(r => `${r.name}: ${r.version} instead of ${r.latestPublished}`),
    '', 'DIAGNOSTICS', ...result.diagnostics,
    '', 'NPM VALIDATION',
    result.validation ? `${result.validation.passed ? 'PASSED' : 'FAILED'}: ${result.validation.summary}` : 'Not run; use --validate',
    result.validation?.log ?? '', '', result.caveat
  ];
  return lines.join('\n');
}

export async function run(mode, argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log(help); return; }
  const outputDir = resolve(options.output);
  await mkdir(outputDir, { recursive: true });
  let report;
  if (mode === 'analyze' || options.project) {
    const projectPath = resolve(options.project ?? options.positionals[0] ?? '.');
    report = await analyze(projectPath, options);
    await writeFile(join(outputDir, 'dependency-metadata.json'), JSON.stringify(report, null, 2));
    console.log(`Analyzed ${report.totalDependencies} direct dependencies: ${join(outputDir, 'dependency-metadata.json')}`);
    if (mode === 'analyze') return;
  } else {
    report = JSON.parse(await readFile(resolve(options.metadata ?? options.positionals[0] ?? join(outputDir, 'dependency-metadata.json')), 'utf8'));
    if (!report.manifest) report.manifest = (await readProject(report.projectPath)).manifest;
    if (!report.npmVersion) report.npmVersion = 'unknown';
  }
  if (options.nodeVersion) report.nodeVersion = options.nodeVersion;
  const result = await resolveRecommendations(report, { nodeVersion: options.nodeVersion ?? report.nodeVersion ?? process.version,
    npmVersion: report.npmVersion, maxNodes: options.maxNodes, initialCandidates: options.initialCandidates,
    maxCandidates: options.maxCandidates, maxValidations: options.maxValidations, verbose: options.verbose,
    validator: options.validate ? manifest => validateWithNpm(manifest) : null });
  const recommendedManifest = makeRecommendedManifest(report.manifest, result.recommendations);
  await Promise.all([
    writeFile(join(outputDir, 'recommended-dependencies.json'), JSON.stringify(result, null, 2)),
    writeFile(join(outputDir, 'recommended-package.json'), JSON.stringify(recommendedManifest, null, 2) + '\n'),
    writeFile(join(outputDir, 'compatibility-report.json'), JSON.stringify({ project: report.projectPath, generatedAt: new Date().toISOString(), nodeVersion: report.nodeVersion, npmVersion: report.npmVersion, totalDependencies: report.totalDependencies, ...result }, null, 2)),
    writeFile(join(outputDir, 'compatibility-report.txt'), renderText(report, result))
  ]);
  console.log(`Status: ${result.status}; search nodes: ${result.searchedNodes}; reports: ${outputDir}`);
  if ((options.validate && result.status !== 'validated') || result.status === 'conflict' || result.status === 'validation-failed' ||
    (result.status === 'search-limit' && !Object.keys(result.selected).length)) process.exitCode = 2;
}
