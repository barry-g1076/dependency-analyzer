import semver from 'semver';
import { classifySpec, matchSpec } from './spec.js';

function platformAllowed(list, value) {
  if (!Array.isArray(list) || !list.length) return true;
  if (list.includes(`!${value}`)) return false;
  const positives = list.filter(x => !x.startsWith('!'));
  return !positives.length || positives.includes(value);
}

function candidateConflict(aName, a, bName, b, diagnostics) {
  for (const [owner, candidate, peerName, peer] of [[aName, a, bName, b], [bName, b, aName, a]]) {
    const range = candidate.peerDependencies?.[peerName];
    if (!range) continue;
    const match = matchSpec(peer.version, range);
    if (match === false) {
      diagnostics.add(`${owner}@${candidate.version} requires peer ${peerName}@${range}; selected ${peer.version}`);
      return true;
    }
    if (match === null) diagnostics.add(`${owner}@${candidate.version}: peer ${peerName}@${range} needs npm interpretation`);
  }
  return false;
}

export function makeRecommendedManifest(manifest, recommendations) {
  const copy = structuredClone(manifest);
  for (const item of recommendations) if (item.version && item.change && item.status !== 'duplicate-declaration' &&
    (item.declarations?.length ?? 1) === 1) {
    copy[item.section] ??= {};
    copy[item.section][item.name] = item.version;
  }
  return copy;
}

