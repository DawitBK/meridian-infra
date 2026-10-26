#!/usr/bin/env node
/**
 * Fills the four product apps with believable, generic demo data through their own APIs (so every rule runs), then
 * spreads dates over the last month where the app has no way to back-date a record.
 *
 *   node seed-apps.mjs --apps-root <dir> --runtime <dir> [--only retail-os,library,martronics,jobpilot]
 *
 * Needs the APIs running (hosting/scripts/apps.mjs up) and the accounts created (apps.mjs people).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const appsRoot = arg('apps-root');
const runtime = arg('runtime');
const only = arg('only')?.split(',');
if (!appsRoot || !runtime) {
  console.error('Usage: seed-apps.mjs --apps-root <dir> --runtime <dir> [--only a,b]');
  process.exit(2);
}
const secrets = JSON.parse(fs.readFileSync(path.join(runtime, 'secrets.json'), 'utf8'));
const infra = Object.fromEntries(
  fs.readFileSync(path.join(runtime, 'infra.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const PORTS = { 'retail-os': 16101, library: 16102, martronics: 16103, jobpilot: 16104 };
const DIRS = { 'retail-os': 'retail-os', library: 'library-management-system', martronics: 'martronics', jobpilot: 'jobpilot' };
const DBS = { 'retail-os': 'retail_os', library: 'library', martronics: 'martronics', jobpilot: 'jobpilot' };
const OWNER = process.env.SAAS_OWNER_EMAIL ?? 'owner@examplecorp.com';
const DEMO_PASSWORD = secrets['demo.password'];
if (!DEMO_PASSWORD) throw new Error('secrets.json has no demo.password (seed-demo-accounts.mjs / prepare.mjs creates it)');

let seed = 20261019;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (list) => list[int(0, list.length - 1)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, w = 3) => String(n).padStart(w, '0');
/** A valid ISBN-13 (978 + 9 digits + check digit). */
const isbn13 = (i) => {
  const body = '978' + String(100000000 + i * 104729).slice(-9);
  const sum = [...body].reduce((a, d, k) => a + Number(d) * (k % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
};

async function client(key, email, password) {
  const base = `http://127.0.0.1:${PORTS[key]}/api/v1`;
  let token;
  const call = async (method, p, body) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(110);
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && method === 'POST' && p.match(/sales|purchases|orders|loans|expenses/) ? { 'idempotency-key': randomBytes(12).toString('hex') } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) {
        await sleep(15000);
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 240)}`);
      return json;
    }
    throw new Error(`${method} ${p}: rate limited`);
  };
  const login = await call('POST', '/auth/login', { email, password });
  token = login.accessToken;
  return { call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), login };
}

async function superDb(key) {
  const pg = createRequire(path.join(appsRoot, DIRS[key], 'apps', 'api', 'package.json'))('pg');
  const c = new pg.Client({ host: '127.0.0.1', port: Number(infra.POSTGRES_PORT ?? 5440), user: 'postgres', password: infra.POSTGRES_PASSWORD, database: DBS[key] });
  await c.connect();
  return c;
}

const log = (s) => console.log(`  ${s}`);

// ======================================================================================= Retail OS
/** The API stamps records "now": move the fresh sales and purchases back over the last month (once: only records from the last hours move). */
async function spreadRetailDates() {
  const db = await superDb('retail-os');
  try {
    await db.query('alter table journal_entries disable trigger user');
    const sales = (await db.query("select id from sales where created_at > now() - interval '3 hours' order by created_at")).rows;
    for (let i = 0; i < sales.length; i += 1) {
      const daysAgo = Math.floor((i / sales.length) * 29) + (i % 2);
      await db.query("update sales set created_at = created_at - ($2 || ' days')::interval, sale_date = sale_date - ($2 || ' days')::interval where id = $1", [sales[i].id, daysAgo]);
      await db.query("update journal_entries set entry_date = (entry_date - ($2 || ' days')::interval)::date, created_at = created_at - ($2 || ' days')::interval where reference_id = $1", [sales[i].id, daysAgo]);
    }
    const purchases = (await db.query("select id from purchases where created_at > now() - interval '3 hours' order by created_at")).rows;
    for (let i = 0; i < purchases.length; i += 1) {
      await db.query("update purchases set order_date = (order_date - ($2 || ' days')::interval)::date, created_at = created_at - ($2 || ' days')::interval where id = $1", [purchases[i].id, Math.max(29 - i * 2, 1)]);
    }
    console.log(`  dates spread: ${sales.length} sales, ${purchases.length} purchase orders`);
  } finally {
    await db.query('alter table journal_entries enable trigger user').catch(() => undefined);
    await db.end();
  }
}

async function retail() {
  const api = await client('retail-os', OWNER, secrets['apps.retail-os.owner']);
  const existing = await api.get('/products?limit=1');
  if ((existing.total ?? existing.items?.length ?? 0) > 0) {
    await spreadRetailDates();
    return log('already seeded');
  }
  const money = (birr) => Math.round(birr * 100);

  const cats = {};
  for (const [name, type] of [['Electronics', 'ELECTRONICS'], ['Stationery', 'STATIONERY']]) cats[type] = (await api.post('/categories', { name, type })).id;
  const subs = {};
  const SUBS = { ELECTRONICS: ['Phones and accessories', 'Computers', 'Audio', 'Power and cables', 'Home appliances'], STATIONERY: ['Paper', 'Writing', 'Office supplies', 'School supplies'] };
  for (const [type, names] of Object.entries(SUBS)) for (const n of names) subs[n] = (await api.post('/sub-categories', { categoryId: cats[type], name: n })).id;
  const brands = {};
  for (const [n, c] of [['Samsung', 'South Korea'], ['Xiaomi', 'China'], ['Lenovo', 'China'], ['HP', 'United States'], ['JBL', 'United States'], ['Anker', 'China'], ['Tecno', 'China'], ['Pilot', 'Japan'], ['Bic', 'France'], ['Double A', 'Thailand'], ['Casio', 'Japan'], ['Stabilo', 'Germany']]) brands[n] = (await api.post('/brands', { name: n, country: c })).id;
  log('catalogue structure ready');

  const PRODUCTS = [
    ['Smartphone 6.5in 128GB', 'Phones and accessories', 'Samsung', 14500, 11200, 'ELECTRONICS'], ['Smartphone 6.7in 256GB', 'Phones and accessories', 'Xiaomi', 17800, 14100, 'ELECTRONICS'],
    ['Budget smartphone 64GB', 'Phones and accessories', 'Tecno', 6200, 4700, 'ELECTRONICS'], ['Phone case, clear', 'Phones and accessories', 'Anker', 450, 220, 'ELECTRONICS'],
    ['Tempered glass protector', 'Phones and accessories', 'Anker', 250, 90, 'ELECTRONICS'], ['Laptop 15.6in i5 8GB', 'Computers', 'Lenovo', 38500, 31500, 'ELECTRONICS'],
    ['Laptop 14in i3 4GB', 'Computers', 'HP', 26500, 21800, 'ELECTRONICS'], ['Wireless mouse', 'Computers', 'HP', 750, 420, 'ELECTRONICS'],
    ['USB keyboard', 'Computers', 'Lenovo', 950, 560, 'ELECTRONICS'], ['USB flash drive 64GB', 'Computers', 'Samsung', 650, 380, 'ELECTRONICS'],
    ['Bluetooth speaker', 'Audio', 'JBL', 4200, 3100, 'ELECTRONICS'], ['Wired earphones', 'Audio', 'Xiaomi', 380, 170, 'ELECTRONICS'],
    ['Wireless earbuds', 'Audio', 'Samsung', 2900, 2000, 'ELECTRONICS'], ['Power bank 20000mAh', 'Power and cables', 'Anker', 2400, 1650, 'ELECTRONICS'],
    ['USB-C cable 1m', 'Power and cables', 'Anker', 320, 130, 'ELECTRONICS'], ['Phone charger 25W', 'Power and cables', 'Samsung', 850, 480, 'ELECTRONICS'],
    ['Extension socket 4-way', 'Power and cables', 'Xiaomi', 600, 340, 'ELECTRONICS'], ['Electric kettle 1.7L', 'Home appliances', 'Xiaomi', 2100, 1450, 'ELECTRONICS'],
    ['Rice cooker 1.8L', 'Home appliances', 'Samsung', 3400, 2500, 'ELECTRONICS'], ['LED desk lamp', 'Home appliances', 'Xiaomi', 780, 430, 'ELECTRONICS'],
    ['A4 copy paper, ream 500', 'Paper', 'Double A', 420, 310, 'STATIONERY'], ['A4 copy paper, box of 5', 'Paper', 'Double A', 2050, 1550, 'STATIONERY'],
    ['Notebook A5 80 pages', 'Paper', 'Bic', 55, 28, 'STATIONERY'], ['Notebook A4 160 pages', 'Paper', 'Bic', 110, 62, 'STATIONERY'],
    ['Sticky notes 76mm', 'Paper', 'Stabilo', 60, 30, 'STATIONERY'], ['Ballpoint pen blue, box of 50', 'Writing', 'Bic', 480, 310, 'STATIONERY'],
    ['Gel pen black', 'Writing', 'Pilot', 45, 22, 'STATIONERY'], ['Highlighter set of 4', 'Writing', 'Stabilo', 190, 110, 'STATIONERY'],
    ['Permanent marker black', 'Writing', 'Pilot', 40, 19, 'STATIONERY'], ['Whiteboard marker, set of 4', 'Writing', 'Pilot', 170, 95, 'STATIONERY'],
    ['Stapler standard', 'Office supplies', 'Bic', 160, 90, 'STATIONERY'], ['Staples 26/6, box', 'Office supplies', 'Bic', 25, 11, 'STATIONERY'],
    ['Ring binder A4', 'Office supplies', 'Double A', 95, 52, 'STATIONERY'], ['Clear folder, pack of 12', 'Office supplies', 'Double A', 130, 74, 'STATIONERY'],
    ['Calculator 12-digit', 'Office supplies', 'Casio', 520, 340, 'STATIONERY'], ['Scientific calculator', 'School supplies', 'Casio', 1450, 1050, 'STATIONERY'],
    ['Geometry set', 'School supplies', 'Stabilo', 120, 66, 'STATIONERY'], ['School bag', 'School supplies', 'Xiaomi', 950, 560, 'STATIONERY'],
    ['Pencil box with pencils', 'School supplies', 'Bic', 140, 75, 'STATIONERY'], ['Colouring pencils, 24', 'School supplies', 'Stabilo', 210, 125, 'STATIONERY'],
  ];
  const products = [];
  for (let i = 0; i < PRODUCTS.length; i += 1) {
    const [name, sub, brand, price, cost, type] = PRODUCTS[i];
    const p = await api.post('/products', {
      sku: `${type === 'ELECTRONICS' ? 'EL' : 'ST'}-${pad(i + 1)}`,
      barcode: `62${String(1000000000 + i * 7919).slice(-10)}`,
      name,
      categoryId: cats[type],
      subCategoryId: subs[sub],
      brandId: brands[brand],
      unitOfMeasure: 'piece',
      sellingPriceMinor: money(price),
      minSellingPriceMinor: money(Math.round(cost * 1.05)),
      reorderPoint: price > 10000 ? 3 : 15,
      reorderQty: price > 10000 ? 6 : 60,
    });
    products.push({ ...p, costMinor: money(cost), priceMinor: money(price) });
  }
  log(`${products.length} products`);

  const suppliers = [];
  for (const [name, contact, city, terms] of [['Addis Digital Imports', 'Hana Tesfaye', 'Addis Ababa', 30], ['Mobile Hub Wholesale', 'Yonas Bekele', 'Addis Ababa', 14], ['Nile Office Supplies', 'Selam Girma', 'Bahir Dar', 30], ['Horizon Electronics', 'Dawit Alemu', 'Dire Dawa', 45], ['Paper & Pen Traders', 'Meron Haile', 'Hawassa', 14], ['Prime Appliance Distributors', 'Biruk Mulu', 'Adama', 30]]) {
    suppliers.push(await api.post('/suppliers', { name, contactPerson: contact, city, country: 'Exampleland', phone: `+2519${int(10000000, 99999999)}`, email: `sales@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`, paymentTermsDays: terms }));
  }
  const customers = [];
  const CUST = [['Walk-in customer', 'RETAIL'], ['Bright Future School', 'INSTITUTIONAL'], ['Sunrise Clinic', 'INSTITUTIONAL'], ['Tech Corner Shop', 'WHOLESALE'], ['Meskel Trading', 'WHOLESALE'], ['Lulit Bekele', 'RETAIL'], ['Samuel Girma', 'RETAIL'], ['Tigist Alemu', 'RETAIL'], ['Hope Foundation', 'INSTITUTIONAL'], ['City Print House', 'WHOLESALE'], ['Rahel Tadesse', 'RETAIL'], ['Mulu Office Solutions', 'WHOLESALE']];
  for (const [name, type] of CUST) customers.push(await api.post('/customers', { name, type, city: 'Addis Ababa', phone: `+2519${int(10000000, 99999999)}` }));
  for (const c of customers) {
    if (c.type === 'INSTITUTIONAL' || c.type === 'WHOLESALE') customers[customers.indexOf(c)] = await api.patch(`/customers/${c.id}`, { version: c.version ?? 1, creditLimitMinor: money(c.type === 'INSTITUTIONAL' ? 400000 : 250000) });
  }
  log(`${suppliers.length} suppliers, ${customers.length} customers`);

  // Opening position, then stock bought on credit and received.
  await api.post('/opening-balances', { cashMinor: money(250000), bankMinor: money(1800000), inventory: products.slice(0, 12).map((p) => ({ productId: p.id, quantity: int(6, 14), unitCostMinor: p.costMinor })) });
  const purchases = [];
  for (let i = 0; i < 12; i += 1) {
    const chosen = [...products].sort(() => rnd() - 0.5).slice(0, int(3, 7));
    const po = await api.post('/purchases', {
      supplierId: suppliers[i % suppliers.length].id,
      notes: 'Monthly restock',
      items: chosen.map((p) => ({ productId: p.id, orderedQty: p.priceMinor > 1000000 ? int(3, 8) : int(25, 120), unitCostMinor: p.costMinor })),
    });
    const full = await api.get(`/purchases/${po.id}`);
    if (i < 10) {
      await api.post(`/purchases/${po.id}/receive`, { items: full.items.map((it) => ({ itemId: it.id, quantity: it.orderedQty })) });
      if (i < 7) await api.post(`/purchases/${po.id}/payments`, { amountMinor: full.totalMinor ?? full.items.reduce((s, it) => s + it.orderedQty * it.unitCostMinor, 0), method: pick(['BANK_TRANSFER', 'CASH']) });
    }
    purchases.push(po.id);
  }
  log(`${purchases.length} purchase orders`);

  // A month of sales.
  const saleIds = [];
  for (let i = 0; i < 140; i += 1) {
    const lines = [...products].sort(() => rnd() - 0.5).slice(0, int(1, 4));
    const customer = rnd() < 0.55 ? customers[0] : pick(customers);
    const paymentMethod = (customer.type === 'INSTITUTIONAL' || customer.type === 'WHOLESALE') && rnd() < 0.5 ? 'CREDIT' : pick(['CASH', 'CASH', 'MOBILE_MONEY', 'BANK_TRANSFER']);
    try {
      const sale = await api.post('/sales', { customerId: customer.id, paymentMethod, items: lines.map((p) => ({ productId: p.id, quantity: p.priceMinor > 1000000 ? 1 : int(1, 5) })) });
      saleIds.push(sale.id);
    } catch (e) {
      if (!/stock|insufficient|credit-limit/i.test(String(e))) throw e;
    }
  }
  log(`${saleIds.length} sales`);
  for (const [d, desc, code, amount] of [[2, 'Shop rent', '6000', 45000], [3, 'Electricity and water', '6010', 6800], [5, 'Staff salaries', '6020', 62000], [9, 'Delivery and transport', '6030', 3400], [12, 'Internet', '6040', 2200], [18, 'Packaging', '6050', 1900], [24, 'Repairs', '6900', 2500]]) {
    await api.post('/expenses', { accountCode: code, description: desc, amountMinor: money(amount), paymentMethod: 'BANK_TRANSFER', vendor: 'Various' });
    void d;
  }

  await spreadRetailDates();
  log('dates spread over the month');
}

// ======================================================================================= Library
async function library() {
  const api = await client('library', OWNER, secrets['apps.library.owner']);
  const have = await api.get('/books?limit=1');
  if ((have.total ?? have.items?.length ?? 0) > 0) return log('already seeded');
  const genres = {};
  for (const g of (await api.get('/genres')).items ?? (await api.get('/genres')) ?? []) genres[g.name] = g.id;
  for (const g of ['Fiction', 'Science', 'History', 'Biography', 'Children', 'Technology', 'Business', 'Poetry', 'Travel', 'Health', 'Art', 'Reference']) if (!genres[g]) genres[g] = (await api.post('/genres', { name: g })).id;
  const BOOKS = [
    ['The Silent Harbour', ['Mira Calloway'], 'Fiction', 2014], ['Letters from the Highlands', ['Tadesse Wolde'], 'Fiction', 2019], ['A Map of Small Rivers', ['Ingrid Solberg'], 'Fiction', 2008], ['The Clockmaker of Lalibela', ['Hana Desta'], 'Fiction', 2021],
    ['Night Train to Nairobi', ['Peter Okoye'], 'Fiction', 2016], ['Salt and Honey', ['Amara Nwosu'], 'Fiction', 2011], ['The Last Coffee Merchant', ['Dawit Haile'], 'Fiction', 2018], ['Winter in the Valley', ['Clara Weston'], 'Fiction', 2005],
    ['How Rockets Fly', ['Dr. Lena Fischer'], 'Science', 2017], ['The Living Soil', ['Prof. Abebe Kebede'], 'Science', 2015], ['Atoms and Everyday Life', ['Samuel Reyes'], 'Science', 2012], ['Weather: A Field Guide', ['Nora Lindqvist'], 'Science', 2020],
    ['Oceans Alive', ['Tomas Brandt'], 'Science', 2013], ['The Human Brain, Explained', ['Dr. Selam Girma'], 'Science', 2022], ['Empires of the Horn', ['Yared Mengistu'], 'History', 2010], ['The Silk Roads Revisited', ['Chen Wei'], 'History', 2016],
    ['Revolutions That Changed Printing', ['Hugo Marchetti'], 'History', 2009], ['A Short History of Trade', ['Aster Tilahun'], 'History', 2018], ['Ancient Cities of the Nile', ['Layla Hassan'], 'History', 2014], ['Voices of the Twentieth Century', ['Martin Alvarez'], 'History', 2007],
    ['A Life in Letters', ['Rahel Alemayehu'], 'Biography', 2019], ['The Engineer\'s Daughter', ['Beth Montgomery'], 'Biography', 2013], ['Running Toward Dawn', ['Haile Bekele'], 'Biography', 2015], ['The Teacher from Gondar', ['Mulu Tesfaye'], 'Biography', 2020],
    ['The Little Fox and the Moon', ['Eden Girma'], 'Children', 2021], ['Counting with Elephants', ['Sara Nyambura'], 'Children', 2018], ['The Brave Seed', ['Liam O\'Connor'], 'Children', 2016], ['Tobias and the Talking Bicycle', ['Mia Andersson'], 'Children', 2019],
    ['Zara\'s Big Day at School', ['Fitsum Alemu'], 'Children', 2022], ['Learn to Code with Robots', ['Jonah Park'], 'Technology', 2021], ['Databases for Everyone', ['Dr. Ruth Adler'], 'Technology', 2018], ['The Cloud Handbook', ['Kofi Mensah'], 'Technology', 2020],
    ['Designing for People', ['Elena Rossi'], 'Technology', 2017], ['Networks in Plain Language', ['Biruk Mulu'], 'Technology', 2015], ['Software that Lasts', ['Anna Kowalski'], 'Technology', 2023], ['Small Business, Big Plans', ['Meron Haile'], 'Business', 2019],
    ['Honest Bookkeeping', ['Yonas Bekele'], 'Business', 2014], ['Leading a Team Well', ['Grace Adeyemi'], 'Business', 2017], ['The Market Square', ['Henry Walsh'], 'Business', 2011], ['Sugar, Tea and Spice', ['Marta Gebre'], 'Poetry', 2016],
    ['River Songs', ['Abel Tesfaye'], 'Poetry', 2012], ['Morning Verses', ['Sofia Ricci'], 'Poetry', 2020], ['Walking the Rift Valley', ['Jonas Eriksen'], 'Travel', 2018], ['A Week in Lisbon', ['Camila Duarte'], 'Travel', 2022],
    ['Backroads of the Highlands', ['Tigist Alemu'], 'Travel', 2015], ['Eat Well, Live Well', ['Dr. Hanna Berhane'], 'Health', 2019], ['Sleep: The Missing Hours', ['Dr. Omar Siddiqui'], 'Health', 2021], ['First Aid at Home', ['Red Cross Editors'], 'Health', 2017],
    ['Colour and Light', ['Isabel Moreau'], 'Art', 2013], ['Drawing from Life', ['Kebede Alemu'], 'Art', 2016], ['A Concise Dictionary', ['The Editors'], 'Reference', 2020], ['World Atlas for Students', ['The Editors'], 'Reference', 2021],
    ['Handbook of Grammar', ['Prof. Ruth Weiss'], 'Reference', 2014], ['Encyclopaedia of Plants', ['Botanical Society'], 'Reference', 2010],
  ];
  const books = [];
  for (let i = 0; i < BOOKS.length; i += 1) {
    const [title, authors, genre, year] = BOOKS[i];
    books.push(await api.post('/books', { isbn: isbn13(i), title, authors, publishedYear: year, genreId: genres[genre], description: `${title}: a ${genre.toLowerCase()} title in the library collection.`, copies: int(2, 6) }));
  }
  log(`${books.length} books`);
  const members = [];
  const FIRST = ['Abebe', 'Tigist', 'Daniel', 'Selamawit', 'Yohannes', 'Hiwot', 'Bereket', 'Marta', 'Solomon', 'Eyob', 'Rahel', 'Tewodros', 'Bezawit', 'Henok', 'Almaz', 'Mikias', 'Sara', 'Kaleb', 'Eden', 'Natnael', 'Liya', 'Dagim', 'Meseret', 'Surafel', 'Hanna', 'Yonatan', 'Rediet', 'Amanuel', 'Saron', 'Biniam'];
  const LAST = ['Kebede', 'Alemu', 'Haile', 'Tesfaye', 'Girma', 'Mengesha', 'Tadesse', 'Worku', 'Bekele', 'Getachew', 'Assefa', 'Asfaw', 'Demissie', 'Fekadu', 'Shiferaw', 'Negash'];
  for (let i = 0; i < 40; i += 1) members.push(await api.post('/members', { name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, email: `member${pad(i + 1)}@library.example.com`, phone: `+2519${int(10000000, 99999999)}` }));
  log(`${members.length} members`);

  const loans = [];
  for (let i = 0; i < 90; i += 1) {
    try {
      loans.push(await api.post('/loans', { memberId: members[i % members.length].id, bookId: books[(i * 5) % books.length].id }));
    } catch (e) {
      if (!/no copy|available|limit/i.test(String(e))) log(`loan skipped: ${String(e).slice(0, 90)}`);
    }
  }
  const holdsFor = books.slice(0, 6);
  for (let i = 0; i < holdsFor.length; i += 1) {
    try {
      await api.post('/holds', { memberId: members[(i + 20) % members.length].id, bookId: holdsFor[i].id });
    } catch {
      /* the book may be on the shelf: no hold needed */
    }
  }
  // Back-date borrowing so some loans are overdue, some old and returned (with fines).
  const db = await superDb('library');
  try {
    const cols = (await db.query("select column_name from information_schema.columns where table_name = 'loans'")).rows.map((r) => r.column_name);
    const borrowed = cols.includes('borrowed_at') ? 'borrowed_at' : 'created_at';
    const due = cols.includes('due_at') ? 'due_at' : cols.includes('due_date') ? 'due_date' : null;
    for (let i = 0; i < loans.length; i += 1) {
      const daysAgo = i % 3 === 0 ? int(16, 40) : int(0, 13);
      await db.query(`update loans set ${borrowed} = ${borrowed} - ($2 || ' days')::interval ${due ? `, ${due} = ${due} - ($2 || ' days')::interval` : ''} where id = $1`, [loans[i].id, daysAgo]);
    }
    for (let i = 0; i < loans.length; i += 4) {
      try {
        await api.post(`/loans/${loans[i].id}/return`, {});
      } catch {
        /* already returned or not returnable */
      }
    }
  } finally {
    await db.end();
  }
  log('loans spread: some returned, some overdue');
}

// ======================================================================================= Martronics
async function martronics() {
  const api = await client('martronics', OWNER, secrets['apps.martronics.owner']);
  const have = await api.get('/products?limit=1');
  const catalogueDone = (have.total ?? have.items?.length ?? 0) > 0;
  const CATALOGUE = {
    'Phones and tablets': { Smartphones: [['Aurora X5 smartphone 128GB', 19900], ['Aurora X3 smartphone 64GB', 12400], ['Nimbus tablet 10in', 14800], ['Nimbus Mini tablet 8in', 9900], ['Kids learning tablet', 5600]], Accessories: [['Fast charger 33W', 790], ['Braided USB-C cable', 360], ['Clear phone case', 450], ['Screen protector 2-pack', 320], ['Wireless charging pad', 1450]] },
    'Computers': { Laptops: [['Orbit 15 laptop i5 8GB 512GB', 41900], ['Orbit 14 laptop i3 4GB 256GB', 27800], ['Orbit Air ultrabook', 56900]], Peripherals: [['Ergonomic wireless mouse', 980], ['Mechanical keyboard', 2900], ['27in monitor', 16400], ['1080p webcam', 1850], ['USB hub 7-port', 1200]] },
    'Audio and video': { Headphones: [['Studio over-ear headphones', 4800], ['Wireless earbuds Pro', 3200], ['Sports earphones', 1450]], Speakers: [['Portable speaker 20W', 2900], ['Soundbar 2.1', 8200], ['Smart speaker', 3900]] },
    'Home and office': { Lighting: [['LED desk lamp', 850], ['Smart bulb, pack of 3', 1250], ['Rechargeable lantern', 980]], 'Small appliances': [['Electric kettle 1.7L', 2200], ['Air fryer 4L', 7400], ['Blender 600W', 3100], ['Steam iron', 2400]] },
    'Gaming': { Consoles: [['Home console 1TB', 33900], ['Handheld console', 21900]], 'Games and gear': [['Wireless game controller', 3400], ['Gaming headset', 3700], ['Racing wheel', 9800]] },
  };
  let products = [];
  let n = 0;
  if (catalogueDone) products = (await api.get('/products?limit=100')).items ?? [];
  for (const [cat, subs] of catalogueDone ? [] : Object.entries(CATALOGUE)) {
    const c = await api.post('/categories', { name: cat });
    for (const [sub, items] of Object.entries(subs)) {
      const s = await api.post('/sub-categories', { categoryId: c.id, name: sub });
      for (const [name, price] of items) {
        n += 1;
        products.push(await api.post('/products', { name, description: `${name}. Free delivery in the city, one-year warranty, genuine and tested before dispatch.`, priceMinor: price * 100, stock: int(15, 120), categoryId: c.id, subCategoryId: s.id }));
      }
    }
  }
  log(`${products.length} products in ${Object.keys(CATALOGUE).length} categories`);

  const shoppers = [];
  const NAMES = [['Dina', 'Buyer'], ['Eli', 'Buyer'], ['Bruk', 'Tesfaye'], ['Aida', 'Mengesha'], ['Naod', 'Alemayehu'], ['Mahlet', 'Girma'], ['Ruth', 'Bekele'], ['Kirubel', 'Haile'], ['Liya', 'Worku'], ['Yared', 'Asfaw'], ['Selam', 'Tadesse'], ['Fasil', 'Negash']];
  const db = await superDb('martronics');
  const { hashPassword } = await import(pathToFileURL(path.join(appsRoot, 'martronics', 'apps', 'api', 'dist', 'auth', 'auth.service.js')).href);
  const hash = await hashPassword(DEMO_PASSWORD);
  try {
    for (let i = 0; i < NAMES.length; i += 1) {
      const email = i < 2 ? `customer.${NAMES[i][0].toLowerCase()}@examplecorp.com` : `${NAMES[i][0].toLowerCase()}.${NAMES[i][1].toLowerCase()}@shopper.example.com`;
      const have2 = await db.query('select id from users where email = $1', [email]);
      if (!have2.rowCount) {
        for (let attempt = 0; ; attempt += 1) {
          const r = await fetch(`http://127.0.0.1:${PORTS.martronics}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: `${randomBytes(9).toString('base64url')}Aa1!`, firstName: NAMES[i][0], lastName: NAMES[i][1] }) });
          if (r.status === 429 && attempt < 5) {
            await sleep(((await r.json()).retryAfterSeconds ?? 30) * 1000 + 1000);
            continue;
          }
          if (!r.ok) throw new Error(`register ${email}: ${r.status} ${await r.text()}`);
          break;
        }
        await sleep(7000);
      }
      await db.query('update users set password_hash = $1 where email = $2', [hash, email]);
      shoppers.push(email);
    }
  } finally {
    await db.end();
  }
  let orders = 0;
  const ordersDb = await superDb('martronics');
  const ordersExist = Number((await ordersDb.query('select count(*)::int as n from orders')).rows[0].n);
  await ordersDb.end();
  for (let i = 0; i < (ordersExist > 0 ? 0 : 28); i += 1) {
    const shopper = await client('martronics', shoppers[i % shoppers.length], DEMO_PASSWORD);
    const lines = [...products].sort(() => rnd() - 0.5).slice(0, int(1, 4));
    for (const p of lines) await shopper.put(`/cart/items/${p.id}`, { quantity: p.priceMinor > 2000000 ? 1 : int(1, 3) });
    const order = await shopper.post('/orders', {});
    orders += 1;
    if (i % 5 !== 4) await shopper.post(`/orders/${order.id}/payments`, { method: pick(['card', 'mobile_money', 'bank_transfer']) });
    if (i % 5 === 0) await api.post(`/orders/${order.id}/fulfill`, {}).catch(() => undefined);
    if (i % 9 === 8) await shopper.post(`/orders/${order.id}/cancel`, {}).catch(() => undefined);
    await sleep(6500); // sign-in is limited to ten a minute per address
  }
  log(`${shoppers.length} shoppers, ${orders} orders`);
  const dbb = await superDb('martronics');
  try {
    const have3 = (await dbb.query("select column_name from information_schema.columns where table_name = 'orders' and column_name = 'created_at'")).rowCount;
    if (have3) await dbb.query("update orders set created_at = created_at - ((random() * 28)::int || ' days')::interval");
  } finally {
    await dbb.end();
  }
}

