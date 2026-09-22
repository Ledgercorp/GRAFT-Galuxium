import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { graftHome } from '../registry/index.js';

const memoryPath = () => path.join(graftHome(), 'capability-memory.json');
const empty = () => ({ schema: 'GraftCapabilityMemory/1.0.0', capabilities: [] });
const fingerprint = ({ capabilityId, sourceRevision, sourceFingerprint }) => `sha256:${crypto.createHash('sha256').update(JSON.stringify({ capabilityId, sourceRevision, sourceFingerprint })).digest('hex')}`;
const save = (memory) => {
  fs.mkdirSync(graftHome(), { recursive: true, mode: 0o700 });
  const temporary = `${memoryPath()}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(memory, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, memoryPath());
};

export function loadCapabilityMemory() {
  try {
    const memory = JSON.parse(fs.readFileSync(memoryPath(), 'utf8'));
    if (memory?.schema !== 'GraftCapabilityMemory/1.0.0' || !Array.isArray(memory.capabilities)) throw new Error('invalid capability memory');
    return memory;
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw error;
  }
}

export function rememberCapability(record) {
  if (!record?.capabilityId || !record?.sourceRevision || !record?.sourceFingerprint) throw new Error('Capability Memory requires capabilityId, sourceRevision, and sourceFingerprint.');
  const memory = loadCapabilityMemory();
  const entry = Object.freeze({ ...record, memoryId: fingerprint(record), rememberedAt: record.rememberedAt || new Date().toISOString() });
  const index = memory.capabilities.findIndex((item) => item.memoryId === entry.memoryId);
  if (index < 0) memory.capabilities.push(entry);
  save(memory);
  return entry;
}

export function findRememberedCapabilities(capabilityId) {
  return loadCapabilityMemory().capabilities.filter((entry) => !capabilityId || entry.capabilityId === capabilityId);
}

/** Append descriptive local history without changing the revision-bound capability identity. */
export function recordCapabilityMemoryObservation({ capabilityId, sourceRevision, sourceFingerprint, observation }) {
  const memory = loadCapabilityMemory();
  const memoryId = fingerprint({ capabilityId, sourceRevision, sourceFingerprint });
  const index = memory.capabilities.findIndex((entry) => entry.memoryId === memoryId);
  if (index < 0) throw new Error('Remember the capability before recording an observation.');
  const current = memory.capabilities[index];
  const observations = [...(current.observations || []), Object.freeze({ ...observation, at: observation?.at || new Date().toISOString() })];
  const entry = Object.freeze({ ...current, observations });
  memory.capabilities[index] = entry;
  save(memory);
  return entry;
}
