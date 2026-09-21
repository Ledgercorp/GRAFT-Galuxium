// Detects a feature-flags capability in LIBRARY form: a reusable module whose public API decides
// whether a named feature is on for some context. No HTTP route is required, because a library has
// none.
//
// Everything here is structural — the shapes of exported functions and their parameters, read from
// the code. Nothing keys on a repository, package name, author or README: a package called
// "feature-flags" with no evaluation API is not a capability, and a package called anything at all
// with one is. Names of API members are read only as part of a signature (a name AND a parameter
// shape AND corroboration), never on their own.
//
// The signature, all of which must hold:
//
//   library-entry      package.json points at a committed JavaScript artifact that exists
//   no-http-surface    the project registers no routes of its own (a service is the other detector)
//   at least two of:
//     feature-predicate   a function asking whether a named feature is on: enabled(slug, …)
//     feature-selection   a function taking a feature name plus two alternatives: invoke(slug, a, b)
//     feature-registry    a construct built from a map of features: FeatureMap(map)
//
// One signal is never enough. A configuration library has `get(key)`; a strategy library has
// `run(name, a, b)`; neither carries the others, so neither is a feature-flags capability here.
import path from 'node:path';
import { parseJavaScript, walkNodes } from '../../emit/entrypoint.js';

// Parameter names that denote "which feature" — the identifier a caller passes to ask about one
// named feature. Deliberately narrow: `name` and `key` are excluded because every library uses them.
const FEATURE_PARAM = /^(slug|feature|features?name|featureflag|flag|toggle|featureid|featurekey)$/i;
// Function names that denote an enablement question. Narrow, and never sufficient alone.
const PREDICATE_NAME = /^(enabled|isenabled|isactive|ison|isfeatureenabled|featureenabled|isallowed|active)$/i;
// Parameter names that denote a map of features supplied as configuration.
const REGISTRY_PARAM = /^(map|features|flags|toggles|featuremap|featureflags|config(uration)?)$/i;
const REGISTRY_NAME = /^(featuremap|featureregistry|flagmap|togglemap|featureconfig|flagregistry)$/i;

const MAX_FILES = 60;
const MAX_BYTES = 600 * 1024;
const isProduction = (file) => !/(^|\/)(test|tests|spec|specs|__tests__|examples?|docs?|benchmarks?)\//i.test(file) && !/\.(test|spec)\.[cm]?jsx?$/i.test(file);

/** Every function-ish node with a name and parameter names, from one source file. */
function functionsIn(source) {
  const ast = parseJavaScript(source);
  if (!ast) return [];
  const found = [];
  const params = (node) => (node.params || []).map((p) => (p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : null));
  walkNodes(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) found.push({ name: n.id.name, params: params(n) });
    else if (n.type === 'MethodDefinition' && n.key && !n.computed) found.push({ name: n.key.name || n.key.value, params: params(n.value) });
    else if (n.type === 'Property' && !n.computed && n.value && ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.value.type)) found.push({ name: n.key.name || n.key.value, params: params(n.value) });
    else if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.init.type)) found.push({ name: n.id.name, params: params(n.init) });
    else if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.property?.name && n.right && ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.right.type)) {
      // `X.prototype.enabled = function enabled(slug, index) {}` — the common pre-class shape.
      found.push({ name: n.left.property.name, params: params(n.right) });
    }
  });
  return found;
}

