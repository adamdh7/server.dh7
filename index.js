require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = new Set([
  'http://localhost:7000', 
  'https://dh7.adamdh7.org', 
  'https://ai.adamdh7.org', 
  'https://mizik.adamdh7.org',
  'https://poste.adamdh7.org', 
  'https://quiz.adamdh7.org', 
  'https://dh7test.adamdh7.org', 
  'https://www.adamdh7.org'
]);
const ALLOWED_HOSTS = new Set(['dh7.adamdh7.org', 'quiz.adamdh7.org', 'ai.adamdh7.org', 'www.adamdh7.org']);
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin || origin === 'null' || origin.startsWith('file:')) {
      return callback(null, true);
    }
    try {
      const normalized = (new URL(origin)).origin;
      if (ALLOWED_ORIGINS.has(normalized)) return callback(null, true);
      return callback(new Error('Unauthorized Origin'), false);
    } catch (e) {
      return callback(new Error('Invalid Origin'), false);
    }
  },
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

const io = new Server(server, {
  cors: corsOptions
});

io.on('connection', (socket) => {
  socket.on('register', (tfid) => {
    if (tfid) socket.join(tfid);
  });
  socket.on('join_group', (groupId) => {
    if (groupId) socket.join(groupId);
  });
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Invalid data format' });
  }
  next();
});

mongoose.connect(process.env.MONGO_URI);

const userSchema = new mongoose.Schema({
  tfid: { type: String, default: '' },
  nom: String,
  prenom: { type: String, default: '' },
  pseudo: { type: String, default: '' },
  nameDisplayPreference: { type: String, default: 'nameOnly' },
  readReceiptsEnabled: { type: Boolean, default: true },
  dh7: String,
  age: String,
  password: { type: String, default: '' },
  logo: { type: String, default: '' },
  banned: { type: Boolean, default: false },
  bannedAt: { type: Date, default: null },
  spammedUntil: { type: Date, default: null },
  spamCount: { type: Number, default: 0 },
  lastSpammedAt: { type: Date, default: null }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  text: String,
  time: String,
  read: { type: Boolean, default: false },
  deletedFor: { type: [String], default: [] }
});
const Message = mongoose.model('Message', messageSchema);

const groupSchema = new mongoose.Schema({
  tfid: String,
  nom: String,
  photo: { type: String, default: '' },
  proprietaire: String,
  admins: { type: [String], default: [] },
  membres: { type: [String], default: [] }
});
const Group = mongoose.model('Group', groupSchema);

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});
const upload = multer({ storage: multer.memoryStorage() });

const AI_CONFIGS = [
  {
    accountId: process.env.CF_ACCOUNT_ID,
    token: process.env.CF_AI_TOKEN,
    model: '@cf/meta/llama-3.1-8b-instruct'
  },
  {
    accountId: '72351c7ced3e10d7f2380439b30f9d7e',
    token: 'cfut_s3zxeYHDLUUlGNNdjojKNbxOFpbsYx9X41joP9os1df458d2',
    model: '@cf/meta/llama-3.1-8b-instruct'
  },
  {
    accountId: process.env.CF_ACCOUNT_ID_FALLBACK_2 || 'ESPACE_POUR_ACCOUNT_ID_3',
    token: process.env.CF_AI_TOKEN_FALLBACK_2 || 'ESPACE_POUR_TOKEN_3',
    model: '@cf/meta/llama-3.1-8b-instruct'
  },
  {
    accountId: process.env.CF_ACCOUNT_ID_FALLBACK_3 || 'ESPACE_POUR_ACCOUNT_ID_4',
    token: process.env.CF_AI_TOKEN_FALLBACK_3 || 'ESPACE_POUR_TOKEN_4',
    model: '@cf/meta/llama-3.1-8b-instruct'
  }
];

