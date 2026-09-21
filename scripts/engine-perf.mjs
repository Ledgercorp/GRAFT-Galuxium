// Engine 1.1 performance measurements: plan JSON size, planning overhead split, atlas/recipe latency.
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintProject } from '../packages/core/src/analyze/fingerprint.js';
import { harvest } from '../packages/core/src/harvest/index.js';
import { createTransplantPlan } from '../packages/core/src/plan/index.js';
import { analyzeCompatibility } from '../packages/core/src/plan/compatibility.js';
import { emitSessionAuth } from '../packages/core/src/emit/session-auth.js';
import { buildEngineArtifacts, buildHostModel, analyzeForHost, buildAtlasEntry, queryAtlas, deriveLearnedRecipes, selectRecipe } from '../packages/core/src/engine/index.js';
const ms = (fn, n = 20) => { const t0 = performance.now(); for (let i = 0; i < n; i += 1) fn(); return +((performance.now() - t0) / n).toFixed(2); };
const kb = (o) => +(JSON.stringify(o).length / 1024).toFixed(1);
const dst = fingerprintProject('fixtures/new-startup');
const out = {};
for (const [kind, fixture, id] of [['session-auth', 'fixtures/old-saas-project', 'authentication'], ['feature-flags', 'fixtures/config-service', 'feature-flags']]) {
  const m = harvest(fingerprintProject(fixture), id);
  const plan = createTransplantPlan(m, dst, { resolveConflicts: true, atlas: null });
  const { engine, semantic, ...legacy } = plan;
  out[kind] = { planKiB: { total: kb(plan), legacy: kb(legacy), engine: kb(engine), semantic: kb(semantic) },
    ms: { fullPlan: ms(() => createTransplantPlan(m, dst, { resolveConflicts: true, atlas: null })),
      legacyOnly: ms(() => { const e = emitSessionAuth; void e; analyzeCompatibility(m, dst); }),
      engineArtifacts: ms(() => buildEngineArtifacts(m)), hostModel: ms(() => buildHostModel(dst)), engineAnalysis: ms(() => analyzeForHost(m, dst, { atlas: null })) } };
}
const auth = harvest(fingerprintProject('fixtures/old-saas-project'), 'authentication');
const g = buildEngineArtifacts(auth); const host = buildHostModel(dst);
const entries = []; for (let i = 0; i < 5000; i += 1) entries.push(buildAtlasEntry({ capabilityId: g.genome.identity.capabilityId, capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: g.genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, hostId: `h${i % 40}`, adaptations: ['esm-return-response'], result: 'conditionally-supported', verification: { verdict: i % 7 ? 'VERIFIED' : 'FAILED', summary: {} }, at: new Date(1767225600000 + i * 3600000).toISOString() }));
out.atlas = { entries: 5000, queryMs: ms(() => queryAtlas({ capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: g.genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, adaptations: ['esm-return-response'], entries }), 5),
  deriveLearnedMs: ms(() => deriveLearnedRecipes(entries), 5), selectRecipeMs: ms(() => selectRecipe(g.ir, host, { learned: deriveLearnedRecipes(entries.slice(0, 50)) })) };
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(path.join('dist', 'engine-1.1-perf.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
