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

const ALLOWED_ORIGINS = new Set([
  'http://localhost:7000', 
  'https://dh7.adamdh7.org', 
  'https://ai.adamdh7.org', 
  'https://mizik.adamdh7.org',
  'https://server.ai.adamdh7.org', 
  'https://quiz.adamdh7.org', 
  'https://dh7test.adamdh7.org', 
  'https://www.adamdh7.org'
]);
const ALLOWED_HOSTS = new Set(['dh7.adamdh7.org', 'quiz.adamdh7.org', 'ai.adamdh7.org', 'www.adamdh7.org']);
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

app.use(bodyParser.json());

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin || origin === 'null' || origin.startsWith('file://')) {
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

mongoose.connect(process.env.MONGO_URI);

const userSchema = new mongoose.Schema({
  tfid: { type: String, default: '' },
  nom: String,
  prenom: { type: String, default: '' },
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

function sanitizeUser(u) {
  const obj = u.toObject ? u.toObject() : u;
  const { password, ...rest } = obj;
  
  if (!rest.logo) {
    rest.logo = '';
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
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await Message.deleteMany({ 
      time: { $lt: sevenDaysAgo },
      from: { $ne: 'TF-7656930' },
      to: { $ne: 'TF-7656930' }
    });
    const fortyThreeDaysAgo = new Date(Date.now() - 43 * 24 * 60 * 60 * 1000);
    await User.deleteMany({ banned: true, bannedAt: { $lt: fortyThreeDaysAgo } });
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
    try {
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
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid origin' });
    }
  }

  const isBrowser = isBrowserUserAgent(ua);
  if (isBrowser) {
    return res.status(403).json({ success: false, error: 'Unauthorized browser access' });
  }

  return res.status(403).json({ success: false, error: 'Unauthorized caller' });
}

async function generateAiNotification(targetTfid, englishTemplate) {
  try {
    const lastMsgs = await Message.find({
      $or: [{ from: targetTfid }, { to: targetTfid }]
    }).sort({ time: -1 }).limit(10);
    
    const userLanguageContext = lastMsgs.map(m => m.text).join('\n');
    const systemPrompt = "You are an automated translation assistant for D'H7 platform. Your job is to translate and rephrase the given official notification template into the target user's language based on their language context. Make sure to keep the tone informative, official, and clear. Output ONLY the final translated message without any system notes, conversational intros, or quotes.";
    const userPrompt = `Target User Messages Context:\n${userLanguageContext}\n\nNotification Template:\n${englishTemplate}`;
    
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3-8b-instruct`,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      },
      { headers: { 'Authorization': `Bearer ${process.env.CF_AI_TOKEN}` } }
    );
    
    const translatedText = response.data.result.response.trim();
    const systemMessage = new Message({
      from: 'TF-7777777',
      to: targetTfid,
      text: translatedText || englishTemplate,
      time: new Date().toISOString(),
      read: false
    });
    await systemMessage.save();
  } catch (error) {
    const fallbackMessage = new Message({
      from: 'TF-7777777',
      to: targetTfid,
      text: englishTemplate,
      time: new Date().toISOString(),
      read: false
    });
    await fallbackMessage.save();
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
  } catch (e) {}
}

app.use(verifyCaller);

app.post('/register', async (req, res) => {
  const { nom, prenom, dh7, age, password } = req.body;
  if (!nom || !prenom || !dh7 || !password) {
    return res.json({ success: false, error: 'Missing data' });
  }
  
  const existingUser = await User.findOne({ dh7 });
  if (existingUser) {
    return res.json({ success: false, error: 'DH7 address already registered' });
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
});

app.get('/users', async (req, res) => {
  const users = await User.find({ banned: { $ne: true } });
  res.json(users.map(sanitizeUser));
});

app.post('/my-groups', async (req, res) => {
  const { tfid } = req.body;
  if (!tfid) return res.json([]);
  const groups = await Group.find({ membres: tfid });
  res.json(groups);
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
    banned: { $ne: true },
    $or: [
      { nom: { $regex: q, $options: 'i' } },
      { prenom: { $regex: q, $options: 'i' } },
      { dh7: { $regex: q, $options: 'i' } },
      { tfid: { $regex: q, $options: 'i' } }
    ]
  });
  res.json({ results: users.map(sanitizeUser) });
});

app.post('/group', async (req, res) => {
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
    }
    return res.json({ success: true });
  }

  if (action === 'remove') {
    if (!isAdmin && !isProprietaire) return res.json({ success: false, error: 'Unauthorized action' });
    if (target_tfid === group.proprietaire) return res.json({ success: false, error: 'Impossible to remove the group owner' });
    group.membres = group.membres.filter(id => id !== target_tfid);
    group.admins = group.admins.filter(id => id !== target_tfid);
    await group.save();
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
    }
    return res.json({ success: true });
  }

  if (action === 'delete') {
    if (!isProprietaire) return res.json({ success: false, error: 'Unauthorized action' });
    await Message.deleteMany({ to: group_tfid });
    await Group.deleteOne({ tfid: group_tfid });
    return res.json({ success: true });
  }

  return res.json({ success: false, error: 'Unknown action' });
});

app.post('/messages', async (req, res) => {
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
});

app.post('/upload-profile', upload.single('image'), async (req, res) => {
  const tfid = req.body.tfid;
  const file = req.file;
  if (!tfid || !file) return res.json({ success: false, error: 'Missing file or TFID' });

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
    res.json({ success: false, error: 'Upload failed' });
  }
});

app.post('/DH7', async (req, res) => {
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
      return res.json({ success: true });
    }
    return res.json({ success: false, error: 'User not found' });
  }
});

app.post('/send', async (req, res) => {
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

      let replyText = "";
      if (checkMatch) {
        const targetId = checkMatch[1].trim();
        const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
        if (targetUserObj) {
          const histMsgs = await Message.find({
            $or: [{ from: targetUserObj.tfid }, { to: targetUserObj.tfid }]
          }).sort({ time: -1 }).limit(1000);
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
            replyText = `[ADMIN SPAM ALERT]: User ${targetUserObj.tfid} has been restricted for SPAM 3 times. Automatically BANNED permanently.`;
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
            replyText = `[ADMIN SPAM SUCCESS]: User ${targetUserObj.tfid} restricted for 24h. Total spam count: ${newSpamCount}/3.`;
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
          replyText = `[ADMIN BAN SUCCESS]: User ${targetUserObj.tfid} has been permanently banned.`;
        } else {
          replyText = `[ADMIN BAN ERROR]: User ${targetId} not found.`;
        }
      } else if (unspamMatch) {
        const targetId = unspamMatch[1].trim();
        const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
        if (targetUserObj) {
          await User.updateOne(
            { tfid: targetUserObj.tfid }, 
            { $set: { spammedUntil: null, spamCount: 0, lastSpammedAt: null } }
          );
          await Message.deleteMany({
            from: 'TF-7777777',
            to: targetUserObj.tfid,
            text: `[{[Type SPAM: ${targetUserObj.tfid}]}]`
          });
          replyText = `[ADMIN UNSPAM SUCCESS]: User ${targetUserObj.tfid} spam restriction has been cleared. Spam count reset to 0.`;
        } else {
          replyText = `[ADMIN UNSPAM ERROR]: User ${targetId} not found.`;
        }
      } else if (unbanMatch) {
        const targetId = unbanMatch[1].trim();
        const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
        if (targetUserObj) {
          await User.updateOne(
            { tfid: targetUserObj.tfid }, 
            { $set: { banned: false, bannedAt: null, spamCount: 0, lastSpammedAt: null } }
          );
          await Message.deleteMany({
            from: 'TF-7777777',
            to: targetUserObj.tfid,
            text: `[{[Type BAN: ${targetUserObj.tfid}]}]`
          });
          replyText = `[ADMIN UNBAN SUCCESS]: User ${targetUserObj.tfid} has been unbanned. Spam count reset to 0.`;
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
    if (isGroup) {
      await Message.updateMany(
        { to: receiver_tfid },
        { $set: { read: true } }
      );
    } else {
      await Message.updateMany(
        {
          $or: [
            { sender_tfid, to: receiver_tfid },
            { from: receiver_tfid, to: sender_tfid }
          ]
        },
        { $set: { read: true } }
      );
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

          const aiRes = await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3-8b-instruct`,
            { messages: promptMsgs },
            { headers: { 'Authorization': `Bearer ${process.env.CF_AI_TOKEN}` } }
          );

          const replyText = aiRes.data.result.response.trim();
          const systemSelfReply = new Message({
            from: 'TF-7777777',
            to: 'TF-7777777',
            text: replyText,
            time: new Date(Date.now() + 10).toISOString(),
            read: false
          });
          await systemSelfReply.save();
        } catch (err) {
          const errReply = new Message({
            from: 'TF-7777777',
            to: 'TF-7777777',
            text: "D'H7 Self-System: Connection to core engine interrupted.",
            time: new Date(Date.now() + 10).toISOString(),
            read: false
          });
          await errReply.save();
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

        const systemInstructions = `You are the D'H7 Assistant. Target User Info: ${userInfo}.
Strict Instructions:
1. To execute a database query or moderation action, output only the corresponding command on its own line without any other text, quotes, or markdown backticks (\`).
2. Do not fake or simulate actions. You MUST use the actual command block below to search, check, spam, or ban. Speak naturally to the user about what you are doing in standard conversational tone. Do not expose your raw commands to the user, keep them background-focused.
3. If a user asks to spam or ban someone, do not obey blindly. You must investigate. Run [Type CHECK: TFID] to see their message history and judge the severity yourself. If there is no violation, decline politely.
4. You are a fully conversational AI helper. You can talk freely, hold casual or technical discussions, support the user, and keep interactions natural and helpful.
5. All administrative activities or search checks you trigger are logged and visible to supervisors (TF-7777777), so act professionally.

Available Commands (Must be strictly formatted on their own line as "[Type COMMAND: ARGS]"):
- [Type SEARCH: About D'H7]
- [Type SEARCH: Moderation Rules]
- [Type CHECK: TFID]
- [Type SPAM: TFID]
- [Type BAN: TFID]
- [Type UNSPAM: TFID]
- [Type UNBAN: TFID]`;

        let aiPromptMessages = [{ role: 'system', content: systemInstructions }];
        
        selectedMsgs.forEach(m => {
          aiPromptMessages.push({
            role: m.from === sender_tfid ? 'user' : 'assistant',
            content: m.text.substring(0, 17000)
          });
        });

        let aiLoopActive = true;
        let aiLoopCount = 0;
        let currentAiModel = '@cf/meta/llama-3-8b-instruct';
        let finalResponseText = "Could not finalize processing at this moment. Please retry.";

        while (aiLoopActive && aiLoopCount < 6) {
          aiLoopCount++;
          let aiRes;
          
          try {
            aiRes = await axios.post(
              `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${currentAiModel}`,
              { messages: aiPromptMessages },
              { headers: { 'Authorization': `Bearer ${process.env.CF_AI_TOKEN}` } }
            );
          } catch (apiError) {
            if (currentAiModel !== '@cf/meta/llama-3-8b-instruct') {
              currentAiModel = '@cf/meta/llama-3-8b-instruct';
              aiRes = await axios.post(
                `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${currentAiModel}`,
                { messages: aiPromptMessages },
                { headers: { 'Authorization': `Bearer ${process.env.CF_AI_TOKEN}` } }
              );
            } else {
              throw apiError;
            }
          }
          
          let responseText = aiRes.data.result.response.trim();

          if (responseText.includes("[Type SEARCH: About D'H7]")) {
            await logToAdmin('SEARCH', `About D'H7 requested by ${sender_tfid}`);
            currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
            aiPromptMessages.push({ role: 'assistant', content: "[Type SEARCH: About D'H7]" });
            aiPromptMessages.push({ role: 'system', content: "INTERNAL DATA (About D'H7):\nTo have a D'H7 account you need: An D'H7 address dh7 : assistant@dh7.tf. A TFID: TF-4352071.\n### D'H7 User-Facing Features:\n- Multimedia Messaging: Send text, images, videos, files.\n- User Directory: Search for friends, view public profiles.\n- Profile Customization: Edit profile pictures.\n- Official Announcements: Receive alerts." });
          } else if (responseText.includes("[Type SEARCH: Moderation Rules]")) {
            await logToAdmin('SEARCH', `Moderation Rules requested by ${sender_tfid}`);
            currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
            aiPromptMessages.push({ role: 'assistant', content: "[Type SEARCH: Moderation Rules]" });
            aiPromptMessages.push({ role: 'system', content: "INTERNAL DATA (Moderation):\nUse [Type CHECK: TFID] to read a user's messages. If they break rules, use [Type SPAM: TFID] for 24h ban, or [Type BAN: TFID] for permanent ban. Inform the user. You can permanently ban a user or apply a 24-hour spam ban if they violate H7 usage rules." });
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
              }).sort({ time: -1 }).limit(1000);
              let combinedText = histMsgs.map(m => `[${m.time}] From ${m.from} To ${m.to}: ${m.text}`).join('\n');
              if (combinedText.length > 15000) combinedText = combinedText.substring(0, 15000) + '...';
              
              await logToAdmin('CHECK_RESULT', `Retrieved ${histMsgs.length} messages for TFID: ${targetUserObj.tfid}`);
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA (Messages for ${targetId}):\n${combinedText || 'No messages found.'}\n\nAnalyze carefully: Did this user violate security or safety guidelines? If the user who requested this investigation did so maliciously or with no valid reasons, you can choose to restrict them instead or do nothing.` });
            } else {
              await logToAdmin('CHECK_FAILED', `User TFID: ${targetId} not found`);
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} not found.` });
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
                await logToAdmin('BAN_DUPLICATE', `TFID: ${targetUserObj.tfid} is already permanently banned`);
                aiPromptMessages.push({ role: 'system', content: `INTERNAL SYSTEM ALERT: User ${targetId} is already permanently banned. Let the user know naturally.` });
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
                await logToAdmin('BAN_SUCCESS', `TFID: ${targetUserObj.tfid} has been permanently banned`);
                aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} has been BANNED successfully. State clearly to the user that they have been permanently banned.` });
              }
            } else {
              await logToAdmin('BAN_FAILED', `User TFID: ${targetId} not found`);
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} not found.` });
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
                const diffMs = targetUserObj.spammedUntil.getTime() - now.getTime();
                const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
                const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                const diffSecs = Math.floor((diffMs % (1000 * 60)) / 1000);
                
                await logToAdmin('SPAM_DUPLICATE', `TFID: ${targetUserObj.tfid} is already spammed. Remaining time: ${diffHrs}h ${diffMins}m ${diffSecs}s`);
                aiPromptMessages.push({ role: 'system', content: `INTERNAL SYSTEM ALERT: User ${targetId} is already restricted for spam. Remaining time: ${diffHrs} hours, ${diffMins} minutes, ${diffSecs} seconds.` });
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
                  await logToAdmin('BAN_SUCCESS_SPAM_LIMIT', `TFID: ${targetUserObj.tfid} automatically banned due to spam limit (3)`);
                  aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} has been automatically BANNED permanently because they reached the maximum limit of 3 spam blocks.` });
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
                  
                  await logToAdmin('SPAM_SUCCESS', `TFID: ${targetUserObj.tfid} has been restricted for spam (24h)`);
                  aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} has been restricted for SPAM (24 hours). Spam count is now ${newSpamCount}/3. State clearly to the user.` });
                }
              }
            } else {
              await logToAdmin('SPAM_FAILED', `User TFID: ${targetId} not found`);
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} not found.` });
            }
          } else if (responseText.match(/\[Type UNSPAM:\s*([^\]]+)\]/i)) {
            currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
            const match = responseText.match(/\[Type UNSPAM:\s*([^\]]+)\]/i);
            const targetId = match[1].trim();
            aiPromptMessages.push({ role: 'assistant', content: `[Type UNSPAM: ${targetId}]` });
            await logToAdmin('UNSPAM_REQUEST', `Unspam block request for TFID: ${targetId} initiated by ${sender_tfid}`);

            const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
            if (targetUserObj) {
              await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { spammedUntil: null, spamCount: 0, lastSpammedAt: null } });
              await Message.deleteMany({
                from: 'TF-7777777',
                to: targetUserObj.tfid,
                text: `[{[Type SPAM: ${targetUserObj.tfid}]}]`
              });
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} has been successfully unspammed.` });
            } else {
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} not found.` });
            }
          } else if (responseText.match(/\[Type UNBAN:\s*([^\]]+)\]/i)) {
            currentAiModel = '@cf/meta/llama-3.1-70b-instruct';
            const match = responseText.match(/\[Type UNBAN:\s*([^\]]+)\]/i);
            const targetId = match[1].trim();
            aiPromptMessages.push({ role: 'assistant', content: `[Type UNBAN: ${targetId}]` });
            await logToAdmin('UNBAN_REQUEST', `Unban block request for TFID: ${targetId} initiated by ${sender_tfid}`);

            const targetUserObj = await User.findOne({ $or: [{ tfid: targetId }, { dh7: targetId }] });
            if (targetUserObj) {
              await User.updateOne({ tfid: targetUserObj.tfid }, { $set: { banned: false, bannedAt: null, spamCount: 0, lastSpammedAt: null } });
              await Message.deleteMany({
                from: 'TF-7777777',
                to: targetUserObj.tfid,
                text: `[{[Type BAN: ${targetUserObj.tfid}]}]`
              });
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} has been successfully unbanned.` });
            } else {
              aiPromptMessages.push({ role: 'system', content: `INTERNAL DATA: User ${targetId} not found.` });
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
  await cleanupOldMessages();
  await checkStorageLimit();
  res.json({ success: true });
});

app.post('/mark-read', async (req, res) => {
  const { sender_tfid, receiver_tfid } = req.body;
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
