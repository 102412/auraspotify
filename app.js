// ===== GLOBAL STATE =====
const state = {
  currentTrack: null,
  isPlaying: false,
  position: 0,
  duration: 0,
  shuffle: false,
  repeat: 'off', // 'off' | 'context' | 'track'
  volume: 1,
  queue: [],
  currentView: 'nowplaying',
  accessToken: null,
  player: null,
  deviceId: null,
  positionTimer: null,
};

// ===== BOOT =====
(async function boot() {
  const expiresAt = localStorage.getItem('aura_expires_at');
  if (!expiresAt) {
    window.location.href = 'index.html';
    return;
  }

  try {
    state.accessToken = await getValidAccessToken();
  } catch (e) {
    logout();
    return;
  }

  initNav();
  initNowPlayingControls();
  initSearch();
  initSettings();
  initMiniPlayer();
  loadSpotifySDK();
  loadProfile();
  loadLibrary();
  registerServiceWorker();
  startPlaybackPolling();
})();

// ===== WEB API PLAYBACK POLLING =====
// The Web Playback SDK's player_state_changed event doesn't always fire reliably
// (e.g. if playback started from another device before transferring to Aura), so
// this polls the standard Web API as a dependable source of truth for now-playing data.
function startPlaybackPolling() {
  pollPlaybackState();
  setInterval(pollPlaybackState, 3000);
}

