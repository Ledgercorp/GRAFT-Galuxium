// Semantic engine output: what GRAFT understood and intends, as data and as prose.
// Machine-readable for agents and the desktop; human-readable for the CLI and the review
// panel. After verification, semanticOutcome() adds the result and evidence summary.

export function semanticSummary(plan) {
  const e = plan.engine;
  if (!e) return null;
  const files = plan.files.map((f) => f.path);
  const expectedChanges = [
    ...files.map((path) => ({ kind: 'create-file', path })),
    ...(plan.destination.entrypoint && plan.files.length ? [{ kind: 'edit-entrypoint', path: plan.destination.entrypoint, description: 'register the transplanted routes' }] : []),
    ...(plan.conflicts.routes.length ? [{ kind: 'resolve-route-conflicts', routes: plan.conflicts.routes.map((r) => `${r.method} ${r.path}`), approved: plan.conflicts.resolutionApproved }] : []),
  ];
  return {
    engineVersion: e.engineVersion,
    capability: e.analysis.capability,
    dependentComponents: e.analysis.requiredComponents,
    targetMismatches: e.analysis.mismatches.filter((m) => !m.same),
    expectedChanges,
    transplantedComponents: { files, endpoints: e.analysis.requiredComponents.endpoints, middleware: e.analysis.requiredComponents.middleware, entities: e.analysis.requiredComponents.entities.map((s) => s.store) },
    skippedComponents: [
      ...e.genome.dependentModules.map((m) => ({ kind: 'source-file', path: m.file, reason: 'source files are evidence; the capability is regenerated, never copied' })),
      ...e.genome.purpose.notFound.map((x) => ({ kind: 'behavior', id: typeof x === 'string' ? x : x?.id || String(x), reason: 'not present in the source' })),
    ],
    adaptations: e.analysis.adaptations,
    risks: e.analysis.risks, unknowns: e.analysis.unknowns,
    verificationContract: e.verificationContract ? { contractId: e.verificationContract.contractId, successCases: e.verificationContract.successCases.length, counterfactualCases: e.verificationContract.counterfactualCases.length, invariants: e.verificationContract.invariants.length } : null,
    priorObservations: e.analysis.priorObservations,
    result: { planStatus: plan.status, compatibility: plan.compatibility.status, recipe: e.analysis.recipe?.name || null, verdict: null },
  };
}

export function renderSemanticSummary(s) {
  if (!s) return [];
  const lines = [];
  lines.push(`Capability: ${s.capability.name} (${s.capability.kind}) — genome ${s.capability.genomeId.slice(7, 19)}, IR ${s.capability.irId.slice(7, 19)}`);
  lines.push(`Dependent components: ${s.dependentComponents.endpoints.length} endpoint(s), ${s.dependentComponents.entities.length} store(s), ${s.dependentComponents.middleware.length} middleware, ${s.dependentComponents.dependencies.length} package(s), ${s.dependentComponents.environment.length} env var(s)`);
  for (const m of s.targetMismatches) lines.push(`Mismatch · ${m.dimension}: ${m.source} → ${m.destination} [${m.severity}${m.adaptation ? `: ${m.adaptation.kind}` : ''}]`);
  if (!s.targetMismatches.length) lines.push('Mismatch · none: source and destination share every adaptation dimension');
  for (const c of s.expectedChanges) lines.push(`Change · ${c.kind}${c.path ? ` ${c.path}` : ''}${c.routes ? ` ${c.routes.join(', ')}${c.approved ? ' (approved)' : ' (needs approval)'}` : ''}`);
  lines.push(`Transplanted: ${s.transplantedComponents.endpoints.join(', ')}; stores ${s.transplantedComponents.entities.length ? s.transplantedComponents.entities.join(', ') : 'none'}`);
  lines.push(`Skipped: ${s.skippedComponents.filter((x) => x.kind === 'source-file').length} source file(s) (regenerated, not copied)${s.skippedComponents.some((x) => x.kind === 'behavior') ? `; behaviors absent in source: ${s.skippedComponents.filter((x) => x.kind === 'behavior').map((x) => x.id).join(', ')}` : ''}`);
  if (s.verificationContract) lines.push(`Verification will prove: ${s.verificationContract.successCases} success case(s), ${s.verificationContract.counterfactualCases} counterfactual(s), ${s.verificationContract.invariants} invariant(s) declared`);
  for (const r of s.risks) lines.push(`Risk · ${r.level}: ${r.text}`);
  for (const u of s.unknowns) lines.push(`Unknown · ${u}`);
  if (s.priorObservations?.observations) lines.push(`Atlas: ${s.priorObservations.observations} prior observation(s) for this architecture pair — ${s.priorObservations.verdicts.VERIFIED} VERIFIED, ${s.priorObservations.verdicts.FAILED} FAILED, ${s.priorObservations.verdicts.NEEDS_REVIEW} NEEDS_REVIEW`);
  lines.push(`Result: plan ${s.result.planStatus}, compatibility ${s.result.compatibility}${s.result.recipe ? `, recipe "${s.result.recipe}"` : ''}${s.result.verdict ? `, verdict ${s.result.verdict}` : ''}`);
  return lines;
}

export function semanticOutcome(summary, report, proof = null) {
  if (!summary) return null;
  return { ...summary, result: { ...summary.result, verdict: report.verdict, rationale: report.rationale,
    evidence: { tests: report.summary, steps: (report.results || []).reduce((n, r) => n + (r.steps?.length || 0), 0), runtime: report.runtime?.profile || null, finishedAt: report.finishedAt || null },
    proof: proof ? { contractId: proof.contractId, summary: proof.summary, invariants: proof.invariants } : null } };
}
