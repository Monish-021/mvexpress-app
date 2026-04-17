const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 5000;

/* ---------------- BASIC CONFIG ---------------- */

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ---------------- DATA STORAGE ---------------- */

const dataFolder = path.join(__dirname, "data");

const files = {
  shipments: path.join(dataFolder, "shipments.json"),
  couriers: path.join(dataFolder, "couriers.json"),
  rates: path.join(dataFolder, "rates.json"),
  credits: path.join(dataFolder, "credits.json"),
  accounts: path.join(dataFolder, "accounts.json")
};

if (!fs.existsSync(dataFolder)) {
  fs.mkdirSync(dataFolder, { recursive: true });
}

for (const key in files) {
  if (!fs.existsSync(files[key])) {
    fs.writeFileSync(files[key], JSON.stringify([], null, 2));
  }
}

function readFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function writeFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/* ---------------- DEFAULT ADMIN ---------------- */

const DEFAULT_ADMIN = {
  username: "MVEXPRESS021",
  password: "Varamonish2121",
  role: "admin"
};

function ensureDefaultAdminAccount() {
  const accounts = readFile(files.accounts);

  const hasDefault = accounts.some(
    a => String(a.username || "").trim().toLowerCase() === DEFAULT_ADMIN.username.toLowerCase()
  );

  if (!hasDefault) {
    accounts.push({
      id: uuidv4(),
      username: DEFAULT_ADMIN.username,
      password: DEFAULT_ADMIN.password,
      role: DEFAULT_ADMIN.role,
      createdAt: new Date().toISOString()
    });

    writeFile(files.accounts, accounts);
  }
}

ensureDefaultAdminAccount();

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

/* ---------------- HELPERS ---------------- */

function cleanText(value) {
  return String(value || "").trim();
}

function findAccountByUsername(username) {
  const q = cleanText(username).toLowerCase();
  const accounts = readFile(files.accounts);
  return accounts.find(a => cleanText(a.username).toLowerCase() === q);
}

function sanitizeAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    role: account.role || "staff",
    createdAt: account.createdAt || null
  };
}

/* ---------------- HEALTH ---------------- */

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ---------------- LOGIN ---------------- */

app.post("/api/login", (req, res) => {
  const username = cleanText(req.body.username);
  const password = cleanText(req.body.password);

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const account = findAccountByUsername(username);

  if (account && cleanText(account.password) === password) {
    return res.json({
      success: true,
      user: sanitizeAccount(account)
    });
  }

  // Fallback for old hardcoded login safety
  if (
    username === DEFAULT_ADMIN.username &&
    password === DEFAULT_ADMIN.password
  ) {
    return res.json({
      success: true,
      user: {
        username: DEFAULT_ADMIN.username,
        role: DEFAULT_ADMIN.role
      }
    });
  }

  return res.status(401).json({ error: "Invalid credentials" });
});

/* ---------------- ACCOUNTS ---------------- */

app.get("/api/accounts", (req, res) => {
  const accounts = readFile(files.accounts).map(sanitizeAccount);
  res.json(accounts);
});

app.post("/api/accounts", (req, res) => {
  const username = cleanText(req.body.username);
  const password = cleanText(req.body.password);
  const role = cleanText(req.body.role) || "staff";

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }

  const accounts = readFile(files.accounts);

  const exists = accounts.some(
    a => cleanText(a.username).toLowerCase() === username.toLowerCase()
  );

  if (exists) {
    return res.status(400).json({ error: "Username already exists" });
  }

  const account = {
    id: uuidv4(),
    username,
    password,
    role,
    createdAt: new Date().toISOString()
  };

  accounts.push(account);
  writeFile(files.accounts, accounts);

  res.json({
    success: true,
    account: sanitizeAccount(account)
  });
});

app.put("/api/accounts/:id", (req, res) => {
  const accounts = readFile(files.accounts);
  const index = accounts.findIndex(a => a.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Account not found" });
  }

  const current = accounts[index];

  const username = req.body.username !== undefined
    ? cleanText(req.body.username)
    : cleanText(current.username);

  const password = req.body.password !== undefined
    ? cleanText(req.body.password)
    : cleanText(current.password);

  const role = req.body.role !== undefined
    ? cleanText(req.body.role) || "staff"
    : (cleanText(current.role) || "staff");

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }

  const duplicate = accounts.some(
    a =>
      a.id !== req.params.id &&
      cleanText(a.username).toLowerCase() === username.toLowerCase()
  );

  if (duplicate) {
    return res.status(400).json({ error: "Username already exists" });
  }

  accounts[index] = {
    ...current,
    username,
    password,
    role
  };

  writeFile(files.accounts, accounts);

  res.json({
    success: true,
    account: sanitizeAccount(accounts[index])
  });
});

app.delete("/api/accounts/:id", (req, res) => {
  let accounts = readFile(files.accounts);
  const account = accounts.find(a => a.id === req.params.id);

  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  const username = cleanText(account.username).toLowerCase();

  if (username === DEFAULT_ADMIN.username.toLowerCase()) {
    return res.status(400).json({ error: "Default admin account cannot be deleted" });
  }

  accounts = accounts.filter(a => a.id !== req.params.id);
  writeFile(files.accounts, accounts);

  res.json({ success: true });
});

/* ---------------- COURIERS ---------------- */

app.get("/api/couriers", (req, res) => {
  res.json(readFile(files.couriers));
});

