/**
 * Value guards for anything that ends up inside generated source code.
 *
 * A GRAFT manifest is portable by design: it is written to disk, shared, and read back
 * from places GRAFT did not create. Every value the emitter interpolates into a file it
 * is about to write - and that the verifier is about to execute - is therefore untrusted
 * input. These guards refuse anything that could escape its position in the generated
 * code, so a hostile manifest fails loudly at emit time instead of becoming code.
 */

export class UnsafeManifestValue extends Error {
  constructor(field, value, expectation) {
    super(`manifest value ${field} is not safe to write into generated code: ${expectation} (got ${JSON.stringify(value)})`);
    this.name = 'UnsafeManifestValue';
    this.code = 'unsafe-manifest-value';
    this.field = field;
  }
}

const CONTROL_OR_SEPARATOR = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');

/** A JavaScript string literal, correctly escaped. Use instead of writing '${value}'. */
export function jsString(value, field) {
  if (typeof value !== 'string') throw new UnsafeManifestValue(field, value, 'expected a string');
  if (CONTROL_OR_SEPARATOR.test(value)) {
    throw new UnsafeManifestValue(field, value, 'must not contain control characters or line separators');
  }
  return JSON.stringify(value);
}

/** An integer, validated and range-checked, safe to interpolate bare. */
export function intIn(value, field, { min, max }) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) throw new UnsafeManifestValue(field, value, 'expected an integer');
  if (n < min || n > max) throw new UnsafeManifestValue(field, value, `expected an integer between ${min} and ${max}`);
  return String(n);
}

const RESERVED = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);

/** A JavaScript identifier, safe to use as a declared function name. */
export function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value)) {
    throw new UnsafeManifestValue(field, value, 'expected a plain JavaScript identifier');
  }
  if (RESERVED.has(value)) throw new UnsafeManifestValue(field, value, 'must not be a reserved word');
  return value;
}

/** An HTTP route path. Conservative on purpose: these become string literals and route keys. */
export function routePath(value, field) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9\-._~/]{0,255}$/.test(value)) {
    throw new UnsafeManifestValue(field, value, 'expected a path like /auth/login using [A-Za-z0-9-._~/]');
  }
  return value;
}

/** An RFC 6265 cookie name. */
export function cookieName(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(value)) {
    throw new UnsafeManifestValue(field, value, 'expected an RFC 6265 cookie name token');
  }
  return value;
}

/**
 * A value that will sit inside a generated template literal, where a dollar-brace
 * sequence would be evaluated. Only a fixed, known-safe shape is allowed.
 */
export function cookieAttributeValue(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new UnsafeManifestValue(field, value, `expected a value matching ${pattern}`);
  }
  return value;
}

export const COOKIE_PATH = /^\/[A-Za-z0-9\-._~/]{0,128}$/;
export const SAME_SITE = /^(Strict|Lax|None)$/;

/** A module specifier written into an import statement. */
export function moduleSpecifier(value, field) {
  if (typeof value !== 'string' || !/^[.A-Za-z0-9_@][A-Za-z0-9_@./\-]{0,255}$/.test(value)) {
    throw new UnsafeManifestValue(field, value, 'expected a plain relative or package module path');
  }
  return jsString(value, field);
}
