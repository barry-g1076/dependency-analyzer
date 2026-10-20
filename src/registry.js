import semver from "semver";

const REGISTRY = "https://registry.npmjs.org";

export async function getPackageMetadata(
  packageName,
  limit = 10
) {
  const encodedName = encodeURIComponent(packageName);
  const url = `${REGISTRY}/${encodedName}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.npm.install-v1+json"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `Registry request failed for ${packageName}: ${response.status}`
    );
  }

  const data = await response.json();

  const versions = Object.keys(data.versions ?? {})
    .filter(version => semver.valid(version))
    .filter(version => !semver.prerelease(version))
    .sort(semver.rcompare)
    .slice(0, limit);

  return {
    name: packageName,
    latest: data["dist-tags"]?.latest ?? null,

    candidates: versions.map(version => {
      const metadata = data.versions[version];

      return {
        version,
        dependencies: metadata.dependencies ?? {},
        peerDependencies: metadata.peerDependencies ?? {},
        peerDependenciesMeta: metadata.peerDependenciesMeta ?? {},
        engines: metadata.engines ?? {},
        deprecated: metadata.deprecated ?? null
      };
    })
  };
}