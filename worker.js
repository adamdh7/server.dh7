export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

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

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      if (method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      const getChatId = (tfid1, tfid2) => {
        const sorted = [tfid1, tfid2].sort();
        return sorted.join('-');
      };

      const stripPassword = (user) => {
        if (user) delete user.password;
        return user;
      };

      const stripPasswords = (users) => {
        return users.map(u => {
          delete u.password;
          return u;
        });
      };

      if (path === '/login' && method === 'POST') {
        const body = await request.json();
        const { identifier, password } = body;
        if (!identifier || !password) return new Response('Missing fields', { status: 400, headers: corsHeaders });
        const { results } = await env.B1.prepare(`
          SELECT * FROM users WHERE (tfid = ? OR dh7 = ?) AND password = ?
        `).bind(identifier, identifier, password).all();
        if (results.length === 0) return new Response('Invalid credentials', { status: 401, headers: corsHeaders });
        return new Response(JSON.stringify(stripPassword(results[0])), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/register' && method === 'POST') {
        const body = await request.json();
        const { nom, prenom, dh7, age, password } = body;
        if (!nom || !prenom || !dh7 || !age || !password) return new Response('Missing fields', { status: 400, headers: corsHeaders });
        const tfid = crypto.randomUUID();
        await env.B1.prepare(`
          INSERT INTO users (tfid, dh7, nom, prenom, age, password, type, org_url, push_subscription)
          VALUES (?, ?, ?, ?, ?, ?, 'USER', NULL, NULL)
        `).bind(tfid, dh7, nom, prenom, age, password).run();
        const { results } = await env.B1.prepare('SELECT * FROM users WHERE tfid = ?').bind(tfid).all();
        return new Response(JSON.stringify(stripPassword(results[0])), {
          status: 201,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/users' && method === 'GET') {
        const { results } = await env.B1.prepare('SELECT * FROM users').all();
        return new Response(JSON.stringify(stripPasswords(results)), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/messages' && method === 'POST') {
        const body = await request.json();
        const { user1_tfid, user2_tfid } = body;
        if (!user1_tfid || !user2_tfid) return new Response('Missing tfids', { status: 400, headers: corsHeaders });
        const chat_id = getChatId(user1_tfid, user2_tfid);
        const { results } = await env.B1.prepare(`
          SELECT * FROM messages WHERE chat_id = ? ORDER BY time ASC
        `).bind(chat_id).all();
        return new Response(JSON.stringify(results), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/send' && method === 'POST') {
        const body = await request.json();
        const { sender_tfid, receiver_tfid, message } = body;
        if (!sender_tfid || !receiver_tfid || !message) return new Response('Missing fields', { status: 400, headers: corsHeaders });
        const chat_id = getChatId(sender_tfid, receiver_tfid);
        const time = new Date().toISOString();
        await env.B1.prepare(`
          INSERT INTO messages (chat_id, from_tfid, text, time, is_read)
          VALUES (?, ?, ?, ?, 0)
        `).bind(chat_id, sender_tfid, message, time).run();
        return new Response('Message sent', { status: 201, headers: corsHeaders });
      }

      if (path === '/mark-read' && method === 'POST') {
        const body = await request.json();
        const { sender_tfid, receiver_tfid } = body;
        if (!sender_tfid || !receiver_tfid) return new Response('Missing tfids', { status: 400, headers: corsHeaders });
        const chat_id = getChatId(sender_tfid, receiver_tfid);
        const { changes } = await env.B1.prepare(`
          UPDATE messages SET is_read = 1 WHERE chat_id = ? AND from_tfid = ?
        `).bind(chat_id, sender_tfid).run();
        return new Response(JSON.stringify({ updated: changes }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Endpoint not found', { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
  }
};
