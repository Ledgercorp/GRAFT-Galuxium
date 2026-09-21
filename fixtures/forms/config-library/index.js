// An ordinary configuration library: values by key, nothing to do with features.
function Config(map) { this.map = map || {}; }
Config.prototype.get = function get(key, fallback) { return key in this.map ? this.map[key] : fallback; };
Config.prototype.set = function set(key, value) { this.map[key] = value; return this; };
Config.prototype.has = function has(key) { return key in this.map; };
module.exports = { Config };
