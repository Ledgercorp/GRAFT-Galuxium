// Semantic Changeset — what a transplant changed, in capability terms. The raw Git diff stays
// separate (branch, receipt, files written); this is the meaning: what was added, what was
// adapted to the host, what was substituted with something host-native, what was deliberately
// left behind, what is security-sensitive, what verification covered, what repair did, which
// recipe applied, and what the evidence says.
export const CHANGESET_VERSION = '1.0.0';

const ROLE_BY_FILE = [[/store-adapter\.js$/, 'persistence adapter'], [/passwords\.js$/, 'credential hashing'], [/sessions\.js$/, 'session issuance and lookup'], [/guard\.js$/, 'authorization guard'], [/routes\.js$/, 'HTTP routes'], [/flags\.js$/, 'flag defaults and configuration']];
const roleOf = (file) => (ROLE_BY_FILE.find(([re]) => re.test(file)) || [null, 'module'])[1];

export function buildSemanticChangeset({ plan, applied = null, report = null, proof = null, repair = null }) {
  const e = plan.engine;
  const a = e?.analysis;
  const ir = e?.ir;
  const policies = ir?.policies || {};
  const securitySensitive = [
    ...(policies.session ? [{ kind: 'session-cookie', detail: `${policies.session.cookieName}: HttpOnly=${policies.session.httpOnly === true}, Secure=${policies.session.secure === true}, SameSite=${policies.session.sameSite || 'default'}, ttl=${policies.session.ttlSeconds}s, ${policies.session.idBytes} random bytes` }] : []),
    ...(policies.passwordHash ? [{ kind: 'credential-hashing', detail: `${policies.passwordHash.algorithm} keyLength=${policies.passwordHash.keyLength} saltBytes=${policies.passwordHash.saltBytes} ${policies.passwordHash.comparison}` }] : []),
    ...(policies.guard ? [{ kind: 'authorization-guard', detail: `${policies.guard.name} rejects with ${policies.guard.unauthenticatedStatus}` }] : []),
    ...(policies.configuration ? [{ kind: 'runtime-configuration', detail: `${policies.configuration.envVar || 'no environment override'} enables flags; defaults ${Object.keys(policies.configuration.defaults || {}).length}` }] : []),
    ...(a?.risks || []).filter((r) => r.source === 'genome' || /security|cookie|secret/i.test(r.id)).map((r) => ({ kind: 'risk', detail: r.text })),
  ];
  const dependencies = a?.requiredComponents.dependencies || [];
  return {
    changesetVersion: CHANGESET_VERSION,
    capabilityAdded: { name: plan.capability.name, slug: plan.capability.slug, kind: e?.genome.identity.kind || null, capabilityId: e?.genome.identity.capabilityId || null, genomeId: e?.genome.genomeId || null, irId: ir?.irId || null, endpoints: a?.requiredComponents.endpoints || [] },
    componentsIntroduced: plan.files.map((f) => ({ path: f.path, role: roleOf(f.path), generated: true, bytes: Buffer.byteLength(f.contents || '', 'utf8') })),
    componentsAdapted: [
      ...(plan.destination.entrypoint && plan.files.length ? [{ path: plan.destination.entrypoint, change: 'route registration', edits: applied?.entrypointEdits || null, disabledRoutes: applied?.removedRoutes || plan.conflicts.routes.map((r) => `${r.method} ${r.path}`) }] : []),
      ...(a?.adaptations || []).map((x) => ({ adaptation: x.kind, description: x.concrete || x.description, mechanism: x.mechanism })),
    ],
    dependenciesAdded: dependencies.filter((d) => !d.presentInHost).map((d) => ({ name: d.name, reason: d.reason })),
    dependenciesRemoved: (e?.recipe?.dependencySubstitutions || []).filter((s) => !s.conditional).map((s) => ({ from: s.from, to: s.to, reason: s.reason })),
    targetNativeSubstitutions: (a?.mismatches || []).filter((m) => !m.same && m.adaptation).map((m) => ({ dimension: m.dimension, from: m.source, to: m.destination, via: m.adaptation.kind })),
    sourceComponentsOmitted: [
      ...(e?.genome.dependentModules || []).map((m) => ({ kind: 'source-file', path: m.file, role: m.role, reason: 'regenerated in the destination idiom; never copied' })),
      ...(e?.genome.purpose.notFound || []).map((b) => ({ kind: 'behavior', id: typeof b === 'string' ? b : b?.id || String(b), reason: 'absent in the source' })),
    ],
    securitySensitiveChanges: securitySensitive,
    verificationCoverage: proof ? { contractId: proof.contractId, cases: proof.summary, invariants: proof.invariants, routeCoverage: proof.routeCoverage || [], appliedRecipe: proof.appliedRecipe || null }
      : (e?.verificationContract ? { contractId: e.verificationContract.contractId, planned: { successCases: e.verificationContract.successCases.length, counterfactualCases: e.verificationContract.counterfactualCases.length, invariants: e.verificationContract.invariants.length } } : null),
    repairAttempts: repair?.attempts || [],
    recipeUsed: e?.recipe ? { recipeId: e.recipe.recipeId, name: e.recipe.name, origin: e.recipe.provenance.origin, status: e.recipe.provenance.status || 'builtin', explanation: e.recipeSelection?.explanation || null } : null,
    priorObservations: a?.priorObservations ? { observations: a.priorObservations.observations, top: a.priorObservations.top } : null,
    evidenceResult: report ? { verdict: report.verdict, rationale: report.rationale, summary: report.summary, runtime: report.runtime?.profile || null, finishedAt: report.finishedAt || null, initialVerdict: repair?.initialVerdict ?? repair?.initial?.verdict ?? report.verdict } : { verdict: null, planStatus: plan.status, compatibility: plan.compatibility.status },
    rawDiff: applied ? { branch: applied.branch, receiptPath: applied.receiptPath, filesWritten: applied.filesWritten, entrypoint: plan.destination.entrypoint, recovery: applied.recovery?.rollback || null } : null,
  };
}

