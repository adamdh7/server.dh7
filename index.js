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

app.use(cors());
app.use(bodyParser.json());

async function initStorage() {
    await fs.ensureDir(DATA_DIR);
    if (!(await fs.pathExists(USERS_FILE))) await fs.writeJson(USERS_FILE, []);
    if (!(await fs.pathExists(MSGS_FILE))) await fs.writeJson(MSGS_FILE, []);
}

function generateTFID(existingUsers) {
    const existingTfids = new Set(existingUsers.map(u => u.tfid));
    let digits = 7;
    let attempts = 0;

    while (true) {
        let maxVal = Math.pow(10, digits);
        if (existingTfids.size >= maxVal * 0.9) {
            digits++;
            continue;
        }

        let num = Math.floor(Math.random() * maxVal).toString().padStart(digits, '0');
        let tfid = `TF-${num}`;

        if (!existingTfids.has(tfid)) {
            return tfid;
        }

        attempts++;
        if (attempts > 1000) digits++;
    }
}

app.post('/register', async (req, res) => {
    const { nom, prenom, dh7, age, password } = req.body;
    const users = await fs.readJson(USERS_FILE);

    if (users.find(u => u.dh7 === dh7)) {
        return res.json({ success: false, error: "ID DH7 déjà utilisé" });
    }

    const tfid = generateTFID(users);
    const newUser = { tfid, nom, prenom, dh7, age, password };
    users.push(newUser);

    await fs.writeJson(USERS_FILE, users);
    res.json({ success: true, tfid });
});

app.post('/login', async (req, res) => {
    const { identifier, password } = req.body;
    const users = await fs.readJson(USERS_FILE);
    const user = users.find(u => (u.tfid === identifier || u.dh7 === identifier) && u.password === password);

    if (user) {
        res.json({ success: true, user });
    } else {
        res.json({ success: false, error: "Identifiant ou mot de passe incorrect" });
    }
});

app.get('/users', async (req, res) => {
    const users = await fs.readJson(USERS_FILE);
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
});

app.post('/search', async (req, res) => {
    const { query } = req.body;
    const users = await fs.readJson(USERS_FILE);
    const results = users.filter(u =>
        u.nom.toLowerCase().includes(query.toLowerCase()) ||
        u.prenom.toLowerCase().includes(query.toLowerCase()) ||
        u.dh7.toLowerCase().includes(query.toLowerCase()) ||
        u.tfid.toLowerCase().includes(query.toLowerCase())
    );
    res.json({ results: results.map(({ password, ...u }) => u) });
});

app.post('/messages', async (req, res) => {
    const { user1_tfid, user2_tfid } = req.body;
    const msgs = await fs.readJson(MSGS_FILE);
    const filtered = msgs.filter(m =>
        (m.from === user1_tfid && m.to === user2_tfid) ||
        (m.from === user2_tfid && m.to === user1_tfid)
    );
    res.json(filtered);
});

app.post('/send', async (req, res) => {
    const { sender_tfid, receiver_tfid, message } = req.body;
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
    res.json({ success: true });
});

app.post('/mark-read', async (req, res) => {
    const { sender_tfid, receiver_tfid } = req.body;
    const msgs = await fs.readJson(MSGS_FILE);
    msgs.forEach(m => {
        if (m.from === sender_tfid && m.to === receiver_tfid) {
            m.read = true;
        }
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
    const batch = users.slice(start, end);
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
            if (!localUsers.find(lu => lu.tfid === u.tfid)) {
                localUsers.push(u);
            }
        });
        await fs.writeJson(USERS_FILE, localUsers);
    }

    if (incomingMsgs) {
        const localMsgs = await fs.readJson(MSGS_FILE);
        incomingMsgs.forEach(m => {
            if (!localMsgs.find(lm => lm.time === m.time && lm.from === m.from)) {
                localMsgs.push(m);
            }
        });
        await fs.writeJson(MSGS_FILE, localMsgs);
    }

    res.json({ success: true });
});

initStorage().then(() => {
    app.listen(PORT, () => {
        console.log(`Serveur DH7 actif sur le port ${PORT}`);
    });
});
