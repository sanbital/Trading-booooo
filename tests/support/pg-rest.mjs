// A supabase-js query-builder subset over PGlite (real Postgres semantics, in-process), so
// production persistence code (review store, GPT terminal settlement, lifecycle sweep reads)
// runs unmodified in node tests. Only the calls that code makes are supported; anything else
// throws, so a test can never silently exercise a different query than production.
const ident = (x) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(x)) throw Error(`PGREST_UNSUPPORTED_IDENT:${x}`);
  return `"${x}"`;
};
// "features->v17Setup->>state" -> "features"->'v17Setup'->>'state'
function column(expr) {
  const parts = String(expr).split(/(->>|->)/);
  let sql = ident(parts[0]);
  for (let i = 1; i < parts.length; i += 2) {
    if (!/^[A-Za-z0-9_]+$/.test(parts[i + 1])) throw Error(`PGREST_UNSUPPORTED_PATH:${expr}`);
    sql += `${parts[i]}'${parts[i + 1]}'`;
  }
  return sql;
}
function projection(cols) {
  if (!cols || cols.trim() === "*") return "*";
  return cols.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
    const at = c.indexOf(":");
    const alias = at > 0 ? c.slice(0, at) : null, expr = at > 0 ? c.slice(at + 1) : c;
    const name = alias ?? expr.split(/->>|->/).at(-1);
    return `${column(expr)} as ${ident(name)}`;
  }).join(",");
}
const out = (v) => v instanceof Date ? v.toISOString() : v;
const shape = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, out(v)]));

class Query {
  constructor(pg, table) { this.pg = pg; this.table = table; this.filters = []; this.params = []; this.op = null; }
  p(v) { this.params.push(v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v); return `$${this.params.length}`; }
  select(cols = "*") { if (this.op === null) this.op = "select"; this.cols = cols; return this; }
  update(patch) { this.op = "update"; this.patch = patch; return this; }
  insert(row) { this.op = "insert"; this.row = row; return this; }
  eq(c, v) { this.filters.push(`${column(c)} = ${this.p(v)}`); return this; }
  neq(c, v) { this.filters.push(`${column(c)} is distinct from ${this.p(v)}`); return this; }
  lt(c, v) { this.filters.push(`${column(c)} < ${this.p(v)}`); return this; }
  gte(c, v) { this.filters.push(`${column(c)} >= ${this.p(v)}`); return this; }
  in(c, vs) { this.params.push([...vs]); this.filters.push(`${column(c)} = any($${this.params.length}::text[])`); return this; }
  order(c, { ascending = true } = {}) { this.orderBy = `${column(c)} ${ascending ? "asc" : "desc"}`; return this; }
  limit(n) { this.lim = Number(n); return this; }
  maybeSingle() { this.single_ = "maybe"; return this; }
  single() { this.single_ = "one"; return this; }
  async run() {
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    let sql;
    if (this.op === "select") {
      sql = `select ${projection(this.cols)} from public.${ident(this.table)}${where}` +
        (this.orderBy ? ` order by ${this.orderBy}` : "") + (Number.isFinite(this.lim) ? ` limit ${this.lim}` : "");
    } else if (this.op === "update") {
      const sets = Object.entries(this.patch).map(([k, v]) => `${ident(k)} = ${this.p(v)}`).join(",");
      sql = `update public.${ident(this.table)} set ${sets}${where} returning ${projection(this.cols ?? "*")}`;
    } else if (this.op === "insert") {
      const rows = Array.isArray(this.row) ? this.row : [this.row], keys = Object.keys(rows[0]);
      const values = rows.map((r) => `(${keys.map((k) => this.p(r[k])).join(",")})`).join(",");
      sql = `insert into public.${ident(this.table)}(${keys.map(ident).join(",")}) values ${values} returning *`;
    } else throw Error("PGREST_NO_OPERATION");
    const rows = (await this.pg.query(sql, this.params)).rows.map(shape);
    if (this.single_ === "maybe") {
      if (rows.length > 1) return { data: null, error: { message: "MULTIPLE_ROWS" } };
      return { data: rows[0] ?? null, error: null };
    }
    if (this.single_ === "one") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "NOT_ONE_ROW" } };
    return { data: this.op === "update" && this.cols === undefined ? null : rows, error: null };
  }
  then(resolve, reject) { return this.run().catch((e) => ({ data: null, error: { message: String(e?.message ?? e) } })).then(resolve, reject); }
}
export function pgRest(pg) {
  return {
    from: (table) => new Query(pg, table),
    async rpc(name, args) {
      const keys = Object.keys(args ?? {}), params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      try {
        const r = await pg.query(`select public.${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(",")}) as r`, params);
        return { data: r.rows[0]?.r ?? null, error: null };
      } catch (e) { return { data: null, error: { message: String(e?.message ?? e) } }; }
    },
  };
}
