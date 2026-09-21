// The destination's own persistence idiom. Features are expected to use this,
// not to stand up their own module-level state.
export class Store {
  #tables = new Map();

  table(name) {
    if (!this.#tables.has(name)) this.#tables.set(name, new Map());
    return this.#tables.get(name);
  }

  insert(table, key, row) { this.table(table).set(key, row); return row; }
  get(table, key) { return this.table(table).get(key) ?? null; }
  delete(table, key) { return this.table(table).delete(key); }
  find(table, predicate) {
    for (const row of this.table(table).values()) if (predicate(row)) return row;
    return null;
  }
  all(table) { return [...this.table(table).values()]; }
}

export const store = new Store();