/** npm handles nested dependencies, optional peers, aliases, overrides and placement. */
export async function resolveRecommendations(report, {
  nodeVersion = process.version, npmVersion = null, maxNodes = 5000,
  initialCandidates = 10, expansionStep = 10, maxCandidates = 60,
  maxValidations = 8, validator = null, platform = process.platform, arch = process.arch,
  verbose = false
} = {}) {
  const diagnostics = new Set();
  const packages = report.packages ?? [];
  const unresolvedDuplicates = packages.filter(p => p.status === 'duplicate-declaration').map(p => ({
    name: p.name, declarations: p.declarations ?? []
  }));
  const platformOmitted = packages.filter(p => p.section === 'optionalDependencies' && (p.candidateHistory ?? p.candidates)?.length &&
    (p.candidateHistory ?? p.candidates).every(c => !platformAllowed(c.os, platform) || !platformAllowed(c.cpu, arch)));
  for (const p of platformOmitted) diagnostics.add(`${p.name}: optional platform package skipped on ${platform}/${arch}; original specification preserved`);
  const supported = packages.filter(p => !platformOmitted.includes(p) && p.status === 'analyzed' && (p.candidateHistory ?? p.candidates)?.length);
  const unsupported = packages.filter(p => !supported.includes(p) && !platformOmitted.includes(p));
  for (const p of unsupported) {
    if (p.status === 'duplicate-declaration') diagnostics.add(`${p.name}: duplicate-declaration warning (${(p.declarations ?? []).map(d => `${d.section} ${d.requestedRange}`).join('; ')}); original declarations preserved; manual cleanup required`);
    else diagnostics.add(`${p.name}: ${p.message ?? p.error ?? p.status ?? 'missing metadata'}; original specification preserved`);
  }
  const names = supported.map(p => p.name);
  const byName = new Map(supported.map(p => [p.name, p]));
  const direct = new Set(packages.map(p => p.name));
  let searchedNodes = 0, validations = 0, limitReached = false, candidateDepth = 0;
  let best = null, bestScore = null, bestValidation = null;
  let lastFailure = null;

  function score(selection) {
    const rank = names.map(name => {
      const p = byName.get(name), c = selection.get(name);
      const all = p.candidateHistory ?? p.candidates;
      return { latest: c.version === p.latest ? 1 : 0, maintained: c.deprecated ? 0 : 1, rank: -all.findIndex(x => x.version === c.version) };
    });
    return [rank.reduce((sum, x) => sum + x.latest, 0), ...rank.map(x => x.rank), rank.reduce((sum, x) => sum + x.maintained, 0)];
  }
  function better(a, b) {
    if (!b) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }
  function recommendations(selection) {
    return packages.map(p => {
      if (p.status === 'duplicate-declaration') return { name: p.name, section: null, original: null,
        declarations: p.declarations ?? [], version: null, latestPublished: null, latestPermitted: null,
        deprecated: null, change: false, status: 'duplicate-declaration', peerDependencies: {} };
      const c = selection.get(p.name);
      const spec = classifySpec(p.requestedRange);
      const latestPermitted = (p.candidateHistory ?? p.candidates ?? []).find(x => matchSpec(x.version, spec) === true)?.version ?? null;
      return { name: p.name, section: p.section ?? (p.type === 'development' ? 'devDependencies' : 'dependencies'), original: p.requestedRange,
        declarations: p.declarations ?? [{ section: p.section ?? (p.type === 'development' ? 'devDependencies' : 'dependencies'), requestedRange: p.requestedRange }],
        version: c?.version ?? null, latestPublished: p.latest ?? null, latestPermitted, deprecated: c?.deprecated ?? null,
        change: !!c && spec.type === 'semver' && p.requestedRange !== c.version,
        status: c ? 'recommended' : 'preserved', peerDependencies: c?.peerDependencies ?? {} };
    });
  }

  for (let depth = initialCandidates; depth <= maxCandidates; depth += expansionStep) {
    candidateDepth = depth;
    const domains = new Map();
    let empty = false;
    for (const p of supported) {
      const all = p.candidateHistory ?? p.candidates;
      const candidates = all.slice(0, depth).filter(c => {
        if (c.engines?.node && matchSpec(semver.coerce(nodeVersion)?.version ?? nodeVersion, c.engines.node) === false) return false;
        if (c.engines?.npm && npmVersion && matchSpec(npmVersion, c.engines.npm) === false) return false;
        return platformAllowed(c.os, platform) && platformAllowed(c.cpu, arch);
      });
      if (!candidates.length) { empty = true; diagnostics.add(`${p.name}: no candidates compatible with Node ${nodeVersion}, npm ${npmVersion ?? 'unknown'}, ${platform}/${arch} in first ${depth} releases`); }
      domains.set(p.name, candidates);
    }
    if (empty) {
      if (supported.every(p => (p.candidateHistory ?? p.candidates).length <= depth)) break;
      continue;
    }
    const assignment = new Map();
    const ordered = names.slice().sort((a, b) => {
      const peers = n => domains.get(n).reduce((sum, c) => sum + Object.keys(c.peerDependencies ?? {}).filter(x => direct.has(x)).length, 0);
      return peers(b) - peers(a) || domains.get(a).length - domains.get(b).length || a.localeCompare(b);
    });
    let stop = false;
    async function dfs(index) {
      if (stop) return;
      if (searchedNodes >= maxNodes) { limitReached = true; stop = true; return; }
      searchedNodes++;
      if (index === ordered.length) {
        const value = score(assignment);
        if (!better(value, bestScore)) return;
        const proposed = recommendations(assignment);
        let validation = null;
        if (validator) {
          if (validations >= maxValidations) { limitReached = true; stop = true; return; }
          validations++;
          validation = await validator(makeRecommendedManifest(report.manifest ?? {}, proposed));
          if (unresolvedDuplicates.length) validation = { ...validation, duplicateDeclarationsUnresolved: true };
          if (!validation.passed) {
            lastFailure = validation;
            diagnostics.add(`npm validation ${validations} failed: ${validation.conflict ?? validation.summary ?? 'unknown conflict'}`);
            return;
          }
        }
        best = new Map(assignment); bestScore = value; bestValidation = validation;
        if (value[0] === names.length) stop = true;
        return;
      }
      const name = ordered[index];
      for (const c of domains.get(name)) {
        if ([...assignment].some(([other, selected]) => candidateConflict(name, c, other, selected, diagnostics))) continue;
        assignment.set(name, c);
        let viable = true;
        for (const later of ordered.slice(index + 1)) {
          if (!domains.get(later).some(other => ![...assignment].some(([assignedName, selected]) => candidateConflict(later, other, assignedName, selected, diagnostics)))) {
            viable = false; break;
          }
        }
        if (viable) await dfs(index + 1);
        assignment.delete(name);
        if (stop) break;
      }
    }
    await dfs(0);
    if (limitReached || (best && bestScore[0] === names.length)) break;
    if (supported.every(p => (p.candidateHistory ?? p.candidates).length <= depth)) break;
    if (verbose) process.stderr.write(`Expanded candidate history to ${Math.min(depth + expansionStep, maxCandidates)} releases\n`);
  }

  const selected = best ?? new Map();
  const recs = recommendations(selected);
  const externalPeers = [];
  for (const [name, c] of selected) for (const [peer, range] of Object.entries(c.peerDependencies ?? {})) {
    if (!direct.has(peer)) externalPeers.push({ source: `${name}@${c.version}`, peer, range, optional: !!c.peerDependenciesMeta?.[peer]?.optional });
  }
  for (const item of externalPeers.filter(x => !x.optional)) diagnostics.add(`${item.source} requires external peer ${item.peer}@${item.range}; npm validation required`);
  const incomplete = unsupported.length > 0 || packages.some(p => (p.candidateHistory ?? p.candidates ?? []).length < (p.totalVersions ?? 0));
  const missingMetadata = unsupported.some(p => p.status !== 'unsupported-specification' && p.status !== 'duplicate-declaration');
  const unresolvedSelected = [...selected].some(([name, c]) => [...selected].some(([peerName, peer]) =>
    !!c.peerDependencies?.[peerName] && matchSpec(peer.version, c.peerDependencies[peerName]) === null));
  const manual = unsupported.some(p => p.status === 'unsupported-specification') || unresolvedSelected || unresolvedDuplicates.length > 0;
  const status = best ? (unresolvedDuplicates.length ? 'manual-migration-required' : bestValidation?.passed ? 'validated' : limitReached ? 'search-limit' : missingMetadata ? 'incomplete-metadata' : manual ? 'manual-migration-required' : 'peer-compatible-candidate')
    : limitReached ? 'search-limit' : lastFailure ? 'validation-failed' : missingMetadata ? 'incomplete-metadata' : manual ? 'manual-migration-required' : incomplete ? 'search-limit' : 'conflict';
  return { status, searchedNodes, maxNodes, validations, maxValidations, candidateDepth, searchComplete: !limitReached && !incomplete,
    optimalityProven: !!best && !limitReached && !unresolvedDuplicates.length && (bestScore[0] === names.length || !incomplete),
    recommendations: recs, unresolvedDuplicates, selected: Object.fromEntries([...selected].map(([n, c]) => [n, c.version])),
    diagnostics: [...diagnostics].slice(0, 300), externalPeers, validation: bestValidation ?? lastFailure,
    caveat: 'npm validation checks install resolution only; run the application build and tests after reviewing migration guides.' };
}
