const option = (kind, description) => ({ kind, description });
const boolean = (description) => option('boolean', description);
const value = (description) => option('value', description);
const destination = { to: value('Destination project name or path'), dir: value('Directory for generated files (default: src/auth)'), 'resolve-conflicts': boolean('Approve disabling conflicting route registrations') };

export const commands = {
  ui: { args: '[--port <port>]', max: 0, description: 'Open the local browser workspace (prints its address)', options: { port: value('Local port (default: 4317)') } },
  add: { args: '<path>', max: 1, description: 'Register a local project', options: {} },
  projects: { args: '', max: 0, description: 'List known projects', options: {} },
  harvest: {
    args: '<project> [--capability <id>]', max: 1, description: 'Discover capabilities, or harvest one (verification executes project code with your OS privileges)',
    options: { capability: value('Capability to harvest (authentication)'), out: value('Output bank directory (default: GRAFT_HOME/organ-bank)'), 'no-verify-source': boolean('Skip running the source; record it as unproven'), 'bank-unverified': boolean('Keep a failed manifest for inspection') },
  },
  bank: { args: '', max: 0, description: 'Show the organ bank', options: {} },
  plan: {
    args: '<capability> --to <project>', max: 2, description: 'Inspect compatibility and a transplant plan',
    options: { ...destination, json: option('optional-value', 'Write the full plan to a file (default: graft-plan.json)') },
  },
  transplant: {
    args: '<capability> --to <project>', max: 2, description: 'Apply a transplant, then verify it',
    options: { ...destination, 'dry-run': boolean('Check safety and preview writes without applying them'), 'allow-dirty': boolean('Allow a destination with uncommitted changes'), 'allow-no-git': boolean('Allow a destination without a Git recovery point'), 'allow-nested-repo': boolean('Allow a project inside a larger Git repository'), branch: value('Name for the isolated transplant branch'), 'no-verify': boolean('Skip running destination acceptance tests') },
  },
  verify: { args: '<capability> --in <project>', max: 2, description: 'Run acceptance verification again (executes project code with your OS privileges)', options: { in: value('Destination project name or path') } },
  demo: { args: '', max: 0, description: 'Run the full workflow on disposable fixture copies', options: {} },
  workspace: {
    args: '<add|remove|index|list|search|find|refresh|agent> [value]', max: 3,
    description: 'Workspace Capability Index: authorize folders, index them locally, and search what you have already built',
    options: { force: boolean('Re-index every project instead of reusing unchanged entries'), json: boolean('Print JSON instead of text'),
      limit: value('Maximum results (default: 10)'), capability: value('Filter by capability (authentication, feature-flags)'),
      harvestable: boolean('Only capabilities GRAFT can harvest today'), unsupported: boolean('Only capabilities GRAFT cannot yet transplant'),
      explain: boolean('Ask the configured agent to explain the top candidate'), provider: value('Agent provider (anthropic, openai, openai-compatible)'),
      model: value('Agent model'), endpoint: value('Agent endpoint URL'), clear: boolean('Disconnect the configured agent') },
  },
  proof: {
    args: '<verify|export> <file-or-digest> [--out <path>] [--json]', max: 2,
    description: 'Proof artifacts: verify a portable proof file or a stored digest (integrity and the recorded claim, offline), or export a stored proof as an exact copy',
    options: { json: boolean('Print JSON ({ integrity, claim }) instead of text'), out: value('Export destination: a directory (file named by digest) or a file path (default: current directory)') },
  },
  dogfood: {
    args: '<list|show|note|score> [session] [text]', max: 3, description: 'Local dogfood records: list sessions, show events, add an operator observation, or compute the scorecard (never uploaded)',
    options: { tag: value('Observation tag: ENGINE_DEFECT, MISSING_ENGINE_CAPABILITY, VERIFICATION_GAP, UX_FRICTION, PERFORMANCE, EXPECTED_REFUSAL, SUCCESS'), stage: value('Stage the observation is about (setup, register, harvest, plan, apply, verify, repair, review, rollback, other)'),
      ref: value('Event sequence number the observation refers to'), intervention: boolean('Mark the observation as a point where the operator had to intervene'), terminal: boolean('Mark the observation as something that required the Terminal'), json: boolean('Print JSON instead of text') },
  },
};

/** Parse explicitly declared options so a typo cannot accidentally approve a write. */
export function parseArgs(command, argv) {
  if (!Object.hasOwn(commands, command)) throw new Error(`unknown command "${command}". Run graft --help for available commands.`);
  const definition = commands[command];
  const flags = {};
  const positional = [];
  let endOptions = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!endOptions && arg === '--') { endOptions = true; continue; }
    if (endOptions || !arg.startsWith('-')) { positional.push(arg); continue; }
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown option "${arg}". Run graft ${command} --help.`);
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    if (!Object.hasOwn(definition.options, key)) throw new Error(`unknown option "--${key}". Run graft ${command} --help.`);
    const spec = definition.options[key];
    if (Object.hasOwn(flags, key)) throw new Error(`option --${key} was provided more than once`);
    if (spec.kind === 'boolean') {
      if (separator !== -1) throw new Error(`--${key} does not accept a value; omit the flag to leave it disabled`);
      flags[key] = true;
      continue;
    }
    if (separator !== -1) {
      flags[key] = arg.slice(separator + 1);
      if (!flags[key]) throw new Error(`--${key} requires a non-empty value`);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i += 1; }
    else if (spec.kind === 'optional-value') flags[key] = true;
    else throw new Error(`--${key} requires a value`);
  }
  const max = flags.to || flags.in ? 1 : definition.max;
  if (positional.length > max) throw new Error(`too many arguments. Usage: graft ${command} ${definition.args}`.trim());
  return { flags, positional };
}
