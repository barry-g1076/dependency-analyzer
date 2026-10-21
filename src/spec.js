import semver from 'semver';

export function classifySpec(spec) {
  if (typeof spec !== 'string') return { type: 'unsupported', spec, diagnostic: 'non-string specification' };
  if (spec.startsWith('npm:')) {
    const match = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(spec);
    return match ? { type: 'alias', name: match[1], range: match[2], spec } : { type: 'unsupported', spec, diagnostic: 'invalid npm alias' };
  }
  if (/^(file:|link:|\.\.?[\\/]|\/)/.test(spec)) return { type: 'local', spec };
  if (spec.startsWith('workspace:')) return { type: 'workspace', spec };
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:.*\.git)/.test(spec)) return { type: 'git', spec };
  const parts = spec.split('||').map(x => x.trim());
  const valid = parts.filter(x => semver.validRange(x) !== null);
  const unknown = parts.filter(x => semver.validRange(x) === null);
  if (!unknown.length) return { type: 'semver', spec, ranges: valid };
  if (valid.length) return { type: 'partial-or', spec, ranges: valid, unknown, diagnostic: `Unresolved OR alternatives: ${unknown.join(', ')}` };
  if (/^[a-z][a-z0-9._-]*$/i.test(spec)) return { type: 'tag', spec };
  return { type: 'unsupported', spec, diagnostic: 'unsupported dependency specification' };
}

// true, false, or null (npm must decide). Unknown OR alternatives never become false.
export function matchSpec(version, spec, options = {}) {
  const parsed = typeof spec === 'string' ? classifySpec(spec) : spec;
  if (parsed.ranges?.some(range => semver.satisfies(version, range, options))) return true;
  if (parsed.type === 'semver') return false;
  return null;
}
