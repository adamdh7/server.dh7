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

      const origin = request.headers.get('Origin');
      const allowedHosts = ['teste777.pages.dev', 'adamdh7.org', 'ai.adamdh7.org', 'dh7.adamdh7.org'];
      let originHost = null;
      if (origin) {
        try {
          originHost = new URL(origin).hostname;
        } catch {}
      }
      const isAllowedOrigin = !origin || allowedHosts.includes(originHost);

      const getChatId = (tfid1, tfid2) => {
        const sorted = [tfid1, tfid2].sort();
        return sorted.join('-');
      };

      const stripSensitive = (user) => {
        if (user) delete user.password;
        return user;
      };

      const generateRandomTfid = () => {
        let number = '';
        for (let i = 0; i < 7; i++) {
          number += Math.floor(Math.random() * 9) + 1;
        }
        return `TF-${number}`;
      };

      const isOrgUser = async (tfid) => {
        const { results } = await env.B1.prepare('SELECT org_url FROM users WHERE tfid = ?').bind(tfid).all();
        return results.length > 0 && results[0].org_url !== null;
      };

      if (path === '/login' && method === 'POST') {
        const body = await request.json();
        const { identifier, password } = body;
        if (!identifier || !password) return new Response(JSON.stringify({ success: false, error: 'Missing identifier or password' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { results } = await env.B1.prepare(`
          SELECT * FROM users WHERE (tfid = ? OR dh7 = ?) AND password = ?
        `).bind(identifier, identifier, password).all();
        if (results.length === 0) return new Response(JSON.stringify({ success: false, error: 'Invalid credentials' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ success: true, user: stripSensitive(results[0]) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/register' && method === 'POST') {
        if (!isAllowedOrigin) {
          return new Response(JSON.stringify({ success: false, error: 'Forbidden: invalid origin' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const body = await request.json();
        let { nom, prenom, dh7, age, password, org_url } = body;
        if (!nom || !prenom || !dh7 || !age || !password) return new Response(JSON.stringify({ success: false, error: 'Missing fields' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        dh7 = dh7.toLowerCase().trim();
        if (!dh7.includes('@dh7.tf')) {
          dh7 += '@dh7.tf';
        }
        const username = dh7.replace('@dh7.tf', '');
        if (!/^[a-z0-9]+$/.test(username) || username.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid dh7 format: only lowercase letters and numbers allowed' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        dh7 = username + '@dh7.tf';

        try {
          await env.B1.prepare(`
            INSERT INTO users (dh7, nom, prenom, age, password, org_url)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(dh7, nom, prenom, age, password, org_url || null).run();
        } catch (e) {
          if (e.message.includes('UNIQUE')) return new Response(JSON.stringify({ success: false, error: 'dh7 already exists' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
        if (attempts >= 50) return new Response(JSON.stringify({ success: false, error: 'Unable to generate unique tfid' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const { results } = await env.B1.prepare('SELECT * FROM users WHERE id = ?').bind(newId).all();
        const user = stripSensitive(results[0]);
        return new Response(JSON.stringify({ success: true, tfid, user }), {
          status: 201,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/subscribe' && method === 'POST') {
        const body = await request.json();
        const { tfid, subscription } = body;
        if (!tfid || !subscription) return new Response(JSON.stringify({ success: false, error: 'Missing tfid or subscription' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        if (await isOrgUser(tfid)) return new Response(JSON.stringify({ success: false, error: 'Operation not allowed for org users' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { changes } = await env.B1.prepare(`
          UPDATE users SET push_subscription = ? WHERE tfid = ?
        `).bind(JSON.stringify(subscription), tfid).run();
        if (changes === 0) return new Response(JSON.stringify({ success: false, error: 'User not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (path === '/messages' && method === 'POST') {
        const body = await request.json();
        const { user1_tfid, user2_tfid } = body;
        if (!user1_tfid || !user2_tfid) return new Response(JSON.stringify({ success: false, error: 'Missing tfids' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const chat_id = getChatId(user1_tfid, user2_tfid);
        const { results } = await env.B1.prepare(`
          SELECT * FROM messages WHERE chat_id = ? ORDER BY time ASC
        `).bind(chat_id).all();
        return new Response(JSON.stringify({ success: true, messages: results }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/send' && method === 'POST') {
        const body = await request.json();
        const { sender_tfid, receiver_tfid, message } = body;
        if (!sender_tfid || !receiver_tfid || !message) return new Response(JSON.stringify({ success: false, error: 'Missing fields' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const chat_id = getChatId(sender_tfid, receiver_tfid);
        const time = new Date().toISOString();
        await env.B1.prepare(`
          INSERT INTO messages (chat_id, from_tfid, text, time, is_read)
          VALUES (?, ?, ?, ?, 0)
        `).bind(chat_id, sender_tfid, message, time).run();
        return new Response(JSON.stringify({ success: true }), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (path === '/mark-read' && method === 'POST') {
        const body = await request.json();
        const { sender_tfid, receiver_tfid } = body;
        if (!sender_tfid || !receiver_tfid) return new Response(JSON.stringify({ success: false, error: 'Missing tfids' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        if (await isOrgUser(receiver_tfid)) return new Response(JSON.stringify({ success: false, error: 'Operation not allowed for org users' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const chat_id = getChatId(sender_tfid, receiver_tfid);
        const { changes } = await env.B1.prepare(`
          UPDATE messages SET is_read = 1 WHERE chat_id = ? AND from_tfid = ? AND is_read = 0
        `).bind(chat_id, sender_tfid).run();
        return new Response(JSON.stringify({ success: true, marked_as_read: changes }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ success: false, error: 'Endpoint not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }
};
