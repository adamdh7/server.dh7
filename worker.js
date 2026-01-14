export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const blankResponse = new Response('', { status: 200 });

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

    try {
      const origin = request.headers.get('Origin');
      if (!origin) {
        return blankResponse;
      }

      let originHost;
      try {
        const o = new URL(origin);
        originHost = o.hostname;
      } catch {
        return blankResponse;
      }

      const allowedOriginHosts = new Set([
        'teste777.pages.dev',
        'adamdh7.org',
        'sou.adamdh7.org',
        'ai.adamdh7.org',
        'dh7.adamdh7.org'
      ]);

      if (!allowedOriginHosts.has(originHost)) {
        return blankResponse;
      }

      if (method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          }
        });
      }

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

        const user = stripSensitive(results[0]);
        return createJsonResponse({ success: true, user });
      }

      if (path === '/register' && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return blankResponse;
        }

        let { nom, prenom, dh7, age, password } = body;
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

        try {
          await env.B1.prepare(`
            INSERT INTO users (dh7, nom, prenom, age, password)
            VALUES (?, ?, ?, ?, ?)
          `).bind(dh7, nom, prenom, age, password).run();
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
        while (attempts < 7) {
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

        return createJsonResponse({ success: true, user }, 201);
      }

      return blankResponse;
    } catch (err) {
      return blankResponse;
    }
  }
};
