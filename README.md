# Dependency Compatibility Analyzer

This Node.js CLI inspects a project's direct dependencies, collects release metadata from the npm registry, searches for newer combinations, and optionally asks npm to resolve each candidate in an isolated temporary directory. It produces a proposed manifest and both machine-readable and human-readable reports. The target project's files are never changed.

## Install and run

Requires Node.js 20 or newer and npm. In this repository:

```sh
npm install
npm run analyze -- "C:\Projects\my-app"
npm run resolve
npm run resolve:validate
```

Reports are written to `output/` by default. Equivalent commands:

```sh
node index.js --project "C:\Projects\my-app" --output output --candidate-limit 10 --max-candidates 60
node resolve.js --metadata output/dependency-metadata.json --output output --max-nodes 5000
node resolve.js --project "C:\Projects\my-app" --validate --max-validations 8
node resolve.js --help
```

`resolve.js --project` refreshes metadata before resolving. `resolve.js` without `--project` uses the last saved metadata. Use `--include-prerelease` during analysis to collect prereleases; resolving an older metadata file cannot recover releases that were never collected. `--node-version` filters candidate Node engines, while npm validation runs with the machine's actual Node/npm versions, so a cross-version recommendation cannot be validated locally for the other runtime. `--verbose` prints collection and expansion progress. `--concurrency`, `--timeout`, `--candidate-limit`, `--max-candidates`, `--max-nodes`, and `--max-validations` bound work.

## Outputs

| File | Purpose |
| --- | --- |
| `dependency-metadata.json` | Original manifest, specifications, registry release history, peer/dependency/engine/platform data, deprecations, and collection errors. |
| `recommended-dependencies.json` | Search result, selected versions, diagnostics, npm validation result, and search limits. |
| `recommended-package.json` | Copy of the original manifest with only explicitly recommended SemVer dependency versions changed. |
| `compatibility-report.txt` | Readable comparison and conflict report. |
| `compatibility-report.json` | Structured report with project and runtime context. |

A report row distinguishes the **latest published** release from the latest release **permitted by the original manifest** and the **recommended** release. For example, `typescript: ^5.0.0 -> 5.9.0 | published: 7.0.2 | permitted: 5.9.0` means the manifest range and peer constraints are separate limits. A `validated` status means npm resolved the proposed manifest. It does not mean the application runs correctly. Run its build and tests and review major-version migration guides before adopting changes.

## How resolution works

The reader validates `package.json` and detects a package listed in multiple direct sections. The collector requests full npm packuments with bounded concurrency, timeouts, retries, and in-memory caching; it saves up to `--max-candidates` stable releases per package, newest first. The report's latest published version is the highest included SemVer release; the npm `latest` dist-tag is stored separately. Initial search uses `--candidate-limit` releases and expands in ten-release steps if needed.

The local search checks direct peer relationships, Node/npm engines, and platform metadata. Optional peers constrain an installed direct peer but do not require an absent one. Platform-specific optional dependencies are retained in the manifest and skipped on incompatible platforms. The search backtracks, checks remaining domains, and records peer conflicts. Its deterministic objective is: maximize the number of selected packages at their latest published version, then prefer newer releases in original manifest order, then prefer nondeprecated releases. Search and validation budgets can truncate exploration; `search-limit` and `optimalityProven: false` make that explicit. A proof applies only to the collected history and local constraints.

npm's resolver handles transitive dependencies, nested versions, required external peers, aliases, overrides, optional installation behavior, and other npm-specific rules. With `--validate`, each promising candidate is written to a temporary directory and checked using `npm install --package-lock-only --ignore-scripts --strict-peer-deps --engine-strict --no-audit --no-fund`. Failed resolutions are recorded and the search tries alternatives until its limits are reached. The temporary directory is removed in all cases. No `--force` or `--legacy-peer-deps` is used. `--ignore-scripts` suppresses lifecycle scripts during this check; npm still fetches packages and metadata. Git or local dependencies can require manual validation in the original project context.

## Specifications and statuses

SemVer ranges, including valid `||` alternatives, are evaluated locally. For a mixed peer specification such as `>=3.0.0 || insiders`, the valid branch is honored; if it does not match, the unknown branch stays unresolved and npm must decide. Dist-tags, npm aliases, Git references, local paths, workspace specifications, and other unsupported direct specifications are classified and preserved. They are never silently rewritten. A partially interpreted constraint appears in diagnostics.

Statuses are `validated`, `peer-compatible-candidate`, `conflict`, `incomplete-metadata`, `search-limit`, `validation-failed`, and `manual-migration-required`. `peer-compatible-candidate` is a local-search result awaiting npm validation. `conflict` means no solution within the collected candidates and supported local constraints; it is not a global impossibility proof. `incomplete-metadata` reflects missing registry data. `manual-migration-required` flags preserved specifications or constraints that cannot be interpreted locally. A failed npm attempt or exhausted budget never becomes `validated`.

## Troubleshooting and limits

- If metadata collection fails, check registry access and rerun analysis. Failed packages and the error remain in the report.
- If search reaches its limit, increase `--max-nodes`, `--max-candidates`, or `--max-validations` as appropriate. Larger limits increase registry data and npm work.
- When a newest release is blocked, inspect `DIAGNOSTICS` for the package and peer range, then inspect the npm validation log for transitive conflicts.
- npm validation uses a temporary copy of the manifest. Relative `file:` or workspace links, project `.npmrc`, lockfile state, and custom registries may need validation in a copy of the full project. The current validator does not reproduce all project-local settings.
- npm's successful dependency resolution does not prove runtime or source-level compatibility. The proposed manifest is a review artifact; apply it to a branch and run application tests.

Run `npm test` for deterministic reader, spec, registry, resolver, report, and cleanup tests. The suite uses mocked registry responses; it does not depend on live npm availability.
