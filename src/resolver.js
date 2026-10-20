import semver from 'semver';

const passes = (version, range) => {
  try {
    return semver.satisfies(version, range, {
      includePrerelease: true
    });
  } catch (error) {
    console.warn(
      `Unsupported version constraint: ${version} / ${range}`
    );
    return false;
  }
};

/**
 * Direct-dependency peer-compatibility search. This is NOT npm's full resolver:
 * nested packages, omitted mandatory peers, platform rules and code migration
 * are delegated to npm validation and application tests.
 */
export function resolveCandidates(report, { nodeVersion = process.version, maxNodes = 300000 } = {}) {
  const packages = report.packages;
  const names = packages.map(p => p.name);
  const direct = new Set(names);
  const domains = new Map();
  const errors = [];
  const excluded = [];
  const missingPeers = new Map();

  for (const pkg of packages) {
    if (pkg.status !== 'analyzed') {
      errors.push(`${pkg.name}: ${pkg.status} (${pkg.message ?? pkg.error ?? 'unknown'})`);
      continue;
    }
    const engineCompatible = (pkg.candidates ?? []).filter(c => {
      if (c.engines?.node && !passes(nodeVersion, c.engines.node)) {
        excluded.push(`${pkg.name}@${c.version}: Node ${nodeVersion} violates ${c.engines.node}`);
        return false;
      }
      return true;
    });
    const maintained = engineCompatible.filter(c => !c.deprecated);
    // Don't make the entire project impossible solely because every captured
    // version of a direct package is deprecated. Keep it, but flag migration.
    const candidates = (maintained.length ? maintained : engineCompatible)
      .sort((a,b) => semver.rcompare(a.version,b.version));
    if (!maintained.length && engineCompatible.length) {
      excluded.push(`${pkg.name}: all captured viable releases are deprecated; replacement recommended`);
    }
    if (!candidates.length) errors.push(`${pkg.name}: no usable candidates in collected metadata`);
    domains.set(pkg.name, candidates);
  }
  if (errors.length) return { status: 'incomplete', errors, excluded, searchedNodes: 0 };

  const compatiblePair = (nameA, candA, nameB, candB) => {
    const rangeA = candA.peerDependencies?.[nameB];
    const rangeB = candB.peerDependencies?.[nameA];
    return (!rangeA || passes(candB.version, rangeA)) &&
           (!rangeB || passes(candA.version, rangeB));
  };

  // Most connected packages first; forward-check each remaining domain.
  const degree = new Map(names.map(name => [name, 0]));
  for (const name of names) {
    for (const c of domains.get(name)) {
      for (const peer of Object.keys(c.peerDependencies ?? {})) {
        if (direct.has(peer)) degree.set(name, degree.get(name) + 1);
      }
    }
  }

  let nodes = 0, exhausted = false;
  const assigned = new Map();
  let solution = null;

  function dfs(remaining) {
    if (++nodes > maxNodes) { exhausted = true; return false; }
    if (!remaining.length) { solution = new Map(assigned); return true; }
    const choice = remaining.slice().sort((a,b) => {
      const da = domains.get(a).length, db = domains.get(b).length;
      return da - db || degree.get(b) - degree.get(a);
    })[0];
    const rest = remaining.filter(n => n !== choice);
    for (const candidate of domains.get(choice)) {
      let valid = true;
      for (const [other, selected] of assigned) {
        if (!compatiblePair(choice,candidate,other,selected)) { valid = false; break; }
      }
      if (!valid) continue;
      const changed = [];
      for (const other of rest) {
        const before = domains.get(other);
        const after = before.filter(c => compatiblePair(choice,candidate,other,c));
        if (!after.length) { valid = false; break; }
        if (after.length !== before.length) {
          changed.push([other,before]); domains.set(other,after);
        }
      }
      if (valid) {
        assigned.set(choice,candidate);
        if (dfs(rest)) return true;
        assigned.delete(choice);
      }
      for (const [other,before] of changed) domains.set(other,before);
      if (exhausted) return false;
    }
    return false;
  }

  dfs(names);
  if (!solution) {
    return { status: exhausted ? 'search-limit' : 'no-solution-in-collected-candidates',
      searchedNodes:nodes, maxNodes, excluded,
      errors: [exhausted ? 'Search budget exceeded; no conclusion.' : 'No peer-compatible combination found in the collected candidates. Expand candidate history.'] };
  }

  const selected = Object.fromEntries([...solution].map(([n,c]) => [n,c.version]));
  const packagesByName = new Map(packages.map(p => [p.name,p]));
  const recommendations = names.map(name => {
    const c = solution.get(name);
    const pkg = packagesByName.get(name);
    for (const [peer,range] of Object.entries(c.peerDependencies ?? {})) {
      if (!direct.has(peer)) {
        const optional = !!c.peerDependenciesMeta?.[peer]?.optional;
        const key = `${name}@${c.version} -> ${peer}@${range}${optional ? ' (optional)' : ''}`;
        missingPeers.set(key, { source:name, peer, range, optional });
      }
    }
    return { name, type:pkg.type, original:pkg.requestedRange, version:c.version,
      latestInReport:pkg.latest, peerDependencies:c.peerDependencies ?? {},
      engines:c.engines ?? {}, isLatest:c.version === pkg.latest };
  });
  return { status:'peer-compatible-candidate', searchedNodes:nodes, maxNodes,
    nodeVersion, selected, recommendations, excluded,
    externalPeers:[...missingPeers.values()],
    caveat:'First compatible result, not a proven globally newest combination; only captured direct peers are checked.' };
}
