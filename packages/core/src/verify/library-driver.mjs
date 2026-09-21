// The child process that exercises a library capability. It receives one JSON plan on stdin and
// writes one JSON result on stdout. It is deliberately tiny and does exactly four things: load the
// declared artifact, construct the declared export, call the declared operations, and report what
// each produced. It decides nothing: whether an observation satisfies its expectation is the proof
// kernel's call (see verify/library-runner.js).
//
// It never installs, builds, runs package lifecycle scripts, opens a socket or writes anything. The
// artifact path is absolute and outside this process's working directory, so the source checkout is
// only read.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const read = async (stream) => { let data = ''; for await (const chunk of stream) data += chunk; return data; };
const fail = (stage, message) => { process.stdout.write(JSON.stringify({ ok: false, stage, message })); process.exit(0); };

const plan = JSON.parse(await read(process.stdin));

// 1. Load the artifact exactly as a consumer would: CommonJS/UMD through require, ESM through import.
let module_;
try {
  const require_ = createRequire(import.meta.url);
  module_ = plan.artifact.moduleSystem === 'esm' ? await import(pathToFileURL(plan.artifact.path).href) : require_(plan.artifact.path);
} catch (error) { fail('load', `the declared artifact could not be loaded: ${error.message}`); }

// 2. Resolve the declared export.
const resolveExport = (namespace, name) => {
  if (!name) return namespace?.default ?? namespace;
  if (namespace && name in namespace) return namespace[name];
  if (namespace?.default && name in namespace.default) return namespace.default[name];
  return undefined;
};
const exported = resolveExport(module_, plan.artifact.exportName);
if (typeof exported !== 'function' && (exported === null || typeof exported !== 'object')) fail('export', `the artifact does not export ${plan.artifact.exportName || 'a usable value'}`);

const results = [];
for (const testCase of plan.cases) {
  // What each step produced, and nothing more: the decision whether that satisfies the declared
  // expectation belongs to the proof kernel, not to this process.
  const observations = [];
  let operationalError = null;
  try {
    // 3. Construct the capability for this case, from configuration alone.
    let instance = exported;
    if (testCase.construct) {
      if (typeof exported !== 'function') throw new Error(`${plan.artifact.exportName} is not constructible`);
      instance = new exported(testCase.construct.options);
    }
    for (const step of testCase.steps) {
      const target = instance;
      const method = target?.[step.call];
      if (typeof method !== 'function') throw new Error(`the capability exposes no ${step.call}() operation`);
      // Callback arguments record which branch the library chose, which is the observable result
      // for a branch-selecting operation.
      let branch = null;
      const args = (step.args || []).map((argument) => {
        if (argument && typeof argument === 'object' && argument.$callback) { const name = argument.$callback; return () => { branch = name; }; }
        return argument;
      });
      const returned = method.apply(target, args);
      const value = returned && typeof returned.then === 'function' ? await returned : returned;
      observations.push({ step: step.name, call: step.call, args: step.args || [], returned: value === undefined ? null : value, branch });
    }
  } catch (error) {
    // The capability could not be exercised (further): recorded as an operational error, never as
    // a behaviour; the observations made before it stand.
    operationalError = error.message;
  }
  results.push({ id: testCase.id, observations, operationalError });
}
process.stdout.write(JSON.stringify({ ok: true, results }));
