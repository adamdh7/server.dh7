const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSGS_FILE = path.join(DATA_DIR, 'messages.json');

const ALLOWED_ORIGINS = new Set(['https://dh7.adamdh7.org', 'https://www.adamdh7.org']);
const ALLOWED_HOSTS = new Set(['dh7.adamdh7.org', 'www.adamdh7.org']);
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

app.use(bodyParser.json());

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, false);
    try {
      const normalized = (new URL(origin)).origin;
      if (ALLOWED_ORIGINS.has(normalized)) return callback(null, true);
      return callback(new Error('Origin non autorisé'), false);
    } catch (e) {
      return callback(new Error('Origin invalide'), false);
    }
  },
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

async function initStorage() {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(USERS_FILE))) await fs.writeJson(USERS_FILE, []);
  if (!(await fs.pathExists(MSGS_FILE))) await fs.writeJson(MSGS_FILE, []);
}

function sanitizeUser(u) {
  const { password, ...rest } = u || {};
  return rest;
}

async function getDirectorySize(dir) {
  let total = 0;
  const items = await fs.readdir(dir);
  for (const item of items) {
    const full = path.join(dir, item);
    const stat = await fs.stat(full);
    if (stat.isFile()) total += stat.size;
    else if (stat.isDirectory()) total += await getDirectorySize(full);
  }
  return total;
}

async function purgeNonUserData() {
  await fs.writeJson(MSGS_FILE, []);
  const files = await fs.readdir(DATA_DIR);
  for (const f of files) {
    const full = path.join(DATA_DIR, f);
    if (full === USERS_FILE) continue;
    if (full === MSGS_FILE) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) await fs.remove(full);
      else if (stat.isDirectory()) await fs.remove(full);
    } catch (e) {
    }
  }
}

async function checkStorageLimit() {
  try {
    const size = await getDirectorySize(DATA_DIR);
    const limit = 400 * 1024 * 1024;
    if (size > limit) {
      await purgeNonUserData();
    }
  } catch (e) {
  }
}

async function cleanupOldMessages() {
  try {
    const msgs = await fs.readJson(MSGS_FILE);
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const kept = msgs.filter(m => {
      const t = Date.parse(m.time || '');
      if (isNaN(t)) return false;
      return now - t < sevenDays;
    });
    await fs.writeJson(MSGS_FILE, kept);
  } catch (e) {
  }
}

async function ensureStorageHealth() {
  await initStorage();
  await cleanupOldMessages();
  await checkStorageLimit();
}

function isBrowserUserAgent(ua) {
  if (!ua) return false;
  return /Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua);
}

async function verifyCaller(req, res, next) {
  const originHeader = req.headers.origin || req.headers.referer || null;
  if (originHeader) {
    try {
      const normalized = (new URL(originHeader)).origin;
      if (!ALLOWED_ORIGINS.has(normalized)) {
        return res.status(403).json({ success: false, error: 'Origin non autorisé' });
      }
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Origin invalide' });
    }
    return next();
  }
  const token = req.headers['x-worker-token'] || '';
  const callerHost = (req.headers['x-caller-host'] || '').toLowerCase();
  const ua = req.headers['user-agent'] || '';
  if (isBrowserUserAgent(ua) && !token) {
    return res.status(403).json({ success: false, error: 'Accès navigateur non autorisé' });
  }
  if (token && token === WORKER_TOKEN && ALLOWED_HOSTS.has(callerHost)) {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Appel non autorisé' });
}

app.use(verifyCaller);

app.post('/register', async (req, res) => {
  const { nom, prenom, dh7, age, password } = req.body;
  if (!nom || !prenom || !dh7 || !password) {
    return res.json({ success: false, error: 'Données manquantes' });
  }
  const users = await fs.readJson(USERS_FILE);
  if (users.find(u => u.dh7 === dh7)) {
    return res.json({ success: false, error: 'ID DH7 déjà utilisé' });
  }
  const existingTfids = new Set(users.map(u => u.tfid));
  let digits = 7;
  let attempts = 0;
  function generateTFIDLocal() {
    while (true) {
      const maxVal = Math.pow(10, digits);
      if (existingTfids.size >= maxVal * 0.9) {
        digits++;
        continue;
      }
      const num = Math.floor(Math.random() * maxVal).toString().padStart(digits, '0');
      const tfid = `TF-${num}`;
      if (!existingTfids.has(tfid)) return tfid;
      attempts++;
      if (attempts > 1000) digits++;
    }
  }
  const tfid = generateTFIDLocal();
  const newUser = { tfid, nom, prenom, dh7, age, password };
  users.push(newUser);
  await fs.writeJson(USERS_FILE, users);
  await checkStorageLimit();
  res.json({ success: true, tfid });
});

app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  const users = await fs.readJson(USERS_FILE);
  const user = users.find(u => (u.tfid === identifier || u.dh7 === identifier) && u.password === password);
  if (user) {
    return res.json({ success: true, user: sanitizeUser(user) });
  }
  return res.json({ success: false, error: 'Identifiant ou mot de passe incorrect' });
});