async function pollPlaybackState() {
  let data;
  try {
    data = await spotifyFetch('/me/player');
  } catch (e) {
    return;
  }
  if (!data || !data.item) return;

  const track = data.item;
  const isNewTrack = !state.currentTrack || state.currentTrack.id !== track.id;

  state.isPlaying = data.is_playing;
  state.position = data.progress_ms || 0;
  state.duration = track.duration_ms;
  state.shuffle = data.shuffle_state;
  state.repeat = data.repeat_state || 'off';

  state.currentTrack = {
    id: track.id,
    name: track.name,
    artists: (track.artists || []).map((a) => a.name).join(' · '),
    album: track.album?.name || '',
    albumArt: track.album?.images?.[0]?.url || '',
    albumImages: track.album?.images || [],
    durationMs: track.duration_ms,
  };

  if (data.device?.id) state.deviceId = data.device.id;

  renderNowPlaying(isNewTrack);
  renderMiniPlayer();
  renderControlsState();
  startPositionTimer();
  updateMediaSession(isNewTrack);

  if (state.currentView === 'queue') loadQueue();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// ===== SPOTIFY WEB API HELPER =====
async function spotifyFetch(path, options = {}) {
  const token = await getValidAccessToken();
  state.accessToken = token;
  const doFetch = () =>
    fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

  let response;
  try {
    response = await doFetch();
  } catch (e) {
    showToast('No connection');
    throw e;
  }

  if (response.status === 401) {
    // retry once after refresh
    const newToken = await refreshAccessToken();
    state.accessToken = newToken;
    response = await fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${newToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  if (!response.ok && response.status !== 204) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || '';
    } catch (e) {}
    showToast(`Something went wrong${detail ? ': ' + detail : ''} (${response.status})`);
    throw new Error(`Spotify API error ${response.status}${detail ? ': ' + detail : ''} for ${path}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ===== TOASTS =====
function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ===== NAVIGATION =====
function initNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => navigateTo(item.dataset.view));
  });
}

function navigateTo(viewName) {
  state.currentView = viewName;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
  updateMiniPlayerVisibility();

  if (viewName === 'queue') loadQueue();
}

function updateMiniPlayerVisibility() {
  const miniPlayer = document.getElementById('miniPlayer');
  const shouldShow = state.currentView !== 'nowplaying' && state.currentTrack;
  miniPlayer.classList.toggle('visible', !!shouldShow);
}

// ===== SPOTIFY WEB PLAYBACK SDK =====
function loadSpotifySDK() {
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({
      name: 'Aura',
      getOAuthToken: (cb) => {
        getValidAccessToken().then(cb);
      },
      volume: 1,
    });

    state.player = player;

    player.addListener('ready', ({ device_id }) => {
      state.deviceId = device_id;
    });

    player.addListener('not_ready', () => {
      state.deviceId = null;
    });

    player.addListener('initialization_error', () => {
      showToast('Could not connect to Spotify. Make sure Premium is active.');
    });

    player.addListener('authentication_error', () => {
      showToast('Could not connect to Spotify. Make sure Premium is active.');
    });

    player.addListener('account_error', () => {
      showToast('Could not connect to Spotify. Make sure Premium is active.');
    });

    player.addListener('player_state_changed', (playerState) => {
      if (!playerState) return;
      handlePlayerStateChanged(playerState);
    });

    player.connect();
  };

  const script = document.createElement('script');
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  document.head.appendChild(script);
}

function handlePlayerStateChanged(playerState) {
  const track = playerState.track_window.current_track;
  const isNewTrack = !state.currentTrack || state.currentTrack.id !== track.id;

  state.isPlaying = !playerState.paused;
  state.position = playerState.position;
  state.duration = playerState.duration;
  state.shuffle = playerState.shuffle;
  state.repeat = playerState.repeat_mode === 0 ? 'off' : playerState.repeat_mode === 1 ? 'context' : 'track';

  state.currentTrack = {
    id: track.id,
    name: track.name,
    artists: track.artists.map((a) => a.name).join(' · '),
    album: track.album.name,
    albumArt: track.album.images[0]?.url || '',
    albumImages: track.album.images || [],
    durationMs: track.duration_ms,
  };

  state.queue = playerState.track_window.next_tracks.map((t) => ({
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(' · '),
    albumArt: t.album.images[0]?.url || '',
    durationMs: t.duration_ms,
  }));

  renderNowPlaying(isNewTrack);
  renderMiniPlayer();
  renderControlsState();
  startPositionTimer();
  updateMediaSession(isNewTrack);

  if (state.currentView === 'queue') loadQueue();
}

// ===== MEDIA SESSION (Android/lock-screen now-playing) =====
function updateMediaSession(isNewTrack) {
  if (!('mediaSession' in navigator)) return;
  const track = state.currentTrack;
  if (!track) return;

  if (isNewTrack) {
    const images = track.albumImages && track.albumImages.length ? track.albumImages : (track.albumArt ? [{ url: track.albumArt }] : []);
    const artwork = images
      .filter((img) => img.url)
      .map((img) => ({
        src: img.url,
        sizes: img.width && img.height ? `${img.width}x${img.height}` : '300x300',
        type: 'image/jpeg',
      }));

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artists,
      album: track.album,
      artwork,
    });

    navigator.mediaSession.setActionHandler('play', () => state.player?.resume());
    navigator.mediaSession.setActionHandler('pause', () => state.player?.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => state.player?.previousTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => state.player?.nextTrack());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        const seekMs = Math.round(details.seekTime * 1000);
        spotifyFetch(`/me/player/seek?position_ms=${seekMs}`, { method: 'PUT' }).catch(() => {});
      }
    });
  }

  navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  try {
    navigator.mediaSession.setPositionState({
      duration: state.duration / 1000,
      playbackRate: 1,
      position: Math.min(state.position / 1000, state.duration / 1000),
    });
  } catch (e) {}
}

// ===== NOW PLAYING RENDER =====
function renderNowPlaying(isNewTrack) {
  const track = state.currentTrack;
  if (!track) return;

  document.getElementById('trackTitle').textContent = track.name || 'Unknown Track';
  document.getElementById('trackArtist').textContent = track.artists || 'Unknown Artist';
  document.getElementById('trackAlbum').textContent = track.album || '';

  if (isNewTrack) {
    const artEl = document.getElementById('albumArt');
    artEl.style.opacity = '0';
    setTimeout(() => {
      artEl.src = track.albumArt || '';
      artEl.onload = () => {
        artEl.style.opacity = '1';
        extractAndApplyColor(artEl);
        updateAmbientBg(track.albumArt);
      };
      artEl.onerror = () => {
        artEl.style.opacity = '1';
      };
    }, 100);
  }

  updateMiniPlayerVisibility();
}

function updateAmbientBg(url) {
  const bg = document.getElementById('ambientBg');
  if (url) bg.style.backgroundImage = `url(${url})`;
}

function extractAndApplyColor(imgElement) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgElement, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const color = `rgb(${r}, ${g}, ${b})`;
    document.getElementById('albumGlow').style.background = `radial-gradient(circle, ${color}99 0%, transparent 70%)`;
    document.getElementById('progressBarFill').style.background = color;
  } catch (e) {
    // CORS-tainted canvas — fall back silently, keep default white
  }
}

function renderControlsState() {
  document.getElementById('shuffleBtn').classList.toggle('active', state.shuffle);
  const repeatBtn = document.getElementById('repeatBtn');
  repeatBtn.classList.toggle('active', state.repeat !== 'off');

  const playIcon = document.getElementById('playIcon');
  const miniPlayIcon = document.getElementById('miniPlayIcon');
  const iconPath = state.isPlaying
    ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
  playIcon.innerHTML = iconPath;
  miniPlayIcon.innerHTML = iconPath;

  document.getElementById('waveformBars').classList.toggle('paused', !state.isPlaying);
}

function startPositionTimer() {
  if (state.positionTimer) clearInterval(state.positionTimer);
  updateProgressUI();
  state.positionTimer = setInterval(() => {
    if (state.isPlaying) {
      state.position += 1000;
      if (state.position > state.duration) state.position = state.duration;
      updateProgressUI();
    }
  }, 1000);
}

function updateProgressUI() {
  const pct = state.duration ? (state.position / state.duration) * 100 : 0;
  document.getElementById('progressBarFill').style.width = `${pct}%`;
  document.getElementById('positionTime').textContent = formatTime(state.position);
  document.getElementById('durationTime').textContent = formatTime(state.duration);
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ===== NOW PLAYING CONTROLS =====
function initNowPlayingControls() {
  document.getElementById('playBtn').addEventListener('click', togglePlay);
  document.getElementById('miniPlayBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });
  document.getElementById('prevBtn').addEventListener('click', () => state.player?.previousTrack());
  document.getElementById('nextBtn').addEventListener('click', () => state.player?.nextTrack());
  document.getElementById('miniNextBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    state.player?.nextTrack();
  });

  document.getElementById('shuffleBtn').addEventListener('click', async () => {
    const newShuffle = !state.shuffle;
    await spotifyFetch(`/me/player/shuffle?state=${newShuffle}`, { method: 'PUT' });
    state.shuffle = newShuffle;
    renderControlsState();
  });

  document.getElementById('repeatBtn').addEventListener('click', async () => {
    const order = ['off', 'context', 'track'];
    const next = order[(order.indexOf(state.repeat) + 1) % 3];
    await spotifyFetch(`/me/player/repeat?state=${next}`, { method: 'PUT' });
    state.repeat = next;
    renderControlsState();
  });

  const progressTrack = document.getElementById('progressBarTrack');
  progressTrack.addEventListener('click', async (e) => {
    const rect = progressTrack.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const seekMs = Math.round(pct * state.duration);
    state.position = seekMs;
    updateProgressUI();
    await spotifyFetch(`/me/player/seek?position_ms=${seekMs}`, { method: 'PUT' });
  });

  const volumeSlider = document.getElementById('volumeSlider');
  volumeSlider.addEventListener('input', async (e) => {
    const vol = parseInt(e.target.value, 10) / 100;
    state.volume = vol;
    document.getElementById('volumeIcon').style.opacity = vol === 0 ? '0.4' : '1';
    if (state.player) state.player.setVolume(vol);
  });

  document.getElementById('volumeIcon').addEventListener('click', () => {
    const slider = document.getElementById('volumeSlider');
    if (state.volume > 0) {
      slider.dataset.prevVolume = state.volume;
      slider.value = 0;
      state.volume = 0;
    } else {
      const prev = parseFloat(slider.dataset.prevVolume || '1');
      slider.value = prev * 100;
      state.volume = prev;
    }
    if (state.player) state.player.setVolume(state.volume);
  });
}

async function togglePlay() {
  if (!state.player) return;
  await state.player.togglePlay();
}

// ===== QUEUE VIEW =====
async function loadQueue() {
  const container = document.getElementById('queueList');
  container.innerHTML = '';

  if (state.currentTrack) {
    container.appendChild(buildTrackRow(state.currentTrack, true));
  }

  state.queue.forEach((track) => {
    container.appendChild(buildTrackRow(track, false));
  });

  if (!state.currentTrack && state.queue.length === 0) {
    container.innerHTML = '<p class="search-empty">Queue is empty</p>';
  }
}

function buildTrackRow(track, isCurrent) {
  const row = document.createElement('div');
  row.className = `track-row${isCurrent ? ' current' : ''}`;
  row.innerHTML = `
    <img src="${track.albumArt || ''}" alt="">
    <div class="track-row-info">
      <div class="track-row-title">${escapeHtml(track.name)}</div>
      <div class="track-row-artist">${escapeHtml(track.artists)}</div>
    </div>
    <div class="track-row-duration">${formatTime(track.durationMs || 0)}</div>
    ${!isCurrent ? `<button class="track-row-remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>` : ''}
  `;

  if (!isCurrent) {
    const removeBtn = row.querySelector('.track-row-remove');
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await spotifyFetch('/me/player/next', { method: 'POST' });
      } catch (err) {}
      row.remove();
    });

    let startX = 0;
    row.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX), { passive: true });
    row.addEventListener('touchend', (e) => {
      const deltaX = e.changedTouches[0].clientX - startX;
      if (deltaX < -80) {
        row.style.transition = 'transform 200ms ease, opacity 200ms ease';
        row.style.transform = 'translateX(-100%)';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 200);
      }
    });
  }

  return row;
}

// ===== SEARCH VIEW =====
function initSearch() {
  const input = document.getElementById('searchInput');
  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (!query) {
      document.getElementById('searchResults').innerHTML = '<p class="search-empty">Search for something to play</p>';
      return;
    }
    debounceTimer = setTimeout(() => runSearch(query), 300);
  });
}

async function runSearch(query) {
  let data;
  try {
    data = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track,artist,album&limit=5`);
  } catch (e) {
    return;
  }

  const container = document.getElementById('searchResults');
  container.innerHTML = '';

  const tracks = (data.tracks?.items || []).slice(0, 5);
  const artists = (data.artists?.items || []).slice(0, 3);
  const albums = (data.albums?.items || []).slice(0, 3);

  if (tracks.length === 0 && artists.length === 0 && albums.length === 0) {
    container.innerHTML = '<p class="search-empty">No results</p>';
    return;
  }

  if (tracks.length) {
    container.appendChild(buildSectionLabel('Tracks'));
    tracks.forEach((track) => {
      const row = buildTrackRow(
        {
          id: track.id,
          name: track.name,
          artists: track.artists.map((a) => a.name).join(' · '),
          albumArt: track.album.images[0]?.url || '',
          durationMs: track.duration_ms,
          uri: track.uri,
        },
        false
      );
      const removeBtn = row.querySelector('.track-row-remove');
      if (removeBtn) removeBtn.remove();
      row.addEventListener('click', () => playUris([track.uri]));
      container.appendChild(row);
    });
  }

  if (artists.length) {
    container.appendChild(buildSectionLabel('Artists'));
    artists.forEach((artist) => {
      const row = buildSimpleRow(artist.images?.[0]?.url, artist.name, 'Artist', true);
      row.addEventListener('click', () => loadArtistTracks(artist));
      container.appendChild(row);
    });
  }

  if (albums.length) {
    container.appendChild(buildSectionLabel('Albums'));
    albums.forEach((album) => {
      const row = buildSimpleRow(album.images?.[0]?.url, album.name, album.artists.map((a) => a.name).join(', '));
      row.addEventListener('click', () => loadAlbumTracks(album));
      container.appendChild(row);
    });
  }
}

function buildSectionLabel(text) {
  const label = document.createElement('div');
  label.className = 'search-section-label';
  label.textContent = text;
  return label;
}

function buildSimpleRow(imgUrl, title, subtitle, isRound) {
  const row = document.createElement('div');
  row.className = 'track-row';
  row.innerHTML = `
    <img src="${imgUrl || ''}" alt="" style="${isRound ? 'border-radius:50%' : ''}">
    <div class="track-row-info">
      <div class="track-row-title">${escapeHtml(title)}</div>
      <div class="track-row-artist">${escapeHtml(subtitle)}</div>
    </div>
  `;
  return row;
}

async function loadArtistTracks(artist) {
  let data;
  try {
    data = await spotifyFetch(`/artists/${artist.id}/top-tracks?market=${state.userMarket || 'US'}`);
  } catch (e) {
    return;
  }
  const container = document.getElementById('searchResults');
  container.innerHTML = '';
  container.appendChild(buildBackRow(artist.name, () => runSearch(document.getElementById('searchInput').value.trim())));
  (data.tracks || []).forEach((track) => {
    const row = buildTrackRow(
      {
        name: track.name,
        artists: track.artists.map((a) => a.name).join(' · '),
        albumArt: track.album.images[0]?.url || '',
        durationMs: track.duration_ms,
      },
      false
    );
    const removeBtn = row.querySelector('.track-row-remove');
    if (removeBtn) removeBtn.remove();
    row.addEventListener('click', () => playUris([track.uri]));
    container.appendChild(row);
  });
}

async function loadAlbumTracks(album) {
  let data;
  try {
    data = await spotifyFetch(`/albums/${album.id}/tracks?limit=50`);
  } catch (e) {
    return;
  }
  const container = document.getElementById('searchResults');
  container.innerHTML = '';
  container.appendChild(buildBackRow(album.name, () => runSearch(document.getElementById('searchInput').value.trim())));
  (data.items || []).forEach((track, idx) => {
    const row = buildTrackRow(
      {
        name: track.name,
        artists: track.artists.map((a) => a.name).join(' · '),
        albumArt: album.images?.[0]?.url || '',
        durationMs: track.duration_ms,
      },
      false
    );
    const removeBtn = row.querySelector('.track-row-remove');
    if (removeBtn) removeBtn.remove();
    row.addEventListener('click', () => playContext(album.uri, idx));
    container.appendChild(row);
  });
}

function buildBackRow(title, onBack) {
  const wrap = document.createElement('div');
  wrap.className = 'back-row';
  wrap.innerHTML = `
    <button class="back-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
    <span style="font-size:18px;font-weight:700;">${escapeHtml(title)}</span>
  `;
  wrap.querySelector('.back-btn').addEventListener('click', onBack);
  return wrap;
}

// ===== PLAYBACK HELPERS =====
async function playUris(uris) {
  if (!state.deviceId) {
    showToast('Could not connect to Spotify. Make sure Premium is active.');
    return;
  }
  try {
    await spotifyFetch(`/me/player/play?device_id=${state.deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ uris }),
    });
  } catch (e) {}
}

async function playContext(contextUri, offsetIndex) {
  if (!state.deviceId) {
    showToast('Could not connect to Spotify. Make sure Premium is active.');
    return;
  }
  try {
    await spotifyFetch(`/me/player/play?device_id=${state.deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ context_uri: contextUri, offset: { position: offsetIndex || 0 } }),
    });
  } catch (e) {}
}

