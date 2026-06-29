// ===== SPOTIFY APP CONFIG =====
// Get this from developer.spotify.com/dashboard -> your app -> Settings -> Client ID
const SPOTIFY_CLIENT_ID = c65e047cf7114a79b9c140ffdf0f2f6b;
// Must exactly match a Redirect URI registered in your Spotify app settings,
// e.g. https://your-app.vercel.app/callback.html (or http://127.0.0.1:5500/callback.html for local testing)
const REDIRECT_URI = https://auraspotify.vercel.app/;

// NOTE: Spotify's standard token refresh endpoint requires a Client Secret.
// For a pure client-side personal app there is no safe place to hide a secret —
// this is a known, accepted tradeoff for a single-user personal tool only.
// Get this from developer.spotify.com/dashboard -> your app -> Settings -> Client Secret
const SPOTIFY_CLIENT_SECRET = 10b669b0131b4942b1e6add822dba332;

const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-read-recently-played',
  'user-top-read'
].join(' ');

function base64UrlEncode(arrayBuffer) {
  let str = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) result += chars[randomValues[i] % chars.length];
  return result;
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

async function startLogin() {
  if (SPOTIFY_CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
    throw new Error('Set SPOTIFY_CLIENT_ID in auth.js first.');
  }
  const codeVerifier = generateRandomString(64);
  const hashed = await sha256(codeVerifier);
  const codeChallenge = base64UrlEncode(hashed);

  localStorage.setItem('aura_code_verifier', codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    redirect_uri: REDIRECT_URI
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const codeVerifier = localStorage.getItem('aura_code_verifier');
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) throw new Error('Token exchange failed');
  const data = await response.json();
  storeTokens(data);
  return data;
}

function storeTokens(data) {
  localStorage.setItem('aura_access_token', data.access_token);
  if (data.refresh_token) localStorage.setItem('aura_refresh_token', data.refresh_token);
  const expiresAt = Date.now() + data.expires_in * 1000;
  localStorage.setItem('aura_expires_at', String(expiresAt));
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('aura_refresh_token');
  if (!refreshToken) throw new Error('No refresh token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: SPOTIFY_CLIENT_ID
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // Client secret is required by Spotify's token endpoint for refresh in this flow.
  if (SPOTIFY_CLIENT_SECRET && SPOTIFY_CLIENT_SECRET !== 'YOUR_CLIENT_SECRET_HERE') {
    headers['Authorization'] = 'Basic ' + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`);
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers,
    body
  });

  if (!response.ok) throw new Error('Token refresh failed');
  const data = await response.json();
  storeTokens(data);
  return data.access_token;
}

async function getValidAccessToken() {
  const expiresAt = parseInt(localStorage.getItem('aura_expires_at') || '0', 10);
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() > expiresAt - fiveMinutes) {
    return refreshAccessToken();
  }
  return localStorage.getItem('aura_access_token');
}

function logout() {
  localStorage.removeItem('aura_access_token');
  localStorage.removeItem('aura_refresh_token');
  localStorage.removeItem('aura_expires_at');
  localStorage.removeItem('aura_code_verifier');
  window.location.href = 'index.html';
}
