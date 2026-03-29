/**
 * ngames.js — N Games Network SDK
 * Single-file SDK for hooking any game into the N Games Network.
 * Works in browser (HTML games) and Electron.
 *
 * Usage:
 *   <script src="ngames.js"></script>
 *   NGame.init({ game_id: 'chaos-holdem', profile_id: 'keshawn' });
 */

(function (global) {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────

  const DEFAULT_SERVER = 'https://ngames-server-production.up.railway.app';
  const PING_INTERVAL  = 60_000; // 60s
  const WS_RETRY_BASE  = 2_000;
  const WS_RETRY_MAX   = 30_000;

  // ─── State ─────────────────────────────────────────────────────────────────

  let _config = {
    server:     DEFAULT_SERVER,
    game_id:    null,
    profile_id: null,
    debug:      false,
  };

  let _ws          = null;
  let _wsRetryMs   = WS_RETRY_BASE;
  let _wsRetryTimer= null;
  let _pingTimer   = null;
  let _state       = null;   // current game_state passed to ping
  let _listeners   = {};     // event → [fn, ...]
  let _initialized = false;

  // ─── Logging ───────────────────────────────────────────────────────────────

  function log(...args) {
    if (_config.debug) console.log('[NGame]', ...args);
  }

  function warn(...args) {
    console.warn('[NGame]', ...args);
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  async function http(method, path, body) {
    const url  = _config.server + path;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    try {
      const res  = await fetch(url, opts);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      return json;
    } catch (e) {
      warn(`${method} ${path} failed:`, e.message);
      throw e;
    }
  }

  const GET  = (path)        => http('GET',  path);
  const POST = (path, body)  => http('POST', path, body);

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  function connectWS() {
    if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;

    const wsURL = _config.server.replace(/^http/, 'ws');
    log('WS connecting to', wsURL);

    _ws = new WebSocket(wsURL);

    _ws.onopen = () => {
      log('WS connected');
      _wsRetryMs = WS_RETRY_BASE;
      clearTimeout(_wsRetryTimer);
      _ws.send(JSON.stringify({ type: 'identify', profile_id: _config.profile_id }));
      emit('ws_connected');
    };

    _ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        log('WS ←', msg.type);
        emit(msg.type, msg);
        emit('*', msg);
      } catch (e) {
        // bad json
      }
    };

    _ws.onclose = () => {
      log('WS closed — retry in', _wsRetryMs, 'ms');
      emit('ws_disconnected');
      _wsRetryTimer = setTimeout(() => {
        _wsRetryMs = Math.min(_wsRetryMs * 2, WS_RETRY_MAX);
        connectWS();
      }, _wsRetryMs);
    };

    _ws.onerror = () => {
      // onclose will fire after this
    };
  }

  // ─── Ping loop ─────────────────────────────────────────────────────────────

  function startPingLoop() {
    stopPingLoop();
    // Ping immediately, then every 60s
    sendPing();
    _pingTimer = setInterval(sendPing, PING_INTERVAL);
  }

  function stopPingLoop() {
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  }

  async function sendPing() {
    if (!_config.profile_id) return;
    try {
      await POST('/presence/ping', {
        profile_id: _config.profile_id,
        game_id:    _config.game_id,
        game_state: _state,
      });
      log('Ping sent');
    } catch (e) {
      // swallow — network hiccup
    }
  }

  // ─── Event emitter ─────────────────────────────────────────────────────────

  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
    return NGame; // chainable
  }

  function off(event, fn) {
    if (!_listeners[event]) return NGame;
    _listeners[event] = _listeners[event].filter(f => f !== fn);
    return NGame;
  }

  function emit(event, data) {
    (_listeners[event] || []).forEach(fn => { try { fn(data); } catch (e) {} });
  }

  // ─── beforeunload — offline ping ───────────────────────────────────────────

  function setupOfflinePing() {
    const handler = () => {
      if (!_config.profile_id) return;
      // sendBeacon is fire-and-forget, survives page close
      const url  = _config.server + '/presence/offline';
      const body = JSON.stringify({ profile_id: _config.profile_id });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        // Synchronous XHR fallback for Electron
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', url, false);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.send(body);
        } catch (e) {}
      }
    };
    window.addEventListener('beforeunload', handler);
    // Electron: also handle process exit signal via IPC if available
    if (typeof window.__ngames_cleanup === 'undefined') {
      window.__ngames_cleanup = handler;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  const NGame = {

    /**
     * Initialize the SDK. Call this once on game start.
     * @param {object} opts
     * @param {string} opts.game_id     — e.g. 'chaos-holdem'
     * @param {string} opts.profile_id  — e.g. 'keshawn'
     * @param {string} [opts.server]    — override server URL
     * @param {boolean} [opts.debug]    — enable console logging
     * @param {boolean} [opts.ws]       — set false to skip WebSocket (default true)
     */
    init(opts = {}) {
      if (_initialized) {
        warn('Already initialized — call NGame.destroy() first to re-init');
        return NGame;
      }

      _config = {
        server:     (opts.server || DEFAULT_SERVER).replace(/\/$/, ''),
        game_id:    opts.game_id    || null,
        profile_id: opts.profile_id || null,
        debug:      opts.debug      || false,
      };

      if (!_config.game_id)    warn('No game_id provided');
      if (!_config.profile_id) warn('No profile_id provided');

      _initialized = true;
      log('Init', _config);

      setupOfflinePing();
      startPingLoop();
      if (opts.ws !== false) connectWS();

      return NGame;
    },

    /**
     * Update the current game state (shown in crew sidebar).
     * Also immediately sends a presence ping with the new state.
     * @param {object|string|null} state — arbitrary JSON-serializable state
     */
    ping(state = null) {
      _state = state;
      sendPing();
      return NGame;
    },

    /**
     * Submit a completed game session (run end, match over, etc.)
     * Awards XP automatically on the server.
     * @param {object} data
     * @param {number} data.score
     * @param {object} [data.extras]  — any additional game data
     * @returns {Promise<{ ok, session_id, xp_gained }>}
     */
    async submitSession({ score = 0, ...extras } = {}) {
      return POST('/sessions', {
        profile_id: _config.profile_id,
        game_id:    _config.game_id,
        score,
        data: extras,
      });
    },

    /**
     * Post a message to the shared crew wall.
     * @param {string} content — max 500 chars
     * @returns {Promise<{ ok, post_id }>}
     */
    async postToWall(content) {
      return POST('/wall/post', {
        profile_id: _config.profile_id,
        game_id:    _config.game_id,
        content:    String(content).slice(0, 500),
      });
    },

    /**
     * Unlock an achievement for the current profile.
     * @param {string} achievement_id
     */
    async unlockAchievement(achievement_id) {
      try {
        return await POST('/achievements/unlock', {
          profile_id:     _config.profile_id,
          achievement_id,
          progress:       1,
        });
      } catch(e) { if (_config.debug) console.warn('[NGame] unlockAchievement failed', e); }
    },

    /**
     * Update progress toward an achievement.
     * @param {string} achievement_id
     * @param {number} progress — current progress value
     */
    async updateProgress(achievement_id, progress) {
      try {
        return await POST('/achievements/unlock', {
          profile_id:     _config.profile_id,
          achievement_id,
          progress:       Number(progress),
        });
      } catch(e) { if (_config.debug) console.warn('[NGame] updateProgress failed', e); }
    },

    /**
     * Get all achievements with progress for a profile.
     * @param {string} [profile_id] — defaults to current profile
     */
    /**
     * Send real-time room state via WebSocket — use this instead of HTTP for
     * high-frequency multiplayer updates (20-60Hz). Zero HTTP overhead.
     * @param {string} room_id
     * @param {object} state — player position, health, action etc.
     */
    sendRoomState(room_id, state) {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
      try {
        _ws.send(JSON.stringify({ type: 'room_state', room_id, state }));
        return true;
      } catch(e) { return false; }
    },

    /**
     * Send a room event via WebSocket (ready, emote, etc.)
     * @param {string} room_id
     * @param {string} event — event name
     * @param {object} [data]
     */
    sendRoomEvent(room_id, event, data = {}) {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
      try {
        _ws.send(JSON.stringify({ type: 'room_event', room_id, event, data }));
        return true;
      } catch(e) { return false; }
    },

    async getAchievements(profile_id) {
      return GET('/achievements/' + (profile_id || _config.profile_id));
    },

    /**
     * Get the current online status of all crew members.
     * @returns {Promise<Array<{ profile_id, online, game_id, game_state, updated_at }>>}
     */
    async getCrewStatus() {
      return GET('/presence');
    },

    /**
     * Get all crew profiles (xp, level, balance, etc.)
     * @returns {Promise<Array>}
     */
    async getProfiles() {
      return GET('/profiles');
    },

    /**
     * Get a single crew profile.
     * @param {string} profile_id
     * @returns {Promise<object>}
     */
    async getProfile(profile_id) {
      return GET(`/profiles/${profile_id}`);
    },

    /**
     * Get wall posts (latest 50).
     * @returns {Promise<Array>}
     */
    async getWall() {
      return GET('/wall');
    },

    /**
     * Get the leaderboard.
     * @param {string} [game_id] — filter to a specific game, or omit for all
     * @returns {Promise<Array>}
     */
    async getLeaderboard(game_id) {
      const qs = game_id ? `?game=${encodeURIComponent(game_id)}` : '';
      return GET(`/sessions/leaderboard${qs}`);
    },

    /**
     * Send a DM to another crew member.
     * @param {string} to_id
     * @param {string} content
     * @returns {Promise<{ ok, message_id }>}
     */
    async sendMessage(to_id, content) {
      return POST('/messages', {
        from_id: _config.profile_id,
        to_id,
        content,
      });
    },

    /**
     * Get conversation between current profile and another.
     * @param {string} other_id
     * @returns {Promise<Array>}
     */
    async getMessages(other_id) {
      return GET(`/messages/${_config.profile_id}/${other_id}`);
    },

    /**
     * React to a wall post with a suit.
     * @param {number} post_id
     * @param {string} suit — ♦ ♥ ♠ ♣
     * @returns {Promise<{ ok, reactions }>}
     */
    async react(post_id, suit) {
      return POST(`/wall/${post_id}/react`, {
        profile_id: _config.profile_id,
        suit,
      });
    },

    // ── Event API ─────────────────────────────────────────────────────────────
    // Listen to real-time WebSocket events from the server.
    //
    // Events:
    //   'presence'      — { profile_id, online, game_id, game_state }
    //   'wall_post'     — { post }
    //   'reaction'      — { post_id, reactions }
    //   'comment'       — { post_id, profile_id, comment_id }
    //   'message'       — { message }
    //   'session'       — { profile_id, game_id, score, session_id }
    //   'ws_connected'  — WS came online
    //   'ws_disconnected' — WS dropped (auto-retrying)
    //   '*'             — all events
    on,
    off,

    // ── Teardown ──────────────────────────────────────────────────────────────

    /**
     * Clean up — stop pings, close WS. Call on game exit if embedding in a
     * larger shell (like the launcher). Not needed if the page is closing.
     */
    destroy() {
      stopPingLoop();
      clearTimeout(_wsRetryTimer);
      if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
      if (_config.profile_id) {
        POST('/presence/offline', { profile_id: _config.profile_id }).catch(() => {});
      }
      _listeners   = {};
      _initialized = false;
      _state       = null;
      log('Destroyed');
    },

    // ── Getters ───────────────────────────────────────────────────────────────
    get profileId() { return _config.profile_id; },
    get gameId()    { return _config.game_id; },
    get server()    { return _config.server; },
    get connected() { return _ws && _ws.readyState === WebSocket.OPEN; },
  };

  // ─── Export ────────────────────────────────────────────────────────────────

  // Browser global
  global.NGame = NGame;

  // CommonJS (Electron renderer with nodeIntegration, or Node test)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NGame;
  }

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
