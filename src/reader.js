import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readDependencies(projectPath) {
  const filePath = join(projectPath, "package.json");

  let packageJson;

  try {
    const content = await readFile(filePath, "utf8");
    packageJson = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to read ${filePath}: ${error.message}`
    );
  }

  const dependencies = new Map();

  const sections = {
    dependencies: "production",
    devDependencies: "development"
  };

  for (const [section, type] of Object.entries(sections)) {
    const packages = packageJson[section] ?? {};

    for (const [name, requestedRange] of Object.entries(packages)) {
      if (dependencies.has(name)) {
        const existing = dependencies.get(name);

        throw new Error(
          `Duplicate dependency: ${name} (${existing.type} and ${type})`
        );
      }

      dependencies.set(name, {
        name,
        requestedRange,
        type
      });
    }
  }

  return [...dependencies.values()];
}