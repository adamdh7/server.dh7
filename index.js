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

const ALLOWED_ORIGINS = new Set(['https://dh7.dh7.adamdh7.org', 'https://dh7.adamdh7.org', 'https://quiz.adamdh7.org', 'https://dh7test.pages.dev', 'https://www.adamdh7.org', 'null']);
const ALLOWED_HOSTS = new Set(['dh7.adamdh7.org', 'quiz.pages.dev', 'dh7test.pages.dev', 'www.adamdh7.org']);
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

app.use(bodyParser.json());

function normalizeOriginValue(origin) {
  if (!origin) return null;
  if (origin === 'null') return 'null';
  try {
    return new URL(origin).origin;
  } catch (e) {
    return origin.startsWith('file://') ? 'null' : null;
  }
}

function isBrowserUserAgent(ua) {
  if (!ua) return false;
  return /Mozilla|Chrome|Safari|Firefox|Edge|Opera|WebView/i.test(ua);
}

function hasBrowserFetchHeaders(req) {
  return Boolean(req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-dest'] || req.headers['sec-ch-ua'] || req.headers['sec-ch-ua-platform']);
}

function isLikelyBrowserRequest(req) {
  const ua = req.headers['user-agent'] || '';
  return isBrowserUserAgent(ua) && hasBrowserFetchHeaders(req);
}

const corsOptions = {
  origin: function(origin, callback) {
    const normalized = normalizeOriginValue(origin);
    if (normalized && ALLOWED_ORIGINS.has(normalized)) return callback(null, true);
    if (normalized === 'null') return callback(null, true);
    return callback(new Error('Origin non autorisé'), false);
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

const groupSchema = new mongoose.Schema({
  tfid: { type: String, default: '', unique: true, index: true },
  nom: { type: String, default: '' },
  poto: { type: String, default: '' },
  ownerTfid: { type: String, default: '' },
  admins: { type: [String], default: [] },
  members: { type: [String], default: [] },
  createdAt: { type: String, default: () => new Date().toISOString() },
  updatedAt: { type: String, default: () => new Date().toISOString() }
});

const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  text: String,
  time: String,
  read: { type: Boolean, default: false },
  deletedFor: { type: [String], default: [] },
  groupTfid: { type: String, default: '' }
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
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

function sanitizeGroup(g) {
  const obj = g.toObject ? g.toObject() : g;
  return obj;
}

async function generateUniqueNumericTfid(model, digits, prefix) {
  let attempts = 0;
  while (true) {
    const maxVal = Math.pow(10, digits);
    const num = Math.floor(Math.random() * maxVal).toString().padStart(digits, '0');
    const tfid = `${prefix}${num}`;
    if (tfid === 'TF-7777777' || tfid === 'TF-4352071') continue;
    const exists = await model.findOne({ tfid });
    if (!exists) return tfid;
    attempts++;
    if (attempts > 1000) digits++;
  }
}

async function generateUniqueTfid() {
  return generateUniqueNumericTfid(User, 7, 'TF-');
}

async function generateUniqueGroupTfid() {
  return generateUniqueNumericTfid(Group, 17, 'TF-');
}

async function resolveUserTfid(identifier) {
  if (!identifier) return null;
  const user = await User.findOne({
    $or: [{ tfid: identifier }, { dh7: identifier }]
  });
  return user ? user.tfid : null;
}

async function deleteGroupAndMessages(groupTfid) {
  await Message.deleteMany({ groupTfid });
  await Group.deleteMany({ tfid: groupTfid });
}

async function cleanupEmptyGroups() {
  const groups = await Group.find({});
  for (const group of groups) {
    const members = Array.isArray(group.members) ? group.members.filter(Boolean) : [];
    const uniqueMembers = [...new Set(members)];
    if (uniqueMembers.length === 0) {
      await deleteGroupAndMessages(group.tfid);
    } else if (uniqueMembers.length !== members.length) {
      group.members = uniqueMembers;
      group.updatedAt = new Date().toISOString();
      await group.save();
    }
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
            deletedFor: [],
            groupTfid: ''
          });
        }
      }
      if (systemMessages.length > 0) {
        await Message.insertMany(systemMessages);
      }
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
  await cleanupEmptyGroups();
}