// ======================================================================================= JobPilot
async function jobpilot() {
  const api = await client('jobpilot', 'jobseeker.ana@examplecorp.com', DEMO_PASSWORD);
  const me = await api.get('/candidates/me');
  const existing = await api.get('/jobs?limit=1');
  const jobsDone = (existing.total ?? existing.items?.length ?? 0) > 0;
  if (!jobsDone) await profileAndJobs(api, me);
  await progressApplications(api);
}

async function profileAndJobs(api, me) {
  await api.patch(`/candidates/${me.id}`, {
    version: me.version,
    fullName: 'Ana Candidate',
    headline: 'Full-stack engineer, TypeScript and PostgreSQL',
    summary: 'Six years building web products end to end: React front ends, Node services, and PostgreSQL schemas that stay correct under load. Likes small teams, clear contracts and boring operations.',
    targetRoles: ['Senior Full-stack Engineer', 'Backend Engineer', 'Platform Engineer'],
    targetLocations: ['Remote', 'Addis Ababa', 'Nairobi'],
    salaryMin: 60000,
    salaryMax: 95000,
    workAuthStatus: 'CITIZEN',
    remotePref: 'REMOTE_ONLY',
    relocationOk: false,
  });
  for (const [skillName, category, proficiency, yearsExperience] of [['TypeScript', 'FRONTEND', 'EXPERT', 6], ['React', 'FRONTEND', 'ADVANCED', 5], ['Next.js', 'FRONTEND', 'ADVANCED', 3], ['Node.js', 'BACKEND', 'EXPERT', 6], ['NestJS', 'BACKEND', 'ADVANCED', 3], ['PostgreSQL', 'DATABASE', 'EXPERT', 6], ['Redis', 'DATABASE', 'INTERMEDIATE', 3], ['Docker', 'DEVOPS', 'ADVANCED', 5], ['Kubernetes', 'DEVOPS', 'INTERMEDIATE', 2], ['AWS', 'DEVOPS', 'INTERMEDIATE', 3], ['Communication', 'SOFT', 'ADVANCED', 6], ['Mentoring', 'SOFT', 'ADVANCED', 3]]) {
    await api.post(`/candidates/${me.id}/skills`, { skillName, category, proficiency, yearsExperience });
  }
  await api.post(`/candidates/${me.id}/experience`, { companyName: 'Northwind Logistics', title: 'Senior Software Engineer', startDate: '2022-03-01', description: 'Led a team of five rebuilding the dispatch platform on Node and PostgreSQL; cut delivery-planning time by 40%.', technologies: ['TypeScript', 'NestJS', 'PostgreSQL', 'Redis'] });
  await api.post(`/candidates/${me.id}/experience`, { companyName: 'Bluebird Retail', title: 'Software Engineer', startDate: '2019-06-01', endDate: '2022-02-28', description: 'Built the storefront and order pipeline; introduced end-to-end tests and zero-downtime deploys.', technologies: ['React', 'Node.js', 'PostgreSQL'] });
  await api.post(`/candidates/${me.id}/experience`, { companyName: 'Studio Hex', title: 'Junior Developer', startDate: '2018-01-01', endDate: '2019-05-31', description: 'Client websites and internal tools.', technologies: ['JavaScript', 'PHP', 'MySQL'] });
  await api.post(`/candidates/${me.id}/education`, { institution: 'Example Technical University', degree: 'BSc', field: 'Computer Science', startDate: '2013-09-01', endDate: '2017-07-01' });
  await api.post(`/candidates/${me.id}/projects`, { name: 'Open-source invoicing library', description: 'A small library for money arithmetic and invoice numbering, 1.2k stars.', technologies: ['TypeScript'], url: 'https://example.com/projects/invoicing' });
  await api.post(`/candidates/${me.id}/projects`, { name: 'Neighbourhood bike share app', description: 'Maps, bookings and payments for a volunteer bike scheme.', technologies: ['Next.js', 'PostgreSQL'], url: 'https://example.com/projects/bikes' });

  const COMPANIES = ['Aurora Systems', 'Brightwave', 'Cobalt Labs', 'Delta Freight', 'Evergreen Health', 'Fathom Data', 'Granite Pay', 'Harbor Cloud', 'Indigo Mobility', 'Juniper Learning', 'Keystone Energy', 'Lumen Retail', 'Meridian Bank', 'Nimbus Telecom', 'Orbit Media'];
  const TITLES = [['Senior Full-stack Engineer', 'SENIOR', ['TypeScript', 'React', 'Node.js', 'PostgreSQL']], ['Backend Engineer', 'MID', ['Node.js', 'PostgreSQL', 'Docker']], ['Platform Engineer', 'SENIOR', ['Kubernetes', 'AWS', 'Docker', 'TypeScript']], ['Staff Engineer, Payments', 'STAFF', ['PostgreSQL', 'TypeScript', 'NestJS']], ['Frontend Engineer', 'MID', ['React', 'Next.js', 'TypeScript']], ['Data Engineer', 'MID', ['PostgreSQL', 'Python', 'Airflow']], ['Engineering Manager', 'PRINCIPAL', ['Communication', 'Mentoring']], ['Junior Developer', 'ENTRY', ['JavaScript', 'React']]];
  const jobs = [];
  for (let i = 0; i < 36; i += 1) {
    const [title, seniority, skills] = TITLES[i % TITLES.length];
    const company = COMPANIES[(i * 4) % COMPANIES.length];
    jobs.push(await api.post('/jobs', { companyName: company, title, description: `${company} is hiring a ${title}. You will own services and interfaces end to end, work with a small remote-friendly team, and ship weekly.`, location: pick(['Remote', 'Addis Ababa', 'Nairobi', 'Kigali', 'Accra']), remoteType: pick(['REMOTE', 'REMOTE', 'HYBRID', 'ONSITE']), salaryMin: int(40, 70) * 1000, salaryMax: int(75, 130) * 1000, seniority, employmentType: 'FULL_TIME', requiredSkills: skills, preferredSkills: ['Docker', 'AWS'].filter(() => rnd() < 0.6), visaSponsorship: rnd() < 0.2, applicationUrl: `https://careers.example.com/${company.toLowerCase().replace(/[^a-z]+/g, '-')}/${i + 1}` }));
  }
  await api.post('/matches/rescore', {}).catch((e) => log(`rescore: ${String(e).slice(0, 80)}`));
  log(`${jobs.length} jobs scored against the profile`);
}

