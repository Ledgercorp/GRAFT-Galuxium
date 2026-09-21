/** Versioned transport-neutral boundary. No network listener or agent provider is installed. */
export const AGENT_INTERFACE = Object.freeze({
  version: '1.0.0',
  verdictAuthority: 'graft-core deterministic HTTP verifier',
  operations: {
    search: { effect: 'read', input: ['registeredProjectId', 'category'], output: 'discovered capabilities with evidence' },
    inspect: { effect: 'read', input: ['capabilityId'], output: 'capability contract and local lineage' },
    harvest: { effect: 'execute-and-write-bank', input: ['registeredProjectId', 'category', 'executionApproval'], output: 'validated contract and observed source report' },
    plan: { effect: 'read', input: ['capabilityId', 'registeredDestinationId', 'conflictResolutionApproval'], output: 'reviewable plan, compatibility reasons, recovery preconditions' },
    transplant: { effect: 'write-project', input: ['reviewedPlanId', 'planApproval'], output: 'applied receipt or refusal; never an agent-supplied verdict' },
    verify: { effect: 'execute-project', input: ['capabilityId', 'registeredProjectId', 'executionApproval'], output: 'core HTTP verification report and local compatibility observation' },
  },
  hostRequirements: [
    'Resolve opaque project and capability IDs through local registries; reject arbitrary paths.',
    'Execution and mutation approvals come from the host user boundary, never a model boolean.',
    'Bind reviewed plans to the current manifest and exact destination bytes; expire and consume plans once.',
    'Call existing core preconditions, apply recovery, and verify APIs; never accept a submitted verification result.',
    'Compatibility history is descriptive evidence and cannot override present compatibility checks.',
    'A transport implementation requires separate boundary tests before it is enabled.',
  ],
});

export function inspectAgentOperation(name) {
  if (!Object.hasOwn(AGENT_INTERFACE.operations, name)) throw new Error('Unsupported agent operation. Agents cannot submit verdicts.');
  return structuredClone(AGENT_INTERFACE.operations[name]);
}