// ===== LIBRARY VIEW =====
async function loadLibrary() {
  const container = document.getElementById('libraryContent');
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'playlist-grid';

  const likedCard = document.createElement('div');
  likedCard.className = 'playlist-card';
  likedCard.innerHTML = `
    <div class="liked-cover"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.5-9C.5 8 2 4 6 4c2 0 3.5 1.2 4 2 0.5-0.8 2-2 4-2 4 0 5.5 4 3.5 8-2.5 4.5-9.5 9-9.5 9z"/></svg></div>
    <div class="playlist-card-name">Liked Songs</div>
    <div class="playlist-card-count">—</div>
  `;
  likedCard.addEventListener('click', openLikedSongs);
  grid.appendChild(likedCard);

  let playlists = [];
  let url = '/me/playlists?limit=50';
  try {
    while (url) {
      const data = await spotifyFetch(url.replace('https://api.spotify.com/v1', ''));
      playlists = playlists.concat(data.items || []);
      url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
    }
  } catch (e) {}

  playlists.forEach((playlist) => {
    const card = document.createElement('div');
    card.className = 'playlist-card';
    card.innerHTML = `
      <img src="${playlist.images?.[0]?.url || ''}" alt="">
      <div class="playlist-card-name">${escapeHtml(playlist.name)}</div>
      <div class="playlist-card-count">${playlist.tracks?.total || 0} tracks</div>
    `;
    card.addEventListener('click', () => openPlaylist(playlist));
    grid.appendChild(card);
  });

  container.appendChild(grid);
}

