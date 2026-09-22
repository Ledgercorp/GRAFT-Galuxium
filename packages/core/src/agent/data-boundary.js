import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { graftHome } from '../registry/index.js';

export const DATA_CLASSES = Object.freeze({
  NONE: 'NONE',
  METADATA: 'METADATA',
  STRUCTURE: 'STRUCTURE',
  SOURCE_EXCERPT: 'SOURCE_EXCERPT',
  GENERATED_DERIVATIVE: 'GENERATED_DERIVATIVE',
});

export const EGRESS_DECISIONS = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY' });

const ALL_CLASSES = new Set(Object.values(DATA_CLASSES));
const digest = (value) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;

/**
 * Decides and describes external egress without retaining source-derived input.
 * Secrets are a denial reason, never a data class.
 */
export function requestEgress({ provider, operation, destination, dataClass = DATA_CLASSES.NONE, sourceDerived = false, policyContext = {}, input = null, at = new Date().toISOString() } = {}) {
  if (!ALL_CLASSES.has(dataClass)) throw new Error(`Unknown data class ${dataClass}.`);
  if (!provider || !operation || !destination) throw new Error('provider, operation, and destination are required for egress evaluation.');
  const allowed = new Set(policyContext.allowedDataClasses || [DATA_CLASSES.NONE, DATA_CLASSES.METADATA, DATA_CLASSES.STRUCTURE]);
  const blocked = policyContext.containsSecret === true || !allowed.has(dataClass) || (!sourceDerived && dataClass === DATA_CLASSES.SOURCE_EXCERPT);
  const reason = policyContext.containsSecret === true
    ? 'secret-like-content-blocked'
    : !allowed.has(dataClass)
      ? `data-class-not-allowed:${dataClass}`
      : !sourceDerived && dataClass === DATA_CLASSES.SOURCE_EXCERPT
        ? 'source-excerpt-must-be-source-derived'
        : 'policy-allowed';
  const decision = blocked ? EGRESS_DECISIONS.DENY : EGRESS_DECISIONS.ALLOW;
  return Object.freeze({
    decision,
    reason,
    event: Object.freeze({
      schema: 'GraftCustodyEvent/1.0.0', provider, operation, destination,
      executionLocation: 'local', sourceDerived: Boolean(sourceDerived), dataClass,
      policy: { allowedDataClasses: [...allowed].sort() }, decision, reason,
      inputFingerprint: digest(input), timestamp: at,
      bytesOrItemCount: typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : Array.isArray(input) ? input.length : null,
    }),
  });
}

const custodyPath = () => path.join(graftHome(), 'capability-custody.json');

export function loadCustodyEvents() {
  try {
    const stored = JSON.parse(fs.readFileSync(custodyPath(), 'utf8'));
    return Array.isArray(stored?.events) ? stored.events.map((event) => ({ ...event })) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function createCustodyLedger({ persist = false } = {}) {
  const persisted = persist ? loadCustodyEvents() : [];
  const events = [];
  const save = () => {
    if (!persist) return;
    fs.mkdirSync(graftHome(), { recursive: true, mode: 0o700 });
    const temporary = `${custodyPath()}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 'GraftCustodyLedger/1.0.0', events: [...persisted, ...events] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, custodyPath());
  };
  return Object.freeze({
    record(evaluation) {
      if (!evaluation?.event) throw new Error('A custody event is required.');
      events.push(evaluation.event);
      save();
      return evaluation.event;
    },
    list() { return events.map((event) => ({ ...event })); },
  });
}