/** The library's own entry artifact, as package.json declares it. */
function entryArtifact(fp) {
  const pkg = fp.packageJson || {};
  const candidates = [];
  const add = (value) => { if (typeof value === 'string' && /\.[cm]?js$/.test(value)) candidates.push(value.replace(/^\.\//, '')); };
  add(pkg.main); add(pkg.module);
  const exports_ = pkg.exports;
  const walkExports = (value, depth = 0) => {
    if (depth > 4) return;
    if (typeof value === 'string') return add(value);
    if (value && typeof value === 'object') for (const v of Object.values(value)) walkExports(v, depth + 1);
  };
  walkExports(exports_);
  // A published library's entry is often a committed build artifact, which the fingerprint keeps out
  // of the source file list on purpose. Readability is the honest test: package.json names it and
  // GRAFT can read it.
  for (const candidate of candidates) { if (fp.files.includes(candidate)) return candidate; try { if ((fp.readFile(candidate) || '').length) return candidate; } catch { /* unreadable */ } }
  return null;
}

export function detect(fp) {
  const signals = [];
  const absent = [];
  const entry = entryArtifact(fp);
  if (entry) signals.push({ id: 'library-entry', evidence: `package.json points at ${entry}, which is present and readable` });
  else absent.push('a committed JavaScript entry artifact named by package.json');
  // A project that serves its own routes is a service; the service detector owns that shape.
  const serves = (fp.routes || []).length > 0 || fp.hasHttpServer === true || (fp.serverSignals || []).length > 0;
  if (!serves) signals.push({ id: 'no-http-surface', evidence: 'the project registers no HTTP routes of its own' });

  // Read the entry artifact first, then the project's other production sources, bounded.
  const files = [entry, ...(fp.files || []).filter((f) => /\.[cm]?js$/.test(f) && isProduction(f) && f !== entry)].filter(Boolean).slice(0, MAX_FILES);
  let budget = MAX_BYTES;
  const predicate = [], selection = [], registry = [];
  for (const file of files) {
    const source = fp.readFile(file) || '';
    if (!source || source.length > budget) break;
    budget -= source.length;
    for (const fn of functionsIn(source)) {
      const first = fn.params[0];
      // Asking whether one named feature is on.
      if (PREDICATE_NAME.test(fn.name || '') && first && FEATURE_PARAM.test(first)) predicate.push({ file, evidence: `${fn.name}(${fn.params.filter(Boolean).join(', ')}) in ${file}` });
      // Choosing between two outcomes for one named feature.
      if (first && FEATURE_PARAM.test(first) && fn.params.length >= 3 && fn.params.slice(1, 3).every(Boolean)) selection.push({ file, evidence: `${fn.name}(${fn.params.filter(Boolean).join(', ')}) in ${file}` });
      // A construct built from a map of features.
      if ((REGISTRY_NAME.test(fn.name || '') && first) || (first && REGISTRY_PARAM.test(first) && REGISTRY_NAME.test(fn.name || ''))) registry.push({ file, evidence: `${fn.name}(${fn.params.filter(Boolean).join(', ')}) in ${file}` });
    }
  }
  if (predicate.length) signals.push({ id: 'feature-predicate', evidence: predicate[0].evidence });
  else absent.push('a function asking whether a named feature is enabled');
  if (selection.length) signals.push({ id: 'feature-selection', evidence: selection[0].evidence });
  else absent.push('a function choosing between outcomes for a named feature');
  if (registry.length) signals.push({ id: 'feature-registry', evidence: registry[0].evidence });
  else absent.push('a construct built from a map of features');

  const corroborating = [predicate.length, selection.length, registry.length].filter(Boolean).length;
  const found = Boolean(entry) && !serves && corroborating >= 2;
  if (!found) {
    return { category: 'feature-flags', implementationForm: 'library', found: false, signals, absent,
      ambiguous: Boolean(entry) && !serves && corroborating === 1, reason: !entry ? 'no committed library entry artifact' : serves ? 'the project serves its own HTTP routes; this is service form' : corroborating === 1 ? 'only one feature-evaluation signal; the evidence is ambiguous' : 'no feature-evaluation API found' };
  }
  return {
    category: 'feature-flags', implementationForm: 'library', found: true,
    confidence: corroborating === 3 ? 'high' : 'medium',
    signals, absent,
    entry, entryDirectory: path.posix.dirname(entry),
    api: { predicate: predicate.map((p) => p.evidence).slice(0, 4), selection: selection.map((p) => p.evidence).slice(0, 4), registry: registry.map((p) => p.evidence).slice(0, 4) },
    packageName: fp.packageJson?.name || null, packageVersion: fp.packageJson?.version || null,
    moduleSystem: fp.moduleSystem?.value || null, runtime: fp.packageJson?.engines?.node || null,
    runtimeDependencies: (fp.dependencies || []).map((d) => (typeof d === 'string' ? d : d.name)).filter(Boolean),
  };
}

export const meta = {
  category: 'feature-flags',
  implementationForm: 'library',
  displayName: 'Feature flags',
  harvestable: true,
  describe(result) {
    const parts = [`library API in ${result.entry}`];
    if (result.api.predicate.length) parts.push('feature predicate');
    if (result.api.selection.length) parts.push('outcome selection');
    if (result.api.registry.length) parts.push('feature map');
    return parts.join(', ');
  },
};
