require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 5000;
const DB_URL = process.env.DB_URL;

if (!DB_URL) {
  console.error("Missing DB_URL in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

/* ---------------- BASIC CONFIG ---------------- */

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ---------------- LEGACY JSON FILES (FOR ONE-TIME MIGRATION) ---------------- */

const dataFolder = path.join(__dirname, "data");

const files = {
  shipments: path.join(dataFolder, "shipments.json"),
  couriers: path.join(dataFolder, "couriers.json"),
  rates: path.join(dataFolder, "rates.json"),
  credits: path.join(dataFolder, "credits.json"),
  accounts: path.join(dataFolder, "accounts.json")
};

function readLegacyFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

/* ---------------- DEFAULT OPTIONS ---------------- */

const shipmentModes = ["Domestic", "International", "Local", "Ultra Local"];

const transportModes = ["Air", "Surface", "Express", "Rail", "Local Delivery"];

const statuses = [
  "Booked",
  "In Transit",
  "Out for Delivery",
  "Delivered",
  "RTO",
  "Address Not Found",
  "Door Lock",
  "Load Late Arrived"
];

const DEFAULT_ADMIN = {
  username: "MVEXPRESS021",
  password: "Varamonish2121",
  role: "admin"
};

/* ---------------- HELPERS ---------------- */

function cleanText(value) {
  return String(value || "").trim();
}

function sanitizeAccount(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role || "staff",
    createdAt: row.created_at || row.createdAt || null
  };
}

function getSessionTokenFromReq(req) {
  const authHeader = cleanText(req.headers.authorization);
  const headerToken = cleanText(req.headers["x-session-token"]);

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return cleanText(authHeader.slice(7));
  }

  if (headerToken) return headerToken;

  return "";
}

async function getSessionUser(req) {
  const token = getSessionTokenFromReq(req);
  if (!token) return null;

  const result = await pool.query(
    `
    SELECT
      s.token,
      s.expires_at,
      a.id,
      a.username,
      a.role,
      a.created_at
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token = $1
      AND s.expires_at > NOW()
    LIMIT 1
    `,
    [token]
  );

  if (!result.rows.length) return null;

  return {
    token: result.rows[0].token,
    user: sanitizeAccount(result.rows[0]),
    expiresAt: result.rows[0].expires_at
  };
}

