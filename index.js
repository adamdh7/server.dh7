require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = new Set(['https://dh7.dh7.adamdh7.org', 'https://dh7.adamdh7.org', 'https://quiz.adamdh7.org', 'https://dh7test.pages.dev', 'https://www.adamdh7.org']);
const ALLOWED_HOSTS = new Set(['dh7.adamdh7.org', 'quiz.pages.dev', 'dh7test.pages.dev', 'www.adamdh7.org']);
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

app.use(bodyParser.json());

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin || origin === 'null' || origin.startsWith('file://')) return callback(null, true);
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

mongoose.connect(process.env.MONGO_URI);

const userSchema = new mongoose.Schema({
  tfid: { type: String, default: '' },
  nom: String,
  prenom: { type: String, default: '' },
  dh7: String,
  age: String,
  password: { type: String, default: '' },
  logo: { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

const groupSchema = new mongoose.Schema({
  tfid: { type: String, unique: true },
  nom: String,
  logo: { type: String, default: '' },
  owner: String,
  admins: { type: [String], default: [] },
  members: { type: [String], default: [] }
});
const Group = mongoose.model('Group', groupSchema);

const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  text: String,
  time: String,
  read: { type: Boolean, default: false },
  deletedFor: { type: [String], default: [] }
});
const Message = mongoose.model('Message', messageSchema);

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});
const upload = multer({ storage: multer.memoryStorage() });

function sanitizeUser(u) {
  const obj = u.toObject ? u.toObject() : u;
  const { password, ...rest } = obj;
  if (!rest.logo) {
    rest.logo = 'https://adamdh7.org/adamdh7.png';
  }
  if (rest.age && rest.age.length >= 4) {
    const birthYear = parseInt(rest.age.substring(0, 4), 10);
    if (!isNaN(birthYear)) {
      rest.age = (new Date().getFullYear() - birthYear).toString();
    }
  }
  return rest;
}

async function generateUniqueTfid() {
  let digits = 7;
  let attempts = 0;
  while (true) {
    const maxVal = Math.pow(10, digits);
    const num = Math.floor(Math.random() * maxVal).toString().padStart(digits, '0');
    const tempTfid = `TF-${num}`;
    if (tempTfid === 'TF-7777777' || tempTfid === 'TF-4352071') continue;
    const tfidExists = await User.findOne({ tfid: tempTfid });
    if (!tfidExists) return tempTfid;
    attempts++;
    if (attempts > 1000) digits++;
  }
}

async function generateGroupTfid() {
  while (true) {
    let num = '';
    for (let i = 0; i < 17; i++) {
      num += Math.floor(Math.random() * 10).toString();
    }
    const exists = await Group.findOne({ tfid: num });
    if (!exists) return num;
  }
}

async function checkStorageLimit() {
  try {
    const stats = await mongoose.connection.db.command({ dbStats: 1 });
    const limit = 400 * 1024 * 1024;
    if (stats.dataSize > limit) {
      await Message.deleteMany({});
      const users = await User.find({});
      const systemMessages = [];
      for (const u of users) {
        if (u.tfid !== 'TF-7777777' && u.tfid !== 'TF-4352071') {
          systemMessages.push({
            from: 'TF-7777777',
            to: u.tfid,
            text: 'Les donner on été suprimer récemment',
            time: new Date().toISOString(),
            read: false,
            deletedFor: []
          });
        }
      }
      if (systemMessages.length > 0) await Message.insertMany(systemMessages);
    }
  } catch (e) {}
}

async function cleanupOldMessages() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await Message.deleteMany({ time: { $lt: sevenDaysAgo } });
  } catch (e) {}
}

async function ensureStorageHealth() {
  const sysUserExists = await User.findOne({ dh7: 'tfsdh7@dh7.tf' });
  if (!sysUserExists) {
    await User.create({
      tfid: 'TF-7777777',
      nom: "D'H7",
      prenom: '',
      dh7: 'tfsdh7@dh7.tf',
      age: '0',
      password: '',
      logo: 'https://dh7.adamdh7.org/DH7.png'
    });
  } else {
    await User.updateOne(
      { dh7: 'tfsdh7@dh7.tf' },
      { $set: { nom: "D'H7", prenom: '', logo: 'https://dh7.adamdh7.org/DH7.png', tfid: 'TF-7777777' } }
    );
  }
  const aiUserExists = await User.findOne({ dh7: 'ai.adamdh7@dh7.tf' });
  if (!aiUserExists) {
    await User.create({
      tfid: 'TF-4352071',
      nom: "AI.Adam_D'H7",
      prenom: '',
      dh7: 'ai.adamdh7@dh7.tf',
      age: '0',
      password: '',
      logo: 'https://adamdh7.org/adamdh7.png'
    });
  } else {
    await User.updateOne(
      { dh7: 'ai.adamdh7@dh7.tf' },
      { $set: { logo: 'https://adamdh7.org/adamdh7.png', tfid: 'TF-4352071' } }
    );
  }
  const conflictingUsers = await User.find({
    tfid: { $in: ['TF-7777777', 'TF-4352071'] },
    dh7: { $nin: ['tfsdh7@dh7.tf', 'ai.adamdh7@dh7.tf'] }
  });
  for (const cu of conflictingUsers) {
    cu.tfid = await generateUniqueTfid();
    await cu.save();
  }
  await cleanupOldMessages();
  await checkStorageLimit();
}

