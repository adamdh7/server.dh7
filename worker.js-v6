export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const createBlankResponse = () => new Response('', { status: 200 });

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
        return createBlankResponse();
      }

      let originHost;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        return createBlankResponse();
      }

      const allowedOriginHosts = new Set([
        'teste777.pages.dev',
        'adamdh7.org',
        'sou.adamdh7.org',
        'ai.adamdh7.org',
        'dh7.adamdh7.org'
      ]);

      if (!allowedOriginHosts.has(originHost)) {
        return createBlankResponse();
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
        const number = Math.floor(Math.random() * 8888889) + 1111111;
        return `TF-${number}`;
      };

      if (path === '/login' && method === 'POST') {
        const body = await request.json().catch(() => null);
        if (body === null) {
          return createBlankResponse();
        }

        const { identifier, password } = body;
        if (!identifier || !password) {
          return createJsonResponse({ success: false, error: 'Missing identifier or password' }, 400);
        }

        const { results } = await env.B1.prepare(`
          SELECT id, nom, prenom, dh7, age, tfid
          FROM users
          WHERE (tfid = ? OR dh7 = ?) AND password = ?
          LIMIT 1
        `).bind(identifier, identifier, password).all();

        if (results.length === 0) {
          return createJsonResponse({ success: false, error: 'Invalid credentials' }, 401);
        }

        const user = results[0];
        return createJsonResponse({ success: true, user });
      }

      if (path === '/register' && method === 'POST') {
        const body = await request.json().catch(() => null);
        if (body === null) {
          return createBlankResponse();
        }

        let { nom, prenom, dh7, age, password } = body;
        if (!nom || !prenom || !dh7 || !age || !password) {
          return createJsonResponse({ success: false, error: 'Missing fields' }, 400);
        }

        dh7 = (dh7 ?? '').toLowerCase().trim().replace(/@dh7\.tf$/i, '') + '@dh7.tf';

        const username = dh7.slice(0, -8);
        if (username === '' || !/^[a-z0-9]+$/.test(username)) {
          return createJsonResponse({ success: false, error: 'Invalid dh7 format: only lowercase letters and numbers allowed' }, 400);
        }

        let attempts = 0;
        let user;

        while (attempts < 50) {
          const tfid = generateRandomTfid();

          try {
            const { results } = await env.B1.prepare(`
              INSERT INTO users (dh7, nom, prenom, age, password, tfid)
              VALUES (?, ?, ?, ?, ?, ?)
              RETURNING id, nom, prenom, dh7, age, tfid
            `).bind(dh7, nom, prenom, age, password, tfid).all();

            user = results[0];
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
          return createJsonResponse({ success: false, error: 'Unable to generate unique tfid' }, 500);
        }

        return createJsonResponse({ success: true, user }, 201);
      }

      return createBlankResponse();
    } catch (err) {
      return createBlankResponse();
    }
  }
};