app.get('/users', async (req, res) => {
  const users = await fs.readJson(USERS_FILE);
  const safeUsers = users.map(sanitizeUser);
  res.json(safeUsers);
});

app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ results: [] });
  const users = await fs.readJson(USERS_FILE);
  const q = query.toLowerCase();
  const results = users.filter(u =>
    (u.nom || '').toLowerCase().includes(q) ||
    (u.prenom || '').toLowerCase().includes(q) ||
    (u.dh7 || '').toLowerCase().includes(q) ||
    (u.tfid || '').toLowerCase().includes(q)
  );
  res.json({ results: results.map(sanitizeUser) });
});

app.post('/messages', async (req, res) => {
  const { user1_tfid, user2_tfid } = req.body;
  if (!user1_tfid || !user2_tfid) return res.json([]);
  const msgs = await fs.readJson(MSGS_FILE);
  const filtered = msgs.filter(m =>
    (m.from === user1_tfid && m.to === user2_tfid) ||
    (m.from === user2_tfid && m.to === user1_tfid)
  );
  res.json(filtered);
});

app.post('/send', async (req, res) => {
  const { sender_tfid, receiver_tfid, message } = req.body;
  if (!sender_tfid || !receiver_tfid || !message) {
    return res.json({ success: false, error: 'Données manquantes' });
  }
  const msgs = await fs.readJson(MSGS_FILE);
  const newMsg = {
    from: sender_tfid,
    to: receiver_tfid,
    text: message,
    time: new Date().toISOString(),
    read: false
  };
  msgs.push(newMsg);
  await fs.writeJson(MSGS_FILE, msgs);
  await cleanupOldMessages();
  await checkStorageLimit();
  res.json({ success: true });
});

app.post('/mark-read', async (req, res) => {
  const { sender_tfid, receiver_tfid } = req.body;
  const msgs = await fs.readJson(MSGS_FILE);
  msgs.forEach(m => {
    if (m.from === sender_tfid && m.to === receiver_tfid) m.read = true;
  });
  await fs.writeJson(MSGS_FILE, msgs);
  res.json({ success: true });
});

app.get('/get/:page', async (req, res) => {
  const page = parseInt(req.params.page) || 1;
  const limit = 100;
  const users = await fs.readJson(USERS_FILE);
  const start = (page - 1) * limit;
  const end = page * limit;
  const batch = users.slice(start, end).map(sanitizeUser);
  const hasMore = users.length > end;
  res.json({
    batch,
    has_more: hasMore
  });
});

app.post('/sync', async (req, res) => {
  const { users: incomingUsers, messages: incomingMsgs } = req.body;
  if (incomingUsers) {
    const localUsers = await fs.readJson(USERS_FILE);
    incomingUsers.forEach(u => {
      if (!localUsers.find(lu => lu.tfid === u.tfid)) localUsers.push(u);
    });
    await fs.writeJson(USERS_FILE, localUsers);
  }
  if (incomingMsgs) {
    const localMsgs = await fs.readJson(MSGS_FILE);
    incomingMsgs.forEach(m => {
      if (!localMsgs.find(lm => lm.time === m.time && lm.from === m.from)) localMsgs.push(m);
    });
    await fs.writeJson(MSGS_FILE, localMsgs);
    await cleanupOldMessages();
    await checkStorageLimit();
  }
  res.json({ success: true });
});

ensureStorageHealth().then(() => {
  app.listen(PORT, () => {
    console.log(`Serveur DH7 actif sur le port ${PORT}`);
  });
});
