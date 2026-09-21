import crypto from 'node:crypto';
import path from 'node:path';
import { emitCapability } from '../emit/index.js';
import { lowerToEmission } from '../engine/lower.js';
import { buildEngineArtifacts } from '../engine/index.js';
import { buildHostModel } from '../engine/host.js';
import { selectRecipe } from '../engine/recipes.js';
import { planEntrypointEdit } from '../emit/entrypoint.js';
import { validateManifest } from '../manifest/schema.js';
import { analyzeCompatibility } from './compatibility.js';
import { serialisableFingerprint } from '../analyze/fingerprint.js';
import { toCapabilityContract } from '../capability/contract.js';
import { compatibilityKnowledge } from '../capability/knowledge.js';
import { analyzeForHost, GRAFT_ENGINE_VERSION } from '../engine/index.js';
import { semanticSummary } from '../engine/semantic.js';

/**
 * Builds a complete, inspectable transplant plan. Produces no side effects:
 * every file is held in memory so a human, or an agent, can review the whole
 * change before anything touches the destination.
 */
// `atlas` selects Compatibility Atlas consultation: null (default, no GRAFT_HOME I/O — the
// library writes only project-local evidence), 'local' (GRAFT_HOME/atlas, used by the CLI and
// workspace), or an explicit directory.
export function createTransplantPlan(manifest, destFp, { dir = null, resolveConflicts = false, atlas = null } = {}) {
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`invalid manifest: ${validation.errors.join('; ')}`);
  // An unsupported destination, or a manifest carrying a value that cannot be safely
  // written into code, yields a plan with no files rather than an exception: the user
  // still gets the full compatibility report explaining why it cannot proceed.
  // Engine 1.1: genome -> IR -> host model -> recipe -> EmissionSpec -> emitter. The emitter
  // sees only the spec, never the manifest or source files.
  const artifacts = buildEngineArtifacts(manifest);
  const host = buildHostModel(destFp);
  const selection = selectRecipe(artifacts.ir, host);
  const context = { artifacts, host, selection };
  const registrationOf = () => { try { return lowerToEmission(artifacts.ir, host, null, { dir }).registration; } catch { return null; } };
  let emission = { profile: null, dir: dir || 'src/auth', files: [], usesSharedStore: false, registration: registrationOf(), specId: null };
  let emissionRefusal = null;
  try {
    emission = emitCapability(lowerToEmission(artifacts.ir, host, selection.recipe, { dir }));
  } catch (err) {
    if (!['unsupported-profile', 'unsupported-kind', 'unsafe-manifest-value'].includes(err.code)) throw err;
    emissionRefusal = err.message;
  }
  dir = emission.dir;
  const registration = emission.registration || { name: 'registerAuthRoutes', marker: 'authentication', defaultDir: dir };
  let entrypointRefusal = null;
  if (!emissionRefusal && destFp.entrypoint && !destFp.readFile(destFp.entrypoint)?.includes(`// >>> graft:${registration.marker}`)) {
    let routesModule = path.relative(path.dirname(destFp.entrypoint), `${dir}/routes.js`).split(path.sep).join('/');
    if (!routesModule.startsWith('.')) routesModule = './' + routesModule;
    const wanted = new Set(manifest.architecture.capabilityModel.endpoints.map((e) => `${e.method} ${e.path}`));
    const conflictingRoutes = destFp.routes.filter((r) => wanted.has(`${r.method} ${r.path}`));
    if (conflictingRoutes.some((r) => r.file !== destFp.entrypoint)) {
      entrypointRefusal = 'conflicting routes outside the entrypoint require manual integration';
    } else {
      try {
        const edit = planEntrypointEdit(destFp.readFile(destFp.entrypoint) || '', {
          routesModule, conflictingRoutes, resolveConflicts: true, profile: emission.profile, registration,
        });
        if (!edit.applied && edit.reason !== 'already-grafted') entrypointRefusal = edit.reason;
      } catch (err) {
        if (err.code !== 'unsafe-manifest-value') throw err;
        entrypointRefusal = err.message;
      }
    }
  }
  const compatibility = analyzeCompatibility(manifest, destFp, { emittedPaths: emission.files.map((f) => f.path), emissionRefusal, entrypointRefusal });

  const collisionRoutes = compatibility.collisions.map((c) => {
    const [method, ...rest] = c.split(' ');
    return { method, path: rest.join(' ') };
  });

  const needsResolution = collisionRoutes.length > 0 && !resolveConflicts;
  const status = emissionRefusal || compatibility.status === 'block' ? 'blocked' : needsResolution ? 'needs-resolution' : 'ready';

  const steps = emissionRefusal ? [] : [
    { order: 1, kind: 'create-files', description: `Write ${emission.files.length} new files under ${dir}/`, files: emission.files.map((f) => f.path) },
    ...(collisionRoutes.length
      ? [{ order: 2, kind: 'resolve-conflicts', description: `Comment out ${collisionRoutes.length} conflicting route registration(s) in ${destFp.entrypoint}`, routes: compatibility.collisions, requiresExplicitApproval: true, approved: resolveConflicts }]
      : []),
    { order: 3, kind: 'register-routes', description: emission.profile === 'esm-node-http-central' ? `Create the capability once in ${destFp.entrypoint} and give it first refusal inside the central request handler` : emission.profile === 'express-req-res' && registration.style === 'guard' ? `Create the capability once in ${destFp.entrypoint} and mount one guard middleware on the Express app before its routes` : `Import and call ${registration.name}() in ${destFp.entrypoint}`, file: destFp.entrypoint },
    { order: 4, kind: 'verify', description: `Run ${manifest.acceptanceTests.tests.length} acceptance tests against the destination`, tests: manifest.acceptanceTests.tests.map((t) => t.id) },
  ];
  // Engine 1.2: a capability registered inside a central handler must leave everything the
  // handler already did intact. These probes are run after the transplant as REQUIRED cases:
  // the destination's existing routes must still answer, and a traversal attempt must still be
  // refused. They are derived from the Host Model, never from the capability.
  const preservation = emission.profile === 'esm-node-http-central' || (emission.profile === 'express-req-res' && registration.style === 'guard') ? hostPreservationTests(destFp, manifest) : [];

  const plan = {
    preservation,
    id: `graft-${manifest.identity.slug}-${crypto.randomBytes(4).toString('hex')}`,
    createdAt: new Date().toISOString(),
    status,
    capability: { name: manifest.identity.name, slug: manifest.identity.slug, category: manifest.identity.category, manifestVersion: manifest.identity.manifestVersion },
    source: { project: manifest.identity.sourceProject, shape: manifest.architecture.sourceShape },
    destination: {
      project: destFp.name,
      root: destFp.root,
      entrypoint: destFp.entrypoint,
      shape: { moduleSystem: destFp.moduleSystem.value, handlerContract: destFp.handlerContract.value, framework: destFp.framework.value, persistence: destFp.persistence.value },
    },
    registration: { module: `${dir}/routes.js`, name: registration.name, marker: registration.marker, ...(registration.style ? { style: registration.style } : {}) },
    adaptation: {
      profile: emission.profile,
      specId: emission.specId || null,
      refusal: emissionRefusal,
      note: `Source is ${manifest.architecture.sourceShape.moduleSystem}/${manifest.architecture.sourceShape.handlerContract}; destination is ${destFp.moduleSystem.value}/${destFp.handlerContract.value}. The capability is regenerated in the destination idiom, not copied.`,
      // What must survive the transplant exactly, per the IR's preserved policies (kind-aware).
      preservedContract: {
        ...(artifacts.ir.policies.session ? { cookie: artifacts.ir.policies.session } : {}),
        ...(artifacts.ir.policies.passwordHash ? { passwordHash: artifacts.ir.policies.passwordHash } : {}),
        ...(artifacts.ir.policies.configuration ? { configuration: artifacts.ir.policies.configuration } : {}),
        statusCodes: manifest.interfaces.inbound.map((i) => ({ route: `${i.method} ${i.path}`, statuses: Object.keys(i.responses || {}) })),
      },
      usesSharedStore: emission.usesSharedStore,
    },
    compatibility,
    conflicts: { routes: collisionRoutes, resolutionApproved: resolveConflicts },
    steps,
    files: entrypointRefusal ? [] : emission.files,
    acceptanceTests: manifest.acceptanceTests,
    security: manifest.security,
    // Enough for Claude Code, Codex or another agent to perform this transplant itself,
    // while GRAFT keeps ownership of what "done" means.
    agentBrief: {
      objective: `Reproduce the verified behavior of "${manifest.identity.name}" inside ${destFp.name}.`,
      behaviorContract: manifest.behavior.statements,
      constraints: [
        'Do not copy files from the source project; write code in the destination\'s existing idiom.',
        ...(artifacts.ir.policies.session ? [`Preserve the cookie name "${artifacts.ir.policies.session.cookieName}" and its flags exactly.`] : []),
        ...(artifacts.ir.policies.passwordHash ? ['Preserve the password hash algorithm and parameters exactly; changing them invalidates stored hashes.'] : []),
        ...(artifacts.ir.policies.configuration ? [`Preserve the flag defaults exactly${artifacts.ir.policies.configuration.envVar ? ` and honour ${artifacts.ir.policies.configuration.envVar} as the only override` : ''}; flag endpoints must stay read-only.`] : []),
        'Preserve the documented status codes' + (artifacts.ir.policies.session ? ', including the uniform failure for unknown email and wrong password.' : '.'),
        'Do not weaken any assumption listed in security.assumptions.',
        'Do not delete or overwrite existing destination behavior without explicit approval.',
      ],
      acceptanceCriteria: manifest.acceptanceTests.tests.map((t) => ({ id: t.id, description: t.description, required: t.required })),
      verdictOwnedBy: 'graft verify — an agent reporting success is not a verdict',
      provenance: manifest.provenance,
    },
  };
  plan.capabilityContract = toCapabilityContract(manifest);
  // Engine 1.0: the plan carries what GRAFT understood (genome, graph, IR, host model), which
  // recipe applies, the mismatches and adaptations it derived, the risks and unknowns it can
  // name, and the verification contract the destination must satisfy. Compatibility checks
  // above remain the deciding authority; the engine explains, it does not overrule.
  const engine = analyzeForHost(manifest, destFp, { emission, compatibility, atlas, context });
  plan.engine = { engineVersion: GRAFT_ENGINE_VERSION, artifactVersion: engine.artifactVersion, schema: engine.schema, recipeHints: engine.recipeHints, genome: engine.genome, graph: engine.graph, ir: engine.ir, host: engine.host,
    recipe: engine.recipe, recipeSelection: engine.recipeSelection, verificationContract: engine.verificationContract, analysis: engine.analysis };
  // Recorded after the engine so the receipt and atlas carry the applied recipe.
  plan.compatibilityKnowledge = compatibilityKnowledge(manifest, destFp, plan);
  plan.semantic = semanticSummary(plan);
  return plan;
}

