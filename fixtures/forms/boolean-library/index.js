// Exports booleans and carries a variable called flag. No feature evaluation anywhere.
const enabled = true;
const flag = false;
function compare(a, b) { return a === b; }
module.exports = { enabled, flag, compare };
