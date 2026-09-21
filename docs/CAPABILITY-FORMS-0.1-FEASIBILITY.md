# Capability Forms 0.1 — Library Capabilities: STOPPED WITH EVIDENCE

Branch `feature/capability-forms-library-0.1` from `feature/laboratory-composition-kernel-0.4a`
(`bd82008`), pushed before work began. The mapping phase was run read-only, as instructed. **Two
independent blockers stop the phase**, so no schema, detector, harvest or verification code was
written.

The phase's own stop rule applies: *"If the real Microsoft source cannot honestly satisfy the
proposed library model without several unrelated engine changes: STOP WITH EVIDENCE."*

## What the real source offers (the encouraging half)

`microsoft/FeatureManagement-JavaScript`, cloned read-only at
`~/Developer/GRAFT-Dogfood/feature-management-js`, commit
`a5b4f0e6237e6afe673e90956642a4ce27ca5845`, branch `main`, MIT, clean. The capability package is
`src/feature-management` → `@microsoft/feature-management` **v2.3.1**, MIT, dual ESM/CJS via
`exports`.

Its public API is exactly the structural signature a library detector would want — no repository
name, README wording or package-name matching required:

```ts
// src/feature-management/src/model.ts
isEnabled(featureName: string, context?: unknown): Promise<boolean>;
getVariant(featureName: string, context: ITargetingContext): Promise<Variant | undefined>;

// src/feature-management/src/index.ts (public surface)
FeatureManager, IFeatureManager, IFeatureFlagProvider,
ConfigurationMapFeatureFlagProvider, ConfigurationObjectFeatureFlagProvider,
IFeatureFilter, ITargetingContext, EvaluationResult, VariantAssignmentReason
```

Flag-name input, boolean evaluation, variant evaluation, and a provider/configuration abstraction —
all corroborating, all structural. **Detection was not the problem.**

## Blocker 1 — the source cannot be executed without a forbidden install or build

Verification of a library must "exercise real library behavior". This source cannot be loaded at
all under this phase's rules:

- no `dist/` — the package is **not built**;
- no `node_modules` — dev dependencies (rollup, typescript, vitest) are **not installed**;
- the TypeScript is **not erasable-syntax-only**: `export enum` appears in `src/featureManager.ts`
  (`VariantAssignmentReason`) and three times in `src/filter/recurrence/model.ts`, so Node's
  `--experimental-strip-types` cannot run it;
- its internal imports use NodeNext `.js` specifiers that resolve to compiled output.

Measured, not assumed:

```
$ node --experimental-strip-types -e "import('…/src/feature-management/src/index.ts')"
IMPORT FAILED | Error | Cannot find module '…/src/feature-management/src/featureManager.js'
                        imported from …/src/feature-management/src/index.ts
```

Making it runnable requires `npm install` plus a TypeScript build — both explicitly on this phase's
DO-NOT-BUILD list. So `Source behavior: VERIFIED`, which the phase's success criterion requires,
is unreachable for this source no matter how good the detector is.

## Blocker 2 — an honest library representation is several engine changes, not one

GRAFT's capability pipeline is service-shaped at every stage below detection. Representing a
library honestly (never faking routes) would require changing, at minimum:

| Stage | What currently assumes a service |
| --- | --- |
| `manifest/schema.js` — feature-flags model | requires `configuration.defaults` to be a **non-empty** map of names→booleans, and `endpoints` to be **non-empty** with roles `list`/`evaluate` and HTTP methods. A library has neither; flags come from a provider at runtime. Both would have to become form-conditional. |
| `manifest/schema.js` — acceptance tests | every test must be `kind: 'http'` and every step must carry `method` + `path`. A library case is a function call. Needs a new test kind. |
| `engine/genome.js` | builds `endpoints[]` from `model.endpoints`, enriched from `interfaces.inbound`, with role semantics (`cookie`, `guarded`). None apply to a library. |
| `engine/ir.js` + `lower.js` + `emit/*` + `recipes.js` + `profiles.js` | registration is HTTP route/middleware wiring throughout. |
| `verify/index.js` + `verify/http-runner.js` | boots the destination application and issues HTTP requests. A library needs a different harness entirely (import the module, call the API). |
| `engine/verification-contract.js` | evaluates route coverage from observed HTTP steps. |

That is a second, non-HTTP verification path plus a second manifest/genome shape — six subsystems,
each service-shaped deliberately. It is not "the smallest change needed so the IR can represent a
library".

Worth stating plainly: blocker 2 is worth doing *as its own phase*. Blocker 1 means that even after
doing it, this particular source still could not be verified here.

## What was not done, deliberately

No `implementationForm` field, no library detector, no harvest path, no library IR, no verification
contract, no export or UI change. Writing detection without an executable verification path would
have produced a capability GRAFT can *claim* but never *prove* — the exact failure mode every prior
phase has refused.

## Options for the next decision (none taken)

1. **Library form on an executable source first.** Do the form model, structural detector, library
   IR and library verification harness against a library GRAFT *can* run today — plain JavaScript
   ESM, or TypeScript that is erasable-syntax-only with a published build. The engine work is then
   provable end to end, and the Microsoft library becomes admissible later purely by adding a build
   or install step.
2. **A bounded dependency-resolution phase.** Decide, as its own phase with its own safety rules,
   how GRAFT may obtain a package's built artifact (`npm install --ignore-scripts` into a sandbox,
   or consuming an already-installed `node_modules`). Blocker 1 disappears; blocker 2 remains.
3. **Verify library capabilities through a consuming host instead of in isolation.** GRAFT already
   knows how to boot an application and probe behaviour; a small example app that imports the
   library would exercise it — but only once the package is installable, so this still depends on
   option 2.
4. **Represent-only ingestion.** Allow a library capability to be discovered, harvested and shown
   with `Source behavior: NOT VERIFIED — package not executable here`. This is honest but yields a
   capability nothing can act on, and it weakens the rule that a banked capability carries a
   verdict.

Recommended: option 1, then option 2. Option 1 makes the *form* work provable without touching
dependency policy; option 2 is the single change that makes real-world open-source libraries
admissible, and it deserves its own safety review rather than being smuggled into a schema phase.