app.post("/api/couriers", (req, res) => {
  const { name, trackingLink } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Courier name required" });
  }

  const couriers = readFile(files.couriers);

  const exists = couriers.some(
    c => String(c.name || "").toLowerCase() === String(name).trim().toLowerCase()
  );

  if (exists) {
    return res.status(400).json({ error: "Courier already exists" });
  }

  const newCourier = {
    id: uuidv4(),
    name: String(name).trim(),
    trackingLink: trackingLink ? String(trackingLink).trim() : ""
  };

  couriers.push(newCourier);
  writeFile(files.couriers, couriers);

  res.json(newCourier);
});

app.put("/api/couriers/:id", (req, res) => {
  const { name, trackingLink } = req.body;
  const couriers = readFile(files.couriers);

  const index = couriers.findIndex(c => c.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Courier not found" });
  }

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Courier name required" });
  }

  couriers[index] = {
    ...couriers[index],
    name: String(name).trim(),
    trackingLink: trackingLink ? String(trackingLink).trim() : ""
  };

  writeFile(files.couriers, couriers);
  res.json(couriers[index]);
});

app.delete("/api/couriers/:id", (req, res) => {
  let couriers = readFile(files.couriers);
  const before = couriers.length;

  couriers = couriers.filter(c => c.id !== req.params.id);
  writeFile(files.couriers, couriers);

  if (couriers.length === before) {
    return res.status(404).json({ error: "Courier not found" });
  }

  res.json({ success: true });
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

app.get("/api/rates", (req, res) => {
  res.json(readFile(files.rates));
});

app.post("/api/rates", (req, res) => {
  const rates = readFile(files.rates);

  const newRate = {
    id: uuidv4(),
    ...req.body
  };

  rates.push(newRate);
  writeFile(files.rates, rates);

  res.json(newRate);
});

app.put("/api/rates/:id", (req, res) => {
  const rates = readFile(files.rates);
  const index = rates.findIndex(r => r.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Rate not found" });
  }

  rates[index] = {
    ...rates[index],
    ...req.body
  };

  writeFile(files.rates, rates);
  res.json(rates[index]);
});

app.delete("/api/rates/:id", (req, res) => {
  let rates = readFile(files.rates);
  const before = rates.length;

  rates = rates.filter(r => r.id !== req.params.id);
  writeFile(files.rates, rates);

  if (rates.length === before) {
    return res.status(404).json({ error: "Rate not found" });
  }

  res.json({ success: true });
});

/* ---------------- SHIPMENTS ---------------- */

app.get("/api/shipments", (req, res) => {
  res.json(readFile(files.shipments));
});

app.get("/api/shipments/pod/:pod", (req, res) => {
  const shipments = readFile(files.shipments);
  const shipment = shipments.find(s => String(s.pod) === String(req.params.pod));

  if (!shipment) {
    return res.status(404).json({ error: "Shipment not found" });
  }

  res.json(shipment);
});

app.post("/api/shipments", (req, res) => {
  const shipments = readFile(files.shipments);

  const pod = String(req.body.pod || "").trim();
  if (!pod) {
    return res.status(400).json({ error: "POD is required" });
  }

  const exists = shipments.some(s => String(s.pod) === pod);
  if (exists) {
    return res.status(400).json({ error: "POD already exists" });
  }

  const shipment = {
    id: uuidv4(),
    status: "Booked",
    createdAt: new Date().toISOString(),
    ...req.body,
    pod
  };

  shipments.push(shipment);
  writeFile(files.shipments, shipments);

  res.json(shipment);
});

app.put("/api/shipments/:id", (req, res) => {
  const shipments = readFile(files.shipments);
  const index = shipments.findIndex(s => s.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Shipment not found" });
  }

  shipments[index] = {
    ...shipments[index],
    ...req.body
  };

  writeFile(files.shipments, shipments);
  res.json(shipments[index]);
});

app.put("/api/shipments/:id/status", (req, res) => {
  const shipments = readFile(files.shipments);
  const shipment = shipments.find(s => s.id === req.params.id);

  if (!shipment) {
    return res.status(404).json({ error: "Shipment not found" });
  }

  shipment.status = req.body.status;
  writeFile(files.shipments, shipments);

  res.json(shipment);
});

app.get("/api/track/:pod", (req, res) => {
  const shipments = readFile(files.shipments);

  const shipment = shipments.find(
    s => String(s.pod) === String(req.params.pod)
  );

  if (!shipment) {
    return res.status(404).json({
      error: "Shipment not found"
    });
  }

  res.json(shipment);
});

/* ---------------- CREDIT ---------------- */

app.get("/api/credits", (req, res) => {
  res.json(readFile(files.credits));
});

app.post("/api/credits", (req, res) => {
  const credits = readFile(files.credits);

  const credit = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    ...req.body
  };

  credits.push(credit);
  writeFile(files.credits, credits);

  res.json(credit);
});

app.put("/api/credits/:id", (req, res) => {
  const credits = readFile(files.credits);
  const index = credits.findIndex(c => c.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Credit not found" });
  }

  credits[index] = {
    ...credits[index],
    ...req.body
  };

  writeFile(files.credits, credits);
  res.json(credits[index]);
});

app.delete("/api/credits/:id", (req, res) => {
  let credits = readFile(files.credits);
  const before = credits.length;

  credits = credits.filter(c => c.id !== req.params.id);
  writeFile(files.credits, credits);

  if (credits.length === before) {
    return res.status(404).json({ error: "Credit not found" });
  }

  res.json({ success: true });
});

/* ---------------- START SERVER ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});