export function renderSemanticChangeset(c) {
  const lines = [];
  lines.push(`Capability added: ${c.capabilityAdded.name} (${c.capabilityAdded.kind}) — ${c.capabilityAdded.endpoints.join(', ')}`);
  for (const x of c.componentsIntroduced) lines.push(`Introduced · ${x.path} (${x.role})`);
  for (const x of c.componentsAdapted) lines.push(x.path ? `Adapted · ${x.path}: ${x.change}${x.disabledRoutes?.length ? `; disabled ${x.disabledRoutes.join(', ')}` : ''}` : `Adapted · ${x.adaptation}: ${x.description}`);
  for (const x of c.targetNativeSubstitutions) lines.push(`Substituted · ${x.dimension}: ${x.from} → ${x.to} via ${x.via}`);
  for (const x of c.dependenciesAdded) lines.push(`Dependency added · ${x.name} (${x.reason})`);
  if (!c.dependenciesAdded.length) lines.push('Dependency added · none');
  lines.push(`Omitted · ${c.sourceComponentsOmitted.filter((x) => x.kind === 'source-file').length} source file(s) regenerated, not copied${c.sourceComponentsOmitted.some((x) => x.kind === 'behavior') ? `; absent behaviors: ${c.sourceComponentsOmitted.filter((x) => x.kind === 'behavior').map((x) => x.id).join(', ')}` : ''}`);
  for (const x of c.securitySensitiveChanges) lines.push(`Security · ${x.kind}: ${x.detail}`);
  if (c.verificationCoverage?.cases) lines.push(`Verification · ${c.verificationCoverage.cases.passed}/${c.verificationCoverage.cases.cases} cases passed; invariants held ${c.verificationCoverage.cases.invariantsHeld}, violated ${c.verificationCoverage.cases.invariantsViolated}, unobserved ${c.verificationCoverage.cases.invariantsUnobserved}`);
  else if (c.verificationCoverage?.planned) lines.push(`Verification planned · ${c.verificationCoverage.planned.successCases} success, ${c.verificationCoverage.planned.counterfactualCases} counterfactual, ${c.verificationCoverage.planned.invariants} invariants`);
  for (const r of c.repairAttempts) lines.push(`Repair · attempt ${r.attempt}: ${r.class || 'not repairable'} — ${r.repaired ? 'repaired' : 'no change'}${r.changedFiles?.length ? ` (${r.changedFiles.join(', ')})` : ''}`);
  if (c.recipeUsed) lines.push(`Recipe · ${c.recipeUsed.name} [${c.recipeUsed.origin}/${c.recipeUsed.status}]`);
  lines.push(c.evidenceResult.verdict ? `Result · ${c.evidenceResult.verdict}${c.evidenceResult.initialVerdict !== c.evidenceResult.verdict ? ` (initially ${c.evidenceResult.initialVerdict})` : ''}: ${c.evidenceResult.rationale}` : `Result · plan ${c.evidenceResult.planStatus}, compatibility ${c.evidenceResult.compatibility}`);
  return lines;
}