async function requireAuth(req, res, next) {
  try {
    const session = await getSessionUser(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    req.auth = session;
    next();
  } catch (err) {
    res.status(500).json({ error: "Authentication check failed" });
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS couriers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rates (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      pod TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'Booked',
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function cleanupExpiredSessions() {
  await pool.query(`DELETE FROM sessions WHERE expires_at <= NOW()`);
}

async function ensureDefaultAdminAccount() {
  const existing = await pool.query(
    `SELECT id FROM accounts WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [DEFAULT_ADMIN.username]
  );

  if (!existing.rows.length) {
    await pool.query(
      `INSERT INTO accounts (id, username, password, role)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), DEFAULT_ADMIN.username, DEFAULT_ADMIN.password, DEFAULT_ADMIN.role]
    );
  }
}

async function migrateLegacyDataIfNeeded() {
  const accountsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM accounts`);
  if (accountsCount.rows[0].count === 0) {
    const legacyAccounts = readLegacyFile(files.accounts);
    if (legacyAccounts.length) {
      for (const acc of legacyAccounts) {
        const username = cleanText(acc.username);
        const password = cleanText(acc.password);
        if (!username || !password) continue;

        await pool.query(
          `INSERT INTO accounts (id, username, password, role, created_at)
           VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
           ON CONFLICT (id) DO NOTHING`,
          [
            cleanText(acc.id) || uuidv4(),
            username,
            password,
            cleanText(acc.role) || "staff",
            acc.createdAt || null
          ]
        );
      }
    }
  }

  const couriersCount = await pool.query(`SELECT COUNT(*)::int AS count FROM couriers`);
  if (couriersCount.rows[0].count === 0) {
    const legacy = readLegacyFile(files.couriers);
    for (const row of legacy) {
      const record = { ...row };
      record.id = cleanText(record.id) || uuidv4();

      await pool.query(
        `INSERT INTO couriers (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, JSON.stringify(record)]
      );
    }
  }

  const ratesCount = await pool.query(`SELECT COUNT(*)::int AS count FROM rates`);
  if (ratesCount.rows[0].count === 0) {
    const legacy = readLegacyFile(files.rates);
    for (const row of legacy) {
      const record = { ...row };
      record.id = cleanText(record.id) || uuidv4();

      await pool.query(
        `INSERT INTO rates (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, JSON.stringify(record)]
      );
    }
  }

  const shipmentsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM shipments`);
  if (shipmentsCount.rows[0].count === 0) {
    const legacy = readLegacyFile(files.shipments);
    for (const row of legacy) {
      const record = { ...row };
      record.id = cleanText(record.id) || uuidv4();
      record.pod = cleanText(record.pod);
      record.status = cleanText(record.status) || "Booked";
      record.createdAt = record.createdAt || new Date().toISOString();

      if (!record.pod) continue;

      await pool.query(
        `INSERT INTO shipments (id, pod, status, data, created_at)
         VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [
          record.id,
          record.pod,
          record.status,
          JSON.stringify(record),
          record.createdAt || null
        ]
      );
    }
  }

  const creditsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM credits`);
  if (creditsCount.rows[0].count === 0) {
    const legacy = readLegacyFile(files.credits);
    for (const row of legacy) {
      const record = { ...row };
      record.id = cleanText(record.id) || uuidv4();
      record.createdAt = record.createdAt || new Date().toISOString();

      await pool.query(
        `INSERT INTO credits (id, data, created_at)
         VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [record.id, JSON.stringify(record), record.createdAt || null]
      );
    }
  }

  await ensureDefaultAdminAccount();
}

async function getAllJsonRows(table) {
  const result = await pool.query(
    `SELECT id, data, created_at FROM ${table} ORDER BY created_at DESC, id DESC`
  );

  return result.rows.map(r => {
    const data = r.data || {};
    return {
      ...data,
      id: data.id || r.id,
      createdAt: data.createdAt || r.created_at
    };
  });
}

/* ---------------- HEALTH ---------------- */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error", error: "Database connection failed" });
  }
});

/* ---------------- LOGIN / AUTH ---------------- */

app.post("/api/login", async (req, res) => {
  try {
    const username = cleanText(req.body.username);
    const password = cleanText(req.body.password);

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const result = await pool.query(
      `SELECT * FROM accounts WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username]
    );

    const account = result.rows[0];

    if (!account || cleanText(account.password) !== password) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const sessionToken = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await pool.query(
      `INSERT INTO sessions (token, account_id, expires_at)
       VALUES ($1, $2, $3::timestamptz)`,
      [sessionToken, account.id, expiresAt]
    );

    return res.json({
      success: true,
      user: sanitizeAccount(account),
      sessionToken,
      expiresAt
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/logout", requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [req.auth.token]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Logout failed" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  res.json({
    authenticated: true,
    user: req.auth.user,
    expiresAt: req.auth.expiresAt
  });
});

app.get("/api/auth/check", requireAuth, async (req, res) => {
  res.json({
    success: true,
    authenticated: true,
    user: req.auth.user,
    expiresAt: req.auth.expiresAt
  });
});

/* ---------------- ACCOUNTS ---------------- */

app.get("/api/accounts", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, role, created_at FROM accounts ORDER BY created_at DESC, username ASC`
    );
    res.json(result.rows.map(sanitizeAccount));
  } catch (err) {
    res.status(500).json({ error: "Failed to load accounts" });
  }
});

app.post("/api/accounts", async (req, res) => {
  try {
    const username = cleanText(req.body.username);
    const password = cleanText(req.body.password);
    const role = cleanText(req.body.role) || "staff";

    if (!username) return res.status(400).json({ error: "Username is required" });
    if (!password) return res.status(400).json({ error: "Password is required" });

    const exists = await pool.query(
      `SELECT id FROM accounts WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username]
    );

    if (exists.rows.length) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const id = uuidv4();

    const inserted = await pool.query(
      `INSERT INTO accounts (id, username, password, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, created_at`,
      [id, username, password, role]
    );

    res.json({ success: true, account: sanitizeAccount(inserted.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: "Failed to create account" });
  }
});

app.put("/api/accounts/:id", async (req, res) => {
  try {
    const currentResult = await pool.query(
      `SELECT * FROM accounts WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!currentResult.rows.length) {
      return res.status(404).json({ error: "Account not found" });
    }

    const current = currentResult.rows[0];

    const username = req.body.username !== undefined ? cleanText(req.body.username) : cleanText(current.username);
    const password = req.body.password !== undefined ? cleanText(req.body.password) : cleanText(current.password);
    const role = req.body.role !== undefined ? cleanText(req.body.role) || "staff" : cleanText(current.role) || "staff";

    if (!username) return res.status(400).json({ error: "Username is required" });
    if (!password) return res.status(400).json({ error: "Password is required" });

    const duplicate = await pool.query(
      `SELECT id FROM accounts WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1`,
      [username, req.params.id]
    );

    if (duplicate.rows.length) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const updated = await pool.query(
      `UPDATE accounts
       SET username = $1, password = $2, role = $3
       WHERE id = $4
       RETURNING id, username, role, created_at`,
      [username, password, role, req.params.id]
    );

    res.json({ success: true, account: sanitizeAccount(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: "Failed to update account" });
  }
});

app.delete("/api/accounts/:id", async (req, res) => {
  try {
    const currentResult = await pool.query(
      `SELECT * FROM accounts WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!currentResult.rows.length) {
      return res.status(404).json({ error: "Account not found" });
    }

    const account = currentResult.rows[0];
    if (cleanText(account.username).toLowerCase() === DEFAULT_ADMIN.username.toLowerCase()) {
      return res.status(400).json({ error: "Default admin account cannot be deleted" });
    }

    await pool.query(`DELETE FROM accounts WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete account" });
  }
});

/* ---------------- COURIERS ---------------- */

app.get("/api/couriers", async (req, res) => {
  try {
    const rows = await getAllJsonRows("couriers");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load couriers" });
  }
});

app.post("/api/couriers", async (req, res) => {
  try {
    const name = cleanText(req.body.name);
    const trackingLink = cleanText(req.body.trackingLink);

    if (!name) {
      return res.status(400).json({ error: "Courier name required" });
    }

    const exists = await pool.query(
      `SELECT id FROM couriers WHERE LOWER(COALESCE(data->>'name','')) = LOWER($1) LIMIT 1`,
      [name]
    );

    if (exists.rows.length) {
      return res.status(400).json({ error: "Courier already exists" });
    }

    const record = {
      id: uuidv4(),
      name,
      trackingLink
    };

    await pool.query(
      `INSERT INTO couriers (id, data) VALUES ($1, $2::jsonb)`,
      [record.id, JSON.stringify(record)]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to create courier" });
  }
});

app.put("/api/couriers/:id", async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT * FROM couriers WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Courier not found" });
    }

    const name = cleanText(req.body.name);
    const trackingLink = cleanText(req.body.trackingLink);

    if (!name) {
      return res.status(400).json({ error: "Courier name required" });
    }

    const duplicate = await pool.query(
      `SELECT id FROM couriers
       WHERE LOWER(COALESCE(data->>'name','')) = LOWER($1)
       AND id <> $2
       LIMIT 1`,
      [name, req.params.id]
    );

    if (duplicate.rows.length) {
      return res.status(400).json({ error: "Courier already exists" });
    }

    const record = {
      ...(existing.rows[0].data || {}),
      id: req.params.id,
      name,
      trackingLink
    };

    await pool.query(
      `UPDATE couriers SET data = $1::jsonb WHERE id = $2`,
      [JSON.stringify(record), req.params.id]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to update courier" });
  }
});

app.delete("/api/couriers/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM couriers WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Courier not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete courier" });
  }
});

/* ---------------- SHIPMENT MODES ---------------- */

app.get("/api/shipment-modes", (req, res) => {
  res.json(shipmentModes);
});

/* ---------------- TRANSPORT MODES ---------------- */

app.get("/api/transport-modes", (req, res) => {
  res.json(transportModes);
});

/* ---------------- STATUSES ---------------- */

app.get("/api/statuses", (req, res) => {
  res.json(statuses);
});

/* ---------------- RATES ---------------- */

app.get("/api/rates", async (req, res) => {
  try {
    const rows = await getAllJsonRows("rates");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load rates" });
  }
});

app.post("/api/rates", async (req, res) => {
  try {
    const record = {
      id: uuidv4(),
      ...req.body
    };

    await pool.query(
      `INSERT INTO rates (id, data) VALUES ($1, $2::jsonb)`,
      [record.id, JSON.stringify(record)]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to create rate" });
  }
});

app.put("/api/rates/:id", async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT * FROM rates WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Rate not found" });
    }

    const record = {
      ...(existing.rows[0].data || {}),
      ...req.body,
      id: req.params.id
    };

    await pool.query(
      `UPDATE rates SET data = $1::jsonb WHERE id = $2`,
      [JSON.stringify(record), req.params.id]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to update rate" });
  }
});

app.delete("/api/rates/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM rates WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Rate not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete rate" });
  }
});

/* ---------------- SHIPMENTS ---------------- */

app.get("/api/shipments", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, pod, status, data, created_at
       FROM shipments
       ORDER BY created_at DESC, id DESC`
    );

    const rows = result.rows.map(r => ({
      ...(r.data || {}),
      id: r.id,
      pod: r.pod,
      status: r.status || r.data?.status || "Booked",
      createdAt: r.data?.createdAt || r.created_at
    }));

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load shipments" });
  }
});

app.get("/api/shipments/pod/:pod", async (req, res) => {
  try {
    const pod = cleanText(req.params.pod);

    const result = await pool.query(
      `SELECT id, pod, status, data, created_at
       FROM shipments
       WHERE pod = $1
       LIMIT 1`,
      [pod]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    const r = result.rows[0];
    res.json({
      ...(r.data || {}),
      id: r.id,
      pod: r.pod,
      status: r.status || r.data?.status || "Booked",
      createdAt: r.data?.createdAt || r.created_at
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load shipment" });
  }
});

app.post("/api/shipments", async (req, res) => {
  try {
    const pod = cleanText(req.body.pod);
    if (!pod) {
      return res.status(400).json({ error: "POD is required" });
    }

    const exists = await pool.query(
      `SELECT id FROM shipments WHERE pod = $1 LIMIT 1`,
      [pod]
    );

    if (exists.rows.length) {
      return res.status(400).json({ error: "POD already exists" });
    }

    const record = {
      id: uuidv4(),
      status: "Booked",
      createdAt: new Date().toISOString(),
      ...req.body,
      pod
    };

    await pool.query(
      `INSERT INTO shipments (id, pod, status, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [record.id, record.pod, record.status, JSON.stringify(record), record.createdAt]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to create shipment" });
  }
});

app.put("/api/shipments/:id", async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT * FROM shipments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    const current = existing.rows[0];
    const currentData = current.data || {};
    const incomingPod = req.body.pod !== undefined ? cleanText(req.body.pod) : cleanText(current.pod);

    if (!incomingPod) {
      return res.status(400).json({ error: "POD is required" });
    }

    const duplicate = await pool.query(
      `SELECT id FROM shipments WHERE pod = $1 AND id <> $2 LIMIT 1`,
      [incomingPod, req.params.id]
    );

    if (duplicate.rows.length) {
      return res.status(400).json({ error: "POD already exists" });
    }

    const record = {
      ...currentData,
      ...req.body,
      id: req.params.id,
      pod: incomingPod,
      status: cleanText(req.body.status) || cleanText(current.status) || cleanText(currentData.status) || "Booked",
      createdAt: currentData.createdAt || current.created_at
    };

    await pool.query(
      `UPDATE shipments
       SET pod = $1, status = $2, data = $3::jsonb
       WHERE id = $4`,
      [record.pod, record.status, JSON.stringify(record), req.params.id]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to update shipment" });
  }
});

app.put("/api/shipments/:id/status", async (req, res) => {
  try {
    const status = cleanText(req.body.status);

    const existing = await pool.query(
      `SELECT * FROM shipments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    const current = existing.rows[0];
    const record = {
      ...(current.data || {}),
      id: current.id,
      pod: current.pod,
      status: status || "Booked",
      createdAt: current.data?.createdAt || current.created_at
    };

    await pool.query(
      `UPDATE shipments SET status = $1, data = $2::jsonb WHERE id = $3`,
      [record.status, JSON.stringify(record), req.params.id]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to update shipment status" });
  }
});

app.get("/api/track/:pod", async (req, res) => {
  try {
    const pod = cleanText(req.params.pod);

    const result = await pool.query(
      `SELECT id, pod, status, data, created_at
       FROM shipments
       WHERE pod = $1
       LIMIT 1`,
      [pod]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    const r = result.rows[0];
    res.json({
      ...(r.data || {}),
      id: r.id,
      pod: r.pod,
      status: r.status || r.data?.status || "Booked",
      createdAt: r.data?.createdAt || r.created_at
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to track shipment" });
  }
});

/* ---------------- CREDIT ---------------- */

app.get("/api/credits", async (req, res) => {
  try {
    const rows = await getAllJsonRows("credits");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load credits" });
  }
});

app.post("/api/credits", async (req, res) => {
  try {
    const record = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...req.body
    };

    await pool.query(
      `INSERT INTO credits (id, data, created_at) VALUES ($1, $2::jsonb, $3::timestamptz)`,
      [record.id, JSON.stringify(record), record.createdAt]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to create credit" });
  }
});

app.put("/api/credits/:id", async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT * FROM credits WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Credit not found" });
    }

    const record = {
      ...(existing.rows[0].data || {}),
      ...req.body,
      id: req.params.id,
      createdAt: existing.rows[0].data?.createdAt || existing.rows[0].created_at
    };

    await pool.query(
      `UPDATE credits SET data = $1::jsonb WHERE id = $2`,
      [JSON.stringify(record), req.params.id]
    );

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to update credit" });
  }
});

app.delete("/api/credits/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM credits WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Credit not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete credit" });
  }
});

/* ---------------- START SERVER ---------------- */

async function startServer() {
  try {
    await initDatabase();
    await cleanupExpiredSessions();
    await migrateLegacyDataIfNeeded();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Server start failed:", err.message);
    process.exit(1);
  }
}

startServer();