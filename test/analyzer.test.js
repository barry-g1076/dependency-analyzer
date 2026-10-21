import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProject } from '../src/reader.js';
import { classifySpec, matchSpec } from '../src/spec.js';
import { getPackageMetadata, clearRegistryCache } from '../src/registry.js';
import { resolveRecommendations, makeRecommendedManifest } from '../src/resolver.js';
import { validateWithNpm, parseNpmConflict } from '../src/validation.js';
import { run } from '../src/cli.js';

const candidate = (version, peers = {}, extra = {}) => ({ version, peerDependencies: peers, ...extra });
const pkg = (name, versions, extra = {}) => ({ name, section: 'dependencies', type: 'production', requestedRange: '*', status: 'analyzed',
  latest: versions[0].version, candidateHistory: versions, candidates: versions.slice(0, 1), totalVersions: versions.length, ...extra });
const report = packages => ({ manifest: { name: 'fixture', version: '1.0.0', scripts: { test: 'true' }, dependencies: Object.fromEntries(packages.map(p => [p.name, p.requestedRange])) }, packages });

test('reader errors and manifest preservation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyzer-reader-'));
  try {
    await assert.rejects(readProject(dir), /Failed to read/);
    await writeFile(join(dir, 'package.json'), '{');
    await assert.rejects(readProject(dir), /Failed to read/);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    assert.deepEqual((await readProject(dir)).dependencies, []);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@scope/a': '^1.0.0' }, devDependencies: { '@scope/a': '^2.0.0' } }));
    await assert.rejects(readProject(dir), /Duplicate dependency/);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@scope/a': '^1.0.0' }, scripts: { build: 'echo yes' } }));
    assert.equal((await readProject(dir)).dependencies[0].name, '@scope/a');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('specifications, prereleases and partial OR peer regression', () => {
  assert.equal(matchSpec('4.1.0', '>=3.0.0 || insiders'), true);
  assert.equal(matchSpec('2.0.0', '>=3.0.0 || insiders'), null);
  assert.equal(matchSpec('2.0.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(matchSpec('3.0.0', '^1.0.0 || ^2.0.0'), false);
  assert.equal(matchSpec('2.0.0-beta.1', '^2.0.0'), false);
  assert.equal(matchSpec('2.0.0-beta.1', '>=2.0.0-beta.1 <2.0.0'), true);
  for (const [spec, type] of [['npm:real@^1', 'alias'], ['file:../local', 'local'], ['workspace:*', 'workspace'], ['git+https://example.com/x.git', 'git'], ['latest', 'tag']]) assert.equal(classifySpec(spec).type, type);
});

test('scoped registry metadata, deprecation, prereleases, cache and failures', async () => {
  clearRegistryCache();
  let calls = 0;
  const mock = async url => {
    calls++;
    assert.match(url, /%40scope%2Fpkg/);
    return { ok: true, json: async () => ({ 'dist-tags': { latest: '3.0.0' }, versions: {
      '3.0.0': { deprecated: 'use next', peerDependencies: { x: '^2' } },
      '2.0.0': { engines: { node: '>=20' } }, '2.0.0-beta.1': {}, '1.0.0': {}
    } }) };
  };
  const one = await getPackageMetadata('@scope/pkg', { limit: 1, maxCandidates: 3, fetchImpl: mock });
  const two = await getPackageMetadata('@scope/pkg', { limit: 2, maxCandidates: 3, fetchImpl: mock });
  assert.equal(calls, 1);
  assert.deepEqual(one.candidates.map(x => x.version), ['3.0.0']);
  assert.deepEqual(two.candidateHistory.map(x => x.version), ['3.0.0', '2.0.0', '1.0.0']);
  assert.equal(one.candidates[0].deprecated, 'use next');
  assert.equal((await getPackageMetadata('@scope/pkg', { includePrerelease: true, fetchImpl: mock })).totalVersions, 4);
  clearRegistryCache();
  await assert.rejects(getPackageMetadata('missing', { retries: 0, fetchImpl: async () => ({ ok: false, status: 404 }) }), /404/);
  await assert.rejects(getPackageMetadata('network', { retries: 0, fetchImpl: async () => { throw new Error('network down'); } }), /network down/);
  await assert.rejects(getPackageMetadata('broken', { retries: 0, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /Missing version metadata/);
});

test('backtracking, older history, optional peers and Tailwind OR regression', async () => {
  const packages = [
    pkg('tailwindcss', [candidate('4.0.0'), candidate('3.4.0')]),
    pkg('tailwindcss-animate', [candidate('1.0.7', { tailwindcss: '>=3.0.0 || insiders' })]),
    pkg('typescript', [candidate('7.0.0'), candidate('5.9.0')]),
    pkg('typescript-eslint', [candidate('8.0.0', { typescript: '>=4.8.4 <6.0.0' })]),
    pkg('optional', [candidate('1.0.0', { absent: '^1' }, { peerDependenciesMeta: { absent: { optional: true } } })])
  ];
  const result = await resolveRecommendations(report(packages), { initialCandidates: 1, expansionStep: 1, maxCandidates: 2, maxNodes: 500 });
  assert.equal(result.selected.tailwindcss, '4.0.0');
  assert.equal(result.selected.typescript, '5.9.0');
  assert.equal(result.externalPeers[0].optional, true);
  assert.equal(result.status, 'peer-compatible-candidate');
  assert.equal(result.candidateDepth, 2);
});

test('engine and platform filtering, missing metadata, deterministic ranking', async () => {
  const packages = [pkg('a', [candidate('2.0.0', {}, { engines: { node: '>=30' } }), candidate('1.0.0')]),
    pkg('b', [candidate('2.0.0', {}, { os: ['!win32'] }), candidate('1.0.0')]),
    pkg('linux-binary', [candidate('1.0.0', {}, { os: ['linux'] })], { section: 'optionalDependencies' })];
  const options = { initialCandidates: 2, maxCandidates: 2, nodeVersion: 'v24.0.0', platform: 'win32' };
  const first = await resolveRecommendations(report(packages), options);
  const second = await resolveRecommendations(report(packages), options);
  assert.deepEqual(first.selected, second.selected);
  assert.deepEqual(first.selected, { a: '1.0.0', b: '1.0.0' });
  assert.ok(first.diagnostics.some(x => x.includes('optional platform package skipped')));
  const incomplete = await resolveRecommendations(report([...packages, { name: 'lost', requestedRange: '^1', section: 'dependencies', status: 'error', error: 'network down' }]), options);
  assert.equal(incomplete.status, 'incomplete-metadata');
});

test('deprecated releases and unsupported direct specifications are reported and preserved', async () => {
  const special = { name: 'alias', section: 'dependencies', requestedRange: 'npm:real@^1', status: 'unsupported-specification', message: 'alias preserved' };
  const fixture = report([pkg('old', [candidate('2.0.0', {}, { deprecated: 'use replacement' })]), special]);
  const result = await resolveRecommendations(fixture);
  assert.equal(result.status, 'manual-migration-required');
  assert.equal(result.recommendations.find(x => x.name === 'old').deprecated, 'use replacement');
  const proposed = makeRecommendedManifest(fixture.manifest, result.recommendations);
  assert.equal(proposed.dependencies.alias, 'npm:real@^1');
});

test('search limits and validation failures never claim validation', async () => {
  const packages = [pkg('a', [candidate('2.0.0'), candidate('1.0.0')]), pkg('b', [candidate('2.0.0'), candidate('1.0.0')])];
  const limited = await resolveRecommendations(report(packages), { maxNodes: 1, initialCandidates: 2, maxCandidates: 2 });
  assert.equal(limited.status, 'search-limit');
  assert.equal(limited.optimalityProven, false);
  const failed = await resolveRecommendations(report(packages), { maxValidations: 2, initialCandidates: 2, maxCandidates: 2, validator: async () => ({ passed: false, summary: 'ERESOLVE' }) });
  assert.notEqual(failed.status, 'validated');
  assert.ok(failed.diagnostics.some(x => x.includes('ERESOLVE')));
  const good = await resolveRecommendations(report(packages), { initialCandidates: 2, maxCandidates: 2, validator: async () => ({ passed: true, summary: 'ok' }) });
  assert.equal(good.status, 'validated');
  const manifest = makeRecommendedManifest(report(packages).manifest, good.recommendations);
  assert.equal(manifest.scripts.test, 'true');
  assert.equal(manifest.dependencies.a, '2.0.0');
  const impossible = await resolveRecommendations(report([
    pkg('core', [candidate('2.0.0')]), pkg('plugin', [candidate('1.0.0', { core: '^1.0.0' })])
  ]), { initialCandidates: 1, maxCandidates: 1 });
  assert.equal(impossible.status, 'conflict');
  assert.ok(impossible.diagnostics.some(x => x.includes('requires peer core')));
});

test('npm conflict parser and temporary validation directory cleanup', async () => {
  assert.match(parseNpmConflict('npm error peer ^5.0.0 from plugin@1.0.0\nnpm error Found: typescript@7.0.0'), /plugin@1.0.0/);
  let directory;
  const result = await validateWithNpm({ name: 'fixture', version: '1.0.0' }, { npmCommand: 'command-that-does-not-exist', onDirectory: value => { directory = value; }, timeoutMs: 1000 });
  assert.equal(result.passed, false);
  await assert.rejects(access(directory));
});

test('CLI generates the complete report set and preserves manifest fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analyzer-report-'));
  try {
    const metadata = join(directory, 'metadata.json');
    const fixture = { ...report([pkg('fixture', [candidate('2.0.0')], { requestedRange: '^1.0.0' })]),
      projectPath: directory, totalDependencies: 1, nodeVersion: 'v24.0.0', npmVersion: '11.0.0' };
    await writeFile(metadata, JSON.stringify(fixture));
    await run('resolve', ['--metadata', metadata, '--output', join(directory, 'out'), '--max-nodes', '20']);
    for (const name of ['recommended-dependencies.json', 'recommended-package.json', 'compatibility-report.txt', 'compatibility-report.json']) {
      await access(join(directory, 'out', name));
    }
    const manifest = JSON.parse(await readFile(join(directory, 'out', 'recommended-package.json'), 'utf8'));
    assert.equal(manifest.scripts.test, 'true');
    assert.equal(manifest.dependencies.fixture, '2.0.0');
    assert.match(await readFile(join(directory, 'out', 'compatibility-report.txt'), 'utf8'), /Status: peer-compatible-candidate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
