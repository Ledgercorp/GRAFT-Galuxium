// Holds a map of features, but exposes no way to ask whether one is on.
function FeatureMap(map) { this.map = map || {}; }
FeatureMap.prototype.size = function size() { return Object.keys(this.map).length; };
module.exports = { FeatureMap };