async function verifyCaller(req, res, next) {
  const originHeader = req.headers.origin || req.headers.referer || null;
  const token = req.headers['x-worker-token'] || '';
  const callerHost = (req.headers['x-caller-host'] || '').toLowerCase();
  const browserLike = isLikelyBrowserRequest(req);

  req.isWorker = false;

  if (token && WORKER_TOKEN && token === WORKER_TOKEN && ALLOWED_HOSTS.has(callerHost)) {
    req.isWorker = true;
    return next();
  }

  if (req.method === 'OPTIONS') {
    if (browserLike) return next();
    return res.status(403).json({ success: false, error: 'Préflight non autorisé' });
  }

  if (req.path === '/sync') {
    return res.status(403).json({ success: false, error: 'Accès strict travailleur requis' });
  }

  if (!browserLike) {
    return res.status(403).json({ success: false, error: 'Requête navigateur requise' });
  }

  if (originHeader) {
    const normalized = normalizeOriginValue(originHeader);
    if (normalized && ALLOWED_ORIGINS.has(normalized)) {
      return next();
    }
    if (normalized === 'null') {
      return next();
    }
    return res.status(403).json({ success: false, error: 'Origin non autorisé' });
  }

  return next();
}

app.use(verifyCaller);

app.post('/register', async (req, res) => {
  const { nom, prenom, dh7, age, password } = req.body;
  if (!nom || !prenom || !dh7 || !password) {
    return res.json({ success: false, error: 'Données manquantes' });
  }

  const existingUser = await User.findOne({ dh7 });
  if (existingUser) {
    return res.json({ success: false, error: 'ID DH7 déjà utilisé' });
  }

  const tfid = await generateUniqueTfid();

  const newUser = new User({ tfid, nom, prenom, dh7, age, password, logo: '' });
  await newUser.save();
  await checkStorageLimit();
  res.json({ success: true, tfid });
});

app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!password || password === '') {
    return res.json({ success: false, error: 'Identifiant ou mot de passe incorrect' });
  }
  const user = await User.findOne({
    $or: [{ tfid: identifier }, { dh7: identifier }],
    password: password
  });
  if (user && user.dh7 !== 'tfsdh7@dh7.tf' && user.dh7 !== 'ai.adamdh7@dh7.tf') {
    return res.json({ success: true, user: sanitizeUser(user) });
  }
  return res.json({ success: false, error: 'Identifiant ou mot de passe incorrect' });
});

app.get('/users', async (req, res) => {
  const users = await User.find({});
  res.json(users.map(sanitizeUser));
});

app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ results: [] });

  const q = query.toLowerCase().trim();

  const forbiddenExact = ['t', 'tf', 'tf-', 'd', 'dh', 'dh7', 'dh7.', 'dh7.t', 'dh7.tf', '@', '@d', '@dh', '@dh7', '@dh7.', '@dh7.t', '@dh7.tf'];
  if (forbiddenExact.includes(q)) {
    return res.json({ results: [] });
  }

  const effectiveQ = q.replace(/^(tf-?|dh7?)/g, '').trim();

  if (effectiveQ.length < 2) {
    return res.json({ results: [] });
  }

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

app.get('/group', async (req, res) => {
  const { mode, tfid } = req.query;

  if (mode === 'users') {
    const users = await User.find({});
    return res.json({ success: true, users: users.map(sanitizeUser) });
  }

  if (tfid) {
    const groups = await Group.find({
      $or: [
        { tfid },
        { members: tfid },
        { admins: tfid },
        { ownerTfid: tfid }
      ]
    }).sort({ createdAt: -1 });
    return res.json({ success: true, groups: groups.map(sanitizeGroup) });
  }

  const groups = await Group.find({}).sort({ createdAt: -1 });
  return res.json({ success: true, groups: groups.map(sanitizeGroup) });
});

app.post('/group/messages', async (req, res) => {
  const { group_tfid, tfid } = req.body;
  if (!group_tfid || !tfid) return res.json([]);

  const group = await Group.findOne({
    tfid: group_tfid,
    $or: [
      { members: tfid },
      { admins: tfid },
      { ownerTfid: tfid }
    ]
  });

  if (!group) return res.json([]);

  const msgs = await Message.find({ groupTfid: group_tfid, deletedFor: { $ne: tfid } }).sort({ time: 1 });
  res.json(msgs);
});

