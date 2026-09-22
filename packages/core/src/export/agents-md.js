const line = (label, value) => value == null || value === '' ? null : `- ${label}: ${value}`;

/** Stable, portable handoff; callers choose a non-overwriting destination. */
export function blueprintAgentsMd(blueprint) {
  if (!blueprint?.id || !blueprint?.capability?.slug) throw new Error('A finalized Blueprint with id and capability is required.');
  const checks = blueprint.compatibility?.checks || [];
  const required = checks.filter((check) => check.status === 'ok').map((check) => `- ${check.title}`);
  const adaptations = checks.filter((check) => check.status === 'warn').map((check) => `- ${check.title}: ${check.detail}`);
  const prohibited = checks.filter((check) => check.status === 'block').map((check) => `- Do not proceed: ${check.title}`);
  return [
    '# GRAFT Blueprint Handoff', '',
    '## Objective', `Apply the ${blueprint.capability.slug} capability to the reviewed destination.`, '',
    '## Provenance', ...[line('Blueprint', blueprint.id), line('Capability', blueprint.capability.slug), line('Source', blueprint.source?.project), line('Destination', blueprint.destination?.project)].filter(Boolean), '',
    '## Required constraints', ...(required.length ? required : ['- Preserve the reviewed behavioral contract.']), '',
    '## Adaptation requirements', ...(adaptations.length ? adaptations : ['- No additional adaptation identified.']), '',
    '## Prohibited modifications', ...(prohibited.length ? prohibited : ['- Do not overwrite unrelated destination files.']), '',
    '## Verification', ...((blueprint.steps || []).filter((step) => step.type === 'verify').map((step) => `- ${step.title || step.description || 'Run the Blueprint verification.'}`) || ['- Run the Blueprint verification.']), '',
    '## Evidence expectations', '- Record source and destination revisions plus required verification results.', '',
  ].join('\n');
}

/** Preview is pure; export never replaces a destination's existing AGENTS.md. */
export function exportBlueprintAgentsMd(blueprint, destination) {
  const content = blueprintAgentsMd(blueprint);
  const root = path.resolve(destination);
  const primary = path.join(root, 'AGENTS.md');
  const safeId = String(blueprint.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const target = fs.existsSync(primary) ? path.join(root, `AGENTS.graft-${safeId}.md`) : primary;
  if (fs.existsSync(target)) throw Object.assign(new Error(`Export already exists at ${target}. Review it or choose a different destination.`), { code: 'agents-export-exists' });
  fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { content, path: target, alternate: target !== primary, mergeGuidance: target !== primary ? 'Review the generated handoff and merge the transplant-specific sections into the destination AGENTS.md.' : null };
}
import fs from 'node:fs';
import path from 'node:path';
