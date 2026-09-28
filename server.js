const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'warehouse.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT '蔬菜'
  );
  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS batches_fifo ON batches(item_id, received_at, id);
  CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(id),
    batch_id INTEGER REFERENCES batches(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
`);

const countItems = db.prepare('SELECT COUNT(*) AS count FROM items').get().count;
if (countItems === 0) {
  const seed = db.prepare('INSERT INTO items (name, category) VALUES (?, ?)');
  const seedWarehouse = db.prepare('INSERT OR IGNORE INTO warehouses (id, name) VALUES (?, ?)');
  seedWarehouse.run(1, '一號冷凍庫');
  seedWarehouse.run(2, '二號冷凍庫');
  const itemIds = new Map();
  for (const [name, category] of [
    ['青江菜', '蔬菜'], ['甘藍菜', '蔬菜'], ['菠菜', '蔬菜'],
    ['花椰菜', '蔬菜'], ['玉米', '蔬菜'], ['草莓', '水果'], ['芒果', '水果']
  ]) {
    itemIds.set(name, Number(seed.run(name, category).lastInsertRowid));
  }
  const addBatch = db.prepare(`
    INSERT INTO batches (item_id, warehouse_id, location, quantity, received_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const addMovement = db.prepare(`
    INSERT INTO movements (type, item_id, batch_id, warehouse_id, location, quantity, created_at, note)
    VALUES ('receipt', ?, ?, ?, ?, ?, ?, '系統初始庫存')
  `);
  const initialStock = [
    ['青江菜', 1, 'A-01', 3, '2026-09-26T09:00:00+08:00'],
    ['青江菜', 1, 'A-04', 2, '2026-09-27T08:00:00+08:00'],
    ['甘藍菜', 1, 'A-02', 5, '2026-09-25T10:00:00+08:00'],
    ['菠菜', 1, 'A-03', 4, '2026-09-26T14:30:00+08:00'],
    ['花椰菜', 1, 'A-05', 3, '2026-09-27T11:15:00+08:00'],
    ['玉米', 1, 'A-06', 6, '2026-09-24T15:00:00+08:00'],
    ['草莓', 2, 'B-01', 8, '2026-09-25T09:30:00+08:00'],
    ['青江菜', 2, 'B-02', 4, '2026-09-24T08:00:00+08:00'],
    ['甘藍菜', 2, 'B-03', 3, '2026-09-26T13:20:00+08:00'],
    ['芒果', 2, 'B-04', 10, '2026-09-23T10:00:00+08:00']
  ];
  const now = new Date().toISOString();
  for (const [name, warehouseId, location, quantity, receivedAt] of initialStock) {
    const itemId = itemIds.get(name);
    const result = addBatch.run(itemId, warehouseId, location, quantity, new Date(receivedAt).toISOString());
    addMovement.run(itemId, Number(result.lastInsertRowid), warehouseId, location, quantity, now);
  }
}

const inventoryQuery = db.prepare(`
  SELECT b.id AS batchId, i.id AS itemId, i.name AS itemName, i.category,
         b.warehouse_id AS warehouseId, w.name AS warehouseName,
         b.location, b.quantity, b.received_at AS receivedAt
  FROM batches b
  JOIN items i ON i.id = b.item_id
  JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.quantity > 0
  ORDER BY b.warehouse_id, i.name, b.received_at, b.id
`);

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error('請求內容過大'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('請提供有效的 JSON'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw Object.assign(new Error(`${label}必須是大於零的整數`), { status: 400 });
  }
  return number;
}

function getInventory() {
  const batches = inventoryQuery.all();
  const totals = db.prepare(`
    SELECT warehouse_id AS warehouseId, SUM(quantity) AS quantity
    FROM batches WHERE quantity > 0 GROUP BY warehouse_id
  `).all();
  return {
    warehouses: db.prepare('SELECT id, name FROM warehouses ORDER BY id').all().map(warehouse => ({
      ...warehouse,
      quantity: totals.find(total => total.warehouseId === warehouse.id)?.quantity ?? 0
    })),
    batches,
    totalQuantity: batches.reduce((sum, batch) => sum + batch.quantity, 0),
    itemCount: new Set(batches.map(batch => batch.itemId)).size
  };
}

function getFifo(itemId, warehouseId) {
  const batches = db.prepare(`
    SELECT b.id AS batchId, i.id AS itemId, i.name AS itemName,
           b.warehouse_id AS warehouseId, w.name AS warehouseName,
           b.location, b.quantity, b.received_at AS receivedAt
    FROM batches b
    JOIN items i ON i.id = b.item_id
    JOIN warehouses w ON w.id = b.warehouse_id
    WHERE b.item_id = ? AND b.quantity > 0 ${warehouseId ? 'AND b.warehouse_id = ?' : ''}
    ORDER BY b.received_at, b.id
  `).all(...(warehouseId ? [itemId, warehouseId] : [itemId]));
  return { batches, suggested: batches[0] ?? null };
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/inventory') {
    return json(response, 200, getInventory());
  }
  if (request.method === 'GET' && url.pathname === '/api/items') {
    return json(response, 200, db.prepare('SELECT id, name, category FROM items ORDER BY name').all());
  }
  if (request.method === 'GET' && url.pathname === '/api/activity') {
    const rows = db.prepare(`
      SELECT m.id, m.type, i.name AS itemName, w.name AS warehouseName,
             m.location, m.quantity, m.created_at AS createdAt, m.note
      FROM movements m
      JOIN items i ON i.id = m.item_id
      JOIN warehouses w ON w.id = m.warehouse_id
            WHERE m.note <> '系統初始庫存'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 12
    `).all();
    return json(response, 200, rows);
  }
  if (request.method === 'GET' && url.pathname === '/api/fifo') {
    const itemId = positiveInteger(url.searchParams.get('itemId'), '品項');
    const warehouseId = url.searchParams.get('warehouseId')
      ? positiveInteger(url.searchParams.get('warehouseId'), '倉庫')
      : null;
    return json(response, 200, getFifo(itemId, warehouseId));
  }
  if (request.method === 'GET' && url.pathname === '/api/counts') {
    const warehouseId = positiveInteger(url.searchParams.get('warehouseId'), '倉庫');
    const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ?').get(warehouseId);
    if (!warehouse) throw Object.assign(new Error('找不到指定倉庫'), { status: 404 });
    return json(response, 200, {
      warehouse,
      batches: inventoryQuery.all().filter(batch => batch.warehouseId === warehouseId)
    });
  }
  if (request.method !== 'POST') {
    throw Object.assign(new Error('找不到此 API'), { status: 404 });
  }

  const body = await readBody(request);
  if (url.pathname === '/api/receipts') {
    const itemName = String(body.itemName || '').trim();
    const category = body.category === '水果' ? '水果' : '蔬菜';
    const location = String(body.location || '').trim();
    const quantity = positiveInteger(body.quantity, '進貨數量');
    const warehouseId = positiveInteger(body.warehouseId, '倉庫');
    const receivedAt = new Date(body.receivedAt || Date.now());
    if (!itemName || itemName.length > 40 || !location || location.length > 30 || Number.isNaN(receivedAt.getTime())) {
      throw Object.assign(new Error('請檢查品項、儲位與入庫時間'), { status: 400 });
    }
    if (!db.prepare('SELECT id FROM warehouses WHERE id = ?').get(warehouseId)) {
      throw Object.assign(new Error('找不到指定倉庫'), { status: 404 });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      let item = db.prepare('SELECT id FROM items WHERE name = ?').get(itemName);
      if (!item) {
        const result = db.prepare('INSERT INTO items (name, category) VALUES (?, ?)').run(itemName, category);
        item = { id: Number(result.lastInsertRowid) };
      }
      const timestamp = receivedAt.toISOString();
      const result = db.prepare(`
        INSERT INTO batches (item_id, warehouse_id, location, quantity, received_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(item.id, warehouseId, location, quantity, timestamp);
      db.prepare(`
        INSERT INTO movements (type, item_id, batch_id, warehouse_id, location, quantity, created_at, note)
        VALUES ('receipt', ?, ?, ?, ?, ?, ?, '一般進貨')
      `).run(item.id, Number(result.lastInsertRowid), warehouseId, location, quantity, new Date().toISOString());
      db.exec('COMMIT');
      return json(response, 201, { ok: true, batchId: Number(result.lastInsertRowid), receivedAt: timestamp });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  if (url.pathname === '/api/shipments') {
    const itemId = positiveInteger(body.itemId, '品項');
    const quantity = positiveInteger(body.quantity, '出貨數量');
    const warehouseId = body.warehouseId ? positiveInteger(body.warehouseId, '倉庫') : null;
    const item = db.prepare('SELECT id, name FROM items WHERE id = ?').get(itemId);
    if (!item) throw Object.assign(new Error('找不到指定品項'), { status: 404 });
    db.exec('BEGIN IMMEDIATE');
    try {
      const candidates = db.prepare(`
        SELECT id AS batchId, warehouse_id AS warehouseId, location, quantity, received_at AS receivedAt
        FROM batches WHERE item_id = ? AND quantity > 0 ${warehouseId ? 'AND warehouse_id = ?' : ''}
        ORDER BY received_at, id
      `).all(...(warehouseId ? [itemId, warehouseId] : [itemId]));
      const available = candidates.reduce((sum, batch) => sum + batch.quantity, 0);
      if (available < quantity) {
        throw Object.assign(new Error(`庫存不足，目前可出貨 ${available} 箱`), { status: 409 });
      }
      let remaining = quantity;
      const picks = [];
      for (const batch of candidates) {
        if (!remaining) break;
        const taken = Math.min(batch.quantity, remaining);
        db.prepare('UPDATE batches SET quantity = quantity - ? WHERE id = ?').run(taken, batch.batchId);
        db.prepare(`
          INSERT INTO movements (type, item_id, batch_id, warehouse_id, location, quantity, created_at, note)
          VALUES ('shipment', ?, ?, ?, ?, ?, ?, 'FIFO 先進先出')
        `).run(itemId, batch.batchId, batch.warehouseId, batch.location, -taken, new Date().toISOString());
        picks.push({ batchId: batch.batchId, warehouseId: batch.warehouseId, location: batch.location, quantity: taken, receivedAt: batch.receivedAt });
        remaining -= taken;
      }
      db.exec('COMMIT');
      return json(response, 200, { ok: true, itemName: item.name, shipped: quantity, picks });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  if (url.pathname === '/api/counts') {
    const warehouseId = positiveInteger(body.warehouseId, '倉庫');
    if (!Array.isArray(body.lines)) throw Object.assign(new Error('盤點明細格式錯誤'), { status: 400 });
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare(`
        SELECT b.id AS batchId, b.item_id AS itemId, i.name AS itemName,
               b.location, b.quantity
        FROM batches b JOIN items i ON i.id = b.item_id
        WHERE b.warehouse_id = ? AND b.quantity > 0 ORDER BY b.id
      `).all(warehouseId);
      const submitted = new Map(body.lines.map(line => [Number(line.batchId), line]));
      if (submitted.size !== current.length || current.some(batch => !submitted.has(batch.batchId))) {
        throw Object.assign(new Error('庫存清單已變更，請重新載入盤點表'), { status: 409 });
      }
      const results = [];
      const now = new Date().toISOString();
      for (const batch of current) {
        const line = submitted.get(batch.batchId);
        const counted = Number(line.countedQuantity);
        const damaged = Number(line.damagedQuantity || 0);
        if (!Number.isSafeInteger(counted) || counted < 0 || !Number.isSafeInteger(damaged) || damaged < 0 || damaged > counted) {
          throw Object.assign(new Error(`${batch.itemName}（${batch.location}）的數量不正確`), { status: 400 });
        }
        const available = counted - damaged;
        if (damaged > 0) {
          db.prepare(`
            INSERT INTO movements (type, item_id, batch_id, warehouse_id, location, quantity, created_at, note)
            VALUES ('spoilage', ?, ?, ?, ?, ?, ?, '盤點登記腐敗報廢')
          `).run(batch.itemId, batch.batchId, warehouseId, batch.location, -damaged, now);
        }
        const adjustment = available - (batch.quantity - damaged);
        if (adjustment !== 0) {
          db.prepare(`
            INSERT INTO movements (type, item_id, batch_id, warehouse_id, location, quantity, created_at, note)
            VALUES ('count_adjustment', ?, ?, ?, ?, ?, ?, '盤點差異校正')
          `).run(batch.itemId, batch.batchId, warehouseId, batch.location, adjustment, now);
        }
        db.prepare('UPDATE batches SET quantity = ? WHERE id = ?').run(available, batch.batchId);
        results.push({ batchId: batch.batchId, itemName: batch.itemName, location: batch.location, previous: batch.quantity, counted, damaged, available, adjustment });
      }
      db.exec('COMMIT');
      return json(response, 200, { ok: true, warehouseId, results });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  throw Object.assign(new Error('找不到此 API'), { status: 404 });
}

function serveStatic(response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    const extension = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream' });
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.message || '伺服器發生錯誤' });
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method not allowed');
    return;
  }
  serveStatic(response, url.pathname);
});

server.listen(PORT, () => {
  console.log(`竹南冷凍倉儲管理系統已啟動：http://localhost:${PORT}`);
});