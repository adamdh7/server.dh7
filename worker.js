export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const blankResponse = new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title></title>
</head>
<body>
</body>
</html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });

    const createJsonResponse = (obj, status = 200) => {
      const origin = request.headers.get('Origin');
      const headers = {
        'Content-Type': 'application/json',
      };
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
      }
      return new Response(JSON.stringify(obj), { status, headers });
    };

    const createNoContentResponse = (status = 204) => {
      const origin = request.headers.get('Origin');
      const headers = {};
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
      }
      return new Response(null, { status, headers });
    };

    try {
      await env.B1.batch([
        env.B1.prepare(`
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT,
            from_tfid TEXT,
            text TEXT,
            time TEXT,
            is_read INTEGER DEFAULT 0
          )
        `),
        env.B1.prepare(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tfid TEXT UNIQUE,
            dh7 TEXT UNIQUE,
            nom TEXT,
            prenom TEXT,
            age INTEGER,
            password TEXT,
            type TEXT DEFAULT 'USER',
            org_url TEXT,
            push_subscription TEXT
          )
        `)
      ]);

      if (method === 'OPTIONS') {
        const origin = request.headers.get('Origin');
        if (!origin) {
          return new Response(null, { status: 204 });
        }
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          }
        });
      }

      const origin = request.headers.get('Origin');
      if (!origin) {
        return blankResponse;
      }

      let currentOriginNormalized;
      let originHost;
      try {
        const o = new URL(origin);
        currentOriginNormalized = o.origin;
        originHost = o.hostname;
      } catch {
        return blankResponse;
      }

      const allowedOriginHosts = new Set(['teste777.pages.dev', 'adamdh7.org', 'sou.adamdh7.org', 'ai.adamdh7.org', 'dh7.adamdh7.org']);
      const isMainOriginAllowed = allowedOriginHosts.has(originHost);

      const isOriginAllowedForUser = (user) => {
        if (!user) return false;
        if (user.org_url === null) {
          return isMainOriginAllowed;
        }
        return currentOriginNormalized === user.org_url;
      };

      const getChatId = (tfid1, tfid2) => {
        const sorted = [tfid1, tfid2].sort();
        return sorted.join('-');
      };

      const stripSensitive = (user) => {
        if (user) delete user.password;
        return user;
      };

      const stripSensitiveArray = (users) => {
        return users.map(u => {
          delete u.password;
          return u;
        });
      };

      const generateRandomTfid = () => {
        let number = '';
        for (let i = 0; i < 7; i++) {
          number += Math.floor(Math.random() * 9) + 1;
        }
        return `TF-${number}`;
      };

      const getUserByTfid = async (tfid) => {
        const { results } = await env.B1.prepare('SELECT * FROM users WHERE tfid = ?').bind(tfid).all();
        return results.length > 0 ? results[0] : null;
      };

      if (path === '/login' && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return blankResponse;
        }
        const { identifier, password } = body;
        if (!identifier || !password) {
          return createJsonResponse({ success: false, error: 'Missing identifier or password' }, 400);
        }
        const { results } = await env.B1.prepare(`
          SELECT * FROM users WHERE (tfid = ? OR dh7 = ?) AND password = ?
        `).bind(identifier, identifier, password).all();
        if (results.length === 0) {
          return createJsonResponse({ success: false, error: 'Invalid credentials' }, 401);
        }
        const user = results[0];
        if (!isOriginAllowedForUser(user)) {
          return createJsonResponse({ success: false, error: 'Invalid credentials' }, 401);
        }
        return createJsonResponse({ success: true, user: stripSensitive(user) });
      }

      if (path === '/register' && method === 'POST') {
        if (!isMainOriginAllowed) {
          return blankResponse;
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return blankResponse;
        }
        let { nom, prenom, dh7, age, password, org_url } = body;
        if (!nom || !prenom || !dh7 || !age || !password) {
          return createJsonResponse({ success: false, error: 'Missing fields' }, 400);
        }
        dh7 = dh7.toLowerCase().trim();
        if (!dh7.includes('@dh7.tf')) {
          dh7 += '@dh7.tf';
        }
        const username = dh7.replace('@dh7.tf', '');
        if (!/^[a-z0-9]+$/.test(username) || username.length === 0) {
          return createJsonResponse({ success: false, error: 'Invalid dh7 format: only lowercase letters and numbers allowed' }, 400);
        }
        dh7 = username + '@dh7.tf';
        const storedOrgUrl = org_url ? new URL(org_url).origin : currentOriginNormalized;
        try {
          await env.B1.prepare(`
            INSERT INTO users (dh7, nom, prenom, age, password, org_url)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(dh7, nom, prenom, age, password, storedOrgUrl).run();
        } catch (e) {
          if (e.message.includes('UNIQUE')) {
            return createJsonResponse({ success: false, error: 'dh7 already exists' }, 409);
          }
          throw e;
        }
        const { results: idResults } = await env.B1.prepare('SELECT last_insert_rowid() AS new_id').all();
        const newId = idResults[0].new_id;
        let tfid;
        let attempts = 0;
        while (attempts < 50) {
          tfid = generateRandomTfid();
          try {
            await env.B1.prepare('UPDATE users SET tfid = ? WHERE id = ?').bind(tfid, newId).run();
            break;
          } catch (e) {
            if (e.message.includes('UNIQUE constraint failed: users.tfid')) {
              attempts++;
              continue;
            }
            throw e;
          }
        }
        if (attempts >= 50) {
          return createJsonResponse({ success: false, error: 'Unable to generate unique tfid' }, 500);
        }
        const { results } = await env.B1.prepare('SELECT * FROM users WHERE id = ?').bind(newId).all();
        const user = stripSensitive(results[0]);
        return createJsonResponse({ success: true, tfid, user }, 201);
      }

      if (path === '/users' && method === 'GET') {
        if (!isMainOriginAllowed) {
          return blankResponse;
        }
        const { results } = await env.B1.prepare('SELECT * FROM users').all();
        return createJsonResponse(stripSensitiveArray(results));
      }

      if (path === '/messages' && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return blankResponse;
        }
        const { user1_tfid, user2_tfid } = body;
        if (!user1_tfid || !user2_tfid) {
          return blankResponse;
        }
        const user = await getUserByTfid(user1_tfid);
        if (!user || !isOriginAllowedForUser(user)) {
          return blankResponse;
        }
        const chat_id = getChatId(user1_tfid, user2_tfid);
        const { results } = await env.B1.prepare(`
          SELECT id, chat_id, from_tfid AS "from", text, time, is_read AS read FROM messages WHERE chat_id = ? ORDER BY time ASC
        `).bind(chat_id).all();
        return createJsonResponse(results);
      }

      if (path === '/send' && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return blankResponse;
        }
        const { sender_tfid, receiver_tfid, message } = body;
        if (!sender_tfid || !receiver_tfid || !message) {
          return blankResponse;
        }
        const user = await getUserByTfid(sender_tfid);
        if (!user || !isOriginAllowedForUser(user)) {
          return blankResponse;
        }
        const chat_id = getChatId(sender_tfid, receiver_tfid);
        const time = new Date().toISOString();
        await env.B1.prepare(`
          INSERT INTO messages (chat_id, from_tfid, text, time, is_read)
          VALUES (?, ?, ?, ?, 0)
        `).bind(chat_id, sender_tfid, message, time).run();
        return createNoContentResponse(201);
      }

      if (path === '/mark-read' && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return blankResponse;
        }
        const { sender_tfid, receiver_tfid } = body;
        if (!sender_tfid || !receiver_tfid) {
          return blankResponse;
        }
        const user = await getUserByTfid(receiver_tfid);
        if (!user || !isOriginAllowedForUser(user)) {
          return blankResponse;
        }
        if (user.org_url !== null) {
          return createJsonResponse({ success: false, error: 'Operation not allowed for org users' }, 403);
        }
        const chat_id = getChatId(sender_tfid, receiver_tfid);
        await env.B1.prepare(`
          UPDATE messages SET is_read = 1 WHERE chat_id = ? AND from_tfid = ? AND is_read = 0
        `).bind(chat_id, sender_tfid).run();
        return createNoContentResponse(200);
      }

      return blankResponse;
    } catch (err) {
      return blankResponse;
    }
  }
};
