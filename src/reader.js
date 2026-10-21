import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readProject(projectPath) {
  const file = join(projectPath, 'package.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Failed to read ${file}: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${file}: expected a JSON object`);
  const dependencies = new Map();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const entries = manifest[section] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${file}: ${section} must be an object`);
    for (const [name, requestedRange] of Object.entries(entries)) {
      if (typeof requestedRange !== 'string') throw new Error(`${file}: ${section}.${name} must be a string`);
      const declaration = { section, requestedRange };
      if (dependencies.has(name)) {
        const existing = dependencies.get(name);
        existing.declarations.push(declaration);
        existing.status = 'duplicate-declaration';
        existing.requestedRange = null;
        existing.section = null;
        existing.type = null;
      } else {
        dependencies.set(name, { name, requestedRange, section,
          type: section === 'devDependencies' ? 'development' : 'production', declarations: [declaration] });
      }
    }
  }
  return { manifest, dependencies: [...dependencies.values()] };
}

export async function readDependencies(projectPath) { return (await readProject(projectPath)).dependencies; }