function isBrowserUserAgent(ua) {
  if (!ua) return false;
  return /Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua);
}

async function verifyCaller(req, res, next) {
  const originHeader = req.headers.origin || req.headers.referer || null;
  const token = req.headers['x-worker-token'] || '';
  const callerHost = (req.headers['x-caller-host'] || '').toLowerCase();
  const ua = req.headers['user-agent'] || '';
  const secFetch = req.headers['sec-fetch-mode'];

  req.isWorker = false;

  if (token && WORKER_TOKEN && token === WORKER_TOKEN && ALLOWED_HOSTS.has(callerHost)) {
    req.isWorker = true;
    return next();
  }

  if (req.path === '/sync') return res.status(403).json({ success: false, error: 'Accès strict travailleur requis' });

  if (originHeader) {
    try {
      const normalized = (new URL(originHeader)).origin;
      if (normalized === 'null' || normalized.startsWith('file://') || ALLOWED_ORIGINS.has(normalized)) {
        if (isBrowserUserAgent(ua) && !secFetch) return res.status(403).json({ success: false, error: 'Requête non-browser détectée' });
        return next();
      }
      return res.status(403).json({ success: false, error: 'Origin non autorisé' });
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Origin invalide' });
    }
  }

  if (isBrowserUserAgent(ua)) return res.status(403).json({ success: false, error: 'Accès navigateur direct non autorisé' });

  return res.status(403).json({ success: false, error: 'Appel non autorisé' });
}

app.use(verifyCaller);

app.post('/register', async (req, res) => {
  const { nom, prenom, dh7, age, password } = req.body;
  if (!nom || !prenom || !dh7 || !password) return res.json({ success: false, error: 'Données manquantes' });
  const existingUser = await User.findOne({ dh7 });
  if (existingUser) return res.json({ success: false, error: 'ID DH7 déjà utilisé' });
  const tfid = await generateUniqueTfid();
  const newUser = new User({ tfid, nom, prenom, dh7, age, password, logo: '' });
  await newUser.save();
  await checkStorageLimit();
  res.json({ success: true, tfid });
});

app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!password || password === '') return res.json({ success: false, error: 'Identifiant ou mot de passe incorrect' });
  const user = await User.findOne({
    $or: [{ tfid: identifier }, { dh7: identifier }],
    password: password
  });
  if (user && user.dh7 !== 'tfsdh7@dh7.tf' && user.dh7 !== 'ai.adamdh7@dh7.tf') {
    return res.json({ success: true, user: sanitizeUser(user) });
  }
  return res.json({ success: false, error: 'Identifiant ou mot de passe incorrect' });
});

app.post('/group', async (req, res) => {
  const { action, nom, poto, owner_tfid, target_tfid, group_tfid, members_list } = req.body;
  
  if (action === 'create') {
    const gid = await generateGroupTfid();
    const newGroup = new Group({
      tfid: gid,
      nom,
      logo: poto || '',
      owner: owner_tfid,
      members: members_list || [owner_tfid],
      admins: [owner_tfid]
    });
    await newGroup.save();
    return res.json({ success: true, tfid: gid });
  }

  const group = await Group.findOne({ tfid: group_tfid });
  if (!group) return res.json({ success: false, error: 'Groupe introuvable' });

  if (action === 'sup') {
    if (!group.admins.includes(owner_tfid)) return res.json({ success: false, error: 'Action interdite' });
    if (target_tfid === group.owner) return res.json({ success: false, error: 'Impossible de supprimer le propriétaire' });
    group.members = group.members.filter(m => m !== target_tfid);
    group.admins = group.admins.filter(a => a !== target_tfid);
  } else if (action === 'left') {
    group.members = group.members.filter(m => m !== target_tfid);
    group.admins = group.admins.filter(a => a !== target_tfid);
    if (group.owner === target_tfid) group.owner = '';
  } else if (action === 'promote') {
    if (!group.admins.includes(owner_tfid)) return res.json({ success: false, error: 'Action interdite' });
    if (!group.admins.includes(target_tfid)) group.admins.push(target_tfid);
  } else if (action === 'delete-group') {
    if (group.owner !== owner_tfid) return res.json({ success: false, error: 'Seul le propriétaire peut supprimer le groupe' });
    await Message.deleteMany({ to: group_tfid });
    await Group.deleteOne({ tfid: group_tfid });
    return res.json({ success: true });
  }

  if (group.members.length < 1) {
    await Message.deleteMany({ to: group_tfid });
    await Group.deleteOne({ tfid: group_tfid });
    return res.json({ success: true, status: 'deleted' });
  }

  await group.save();
  res.json({ success: true });
});

