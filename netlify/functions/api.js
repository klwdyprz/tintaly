// Replaces api.php — same actions, same JSON shapes, Postgres (Supabase) instead of MySQL.
const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
const json = (status, data) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const actions = {
  async login({ body }) {
    const { rows } = await pool.query("SELECT * FROM store_owners WHERE username = $1", [body.username]);
    const row = rows[0];
    if (row && row.password_hash === sha256(body.password)) {
      return { owner_id: row.owner_id, store_name: row.store_name };
    }
    bad("Invalid username or password.");
  },

  async create_account({ body }) {
    for (const f of ["username", "email", "password", "store_name"]) {
      if (!body[f]) bad("Required field missing: " + f);
    }
    const defaults = ["Beverages", "Instant Foods", "Others", "Personal Care", "Snacks"];
    return withTx(async (c) => {
      let ownerId;
      try {
        const r = await c.query(
          "INSERT INTO store_owners (username, password_hash, email, store_name) VALUES ($1,$2,$3,$4) RETURNING owner_id",
          [body.username, sha256(body.password), body.email, body.store_name]
        );
        ownerId = r.rows[0].owner_id;
      } catch (e) {
        bad(e.code === "23505" ? "Username already taken." : "Could not create account: " + e.message);
      }
      for (const name of defaults) {
        await c.query("INSERT INTO categories (owner_id, category_name) VALUES ($1,$2)", [ownerId, name]);
      }
      return { owner_id: ownerId, store_name: body.store_name };
    });
  },

  async dashboard_totals({ q }) {
    const { rows } = await pool.query(
      "SELECT COALESCE(SUM(balance),0) AS total, COUNT(*)::int AS active FROM customers WHERE owner_id = $1 AND balance > 0",
      [q.owner_id]
    );
    return rows[0];
  },

  async customers({ q }) {
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE owner_id = $1 AND full_name ILIKE $2 ORDER BY full_name",
      [q.owner_id, "%" + (q.search || "") + "%"]
    );
    return rows;
  },

  async customer({ q }) {
    const { rows } = await pool.query("SELECT * FROM customers WHERE customer_id = $1", [q.customer_id]);
    return rows[0] || null;
  },

  async add_customer({ body }) {
    if (!body.full_name || !String(body.full_name).trim()) bad("Customer name is required.");
    if (!/^\d{11}$/.test(String(body.contact_number || ""))) bad("Contact number must be exactly 11 digits.");
    const { rows } = await pool.query(
      "INSERT INTO customers (owner_id, full_name, contact_number) VALUES ($1,$2,$3) RETURNING customer_id",
      [body.owner_id, body.full_name, body.contact_number]
    );
    return { customer_id: rows[0].customer_id };
  },

  async categories({ q }) {
    const { rows } = await pool.query("SELECT * FROM categories WHERE owner_id = $1 ORDER BY category_name", [q.owner_id]);
    return rows;
  },

  async products({ q }) {
    let sql =
      "SELECT p.*, c.category_name FROM products p LEFT JOIN categories c ON p.category_id = c.category_id WHERE p.owner_id = $1";
    const params = [q.owner_id];
    if (q.category_id) { sql += " AND p.category_id = $2"; params.push(q.category_id); }
    sql += " ORDER BY p.product_name";
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  async add_product({ body }) {
    const { rows } = await pool.query(
      "INSERT INTO products (owner_id, category_id, product_name, price) VALUES ($1,$2,$3,$4) RETURNING product_id",
      [body.owner_id, body.category_id, body.product_name, body.price]
    );
    return { product_id: rows[0].product_id };
  },

  async add_purchase({ body }) {
    const items = body.items || [];
    if (!items.length) bad("A purchase needs at least one item.");
    const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    return withTx(async (c) => {
      const cur = await c.query("SELECT balance FROM customers WHERE customer_id = $1 FOR UPDATE", [body.customer_id]);
      if (!cur.rows[0]) bad("Customer not found.");
      const before = Number(cur.rows[0].balance);
      const t = await c.query(
        "INSERT INTO transactions (customer_id, transaction_type, amount) VALUES ($1,'purchase',$2) RETURNING transaction_id",
        [body.customer_id, total]
      );
      const txn = t.rows[0].transaction_id;
      for (const i of items) {
        await c.query(
          "INSERT INTO transaction__items (transaction_id, product_id, quantity, unit_price, subtotal) VALUES ($1,$2,$3,$4,$5)",
          [txn, i.product_id, i.quantity, i.unit_price, i.quantity * i.unit_price]
        );
      }
      const after = before + total;
      await c.query("UPDATE customers SET balance = $1 WHERE customer_id = $2", [after, body.customer_id]);
      await c.query(
        "INSERT INTO balance_history (customer_id, transaction_id, balance_before, balance_after) VALUES ($1,$2,$3,$4)",
        [body.customer_id, txn, before, after]
      );
      return { transaction_id: txn };
    });
  },

  async add_payment({ body }) {
    const amount = Number(body.amount);
    return withTx(async (c) => {
      const cur = await c.query("SELECT balance FROM customers WHERE customer_id = $1 FOR UPDATE", [body.customer_id]);
      if (!cur.rows[0]) bad("Customer not found.");
      const before = Number(cur.rows[0].balance);
      if (amount > before) bad(`Payment of ${amount} exceeds current utang of ${before}.`);
      const t = await c.query(
        "INSERT INTO transactions (customer_id, transaction_type, amount) VALUES ($1,'payment',$2) RETURNING transaction_id",
        [body.customer_id, amount]
      );
      const txn = t.rows[0].transaction_id;
      const after = before - amount;
      await c.query("UPDATE customers SET balance = $1 WHERE customer_id = $2", [after, body.customer_id]);
      await c.query(
        "INSERT INTO balance_history (customer_id, transaction_id, balance_before, balance_after) VALUES ($1,$2,$3,$4)",
        [body.customer_id, txn, before, after]
      );
      return { transaction_id: txn };
    });
  },

  async customer_history({ q }) {
    const { rows } = await pool.query(
      `SELECT t.*, to_char(t.transaction_date, 'YYYY-MM-DD HH24:MI:SS') AS transaction_date,
              (SELECT string_agg(pr.product_name, ', ')
                 FROM transaction__items ti JOIN products pr ON ti.product_id = pr.product_id
                WHERE ti.transaction_id = t.transaction_id) AS product_names
         FROM transactions t WHERE t.customer_id = $1 ORDER BY t.transaction_id DESC`,
      [q.customer_id]
    );
    return rows;
  },

  async summary({ q }) {
    const period = q.period || "week";
    const now = new Date();
    let start;
    if (period === "week") start = new Date(now.getTime() - 7 * 864e5);
    else if (period === "month") start = new Date(now.getFullYear(), now.getMonth(), 1);
    else start = new Date(now.getFullYear(), 0, 1);

    const unpaid = await pool.query(
      "SELECT COALESCE(SUM(balance),0) AS t FROM customers WHERE owner_id = $1 AND balance > 0", [q.owner_id]);
    const paid = await pool.query(
      `SELECT COALESCE(SUM(t.amount),0) AS t FROM transactions t JOIN customers c ON t.customer_id = c.customer_id
        WHERE c.owner_id = $1 AND t.transaction_type = 'payment' AND t.transaction_date >= $2`,
      [q.owner_id, start]);
    const rows = await pool.query(
      `SELECT c.full_name, t.amount, t.transaction_type,
              to_char(t.transaction_date, 'YYYY-MM-DD HH24:MI:SS') AS transaction_date
         FROM transactions t JOIN customers c ON t.customer_id = c.customer_id
        WHERE c.owner_id = $1 AND t.transaction_date >= $2 ORDER BY t.transaction_id DESC`,
      [q.owner_id, start]);
    return { total_unpaid: unpaid.rows[0].t, total_paid: paid.rows[0].t, rows: rows.rows };
  },
};

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { bad("Invalid JSON body."); }
    const fn = actions[q.action];
    if (!fn) bad("Unknown action: " + q.action);
    return json(200, await fn({ q, body }));
  } catch (e) {
    if (e.code === "23514") return json(400, { error: "Invalid value: contact number must be exactly 11 digits." });
    return json(e.status || 500, { error: e.message });
  }
};