const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const wrap = (code) => (s) => (useColor ? ESC + '[' + code + 'm' + s + ESC + '[0m' : s);

export const bold = wrap(1);
export const dim = wrap(2);
export const green = wrap(32);
export const yellow = wrap(33);
export const red = wrap(31);
export const cyan = wrap(36);

export function heading(text) {
  console.log('');
  console.log(bold(text));
  console.log(dim('-'.repeat(Math.max(text.length, 24))));
}

export function statusMark(status) {
  if (status === 'ok') return green('  ok   ');
  if (status === 'warn') return yellow(' warn  ');
  return red(' block ');
}

export function verdictBanner(verdict) {
  if (verdict === 'VERIFIED') return green(bold('VERIFIED'));
  if (verdict === 'FAILED') return red(bold('FAILED'));
  return yellow(bold('NEEDS REVIEW'));
}

export function bullet(text, indent = 2) { console.log(' '.repeat(indent) + text); }
