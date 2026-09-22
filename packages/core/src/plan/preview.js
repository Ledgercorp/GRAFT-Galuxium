export const COMPATIBILITY_STATES = Object.freeze({
  COMPATIBLE: 'COMPATIBLE',
  ADAPTABLE: 'ADAPTABLE',
  INCOMPATIBLE: 'INCOMPATIBLE',
});

/** Deterministic UI-safe projection of the existing compatibility checks. */
export function compatibilityPreview(compatibility) {
  const state = compatibility.status === 'block'
    ? COMPATIBILITY_STATES.INCOMPATIBLE
    : compatibility.status === 'warn'
      ? COMPATIBILITY_STATES.ADAPTABLE
      : COMPATIBILITY_STATES.COMPATIBLE;
  const reasons = compatibility.checks
    .filter((check) => check.status !== 'ok')
    .map(({ id, status, title, detail, remedy }) => ({ id, status, title, detail, remedy }));
  return Object.freeze({ state, reasons, transplantAllowed: state !== COMPATIBILITY_STATES.INCOMPATIBLE });
}