app.post('/send', async (req, res) => {
  const { sender_tfid, receiver_tfid, message } = req.body;
  if (!sender_tfid || !receiver_tfid || !message) return res.json({ success: false, error: 'Données manquantes' });

  if (receiver_tfid.length === 17) {
    const group = await Group.findOne({ tfid: receiver_tfid });
    if (!group || !group.members.includes(sender_tfid)) return res.json({ success: false, error: 'Groupe ou accès invalide' });
  }

  const newMsg = new Message({
    from: sender_tfid,
    to: receiver_tfid,
    text: message,
    time: new Date().toISOString(),
    read: false
  });
  await newMsg.save();
  res.json({ success: true });
});

app.post('/messages', async (req, res) => {
  const { user1_tfid, user2_tfid } = req.body;
  const query = user2_tfid.length === 17 ? { to: user2_tfid } : {
    $or: [
      { from: user1_tfid, to: user2_tfid },
      { from: user2_tfid, to: user1_tfid }
    ],
    deletedFor: { $ne: user1_tfid }
  };
  const msgs = await Message.find(query).sort({ time: 1 });
  res.json(msgs);
});

app.get('/users', async (req, res) => {
  const users = await User.find({});
  res.json(users.map(sanitizeUser));
});

app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ results: [] });
  const q = query.toLowerCase().trim();
  const effectiveQ = q.replace(/^(tf-?|dh7?)/g, '').trim();
  if (effectiveQ.length < 2) return res.json({ results: [] });
  const users = await User.find({
    $or: [
      { nom: { $regex: q, $options: 'i' } },
      { prenom: { $regex: q, $options: 'i' } },
      { dh7: { $regex: q, $options: 'i' } },
      { tfid: { $regex: q, $options: 'i' } }
    ]
  });
  res.json({ results: users.map(sanitizeUser) });
});

app.post('/upload-profile', upload.single('image'), async (req, res) => {
  const tfid = req.body.tfid;
  const file = req.file;
  if (!tfid || !file) return res.json({ success: false, error: 'Fichier ou TFID manquant' });
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: tfid,
      Body: file.buffer,
      ContentType: file.mimetype
    });
    await s3Client.send(command);
    const logoUrl = `https://pub-24986ee77a4440dba7c072922c670547.r2.dev/${tfid}`;
    await User.updateOne({ tfid: tfid }, { $set: { logo: logoUrl } });
    res.json({ success: true, logo: logoUrl });
  } catch (e) {
    res.json({ success: false, error: 'Erreur upload' });
  }
});

app.post('/mark-read', async (req, res) => {
  const { sender_tfid, receiver_tfid } = req.body;
  await Message.updateMany({ from: sender_tfid, to: receiver_tfid }, { $set: { read: true } });
  res.json({ success: true });
});

app.get('/get/:page', async (req, res) => {
  const page = parseInt(req.params.page) || 1;
  const limit = 100;
  const skip = (page - 1) * limit;
  const users = await User.find({}).skip(skip).limit(limit + 1);
  const hasMore = users.length > limit;
  const batch = users.slice(0, limit).map(u => req.isWorker ? u : sanitizeUser(u));
  res.json({ batch, has_more: hasMore });
});

app.post('/sync', async (req, res) => {
  const { users: incomingUsers, messages: incomingMsgs } = req.body;
  if (incomingUsers && Array.isArray(incomingUsers)) {
    for (const u of incomingUsers) {
      const exists = await User.findOne({ tfid: u.tfid });
      if (!exists) await User.create(u);
    }
  }
  if (incomingMsgs && Array.isArray(incomingMsgs)) {
    for (const m of incomingMsgs) {
      const exists = await Message.findOne({ time: m.time, from: m.from });
      if (!exists) await Message.create(m);
    }
  }
  res.json({ success: true });
});

ensureStorageHealth().then(() => {
  app.listen(PORT, () => {});
});
