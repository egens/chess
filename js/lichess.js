// Minimal lichess.org client for the Board API: OAuth2 PKCE login (no app registration needed),
// NDJSON event/game streams and game actions. Docs: https://lichess.org/api
const HOST = 'https://lichess.org';
const CLIENT_ID = 'voxel-chess';
const SCOPES = 'board:play challenge:read challenge:write';
const TOKEN_KEY = 'lichess-token';

const store = {
  get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
  set(area, k, v) { try { window[area].setItem(k, v); } catch { /* storage blocked */ } },
  del(area, k) { try { window[area].removeItem(k); } catch { /* storage blocked */ } },
};

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => location.origin + location.pathname;

export async function readNdjson(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
  if (buf.trim()) onLine(JSON.parse(buf));
}

export class Lichess {
  constructor() {
    this.token = store.get('localStorage', TOKEN_KEY);
    this.me = null;
  }

  get loggedIn() { return !!this.token; }

  async login() {
    const verifier = randomString(48);
    const state = randomString(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set('sessionStorage', 'lichess-verifier', verifier);
    store.set('sessionStorage', 'lichess-state', state);
    const q = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(), scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, state,
    });
    location.href = `${HOST}/oauth?${q}`;
  }

  // Finishes the OAuth redirect if the page was opened with ?code=…; returns true when it did.
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code'), state = params.get('state'), error = params.get('error');
    if (!code && !error) return false;
    history.replaceState(null, '', redirectUri() + location.hash);
    if (error) throw new Error(params.get('error_description') || error);
    if (state !== store.get('sessionStorage', 'lichess-state')) throw new Error('OAuth state mismatch');
    const res = await fetch(`${HOST}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: store.get('sessionStorage', 'lichess-verifier'),
        redirect_uri: redirectUri(), client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`Не удалось получить токен (${res.status})`);
    this.token = (await res.json()).access_token;
    store.set('localStorage', TOKEN_KEY, this.token);
    store.del('sessionStorage', 'lichess-verifier');
    store.del('sessionStorage', 'lichess-state');
    return true;
  }

  async logout() {
    const t = this.token;
    this.token = null;
    this.me = null;
    store.del('localStorage', TOKEN_KEY);
    if (t) await fetch(`${HOST}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(HOST + path, { method, headers, body: body && new URLSearchParams(body), signal });
    if (res.status === 401) {
      await this.logout();
      throw Object.assign(new Error('Сессия Lichess истекла, войдите снова'), { status: 401 });
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg = j.error || JSON.stringify(j); } catch { /* not json */ }
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return res;
  }

  async account() {
    this.me = await (await this.request('/api/account')).json();
    return this.me;
  }

  // Opens an NDJSON stream and keeps it open, reconnecting after drops. Returns a stop function.
  stream(path, onMsg, onState = () => {}) {
    const ctrl = new AbortController();
    let stopped = false;
    const run = async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          const res = await this.request(path, { signal: ctrl.signal });
          onState('open');
          delay = 1000;
          await readNdjson(res, onMsg);
        } catch (e) {
          if (stopped || e.status === 401 || e.status === 404) { onState('closed', e); return; }
        }
        if (stopped) return;
        onState('reconnecting');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
      }
    };
    run();
    return () => { stopped = true; ctrl.abort(); };
  }

  streamEvents(onMsg, onState) { return this.stream('/api/stream/event', onMsg, onState); }
  streamGame(id, onMsg, onState) { return this.stream(`/api/board/game/stream/${id}`, onMsg, onState); }

  // Public seek; the request stays open while lichess looks for an opponent. Returns a cancel function.
  seek({ time, increment, rated }, onDone) {
    const ctrl = new AbortController();
    this.request('/api/board/seek', {
      method: 'POST', signal: ctrl.signal,
      body: { time: String(time), increment: String(increment), rated: String(rated), variant: 'standard', color: 'random' },
    }).then((res) => readNdjson(res, () => {})).then(() => onDone(null), (e) => onDone(ctrl.signal.aborted ? null : e));
    return () => ctrl.abort();
  }

  async challenge(username, { time, increment, rated }) {
    const res = await this.request(`/api/challenge/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: { rated: String(rated), 'clock.limit': String(time * 60), 'clock.increment': String(increment), color: 'random', variant: 'standard' },
    });
    return (await res.json()).challenge || null;
  }

  acceptChallenge(id) { return this.request(`/api/challenge/${id}/accept`, { method: 'POST' }); }
  declineChallenge(id) { return this.request(`/api/challenge/${id}/decline`, { method: 'POST' }); }
  cancelChallenge(id) { return this.request(`/api/challenge/${id}/cancel`, { method: 'POST' }); }
  move(id, uci) { return this.request(`/api/board/game/${id}/move/${uci}`, { method: 'POST' }); }
  resign(id) { return this.request(`/api/board/game/${id}/resign`, { method: 'POST' }); }
  abort(id) { return this.request(`/api/board/game/${id}/abort`, { method: 'POST' }); }
  draw(id, yes) { return this.request(`/api/board/game/${id}/draw/${yes ? 'yes' : 'no'}`, { method: 'POST' }); }
}