async function openLikedSongs() {
  document.getElementById('libraryHeader').textContent = 'Liked Songs';
  const container = document.getElementById('libraryContent');
  container.innerHTML = '';
  container.appendChild(buildBackRow('Liked Songs', () => {
    document.getElementById('libraryHeader').textContent = 'Library';
    loadLibrary();
  }));

  let tracks = [];
  let url = '/me/tracks?limit=50';
  try {
    while (url) {
      const data = await spotifyFetch(url.replace('https://api.spotify.com/v1', ''));
      tracks = tracks.concat(data.items || []);
      url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
    }
  } catch (e) {
    console.error('Failed to load liked songs', e);
    showToast('Could not load Liked Songs: ' + e.message);
  }

  const playAllBtn = document.createElement('button');
  playAllBtn.className = 'glass-btn play-all-btn';
  playAllBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play All`;
  playAllBtn.addEventListener('click', () => playUris(tracks.map((item) => item.track.uri)));
  container.appendChild(playAllBtn);

  tracks.forEach((item, idx) => {
    const track = item.track;
    if (!track) return;
    const row = buildTrackRow(
      {
        name: track.name,
        artists: (track.artists || []).map((a) => a.name).join(' · '),
        albumArt: track.album?.images?.[0]?.url || '',
        durationMs: track.duration_ms,
      },
      false
    );
    const removeBtn = row.querySelector('.track-row-remove');
    if (removeBtn) removeBtn.remove();
    row.addEventListener('click', () => playUris(tracks.slice(idx).map((t) => t.track.uri)));
    container.appendChild(row);
  });
}

async function openPlaylist(playlist) {
  document.getElementById('libraryHeader').textContent = playlist.name;
  const container = document.getElementById('libraryContent');
  container.innerHTML = '';
  container.appendChild(buildBackRow(playlist.name, () => {
    document.getElementById('libraryHeader').textContent = 'Library';
    loadLibrary();
  }));

  let tracks = [];
  let url = `/playlists/${playlist.id}/tracks?limit=100`;
  try {
    while (url) {
      const data = await spotifyFetch(url.replace('https://api.spotify.com/v1', ''));
      tracks = tracks.concat(data.items || []);
      url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
    }
  } catch (e) {
    console.error('Failed to load playlist tracks via /tracks endpoint, trying fallback', e);
    // Fallback: fetch tracks embedded in the playlist object itself instead of the
    // dedicated /tracks endpoint — Spotify sometimes handles permissions differently
    // between the two for the same playlist.
    try {
      tracks = [];
      let fallbackUrl = `/playlists/${playlist.id}?fields=tracks.items,tracks.next`;
      let isFirstPage = true;
      while (fallbackUrl) {
        const data = await spotifyFetch(fallbackUrl.replace('https://api.spotify.com/v1', ''));
        const tracksObj = isFirstPage ? data.tracks : data;
        tracks = tracks.concat(tracksObj.items || []);
        fallbackUrl = tracksObj.next ? tracksObj.next.replace('https://api.spotify.com/v1', '') : null;
        isFirstPage = false;
      }
    } catch (fallbackError) {
      console.error('Fallback also failed', fallbackError);
      showToast('Could not load tracks: ' + fallbackError.message);
    }
  }

  const playAllBtn = document.createElement('button');
  playAllBtn.className = 'glass-btn play-all-btn';
  playAllBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play All`;
  playAllBtn.addEventListener('click', () => playContext(playlist.uri, 0));
  container.appendChild(playAllBtn);

  tracks.forEach((item, idx) => {
    const track = item.track;
    if (!track) return;
    const row = buildTrackRow(
      {
        name: track.name,
        artists: (track.artists || []).map((a) => a.name).join(' · '),
        albumArt: track.album?.images?.[0]?.url || '',
        durationMs: track.duration_ms,
      },
      false
    );
    const removeBtn = row.querySelector('.track-row-remove');
    if (removeBtn) removeBtn.remove();
    row.addEventListener('click', () => playContext(playlist.uri, idx));
    container.appendChild(row);
  });
}

