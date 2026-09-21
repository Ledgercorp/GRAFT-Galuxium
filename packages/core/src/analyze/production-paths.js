// One policy for "is this file part of the production application?" shared by the workspace
// detector and the fingerprint. Tests, specs, fixtures, benchmarks and coverage output describe
// other programs (or exercise this one); they must never decide what framework, handler contract
// or routes the application itself has.
export const NON_PRODUCTION_PATH = /(^|\/)(tests?|__tests__|specs?|fixtures?|bench|benchmarks?|coverage|__mocks__|__snapshots__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** True for a project-relative POSIX path that belongs to the production application. */
export const isProductionPath = (relativePath) => !NON_PRODUCTION_PATH.test(relativePath);
