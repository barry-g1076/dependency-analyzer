import semver from 'semver';

const REGISTRY = 'https://registry.npmjs.org';
const memory = new Map();
let customMemory = new WeakMap();

export async function getPackageMetadata(name, { limit = 10, maxCandidates = 60, includePrerelease = false, timeoutMs = 15000, retries = 2, fetchImpl = fetch } = {}) {
  const cache = fetchImpl === fetch ? memory : (customMemory.get(fetchImpl) ?? (customMemory.set(fetchImpl, new Map()), customMemory.get(fetchImpl)));
  let data = cache.get(name);
  if (!data) {
    const url = `${REGISTRY}/${encodeURIComponent(name)}`;
    let failure;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          const error = new Error(`Registry request failed for ${name}: ${response.status}`);
          if (response.status < 500 && response.status !== 429) throw Object.assign(error, { permanent: true });
          throw error;
        }
        const payload = await response.json();
        if (!payload.versions || typeof payload.versions !== 'object') throw Object.assign(new Error(`Missing version metadata for ${name}`), { permanent: true });
        data = payload;
        cache.set(name, data);
        break;
      } catch (error) {
        failure = error;
        if (error.permanent || attempt === retries) break;
        await new Promise(done => setTimeout(done, 150 * 2 ** attempt));
      }
    }
    if (!data) throw failure;
  }
  const versions = Object.keys(data.versions).filter(v => semver.valid(v) && (includePrerelease || !semver.prerelease(v))).sort(semver.rcompare);
  const history = versions.slice(0, maxCandidates).map(version => {
    const m = data.versions[version];
    return { version, dependencies: m.dependencies ?? {}, optionalDependencies: m.optionalDependencies ?? {}, peerDependencies: m.peerDependencies ?? {}, peerDependenciesMeta: m.peerDependenciesMeta ?? {}, engines: m.engines ?? {}, os: m.os ?? [], cpu: m.cpu ?? [], deprecated: m.deprecated ?? null };
  });
  return { name, latest: versions[0] ?? null, latestDistTag: data['dist-tags']?.latest ?? null,
    totalVersions: versions.length, candidateHistory: history, candidates: history.slice(0, limit) };
}

export function clearRegistryCache() { memory.clear(); customMemory = new WeakMap(); }
