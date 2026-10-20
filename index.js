import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import semver from "semver";

import { readDependencies } from "./src/reader.js";
import { getPackageMetadata } from "./src/registry.js";

const projectPath = resolve(process.argv[2] ?? ".");

async function main() {
  console.log(`Analyzing project: ${projectPath}`);

  const dependencies = await readDependencies(projectPath);

  console.log(`Found ${dependencies.length} dependencies`);

  const results = [];

  for (const [index, dependency] of dependencies.entries()) {
    console.log(
      `[${index + 1}/${dependencies.length}] ${dependency.name}`
    );

    if (!semver.validRange(dependency.requestedRange)) {
      results.push({
        ...dependency,
        status: "unsupported-specification",
        message: "Requires special handling",
        candidates: []
      });

      continue;
    }

    try {
      const metadata = await getPackageMetadata(
        dependency.name,
        10
      );

      results.push({
        ...dependency,
        status: "analyzed",
        latest: metadata.latest,
        candidates: metadata.candidates.map(candidate => ({
          ...candidate,
          satisfiesOriginalRange: semver.satisfies(
            candidate.version,
            dependency.requestedRange
          )
        }))
      });
    } catch (error) {
      console.error(`Failed: ${dependency.name}: ${error.message}`);

      results.push({
        ...dependency,
        status: "error",
        error: error.message,
        candidates: []
      });
    }
  }

  const report = {
    projectPath,
    generatedAt: new Date().toISOString(),
    totalDependencies: dependencies.length,
    packages: results
  };

  const outputDir = join(process.cwd(), "output");

  await mkdir(outputDir, { recursive: true });

  const outputFile = join(
    outputDir,
    "dependency-metadata.json"
  );

  await writeFile(
    outputFile,
    JSON.stringify(report, null, 2)
  );

  console.log(`\nReport generated: ${outputFile}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});