export { analyzeCompatibility, serialisableFingerprint };

/**
 * Host-preservation probes for a central-handler destination: every existing GET route the host
 * dispatches must still answer with a non-5xx status, the root must still serve, and an encoded
 * traversal attempt must still be refused (never 200). Required, so a transplant that breaks the
 * host's own behaviour is FAILED, not merely warned about.
 */
export function hostPreservationTests(destFp, manifest) {
  const wanted = new Set(manifest.architecture.capabilityModel.endpoints.map((e) => `${e.method} ${e.path}`));
  const existing = destFp.routes.filter((r) => r.method === 'GET' && /^\/[A-Za-z0-9\-._~/]*$/.test(r.path) && !wanted.has(`${r.method} ${r.path}`)).slice(0, 8);
  // An Express host mounts routers at prefixes; those prefixes are the routes people call.
  const mounts = (destFp.expressGuard?.mounts || []).filter((m) => m !== '/' && !wanted.has(`GET ${m}`)).slice(0, 8);
  const seen = new Set(['/']);
  const probes = [{ name: 'root', method: 'GET', path: '/', expect: { status: [200, 301, 302, 303, 304] } },
    ...existing.filter((r) => !seen.has(r.path) && seen.add(r.path)).map((r, i) => ({ name: `existing-${i + 1}`, method: 'GET', path: r.path, expect: { status: [200, 204, 301, 302, 303, 304, 400, 401, 403, 404, 405] } })),
    ...mounts.filter((m) => !seen.has(m) && seen.add(m)).map((m, i) => ({ name: `mount-${i + 1}`, method: 'GET', path: m, expect: { status: [200, 204, 301, 302, 303, 304, 400, 401, 403, 404, 405] } }))];
  return [
    { id: 'host.routes-still-answer', kind: 'http', required: true, provesBehavior: 'host.preserved', description: 'The destination\'s own routes still answer after the transplant (no 5xx, no hang).', steps: probes },
    { id: 'host.traversal-still-refused', kind: 'http', required: true, provesBehavior: 'host.preserved', description: 'An encoded path-traversal attempt is still refused by the destination after the transplant.',
      steps: [{ name: 'traversal', method: 'GET', path: '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', expect: { status: [400, 403, 404] } }, { name: 'traversal-dotdot', method: 'GET', path: '/..%2f..%2f..%2fetc%2fpasswd', expect: { status: [400, 403, 404] } }] },
  ];
}
