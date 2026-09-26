const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAX_BODY = 256 * 1024;
const MAX_ITEMS = 200;
const MAX_BILLS_PER_SESSION = 500;
const UNITS = new Set(["kg", "quintal", "gram"]);
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "calculator.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS drafts (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    total REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bills_sid_created ON bills (sid, created_at DESC);
`);

const q = {
  getDraft: db.prepare("SELECT data FROM drafts WHERE sid = ?"),
  putDraft: db.prepare(
    "INSERT INTO drafts (sid, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ),
  listBills: db.prepare(
    "SELECT id, name, item_count, total, created_at FROM bills WHERE sid = ? ORDER BY created_at DESC, id DESC"
  ),
  getBill: db.prepare("SELECT id, name, data FROM bills WHERE id = ? AND sid = ?"),
  countBills: db.prepare("SELECT COUNT(*) AS c FROM bills WHERE sid = ?"),
  addBill: db.prepare(
    "INSERT INTO bills (sid, name, data, item_count, total, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  delBill: db.prepare("DELETE FROM bills WHERE id = ? AND sid = ?"),
};

const shortText = (v, max) => String(v ?? "").slice(0, max);

function cleanBill(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
    return null;
  }
  const items = body.items.map((i) => ({
    item: shortText(i?.item, 120),
    rate: shortText(i?.rate, 30),
    rateUnit: UNITS.has(i?.rateUnit) ? i.rateUnit : "quintal",
    total: shortText(i?.total, 30),
    bag: shortText(i?.bag, 30),
  }));
  return { items, outUnit: UNITS.has(body.outUnit) ? body.outUnit : "kg" };
}

function getSession(req, res) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "");
  if (m && SID_RE.test(m[1])) return m[1];
  const sid = crypto.randomUUID();
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  return sid;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) {
      return reject({ status: 415, message: "JSON required" });
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject({ status: 413, message: "Too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject({ status: 400, message: "Bad JSON" });
      }
    });
    req.on("error", () => reject({ status: 400, message: "Bad request" }));
  });
}

function send(res, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

const indexHtml = () => fs.readFileSync(path.join(__dirname, "index.html"));

async function handleApi(req, res, url) {
  const sid = getSession(req, res);
  const method = req.method;

  if (url.pathname === "/api/state" && method === "GET") {
    const row = q.getDraft.get(sid);
    return send(res, 200, {
      draft: row ? JSON.parse(row.data) : null,
      bills: q.listBills.all(sid),
    });
  }

  if (url.pathname === "/api/draft" && method === "PUT") {
    const bill = cleanBill(await readJson(req));
    if (!bill) return send(res, 400, { error: "Invalid bill" });
    q.putDraft.run(sid, JSON.stringify(bill), Date.now());
    return send(res, 204);
  }

  if (url.pathname === "/api/bills" && method === "GET") {
    return send(res, 200, { bills: q.listBills.all(sid) });
  }

  if (url.pathname === "/api/bills" && method === "POST") {
    const body = await readJson(req);
    const bill = cleanBill(body);
    if (!bill || bill.items.length === 0) return send(res, 400, { error: "Invalid bill" });
    if (q.countBills.get(sid).c >= MAX_BILLS_PER_SESSION) {
      return send(res, 409, { error: "Too many saved bills. Delete some first." });
    }
    const name = shortText(body.name, 80).trim() || "Untitled bill";
    const total = bill.items.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
    const info = q.addBill.run(sid, name, JSON.stringify(bill), bill.items.length, total, Date.now());
    return send(res, 201, { id: Number(info.lastInsertRowid) });
  }

  const m = /^\/api\/bills\/(\d+)$/.exec(url.pathname);
  if (m && method === "GET") {
    const row = q.getBill.get(Number(m[1]), sid);
    if (!row) return send(res, 404, { error: "Not found" });
    return send(res, 200, { id: row.id, name: row.name, ...JSON.parse(row.data) });
  }
  if (m && method === "DELETE") {
    const info = q.delBill.run(Number(m[1]), sid);
    return send(res, info.changes ? 204 : 404, info.changes ? undefined : { error: "Not found" });
  }

  return send(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && (req.method === "GET" || req.method === "HEAD")) {
      const html = indexHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": html.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(req.method === "HEAD" ? undefined : html);
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    if (err && err.status) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, () => console.log(`Listening on ${PORT}, data in ${DATA_DIR}`));