// ===== SETTINGS / PROFILE =====
function initSettings() {
  document.getElementById('logoutBtn').addEventListener('click', logout);
}

async function loadProfile() {
  let profile;
  try {
    profile = await spotifyFetch('/me');
  } catch (e) {
    return;
  }
  document.getElementById('profileName').textContent = profile.display_name || profile.id;
  document.getElementById('profileAvatar').src = profile.images?.[0]?.url || '';
  state.userMarket = profile.country || '';
  loadDevices();
}

async function loadDevices() {
  let data;
  try {
    data = await spotifyFetch('/me/player/devices');
  } catch (e) {
    return;
  }
  const container = document.getElementById('deviceList');
  container.innerHTML = '';
  (data.devices || []).forEach((device) => {
    const row = document.createElement('div');
    row.className = `device-row glass-btn${device.is_active ? ' active' : ''}`;
    row.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>
      <span class="device-name">${escapeHtml(device.name)}</span>
    `;
    row.addEventListener('click', async () => {
      try {
        await spotifyFetch('/me/player', {
          method: 'PUT',
          body: JSON.stringify({ device_ids: [device.id], play: true }),
        });
        loadDevices();
      } catch (e) {}
    });
    container.appendChild(row);
  });
}

// ===== MINI PLAYER =====
function initMiniPlayer() {
  document.getElementById('miniPlayer').addEventListener('click', (e) => {
    if (e.target.closest('.mini-btn')) return;
    navigateTo('nowplaying');
  });
}

function renderMiniPlayer() {
  const track = state.currentTrack;
  if (!track) return;
  document.getElementById('miniArt').src = track.albumArt || '';
  document.getElementById('miniTitle').textContent = track.name;
  document.getElementById('miniArtist').textContent = track.artists;
  updateMiniPlayerVisibility();
}

// ===== UTIL =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

window.addEventListener('offline', () => showToast('No connection'));