async function executeAiRequest(messages, overrideModel) {
  let lastError;
  for (const config of AI_CONFIGS) {
    if (!config.accountId || !config.token || config.accountId.startsWith('ESPACE_')) continue;
    try {
      const modelToUse = overrideModel || config.model;
      const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${modelToUse}`;
      const response = await axios.post(
        url,
        { messages: messages },
        { headers: { 'Authorization': `Bearer ${config.token}` } }
      );
      if (response && response.data && response.data.result) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('All AI configurations failed');
}

function generateDefaultLogo(prenom, nom) {
  let letter = '?';
  if (prenom && prenom.trim().length > 0) {
    letter = prenom.trim().charAt(0).toUpperCase();
  } else if (nom && nom.trim().length > 0) {
    letter = nom.trim().charAt(0).toUpperCase();
  }
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(letter)}&background=000&color=fff&size=200`;
}

function sanitizeUser(u) {
  try {
    const obj = u.toObject ? u.toObject() : u;
    const { password, ...rest } = obj;
    
    if (!rest.logo || rest.logo.trim() === '') {
      rest.logo = generateDefaultLogo(rest.prenom, rest.nom);
    }
    
    if (rest.age && rest.age.length >= 4) {
      const birthYear = parseInt(rest.age.substring(0, 4), 10);
      if (!isNaN(birthYear)) {
        rest.age = (new Date().getFullYear() - birthYear).toString();
      }
    }

    if (rest.spammedUntil) {
      const now = new Date();
      const spammedUntilDate = new Date(rest.spammedUntil);
      if (spammedUntilDate > now) {
        const diffMs = spammedUntilDate.getTime() - now.getTime();
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
        rest.spamRemaining = { hours, minutes, seconds, formatted: `${hours}h ${minutes}m ${seconds}s` };
      } else {
        rest.spamRemaining = null;
      }
    } else {
      rest.spamRemaining = null;
    }
    
    return rest;
  } catch (e) {
    return u;
  }
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
    if (!tfidExists) {
      return tempTfid;
    }
    attempts++;
    if (attempts > 1000) digits++;
  }
}

async function generateGroupTfid() {
  let digits = 17;
  while (true) {
    let num = '';
    for (let i = 0; i < digits; i++) {
      num += Math.floor(Math.random() * 10).toString();
    }
    const tempTfid = `TF-${num}`;
    const tfidExists = await Group.findOne({ tfid: tempTfid });
    if (!tfidExists) {
      return tempTfid;
    }
  }
}

async function checkStorageLimit() {
  try {
    const stats = await mongoose.connection.db.command({ dbStats: 1 });
    const limit = 400 * 1024 * 1024;
    
    if (stats.dataSize > limit) {
      await Message.deleteMany({
        from: { $ne: 'TF-7656930' },
        to: { $ne: 'TF-7656930' }
      });
      const users = await User.find({});
      const systemMessages = [];
      
      for (const u of users) {
        if (u.tfid !== 'TF-7777777' && u.tfid !== 'TF-4352071' && u.tfid !== 'TF-7656930') {
          systemMessages.push({
            from: 'TF-7777777',
            to: u.tfid,
            text: 'Data was cleared recently',
            time: new Date().toISOString(),
            read: false,
            deletedFor: []
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
    const fortyThreeDaysAgo = new Date(Date.now() - 43 * 24 * 60 * 60 * 1000);
    await User.deleteMany({ banned: true, bannedAt: { $lt: fortyThreeDaysAgo } });

    const seventeenMinsAgo = new Date(Date.now() - 17 * 60 * 1000).toISOString();
    await Message.deleteMany({
      from: 'TF-7777777',
      to: 'TF-7777777',
      time: { $lt: seventeenMinsAgo }
    });
    await Message.deleteMany({
      from: 'TF-7777777',
      text: { $regex: /^\[ADMIN / },
      time: { $lt: seventeenMinsAgo }
    });
    await Message.deleteMany({
      text: { $regex: /^\[Type (CHECK|SPAM|BAN|UNSPAM|UNBAN):/i },
      time: { $lt: seventeenMinsAgo }
    });

    const now = new Date();
    const expiredSpamUsers = await User.find({ spammedUntil: { $lt: now }, banned: false });
    for (const u of expiredSpamUsers) {
      await Message.deleteMany({
        from: 'TF-7777777',
        to: u.tfid,
        text: `[{[Type SPAM: ${u.tfid}]}]`
      });
      await User.updateOne({ tfid: u.tfid }, { $set: { spammedUntil: null } });
    }
  } catch (e) {}
}

async function ensureStorageHealth() {
  try {
    const sysUserExists = await User.findOne({ dh7: 'tfsdh7@dh7.tf' });
    if (!sysUserExists) {
      await User.create({
        tfid: 'TF-7777777',
        nom: "D'H7",
        prenom: '',
        dh7: 'tfsdh7@dh7.tf',
        age: '0',
        password: '',
        logo: 'https://dh7.adamdh7.org/DH7.png',
        banned: false
      });
    } else {
      await User.updateOne(
        { dh7: 'tfsdh7@dh7.tf' },
        { $set: { nom: "D'H7", prenom: '', logo: 'https://dh7.adamdh7.org/DH7.png', tfid: 'TF-7777777', banned: false } }
      );
    }

    const aiUserExists = await User.findOne({ dh7: 'assistant@dh7.tf' });
    if (!aiUserExists) {
      await User.create({
        tfid: 'TF-4352071',
        nom: "Assistant",
        prenom: '',
        dh7: 'assistant@dh7.tf',
        age: '0',
        password: '',
        logo: 'https://dh7.adamdh7.org/DH72.png',
        banned: false
      });
    } else {
      await User.updateOne(
        { dh7: 'assistant@dh7.tf' },
        { $set: { logo: 'https://dh7.adamdh7.org/DH72.png', tfid: 'TF-4352071', banned: false } }
      );
    }

    const conflictingUsers = await User.find({
      tfid: { $in: ['TF-7777777', 'TF-4352071'] },
      dh7: { $nin: ['tfsdh7@dh7.tf', 'assistant@dh7.tf'] }
    });
    
    for (const cu of conflictingUsers) {
      cu.tfid = await generateUniqueTfid();
      await cu.save();
    }

    const noLogoUsers = await User.find({
      $or: [{ logo: '' }, { logo: null }, { logo: { $exists: false } }],
      tfid: { $nin: ['TF-7777777', 'TF-4352071'] }
    });

    for (const nu of noLogoUsers) {
      nu.logo = generateDefaultLogo(nu.prenom, nu.nom);
      await nu.save();
    }

    await cleanupOldMessages();
    await checkStorageLimit();
  } catch (e) {}
}

function isBrowserUserAgent(ua) {
  if (!ua) return false;
  return /Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua);
}

async function verifyCaller(req, res, next) {
  try {
    const originHeader = req.headers.origin || req.headers.referer || null;
    const token = req.headers['x-worker-token'] || '';
    const appSecret = req.headers['x-app-request'] || '';
    const callerHost = (req.headers['x-caller-host'] || '').toLowerCase();
    const ua = req.headers['user-agent'] || '';

    req.isWorker = false;

    if (token && WORKER_TOKEN && token === WORKER_TOKEN && ALLOWED_HOSTS.has(callerHost)) {
      req.isWorker = true;
      return next();
    }

    if (req.path === '/sync') {
      return res.status(403).json({ success: false, error: 'Strict worker token required' });
    }

    if (appSecret === 'tfsdh7') {
      return next();
    }

    if (originHeader) {
      const normalized = (new URL(originHeader)).origin;
      if (!ALLOWED_ORIGINS.has(normalized)) {
        return res.status(403).json({ success: false, error: 'Unauthorized origin' });
      }
      const isBrowser = isBrowserUserAgent(ua);
      const isCurl = ua.toLowerCase().includes('curl') || ua.toLowerCase().includes('postman');
      if (!isBrowser || isCurl) {
        return res.status(403).json({ success: false, error: 'Browser required for this origin' });
      }
      return next();
    }

    const isBrowser = isBrowserUserAgent(ua);
    if (isBrowser) {
      return res.status(403).json({ success: false, error: 'Unauthorized browser access' });
    }

    return res.status(403).json({ success: false, error: 'Unauthorized caller' });
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid origin or verification error' });
  }
}

async function generateAiNotification(targetTfid, englishTemplate, adminLogs = '') {
  try {
    const recentMsgs = await Message.find({
      $or: [
        { from: targetTfid, to: { $nin: ['TF-7777777', 'TF-4352071'] } },
        { to: targetTfid, from: { $nin: ['TF-7777777', 'TF-4352071'] } }
      ]
    }).sort({ time: -1 }).limit(7);
    
    let userLanguageContext = recentMsgs.map(m => `[From ${m.from} to ${m.to}]: ${m.text}`).join('\n');
    if (userLanguageContext.length > 7000) {
      userLanguageContext = userLanguageContext.substring(0, 7000) + '... (truncated)';
    }

    const systemPrompt = "You are the D'H7 Platform System Translator. Translate the official notification into the user's preferred language detected from their chat history. Keep the tone official, objective, and extremely clear. Inform them exactly why they were restricted/banned based on the provided Admin logs. Output ONLY the final translated message without introductory lines, greetings, or markdown blocks.";
    const userPrompt = `[ADMIN INVESTIGATION CONTEXT]:\n${adminLogs || 'No specific logs.'}\n\n[USER RECENT CONVERSATIONS WITH OTHERS]:\n${userLanguageContext || 'No past external messages.'}\n\n[OFFICIAL TEMPLATE TO TRANSLATE]:\n${englishTemplate}`;
    
    const response = await executeAiRequest([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], '@cf/meta/llama-3.1-8b-instruct');
    
    const translatedText = response.data.result.response.trim();
    const systemMessage = new Message({
      from: 'TF-7777777',
      to: targetTfid,
      text: translatedText || englishTemplate,
      time: new Date().toISOString(),
      read: false
    });
    await systemMessage.save();
    io.to(targetTfid).emit('new_message', systemMessage);
  } catch (error) {
    try {
      const fallbackMessage = new Message({
        from: 'TF-7777777',
        to: targetTfid,
        text: englishTemplate,
        time: new Date().toISOString(),
        read: false
      });
      await fallbackMessage.save();
      io.to(targetTfid).emit('new_message', fallbackMessage);
    } catch (e) {}
  }
}

async function logToAdmin(action, details) {
  try {
    const logMessage = new Message({
      from: 'TF-4352071',
      to: 'TF-7777777',
      text: `[ADMIN LOG] Action: ${action} | Details: ${details}`,
      time: new Date().toISOString(),
      read: false
    });
    await logMessage.save();
    io.to('TF-7777777').emit('new_message', logMessage);
  } catch (e) {}
}

app.use(verifyCaller);

app.post('/register', async (req, res) => {
  try {
    const { nom, prenom, dh7, age, password } = req.body;
    if (!nom || !prenom || !dh7 || !password) {
      return res.json({ success: false, error: 'Missing data' });
    }
    
    const existingUser = await User.findOne({ dh7 });
    if (existingUser) {
      return res.json({ success: false, error: 'DH7 address already registered' });
    }

    const tfid = await generateUniqueTfid();
    const logoUrl = generateDefaultLogo(prenom, nom);

    const newUser = new User({ tfid, nom, prenom, dh7, age, password, logo: logoUrl });
    await newUser.save();
    await checkStorageLimit();
    res.json({ success: true, tfid });
  } catch (e) {
    res.json({ success: false, error: 'Internal Server Error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!password || password === '') {
      return res.json({ success: false, error: 'Incorrect identifier or password' });
    }
    const user = await User.findOne({
      $or: [{ tfid: identifier }, { dh7: identifier }],
      password: password
    });
    if (user) {
      if (user.banned) {
        return res.json({ success: false, error: `[{[Type BAN: ${user.tfid}]}]` });
      }
      if (user.spammedUntil && new Date() < user.spammedUntil) {
        const now = new Date();
        const diffMs = user.spammedUntil.getTime() - now.getTime();
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
        return res.json({ 
          success: false, 
          error: `[{[Type SPAM: ${user.tfid}]}]`,
          spamRemaining: { hours, minutes, seconds, formatted: `${hours}h ${minutes}m ${seconds}s` }
        });
      }
      return res.json({ success: true, user: sanitizeUser(user) });
    }
    return res.json({ success: false, error: 'Incorrect identifier or password' });
  } catch (e) {
    res.json({ success: false, error: 'Internal Server Error' });
  }
});

app.post('/update-profile', async (req, res) => {
  try {
    const { tfid, nom, pseudo, nameDisplayPreference, readReceiptsEnabled } = req.body;
    if (!tfid) return res.json({ success: false, error: 'Missing TFID' });

    const updateData = {};
    if (nom !== undefined) updateData.nom = nom;
    if (pseudo !== undefined) updateData.pseudo = pseudo;
    if (nameDisplayPreference !== undefined) updateData.nameDisplayPreference = nameDisplayPreference;
    if (readReceiptsEnabled !== undefined) updateData.readReceiptsEnabled = readReceiptsEnabled;

    await User.updateOne({ tfid }, { $set: updateData });
    const updatedUser = await User.findOne({ tfid });
    
    io.emit('user_updated', sanitizeUser(updatedUser));
    
    res.json({ success: true, user: sanitizeUser(updatedUser) });
  } catch (e) {
    res.json({ success: false, error: 'Update failed' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const users = await User.find({ banned: { $ne: true } });
    res.json(users.map(sanitizeUser));
  } catch (e) {
    res.json([]);
  }
});

app.post('/my-groups', async (req, res) => {
  try {
    const { tfid } = req.body;
    if (!tfid) return res.json([]);
    const groups = await Group.find({ membres: tfid });
    res.json(groups);
  } catch (e) {
    res.json([]);
  }
});

app.post('/search', async (req, res) => {
  try {
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
      banned: { $ne: true },
      $or: [
        { nom: { $regex: q, $options: 'i' } },
        { pseudo: { $regex: q, $options: 'i' } },
        { prenom: { $regex: q, $options: 'i' } },
        { dh7: { $regex: q, $options: 'i' } },
        { tfid: { $regex: q, $options: 'i' } }
      ]
    });
    res.json({ results: users.map(sanitizeUser) });
  } catch (e) {
    res.json({ results: [] });
  }
});

app.post('/group', async (req, res) => {
  try {
    const { action, group_tfid, sender_tfid, target_tfid, nom, photo } = req.body;
    if (!action || !sender_tfid) return res.json({ success: false, error: 'Missing data' });

    if (action === 'create') {
      if (!nom) return res.json({ success: false, error: 'Name is required' });
      const tfid = await generateGroupTfid();
      const newGroup = new Group({
        tfid,
        nom,
        photo: photo || '',
        proprietaire: sender_tfid,
        membres: [sender_tfid],
        admins: [sender_tfid]
      });
      await newGroup.save();
      io.to(sender_tfid).emit('group_updated', newGroup);
      return res.json({ success: true, group_tfid: tfid });
    }

    if (!group_tfid) return res.json({ success: false, error: 'Missing group' });
    const group = await Group.findOne({ tfid: group_tfid });
    if (!group) return res.json({ success: false, error: 'Group not found' });

    const isProprietaire = group.proprietaire === sender_tfid;
    const isAdmin = group.admins.includes(sender_tfid);

    if (action === 'add') {
      if (!isAdmin && !isProprietaire) return res.json({ success: false, error: 'Unauthorized action' });
      if (!group.membres.includes(target_tfid)) {
        group.membres.push(target_tfid);
        await group.save();
        io.to(target_tfid).emit('group_updated', group);
        io.to(group_tfid).emit('group_updated', group);
      }
      return res.json({ success: true });
    }

    if (action === 'remove') {
      if (!isAdmin && !isProprietaire) return res.json({ success: false, error: 'Unauthorized action' });
      if (target_tfid === group.proprietaire) return res.json({ success: false, error: 'Impossible to remove the group owner' });
      group.membres = group.membres.filter(id => id !== target_tfid);
      group.admins = group.admins.filter(id => id !== target_tfid);
      await group.save();
      io.to(target_tfid).emit('group_removed', group_tfid);
      io.to(group_tfid).emit('group_updated', group);
      if (group.membres.length === 0) {
        await Message.deleteMany({ to: group_tfid });
        await Group.deleteOne({ tfid: group_tfid });
      }
      return res.json({ success: true });
    }

    if (action === 'leave') {
      group.membres = group.membres.filter(id => id !== sender_tfid);
      group.admins = group.admins.filter(id => id !== sender_tfid);
      if (group.proprietaire === sender_tfid) {
        group.proprietaire = '';
      }
      await group.save();
      io.to(sender_tfid).emit('group_removed', group_tfid);
      io.to(group_tfid).emit('group_updated', group);
      if (group.membres.length === 0) {
        await Message.deleteMany({ to: group_tfid });
        await Group.deleteOne({ tfid: group_tfid });
      }
      return res.json({ success: true });
    }

    if (action === 'promote') {
      if (!isAdmin && !isProprietaire) return res.json({ success: false, error: 'Unauthorized action' });
      if (!group.admins.includes(target_tfid)) {
        group.admins.push(target_tfid);
        await group.save();
        io.to(group_tfid).emit('group_updated', group);
      }
      return res.json({ success: true });
    }

    if (action === 'delete') {
      if (!isProprietaire) return res.json({ success: false, error: 'Unauthorized action' });
      await Message.deleteMany({ to: group_tfid });
      await Group.deleteOne({ tfid: group_tfid });
      io.to(group_tfid).emit('group_removed', group_tfid);
      return res.json({ success: true });
    }

    return res.json({ success: false, error: 'Unknown action' });
  } catch (e) {
    res.json({ success: false, error: 'Internal Server Error' });
  }
});

app.post('/messages', async (req, res) => {
  try {
    const { user1_tfid, user2_tfid } = req.body;
    if (!user1_tfid || !user2_tfid) return res.json([]);
    
    let msgs;
    if (user2_tfid.length === 20 && user2_tfid.startsWith('TF-')) {
      msgs = await Message.find({
        to: user2_tfid,
        deletedFor: { $ne: user1_tfid }
      }).sort({ time: 1 });
    } else {
      msgs = await Message.find({
        $or: [
          { from: user1_tfid, to: user2_tfid },
          { from: user2_tfid, to: user1_tfid }
        ],
        deletedFor: { $ne: user1_tfid }
      }).sort({ time: 1 });
    }
    res.json(msgs);
  } catch (e) {
    res.json([]);
  }
});

app.post('/upload-profile', upload.single('image'), async (req, res) => {
  try {
    const tfid = req.body.tfid;
    const file = req.file;
    if (!tfid || !file) return res.json({ success: false, error: 'Missing file or TFID' });

    const user = await User.findOne({ tfid: tfid });
    if (!user) return res.json({ success: false, error: 'User not found' });

    const uniqueTimestamp = Date.now();
    const dynamicKey = `${tfid}-${uniqueTimestamp}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: dynamicKey,
      Body: file.buffer,
      ContentType: file.mimetype
    });
    await s3Client.send(command);

    const headCommand = new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: dynamicKey
    });
    const headResult = await s3Client.send(headCommand);

    if (headResult && headResult.$metadata && headResult.$metadata.httpStatusCode === 200) {
      if (user.logo) {
        try {
          const urlParts = user.logo.split('/');
          const lastPart = urlParts[urlParts.length - 1];
          if (lastPart && lastPart.startsWith(tfid)) {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET,
              Key: lastPart
            });
            await s3Client.send(deleteCommand);
          }
        } catch (deleteError) {}
      }

      const logoUrl = `https://pub-24986ee77a4440dba7c072922c670547.r2.dev/${dynamicKey}`;
      await User.updateOne({ tfid: tfid }, { $set: { logo: logoUrl } });
      const updatedUser = await User.findOne({ tfid: tfid });
      io.emit('user_updated', sanitizeUser(updatedUser));
      res.json({ success: true, logo: logoUrl });
    } else {
      res.json({ success: false, error: 'Upload verification failed' });
    }
  } catch (e) {
    res.json({ success: false, error: 'Upload failed' });
  }
});

app.post('/DH7', async (req, res) => {
  try {
    const { user, message } = req.body;
    if (!user || !message) {
      return res.json({ success: false, error: 'Missing data' });
    }
    
    if (user === 'All') {
      const allUsers = await User.find({
        tfid: { $nin: ['TF-7777777', 'TF-4352071'] },
        dh7: { $nin: ['tfsdh7@dh7.tf', 'assistant@dh7.tf'] },
        banned: { $ne: true }
      });
      
      const systemMessages = allUsers.map(u => ({
        from: 'TF-7777777',
        to: u.tfid,
        text: message,
        time: new Date().toISOString(),
        read: false
      }));
      
      if (systemMessages.length > 0) {
        await Message.insertMany(systemMessages);
        for (const msg of systemMessages) {
          io.to(msg.to).emit('new_message', msg);
        }
      }
      return res.json({ success: true });
    } else {
      const targetUser = await User.findOne({ tfid: user, banned: { $ne: true } });
      if (targetUser) {
        const sysMsg = new Message({
          from: 'TF-7777777',
          to: targetUser.tfid,
          text: message,
          time: new Date().toISOString(),
          read: false
        });
        await sysMsg.save();
        io.to(targetUser.tfid).emit('new_message', sysMsg);
        return res.json({ success: true });
      }
      return res.json({ success: false, error: 'User not found' });
    }
  } catch (e) {
    res.json({ success: false, error: 'Internal Server Error' });
  }
});

app.post('/send', async (req, res) => {
  try {
    const { sender_tfid, receiver_tfid, message } = req.body;
    if (!sender_tfid || !receiver_tfid || !message) {
      return res.json({ success: false, error: 'Missing data' });
    }

    if (sender_tfid === 'TF-7777777') {
      const checkMatch = message.match(/\[Type CHECK:\s*([^\]]+)\]/i);
      const spamMatch = message.match(/\[Type SPAM:\s*([^\]]+)\]/i);
      const banMatch = message.match(/\[Type BAN:\s*([^\]]+)\]/i);
      const unspamMatch = message.match(/\[Type UNSPAM:\s*([^\]]+)\]/i);
      const unbanMatch = message.match(/\[Type UNBAN:\s*([^\]]+)\]/i);

      if (checkMatch || spamMatch || banMatch || unspamMatch || unbanMatch) {
        const cmdMsg = new Message({
          from: sender_tfid,
          to: receiver_tfid,
          text: message,
          time: new Date().toISOString(),
          read: true
        });
        await cmdMsg.save();
        io.to(receiver_tfid).emit('new_message', cmdMsg);

        let replyText = "";

        if (checkMatch) {
          const targetId = checkMatch[1].trim();
          const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
          if (targetUserObj) {
            const histMsgs = await Message.find({
              $or: [{ from: targetUserObj.tfid }, { to: targetUserObj.tfid }]
            }).sort({ time: -1 }).limit(100);
            histMsgs.reverse();
            let combinedText = histMsgs.map(m => `[${m.time}] From ${m.from} To ${m.to}: ${m.text}`).join('\n');
            if (combinedText.length > 15000) {
              combinedText = combinedText.substring(0, 15000) + '... (truncated)';
            }
            replyText = `[ADMIN CHECK RESULT FOR ${targetUserObj.tfid}]:\n${combinedText || 'No messages found.'}`;
          } else {
            replyText = `[ADMIN CHECK ERROR]: User ${targetId} not found.`;
          }
        } else if (spamMatch) {
          const targetId = spamMatch[1].trim();
          const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
          if (targetUserObj) {
            const unblockDate = new Date();
            unblockDate.setHours(unblockDate.getHours() + 24);
            const newSpamCount = (targetUserObj.spamCount || 0) + 1;
            
            if (newSpamCount >= 3) {
              await User.updateOne(
                { tfid: targetUserObj.tfid }, 
                { $set: { banned: true, bannedAt: new Date(), spamCount: newSpamCount, lastSpammedAt: new Date() } }
              );
              const banMsg = new Message({
                from: 'TF-7777777',
                to: targetUserObj.tfid,
                text: `[{[Type BAN: ${targetUserObj.tfid}]}]`,
                time: new Date().toISOString(),
                read: false
              });
              await banMsg.save();
              io.to(targetUserObj.tfid).emit('new_message', banMsg);
              
              replyText = `[ADMIN SPAM ALERT]: User ${targetUserObj.tfid} restricted 3 times. BANNED permanently.`;
              
              const noticeEng = `Your account ${targetUserObj.tfid} has been permanently banned after receiving 3 spam restrictions. Reason: Maximum spam threshold reached.`;
              await generateAiNotification(targetUserObj.tfid, noticeEng, replyText);
            } else {
              await User.updateOne(
                { tfid: targetUserObj.tfid }, 
                { $set: { spammedUntil: unblockDate, spamCount: newSpamCount, lastSpammedAt: new Date() } }
              );
              const spamMsg = new Message({
                from: 'TF-7777777',
                to: targetUserObj.tfid,
                text: `[{[Type SPAM: ${targetUserObj.tfid}]}]`,
                time: new Date().toISOString(),
                read: false
              });
              await spamMsg.save();
              io.to(targetUserObj.tfid).emit('new_message', spamMsg);
              
              replyText = `[ADMIN SPAM SUCCESS]: User ${targetUserObj.tfid} restricted for 24h. Spam count: ${newSpamCount}/3.`;
              
              const noticeEng = `Your account ${targetUserObj.tfid} is temporarily restricted for 24 hours due to spamming behavior. Your limit is currently ${newSpamCount}/3.`;
              await generateAiNotification(targetUserObj.tfid, noticeEng, replyText);
            }
          } else {
            replyText = `[ADMIN SPAM ERROR]: User ${targetId} not found.`;
          }
        } else if (banMatch) {
          const targetId = banMatch[1].trim();
          const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
          if (targetUserObj) {
            await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { banned: true, bannedAt: new Date() } });
            const banMsg = new Message({
              from: 'TF-7777777',
              to: targetUserObj.tfid,
              text: `[{[Type BAN: ${targetUserObj.tfid}]}]`,
              time: new Date().toISOString(),
              read: false
            });
            await banMsg.save();
            io.to(targetUserObj.tfid).emit('new_message', banMsg);
            
            replyText = `[ADMIN BAN SUCCESS]: User ${targetUserObj.tfid} has been permanently banned.`;
            
            const noticeEng = `This is an official system notification. Your account ${targetUserObj.tfid} has been permanently banned due to severe violations of the D'H7 Community Guidelines. All functions are suspended.`;
            await generateAiNotification(targetUserObj.tfid, noticeEng, replyText);
          } else {
            replyText = `[ADMIN BAN ERROR]: User ${targetId} not found.`;
          }
        } else if (unspamMatch) {
          const targetId = unspamMatch[1].trim();
          const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
          if (targetUserObj) {
            await User.updateOne(
              { tfid: targetUserObj.tfid }, 
              { $set: { spammedUntil: null } }
            );
            await Message.deleteMany({
              from: 'TF-7777777',
              to: targetUserObj.tfid,
              text: `[{[Type SPAM: ${targetUserObj.tfid}]}]`
            });
            replyText = `[ADMIN UNSPAM SUCCESS]: User ${targetUserObj.tfid} spam restriction has been cleared.`;
          } else {
            replyText = `[ADMIN UNSPAM ERROR]: User ${targetId} not found.`;
          }
        } else if (unbanMatch) {
          const targetId = unbanMatch[1].trim();
          const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
          if (targetUserObj) {
            await User.updateOne(
              { tfid: targetUserObj.tfid }, 
              { $set: { banned: false, bannedAt: null, spamCount: 0, lastSpammedAt: null, spammedUntil: null, logo: '' } }
            );
            await Message.deleteMany({
              $or: [{ from: targetUserObj.tfid }, { to: targetUserObj.tfid }]
            });
            replyText = `[ADMIN UNBAN SUCCESS]: User ${targetUserObj.tfid} has been unbanned and fully reset.`;
          } else {
            replyText = `[ADMIN UNBAN ERROR]: User ${targetId} not found.`;
          }
        }

        const replyMsg = new Message({
          from: 'TF-7777777',
          to: receiver_tfid,
          text: replyText,
          time: new Date(Date.now() + 10).toISOString(),
          read: false
        });
        await replyMsg.save();
        io.to(receiver_tfid).emit('new_message', replyMsg);

        return res.json({ success: true });
      }
    }

    const senderUserObj = await User.findOne({ tfid: sender_tfid });
    if (senderUserObj && senderUserObj.banned) {
      if (receiver_tfid !== 'TF-4352071' && receiver_tfid !== 'assistant@dh7.tf') {
        return res.json({ success: false, error: 'Account banned' });
      }
    }
    if (senderUserObj && senderUserObj.spammedUntil && new Date() < senderUserObj.spammedUntil) {
      if (receiver_tfid !== 'TF-4352071' && receiver_tfid !== 'assistant@dh7.tf') {
        return res.json({ success: false, error: 'Account restricted' });
      }
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

    let receiverExists = null;
    const isGroup = receiver_tfid.length === 20 && receiver_tfid.startsWith('TF-');
    
    if (isGroup) {
      receiverExists = await Group.findOne({ tfid: receiver_tfid });
      if (receiverExists && !receiverExists.membres.includes(sender_tfid)) {
        return res.json({ success: false, error: 'Unauthorized access to group' });
      }
    } else {
      receiverExists = await User.findOne({ 
        $or: [{ tfid: receiver_tfid }, { dh7: receiver_tfid }] 
      });
    }

    if (!receiverExists && receiver_tfid !== '') {
      return res.json({ success: false, error: 'Receiver check error' });
    }

    if (message.includes('[Type (<VIEW>)]') || message.includes('[Type (<VIEW)>)]')) {
      const reader = await User.findOne({ tfid: sender_tfid });
      if (reader && reader.readReceiptsEnabled === false) {
        return res.json({ success: true });
      }

      if (isGroup) {
        await Message.updateMany(
          { to: receiver_tfid },
          { $set: { read: true } }
        );
        io.to(receiver_tfid).emit('messages_read', { by: sender_tfid, group: receiver_tfid });
      } else {
        await Message.updateMany(
          {
            $or: [
              { from: sender_tfid, to: receiver_tfid },
              { from: receiver_tfid, to: sender_tfid }
            ]
          },
          { $set: { read: true } }
        );
        io.to(receiver_tfid).emit('messages_read', { by: sender_tfid });
      }
      return res.json({ success: true });
    }

    if (message.startsWith('[Type del-all: ')) {
      const targetTfid = message.replace('[Type del-all: ', '').replace(']', '').trim();
      if (targetTfid.length === 20 && targetTfid.startsWith('TF-')) {
        await Message.updateMany(
          { to: targetTfid },
          { $addToSet: { deletedFor: sender_tfid } }
        );
        io.to(targetTfid).emit('messages_deleted', { by: sender_tfid });
      } else {
        await Message.updateMany(
          {
            $or: [
              { from: sender_tfid, to: targetTfid },
              { from: targetTfid, to: sender_tfid }
            ]
          },
          { $addToSet: { deletedFor: sender_tfid } }
        );
        io.to(targetTfid).emit('messages_deleted', { by: sender_tfid });
      }
      return res.json({ success: true });
    }

    if (message.startsWith('[Type del: ')) {
      const targetId = message.replace('[Type del: ', '').replace(']', '').trim();
      let msgs;
      if (isGroup) {
        msgs = await Message.find({ to: receiver_tfid });
      } else {
        msgs = await Message.find({
          $or: [
            { from: sender_tfid, to: receiver_tfid },
            { from: receiver_tfid, to: sender_tfid }
          ]
        });
      }
      for (let m of msgs) {
        if (m.time + m.from === targetId) {
          if (!m.deletedFor.includes(sender_tfid)) {
            m.deletedFor.push(sender_tfid);
            await m.save();
          }
        }
      }
      io.to(receiver_tfid).emit('message_deleted_single', { by: sender_tfid, targetId });
      return res.json({ success: true });
    }

    if (message.startsWith('[Type del2: ')) {
      const targetId = message.replace('[Type del2: ', '').replace(']', '').trim();
      let msgs;
      if (isGroup) {
        msgs = await Message.find({ to: receiver_tfid });
      } else {
        msgs = await Message.find({
          $or: [
            { from: sender_tfid, to: receiver_tfid },
            { from: receiver_tfid, to: sender_tfid }
          ]
        });
      }
      for (let m of msgs) {
        if (m.time + m.from === targetId) {
          await Message.deleteOne({ _id: m._id });
        }
      }
      io.to(receiver_tfid).emit('message_deleted_global', { by: sender_tfid, targetId });
      return res.json({ success: true });
    }

    if (receiver_tfid === 'tfsdh7@dh7.tf' || receiver_tfid === 'TF-7777777') {
      if (sender_tfid === 'TF-7777777') {
        const selfMsg = new Message({
          from: sender_tfid,
          to: receiver_tfid,
          text: message,
          time: new Date().toISOString(),
          read: true
        });
        await selfMsg.save();

        io.to(receiver_tfid).emit('new_message', selfMsg);
        res.json({ success: true });

        (async () => {
          try {
            const selfMsgs = await Message.find({
              from: 'TF-7777777',
              to: 'TF-7777777'
            }).sort({ time: -1 }).limit(10);
            selfMsgs.reverse();

            let promptMsgs = [
              { role: 'system', content: "You are the D'H7 System Core Host Assistant. You are replying to the admin/host (TF-7777777) in a self-conversation. Speak naturally, be helpful, and support them as their automated system mirror." }
            ];
            selfMsgs.forEach(m => {
              promptMsgs.push({
                role: m.from === 'TF-7777777' && m.read === true ? 'user' : 'assistant',
                content: m.text
              });
            });

            const aiRes = await executeAiRequest(promptMsgs, '@cf/meta/llama-3.1-8b-instruct');

            const replyText = aiRes.data.result.response.trim();
            const systemSelfReply = new Message({
              from: 'TF-7777777',
              to: 'TF-7777777',
              text: replyText,
              time: new Date(Date.now() + 10).toISOString(),
              read: false
            });
            await systemSelfReply.save();
            io.to('TF-7777777').emit('new_message', systemSelfReply);
          } catch (err) {
            const errReply = new Message({
              from: 'TF-7777777',
              to: 'TF-7777777',
              text: "D'H7 Self-System: Connection to core engine interrupted.",
              time: new Date(Date.now() + 10).toISOString(),
              read: false
            });
            await errReply.save();
            io.to('TF-7777777').emit('new_message', errReply);
          }
        })();
        return;
      } else {
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
          io.to(sender_tfid).emit('new_message', dh7Reply);
        }
        return res.json({ success: true });
      }
    }

    if (receiver_tfid === 'assistant@dh7.tf' || receiver_tfid === 'TF-4352071') {
      if (sender_tfid === 'TF-4352071') {
        return res.json({ success: false, error: 'AI infinite loop prevention triggered' });
      }

      if (message.length > 17000) {
        await new Promise(r => setTimeout(r, 3000));
        return res.json({ success: false, error: 'Message size limit exceeded' });
      }

      const senderUser = await User.findOne({ tfid: sender_tfid });
      const userInfo = senderUser ? `Name: ${senderUser.nom}, Surname: ${senderUser.prenom}, DH7: ${senderUser.dh7}, TFID: ${senderUser.tfid}` : 'Unknown';

      const aiMessage = new Message({
        from: sender_tfid,
        to: 'TF-4352071',
        text: message,
        time: new Date().toISOString(),
        read: false
      });
      await aiMessage.save();
      io.to('TF-4352071').emit('new_message', aiMessage);

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

          const systemInstructions = `You are the DH7 Assistant. Use the provided user data (${userInfo}) to personalize responses. You operate as a definitive system tool. Execute commands immediately when conditions are met. Commands must be in English, enclosed in [ and ]. Available Commands: [Type SEARCH: About D'H7] for platform rules and info. [Type SEARCH: Moderation Rules] for your moderation capabilities.`;

          let aiPromptMessages = [{ role: 'system', content: systemInstructions }];
          
          selectedMsgs.forEach(m => {
            aiPromptMessages.push({
              role: m.from === sender_tfid ? 'user' : 'assistant',
              content: m.text.substring(0, 17000)
            });
          });

          let aiLoopActive = true;
          let aiLoopCount = 0;
          let currentAiModel = '@cf/meta/llama-3.1-8b-instruct';
          let finalResponseText = "Could not finalize processing at this moment. Please retry.";

          while (aiLoopActive && aiLoopCount < 6) {
            aiLoopCount++;
            let aiRes;
            
            try {
              aiRes = await executeAiRequest(aiPromptMessages, currentAiModel);
            } catch (apiError) {
              if (currentAiModel !== '@cf/meta/llama-3.1-8b-instruct') {
                currentAiModel = '@cf/meta/llama-3.1-8b-instruct';
                aiRes = await executeAiRequest(aiPromptMessages, currentAiModel);
              } else {
                throw apiError;
              }
            }
            
            let responseText = aiRes.data.result.response.trim();

            if (responseText.includes("[Type SEARCH: About D'H7]")) {
              await logToAdmin('SEARCH', `About D'H7 requested by ${sender_tfid}`);
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              aiPromptMessages.push({ role: 'assistant', content: "[Type SEARCH: About D'H7]" });
              aiPromptMessages.push({ role: 'system', content: `## DH7_APP_DATA
- Accounts: Sign up at login screen (Needs: Name, Birth Year, lowercase fixed handle, password). CRITICAL: Passwords CANNOT be recovered.
- Login: Use TFID or adresse dh7.
- UI Actions: Header ••• (Profile Pic). Swipe left (Reply). Tap/hold (Copy/Delete for self).
- Formats & Limits: Text via input bar (max 70,000 chars, spaces excluded). Images/Videos/Files via + button.
- Platform Info: Web: https://dh7.adamdh7.org/ | App/APK: None published yet.` });
            } else if (responseText.includes("[Type SEARCH: Moderation Rules]")) {
              await logToAdmin('SEARCH', `Moderation Rules requested by ${sender_tfid}`);
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              aiPromptMessages.push({ role: 'assistant', content: "[Type SEARCH: Moderation Rules]" });
              aiPromptMessages.push({ role: 'system', content: `[DATA: RULES]
- A formal investigation is required before enforcing any sanctions. Proceed with [Type CHECK: TFID] first.
- SPAM penalty: Run [Type SPAM: TFID]. Restricts account for 24h. 3 spam actions = Auto-permanent BAN.
- BAN penalty: Run [Type BAN: TFID] for extreme violations only. Permaban.` });
            } else if (responseText.match(/\[Type CHECK:\s*([^\]]+)\]/i)) {
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              const match = responseText.match(/\[Type CHECK:\s*([^\]]+)\]/i);
              const targetId = match[1].trim();
              aiPromptMessages.push({ role: 'assistant', content: `[Type CHECK: ${targetId}]` });
              
              await logToAdmin('CHECK_INITIATED', `Checking messages for TFID: ${targetId} requested by ${sender_tfid}`);

              const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
              if (targetUserObj) {
                const histMsgs = await Message.find({
                  $or: [{ from: targetUserObj.tfid }, { to: targetUserObj.tfid }]
                }).sort({ time: -1 }).limit(100);
                let combinedText = histMsgs.map(m => `[${m.time}] From ${m.from} To ${m.to}: ${m.text}`).join('\n');
                if (combinedText.length > 15000) combinedText = combinedText.substring(0, 15000) + '...';
                
                await logToAdmin('CHECK_RESULT', `Retrieved ${histMsgs.length} messages for TFID: ${targetUserObj.tfid}`);
                aiPromptMessages.push({ role: 'system', content: `[INVESTIGATION LOGS FOR ${targetId}]:\n${combinedText || 'No logs.'}\nReview the logs carefully. State your conclusion or run punishment command strictly on a single line if warranted.` });
              } else {
                await logToAdmin('CHECK_FAILED', `User TFID: ${targetId} not found`);
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} not found.` });
              }
            } else if (responseText.match(/\[Type BAN:\s*([^\]]+)\]/i)) {
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              const match = responseText.match(/\[Type BAN:\s*([^\]]+)\]/i);
              const targetId = match[1].trim();
              aiPromptMessages.push({ role: 'assistant', content: `[Type BAN: ${targetId}]` });
              
              await logToAdmin('BAN_REQUEST', `Ban execution request for TFID: ${targetId} initiated by ${sender_tfid}`);

              const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
              if (targetUserObj) {
                if (targetUserObj.banned) {
                  await logToAdmin('BAN_DUPLICATE', `TFID: ${targetUserObj.tfid} is already banned`);
                  aiPromptMessages.push({ role: 'system', content: `User ${targetId} is already banned.` });
                } else {
                  await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { banned: true, bannedAt: new Date() } });
                  const banMsg = new Message({
                    from: 'TF-7777777',
                    to: targetUserObj.tfid,
                    text: `[{[Type BAN: ${targetUserObj.tfid}]}]`,
                    time: new Date().toISOString(),
                    read: false
                  });
                  await banMsg.save();
                  io.to(targetUserObj.tfid).emit('new_message', banMsg);
                  await logToAdmin('BAN_SUCCESS', `TFID: ${targetUserObj.tfid} has been permanently banned`);
                  
                  const noticeEng = `This is an official system notification. Your account ${targetUserObj.tfid} has been permanently banned due to severe violations of the D'H7 Community Guidelines. All functions are suspended.`;
                  await generateAiNotification(targetUserObj.tfid, noticeEng, `Banned for violation requested by ${sender_tfid}`);

                  aiPromptMessages.push({ role: 'system', content: `User ${targetId} has been successfully banned. Explain the reason to the requester.` });
                }
              } else {
                await logToAdmin('BAN_FAILED', `User TFID: ${targetId} not found`);
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} not found.` });
              }
            } else if (responseText.match(/\[Type SPAM:\s*([^\]]+)\]/i)) {
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              const match = responseText.match(/\[Type SPAM:\s*([^\]]+)\]/i);
              const targetId = match[1].trim();
              aiPromptMessages.push({ role: 'assistant', content: `[Type SPAM: ${targetId}]` });
              
              await logToAdmin('SPAM_REQUEST', `Spam block request for TFID: ${targetId} initiated by ${sender_tfid}`);

              const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
              if (targetUserObj) {
                const now = new Date();
                if (targetUserObj.spammedUntil && now < targetUserObj.spammedUntil) {
                  aiPromptMessages.push({ role: 'system', content: `User ${targetId} is already restricted.` });
                } else {
                  const unblockDate = new Date();
                  unblockDate.setHours(unblockDate.getHours() + 24);
                  const newSpamCount = (targetUserObj.spamCount || 0) + 1;
                  
                  if (newSpamCount >= 3) {
                    await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { banned: true, bannedAt: new Date(), spamCount: newSpamCount, lastSpammedAt: new Date() } });
                    const banMsg = new Message({
                      from: 'TF-7777777',
                      to: targetUserObj.tfid,
                      text: `[{[Type BAN: ${targetUserObj.tfid}]}]`,
                      time: new Date().toISOString(),
                      read: false
                    });
                    await banMsg.save();
                    io.to(targetUserObj.tfid).emit('new_message', banMsg);
                    await logToAdmin('BAN_SUCCESS_SPAM_LIMIT', `TFID: ${targetUserObj.tfid} automatically banned due to spam limit`);
                    
                    const noticeEng = `Your account ${targetUserObj.tfid} has been permanently banned after receiving 3 spam restrictions. Reason: Maximum spam threshold reached.`;
                    await generateAiNotification(targetUserObj.tfid, noticeEng, `Spam count: ${newSpamCount}/3`);

                    aiPromptMessages.push({ role: 'system', content: `User ${targetId} banned permanently (reached 3/3 spam count limit).` });
                  } else {
                    await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { spammedUntil: unblockDate, spamCount: newSpamCount, lastSpammedAt: new Date() } });
                    const spamMsg = new Message({
                      from: 'TF-7777777',
                      to: targetUserObj.tfid,
                      text: `[{[Type SPAM: ${targetUserObj.tfid}]}]`,
                      time: new Date().toISOString(),
                      read: false
                    });
                    await spamMsg.save();
                    io.to(targetUserObj.tfid).emit('new_message', spamMsg);
                    await logToAdmin('SPAM_SUCCESS', `TFID: ${targetUserObj.tfid} has been restricted for spam (24h)`);
                    
                    const noticeEng = `Your account ${targetUserObj.tfid} is temporarily restricted for 24 hours due to spamming behavior. Your limit is currently ${newSpamCount}/3.`;
                    await generateAiNotification(targetUserObj.tfid, noticeEng, `Spam count: ${newSpamCount}/3`);

                    aiPromptMessages.push({ role: 'system', content: `User ${targetId} restricted for 24 hours. Spam count: ${newSpamCount}/3.` });
                  }
                }
              } else {
                await logToAdmin('SPAM_FAILED', `User TFID: ${targetId} not found`);
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} not found.` });
              }
            } else if (responseText.match(/\[Type UNSPAM:\s*([^\]]+)\]/i)) {
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              const match = responseText.match(/\[Type UNSPAM:\s*([^\]]+)\]/i);
              const targetId = match[1].trim();
              aiPromptMessages.push({ role: 'assistant', content: `[Type UNSPAM: ${targetId}]` });
              await logToAdmin('UNSPAM_REQUEST', `Unspam block request for TFID: ${targetId} initiated by ${sender_tfid}`);

              const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
              if (targetUserObj) {
                await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { spammedUntil: null } });
                await Message.deleteMany({
                  from: 'TF-7777777',
                  to: targetUserObj.tfid,
                  text: `[{[Type SPAM: ${targetUserObj.tfid}]}]`
                });
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} has been successfully unspammed.` });
              } else {
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} not found.` });
              }
            } else if (responseText.match(/\[Type UNBAN:\s*([^\]]+)\]/i)) {
              currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
              const match = responseText.match(/\[Type UNBAN:\s*([^\]]+)\]/i);
              const targetId = match[1].trim();
              aiPromptMessages.push({ role: 'assistant', content: `[Type UNBAN: ${targetId}]` });
              await logToAdmin('UNBAN_REQUEST', `Unban block request for TFID: ${targetId} initiated by ${sender_tfid}`);

              const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
              if (targetUserObj) {
                await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { banned: false, bannedAt: null, spamCount: 0, lastSpammedAt: null, spammedUntil: null, logo: '' } });
                await Message.deleteMany({
                  $or: [{ from: targetUserObj.tfid }, { to: targetUserObj.tfid }]
                });
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} has been successfully unbanned and reset.` });
              } else {
                aiPromptMessages.push({ role: 'system', content: `User ${targetId} not found.` });
              }
            } else {
              finalResponseText = responseText;
              aiLoopActive = false;
            }

            if (aiLoopActive && aiLoopCount >= 5) {
              finalResponseText = responseText;
              aiLoopActive = false;
            }
          }
          
          const aiReply = new Message({
            from: 'TF-4352071',
            to: sender_tfid,
            text: finalResponseText,
            time: new Date(Date.now() + 10).toISOString(),
            read: false
          });
          await aiReply.save();
          io.to(sender_tfid).emit('new_message', aiReply);
          
        } catch (e) {
          const errorMsg = e.message ? ` (Internal system failure: ${e.message})` : '';
          const errorReply = new Message({
            from: 'TF-4352071',
            to: sender_tfid,
            text: "I cannot establish connection to the processing core engines right now." + errorMsg,
            time: new Date(Date.now() + 10).toISOString(),
            read: false
          });
          await errorReply.save();
          io.to(sender_tfid).emit('new_message', errorReply);
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
      read: false
    });
    await newMsg.save();
    
    io.to(receiver_tfid).emit('new_message', newMsg);
    io.to(sender_tfid).emit('message_sent_confirm', newMsg);
    
    await cleanupOldMessages();
    await checkStorageLimit();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: 'Internal Server Error' });
  }
});

app.post('/mark-read', async (req, res) => {
  try {
    const { sender_tfid, receiver_tfid } = req.body;
    
    const reader = await User.findOne({ tfid: receiver_tfid });
    if (reader && reader.readReceiptsEnabled === false) {
      return res.json({ success: true });
    }

    await Message.updateMany(
      { from: sender_tfid, to: receiver_tfid },
      { $set: { read: true } }
    );
    io.to(sender_tfid).emit('messages_read', { by: receiver_tfid });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: 'Internal Server Error' });
  }
});

app.get('/get/:page', async (req, res) => {
  try {
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
  } catch (e) {
    res.json({ batch: [], has_more: false });
  }
});

app.post('/sync', async (req, res) => {
  try {
    const { users: incomingUsers, messages: incomingMsgs } = req.body;
    
    if (incomingUsers && Array.isArray(incomingUsers)) {
      for (const u of incomingUsers) {
        const exists = await User.findOne({ tfid: u.tfid });
        if (!exists) {
          if (!u.logo || u.logo.trim() === '') {
            u.logo = generateDefaultLogo(u.prenom, u.nom);
          }
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
  } catch (e) {
    res.json({ success: false, error: 'Sync failed' });
  }
});

ensureStorageHealth().then(() => {
  server.listen(PORT, () => {
  });
});