async function progressApplications(api) {
  const flow = [['SHORTLISTED'], ['SHORTLISTED', 'RESUME_GENERATED', 'COVER_LETTER_GENERATED', 'READY_TO_APPLY'], ['SHORTLISTED', 'RESUME_GENERATED', 'COVER_LETTER_GENERATED', 'READY_TO_APPLY', 'APPROVED', 'APPLIED'], ['SHORTLISTED', 'RESUME_GENERATED', 'COVER_LETTER_GENERATED', 'READY_TO_APPLY', 'APPROVED', 'APPLIED', 'SCREENING', 'INTERVIEW'], ['SHORTLISTED', 'RESUME_GENERATED', 'COVER_LETTER_GENERATED', 'READY_TO_APPLY', 'APPROVED', 'APPLIED', 'SCREENING', 'INTERVIEW', 'FINAL_INTERVIEW', 'OFFER'], ['SHORTLISTED', 'RESUME_GENERATED', 'COVER_LETTER_GENERATED', 'READY_TO_APPLY', 'APPROVED', 'APPLIED', 'REJECTED']];
  let apps = 0;
  const list = await api.get('/applications?limit=100');
  const rows = list.items ?? list;
  const targets = rows.slice(0, 18);
  for (let i = 0; i < targets.length; i += 1) {
    const application = targets[i];
    for (const to of flow[i % flow.length]) {
      try {
        if (to === 'APPROVED') await api.post(`/applications/${application.id}/approve`, {}).catch(() => api.post(`/applications/${application.id}/transition`, { to }));
        else await api.post(`/applications/${application.id}/transition`, { to, note: to === 'REJECTED' ? 'Position filled internally' : undefined });
      } catch {
        break; // a step the state machine does not allow from here: leave the application where it is
      }
    }
    apps += 1;
  }
  log(`${apps} applications moving through the pipeline`);
  try {
    const source = await api.post('/sources', { type: 'RSS', name: 'We Work Remotely: programming', config: { feedUrl: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', companyName: 'We Work Remotely' }, pollIntervalMinutes: 60 });
    await api.post(`/sources/${source.id}/run`, {});
    log('a live job feed added and run once');
  } catch (e) {
    log(`job feed skipped: ${String(e).slice(0, 100)}`);
  }
}

const SEEDS = { 'retail-os': retail, library, martronics, jobpilot };
for (const [key, fn] of Object.entries(SEEDS)) {
  if (only && !only.includes(key)) continue;
  console.log(`\n== ${key}`);
  try {
    await fn();
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    process.exitCode = 1;
  }
}
