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
        originHost = new URL(origin).hostname;
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

      const generateRandomTfid = () => {
        let number = '';
        for (let i = 0; i < 7; i++) {
          number += Math.floor(Math.random() * 9) + 1;
        }
        return `TF-${number}`;
      };

      if (path === '/login' && method === 'POST') {
        const body = await request.json().catch(() => null);
        if (body === null) {
          return blankResponse;
        }

        const { identifier, password } = body;
        if (!identifier || !password) {
          return createJsonResponse({ success: false, error: 'Missing identifier or password' }, 400);
        }

        const { results } = await env.B1.prepare(`
          SELECT id, nom, prenom, dh7, age, tfid, password
          FROM users
          WHERE (tfid = ? OR dh7 = ?) AND password = ?
          LIMIT 1
        `).bind(identifier, identifier, password).all();

        if (results.length === 0) {
          return createJsonResponse({ success: false, error: 'Invalid credentials' }, 401);
        }

        const { password: _, ...user } = results[0];
        return createJsonResponse({ success: true, user });
      }

      if (path === '/register' && method === 'POST') {
        const body = await request.json().catch(() => null);
        if (body === null) {
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

        let tfid;
        let attempts = 0;
        let newId;

        while (attempts < 50) {
          tfid = generateRandomTfid();
          try {
            await env.B1.prepare(`
              INSERT INTO users (dh7, nom, prenom, age, password, tfid)
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(dh7, nom, prenom, age, password, tfid).run();

            const { results: idResults } = await env.B1.prepare(
              'SELECT last_insert_rowid() AS id'
            ).all();
            newId = idResults[0].id;
            break;
          } catch (e) {
            if (e.message.includes('UNIQUE constraint failed: users.dh7')) {
              return createJsonResponse({ success: false, error: 'dh7 already exists' }, 409);
            }
            if (e.message.includes('UNIQUE constraint failed: users.tfid')) {
              attempts++;
              continue;
            }
            throw e;
          }
        }

        if (attempts >= 50) {
          return createJsonResponse({ success: false, error: 'Unable to generate tfid' }, 500);
        }

        const user = {
          id: newId,
          nom,
          prenom,
          dh7,
          age,
          tfid
        };

        return createJsonResponse({ success: true, user }, 201);
      }

      return blankResponse;
    } catch (err) {
      return blankResponse;
    }
  }
};