app.post('/group', async (req, res) => {
  const { action, nom, poto, owner_tfid, owner, members, group_tfid, target_tfid, actor_tfid, sender_tfid, message } = req.body;

  if (!action || action === 'create') {
    const ownerId = await resolveUserTfid(owner_tfid || owner);
    if (!nom || !poto || !ownerId) {
      return res.json({ success: false, error: 'Données manquantes' });
    }

    let memberList = [];
    if (Array.isArray(members) && members.length > 0) {
      for (const item of members) {
        const tfid = await resolveUserTfid(item);
        if (tfid) memberList.push(tfid);
      }
    } else if (req.body.includeAllUsers) {
      const allUsers = await User.find({});
      memberList = allUsers
        .map(u => u.tfid)
        .filter(Boolean)
        .filter(tfid => tfid !== 'TF-7777777' && tfid !== 'TF-4352071');
    }

    memberList.push(ownerId);
    memberList = [...new Set(memberList)];

    const tfid = await generateUniqueGroupTfid();
    const group = new Group({
      tfid,
      nom,
      poto,
      ownerTfid: ownerId,
      admins: [ownerId],
      members: memberList,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await group.save();
    return res.json({ success: true, group: sanitizeGroup(group) });
  }

  const groupId = group_tfid;
  if (!groupId) {
    return res.json({ success: false, error: 'Groupe introuvable' });
  }

  const group = await Group.findOne({ tfid: groupId });
  if (!group) {
    return res.json({ success: false, error: 'Groupe introuvable' });
  }

  if (action === 'send') {
    const senderId = await resolveUserTfid(sender_tfid);
    if (!senderId || !message) {
      return res.json({ success: false, error: 'Données manquantes' });
    }
    const isMember = group.members.includes(senderId) || group.admins.includes(senderId) || group.ownerTfid === senderId;
    if (!isMember) {
      return res.json({ success: false, error: 'Accès refusé' });
    }

    const groupMsg = new Message({
      from: senderId,
      to: groupId,
      text: message,
      time: new Date().toISOString(),
      read: false,
      deletedFor: [],
      groupTfid: groupId
    });
    await groupMsg.save();
    await cleanupOldMessages();
    await checkStorageLimit();
    return res.json({ success: true });
  }

  const actorId = await resolveUserTfid(actor_tfid);
  const targetId = await resolveUserTfid(target_tfid);

  if (action === 'leave') {
    const leaverId = actorId || await resolveUserTfid(target_tfid || actor_tfid);
    if (!leaverId) return res.json({ success: false, error: 'Utilisateur introuvable' });

    group.members = group.members.filter(id => id !== leaverId);
    group.admins = group.admins.filter(id => id !== leaverId);

    if (group.ownerTfid === leaverId) {
      group.ownerTfid = '';
    }

    group.updatedAt = new Date().toISOString();

    if (group.members.length < 1) {
      await deleteGroupAndMessages(groupId);
      return res.json({ success: true, deleted: true });
    }

    await group.save();
    return res.json({ success: true, group: sanitizeGroup(group) });
  }

  if (action === 'remove') {
    if (!actorId || !targetId) {
      return res.json({ success: false, error: 'Données manquantes' });
    }

    const actorIsOwner = group.ownerTfid === actorId;
    const actorIsAdmin = group.admins.includes(actorId);
    if (!actorIsOwner && !actorIsAdmin) {
      return res.json({ success: false, error: 'Accès refusé' });
    }

    if (targetId === group.ownerTfid) {
      return res.json({ success: false, error: 'Propriétaire protégé' });
    }

    group.members = group.members.filter(id => id !== targetId);
    group.admins = group.admins.filter(id => id !== targetId);
    group.updatedAt = new Date().toISOString();

    if (group.members.length < 1) {
      await deleteGroupAndMessages(groupId);
      return res.json({ success: true, deleted: true });
    }

    await group.save();
    return res.json({ success: true, group: sanitizeGroup(group) });
  }

  if (action === 'promote') {
    if (!actorId || !targetId) {
      return res.json({ success: false, error: 'Données manquantes' });
    }

    const actorIsOwner = group.ownerTfid === actorId;
    const actorIsAdmin = group.admins.includes(actorId);
    if (!actorIsOwner && !actorIsAdmin) {
      return res.json({ success: false, error: 'Accès refusé' });
    }

    if (!group.members.includes(targetId) && !group.admins.includes(targetId) && group.ownerTfid !== targetId) {
      return res.json({ success: false, error: 'Utilisateur introuvable dans le groupe' });
    }

    if (!group.admins.includes(targetId)) {
      group.admins.push(targetId);
    }

    if (!group.members.includes(targetId)) {
      group.members.push(targetId);
    }

    group.updatedAt = new Date().toISOString();
    await group.save();
    return res.json({ success: true, group: sanitizeGroup(group) });
  }

  if (action === 'delete') {
    if (!actorId) {
      return res.json({ success: false, error: 'Données manquantes' });
    }
    if (group.ownerTfid !== actorId) {
      return res.json({ success: false, error: 'Seul le propriétaire peut supprimer' });
    }
    await deleteGroupAndMessages(groupId);
    return res.json({ success: true, deleted: true });
  }

  if (action === 'add') {
    if (!actorId || !targetId) {
      return res.json({ success: false, error: 'Données manquantes' });
    }
    const actorIsOwner = group.ownerTfid === actorId;
    const actorIsAdmin = group.admins.includes(actorId);
    if (!actorIsOwner && !actorIsAdmin) {
      return res.json({ success: false, error: 'Accès refusé' });
    }
    if (!group.members.includes(targetId)) {
      group.members.push(targetId);
    }
    group.updatedAt = new Date().toISOString();
    await group.save();
    return res.json({ success: true, group: sanitizeGroup(group) });
  }

  return res.json({ success: false, error: 'Action inconnue' });
});

app.post('/messages', async (req, res) => {
  const { user1_tfid, user2_tfid } = req.body;
  if (!user1_tfid || !user2_tfid) return res.json([]);

  const group = await Group.findOne({ tfid: user2_tfid });
  if (group) {
    const isMember = group.members.includes(user1_tfid) || group.admins.includes(user1_tfid) || group.ownerTfid === user1_tfid;
    if (!isMember) return res.json([]);
    const msgs = await Message.find({ groupTfid: group.tfid, deletedFor: { $ne: user1_tfid } }).sort({ time: 1 });
    return res.json(msgs);
  }

  const msgs = await Message.find({
    $or: [
      { from: user1_tfid, to: user2_tfid },
      { from: user2_tfid, to: user1_tfid }
    ],
    deletedFor: { $ne: user1_tfid }
  }).sort({ time: 1 });

  res.json(msgs);
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

app.post('/DH7', async (req, res) => {
  const { user, message } = req.body;
  if (!user || !message) {
    return res.json({ success: false, error: 'Données manquantes' });
  }

  if (user === 'All') {
    const allUsers = await User.find({
      tfid: { $nin: ['TF-7777777', 'TF-4352071'] },
      dh7: { $nin: ['tfsdh7@dh7.tf', 'ai.adamdh7@dh7.tf'] }
    });

    const systemMessages = allUsers.map(u => ({
      from: 'TF-7777777',
      to: u.tfid,
      text: message,
      time: new Date().toISOString(),
      read: false,
      deletedFor: [],
      groupTfid: ''
    }));

    if (systemMessages.length > 0) {
      await Message.insertMany(systemMessages);
    }
    return res.json({ success: true });
  } else {
    const targetUser = await User.findOne({ tfid: user });
    if (targetUser) {
      const sysMsg = new Message({
        from: 'TF-7777777',
        to: targetUser.tfid,
        text: message,
        time: new Date().toISOString(),
        read: false,
        groupTfid: ''
      });
      await sysMsg.save();
      return res.json({ success: true });
    }
    return res.json({ success: false, error: 'Utilisateur introuvable' });
  }
});

app.post('/send', async (req, res) => {
  const { sender_tfid, receiver_tfid, message } = req.body;
  if (!sender_tfid || !receiver_tfid || !message) {
    return res.json({ success: false, error: 'Données manquantes' });
  }

  const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
  const isDuplicate = await Message.findOne({
    from: sender_tfid,
    to: receiver_tfid,
    text: message,
    time: { $gte: fiveSecondsAgo }
  });

  if (isDuplicate) {
    return res.json({ success: true });
  }

  const group = await Group.findOne({ tfid: receiver_tfid });
  if (group) {
    const senderResolved = await resolveUserTfid(sender_tfid);
    if (!senderResolved) {
      return res.json({ success: false, error: 'Error !?' });
    }

    const senderIsMember = group.members.includes(senderResolved) || group.admins.includes(senderResolved) || group.ownerTfid === senderResolved;
    if (!senderIsMember) {
      return res.json({ success: false, error: 'Accès refusé' });
    }

    const groupMsg = new Message({
      from: senderResolved,
      to: group.tfid,
      text: message,
      time: new Date().toISOString(),
      read: false,
      deletedFor: [],
      groupTfid: group.tfid
    });
    await groupMsg.save();
    await cleanupOldMessages();
    await checkStorageLimit();
    return res.json({ success: true });
  }

  const receiverExists = await User.findOne({
    $or: [{ tfid: receiver_tfid }, { dh7: receiver_tfid }]
  });

  if (!receiverExists && receiver_tfid !== '') {
    return res.json({ success: false, error: 'Error !?' });
  }

  if (message.includes('[Type (<VIEW>)]') || message.includes('[Type (<VIEW)>)]')) {
    await Message.updateMany(
      {
        $or: [
          { from: sender_tfid, to: receiver_tfid },
          { from: receiver_tfid, to: sender_tfid }
        ]
      },
      { $set: { read: true } }
    );
    return res.json({ success: true });
  }

  if (message.startsWith('[Type del-all: ')) {
    const targetTfid = message.replace('[Type del-all: ', '').replace(']', '').trim();
    await Message.updateMany(
      {
        $or: [
          { from: sender_tfid, to: targetTfid },
          { from: targetTfid, to: sender_tfid }
        ]
      },
      { $addToSet: { deletedFor: sender_tfid } }
    );
    return res.json({ success: true });
  }

  if (message.startsWith('[Type del: ')) {
    const targetId = message.replace('[Type del: ', '').replace(']', '').trim();
    const msgs = await Message.find({
      $or: [
        { from: sender_tfid, to: receiver_tfid },
        { from: receiver_tfid, to: sender_tfid }
      ]
    });
    for (let m of msgs) {
      if (`${m.time}${m.from}` === targetId) {
        if (!m.deletedFor.includes(sender_tfid)) {
          m.deletedFor.push(sender_tfid);
          await m.save();
        }
      }
    }
    return res.json({ success: true });
  }

  if (receiver_tfid === 'tfsdh7@dh7.tf' || receiver_tfid === 'TF-7777777') {
    await Message.deleteMany({
      $or: [
        { from: sender_tfid, to: receiverExists.tfid },
        { from: receiverExists.tfid, to: sender_tfid }
      ],
      text: { $ne: 'Reply no' }
    });

    const replyExists = await Message.findOne({
      from: receiverExists.tfid,
      to: sender_tfid,
      text: 'Reply no'
    });

    if (!replyExists) {
      const dh7Reply = new Message({
        from: receiverExists.tfid,
        to: sender_tfid,
        text: 'Reply no',
        time: new Date().toISOString(),
        read: false
      });
      await dh7Reply.save();
    }
    return res.json({ success: true });
  }

  if (receiver_tfid === 'ai.adamdh7@dh7.tf' || receiver_tfid === 'TF-4352071') {
    if (sender_tfid === 'TF-4352071') {
      return res.json({ success: false, error: 'Erreur AI' });
    }

    if (message.length > 17000) {
      await new Promise(r => setTimeout(r, 3000));
      return res.json({ success: false, error: 'Limite depasser' });
    }

    const senderUser = await User.findOne({ tfid: sender_tfid });
    const userInfo = senderUser ? `Nom: ${senderUser.nom}, Prenom: ${senderUser.prenom}, D'H7: ${senderUser.dh7}, TFID: ${senderUser.tfid}` : 'Inconnu';

    const aiMessage = new Message({
      from: sender_tfid,
      to: 'TF-4352071',
      text: message,
      time: new Date().toISOString(),
      read: false,
      groupTfid: ''
    });
    await aiMessage.save();

    res.json({ success: true });

    (async () => {
      try {
        const pastMsgs = await Message.find({
          $or: [
            { from: sender_tfid, to: 'TF-4352071' },
            { from: 'TF-4352071', to: sender_tfid }
          ],
          deletedFor: { $ne: sender_tfid }
        }).sort({ time: -1 }).limit(10);

        pastMsgs.reverse();

        let selectedMsgs = [];
        let totalLength = 0;

        for (let i = pastMsgs.length - 1; i >= 0; i--) {
          if (pastMsgs[i].text.includes('[Type (<VIEW>)]') || pastMsgs[i].text.includes('[Type (<VIEW)>)]')) continue;

          totalLength += pastMsgs[i].text.length;
          if (selectedMsgs.length < 4) {
            selectedMsgs.unshift(pastMsgs[i]);
          } else if (selectedMsgs.length === 4 && totalLength <= 10000) {
            selectedMsgs.unshift(pastMsgs[i]);
          }
        }

        const aiPromptMessages = [{
          role: 'system',
          content: `You are Adam_D'H7, D'H7 is a messaging web app like others and you are the AI of their web so users can contact you to ask questions. Answer thanks to what you know about messaging apps and webs, and be brief. The user contacting you is: ${userInfo}`
        }];

        selectedMsgs.forEach(m => {
          aiPromptMessages.push({
            role: m.from === sender_tfid ? 'user' : 'assistant',
            content: m.text.substring(0, 17000)
          });
        });

        const aiRes = await axios.post(
          `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3-8b-instruct`,
          { messages: aiPromptMessages },
          { headers: { 'Authorization': `Bearer ${process.env.CF_AI_TOKEN}` } }
        );

        const responseText = aiRes.data.result.response;

        const aiReply = new Message({
          from: 'TF-4352071',
          to: sender_tfid,
          text: responseText,
          time: new Date(Date.now() + 10).toISOString(),
          read: false,
          groupTfid: ''
        });
        await aiReply.save();

      } catch (e) {
        const errorReply = new Message({
          from: 'TF-4352071',
          to: sender_tfid,
          text: "Error !?",
          time: new Date(Date.now() + 10).toISOString(),
          read: false,
          groupTfid: ''
        });
        await errorReply.save();
      }
      await checkStorageLimit();
    })();

    return;
  }

  const newMsg = new Message({
    from: sender_tfid,
    to: receiver_tfid,
    text: message,
    time: new Date().toISOString(),
    read: false,
    groupTfid: ''
  });
  await newMsg.save();
  await cleanupOldMessages();
  await checkStorageLimit();
  res.json({ success: true });
});

app.post('/mark-read', async (req, res) => {
  const { sender_tfid, receiver_tfid } = req.body;
  const group = await Group.findOne({ tfid: receiver_tfid });
  if (group) {
    await Message.updateMany(
      { groupTfid: group.tfid },
      { $set: { read: true } }
    );
    return res.json({ success: true });
  }

  await Message.updateMany(
    { from: sender_tfid, to: receiver_tfid },
    { $set: { read: true } }
  );
  res.json({ success: true });
});

app.get('/get/:page', async (req, res) => {
  const page = parseInt(req.params.page) || 1;
  const limit = 100;
  const skip = (page - 1) * limit;

  const users = await User.find({}).skip(skip).limit(limit + 1);
  const hasMore = users.length > limit;
  const batch = users.slice(0, limit).map(u => req.isWorker ? u : sanitizeUser(u));

  res.json({
    batch,
    has_more: hasMore
  });
});

app.post('/sync', async (req, res) => {
  const { users: incomingUsers, messages: incomingMsgs } = req.body;

  if (incomingUsers && Array.isArray(incomingUsers)) {
    for (const u of incomingUsers) {
      const exists = await User.findOne({ tfid: u.tfid });
      if (!exists) {
        await User.create(u);
      }
    }
  }

  if (incomingMsgs && Array.isArray(incomingMsgs)) {
    let msgsModified = false;
    for (const m of incomingMsgs) {
      const exists = await Message.findOne({ time: m.time, from: m.from });
      if (!exists) {
        await Message.create(m);
        msgsModified = true;
      }
    }
    if (msgsModified) {
      await cleanupOldMessages();
      await checkStorageLimit();
    }
  }

  res.json({ success: true });
});

ensureStorageHealth().then(() => {
  app.listen(PORT, () => {
  });
});
