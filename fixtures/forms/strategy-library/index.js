// A generic strategy registry. Chooses between outcomes, but never asks about a feature.
function Registry(strategies) { this.strategies = strategies || {}; }
Registry.prototype.register = function register(name, fn) { this.strategies[name] = fn; return this; };
Registry.prototype.run = function run(name, a, b) { const fn = this.strategies[name]; return fn ? fn(a, b) : b; };
module.exports = { Registry };
