// ==UserScript==
// @name         VixSrc Play HD – Trakt Anchor Observer + Detail Pages
// @namespace    http://tampermonkey.net/
// @version      1.24
// @description  ▶ pallino rosso in basso-destra su film & episodi Trakt (liste SPA + pagine dettaglio)  
// @match        https://trakt.tv/*  
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.15
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      vixsrc.to
// @connect      vixcloud.co
// @connect      vixcloud.to
// @connect      *
// ==/UserScript==

;(function(){
  'use strict';

  const GM_XHR = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);
  const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.15';
  let hlsReady = null;
  let activePlayer = null;

  function gmFetchText(url, referer) {
    if (!GM_XHR) {
      return fetch(url).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
    }
    return new Promise((resolve, reject) => {
      GM_XHR({
        method: 'GET',
        url,
        headers: referer ? { Referer: referer } : undefined,
        onload: (res) => resolve(res.responseText || ''),
        onerror: () => reject(new Error('GM request failed')),
        ontimeout: () => reject(new Error('GM request timeout'))
      });
    });
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function findScriptText(doc, predicate) {
    const scripts = Array.from(doc.querySelectorAll('script'));
    for (const s of scripts) {
      const text = s.textContent || '';
      if (predicate(text)) return text;
    }
    return '';
  }

  function ensurePlaylistM3u8(url) {
    try {
      const u = new URL(url);
      let path = u.pathname.replace(/\/$/, '');
      if (!/\.m3u8$/i.test(path)) path += '.m3u8';
      u.pathname = path;
      return u.toString();
    } catch {
      return url;
    }
  }

  function parseWindowAssignments(scriptText) {
    const rawScript = scriptText.replace(/\n/g, '\t');
    const keyRegex = /window\.(\w+)\s*=\s*/g;
    const keys = [];
    let m;
    while ((m = keyRegex.exec(rawScript)) !== null) keys.push(m[1]);
    const parts = rawScript.split(/window\.(?:\w+)\s*=\s*/).slice(1);
    if (!keys.length || keys.length !== parts.length) return null;

    const jsonObjects = [];
    for (let i = 0; i < keys.length; i++) {
      let cleaned = parts[i]
        .replace(/;/g, '')
        .replace(/(\{|\[|,)\s*(\w+)\s*:/g, '$1 "$2":')
        .replace(/,(\s*[}\]])/g, '$1')
        .trim();
      jsonObjects.push(`"${keys[i]}": ${cleaned}`);
    }
    let aggregated = '{\n' + jsonObjects.join(',\n') + '\n}';
    aggregated = aggregated.replace(/'/g, '"');
    try {
      return JSON.parse(aggregated);
    } catch {
      return null;
    }
  }

  function buildFromMasterPlaylist(scriptText) {
    const parsed = parseWindowAssignments(scriptText);
    if (!parsed || !parsed.masterPlaylist) return null;
    const master = parsed.masterPlaylist;
    const params = master.params || {};
    const token = params.token;
    const expires = params.expires;
    const baseUrl = master.url || '';
    if (!baseUrl || !token || !expires) return null;
    const paramStr = `token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`;
    let finalUrl;
    if (baseUrl.includes('?b')) {
      finalUrl = baseUrl.replace('?b:1', '?b=1') + `&${paramStr}`;
    } else {
      finalUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + paramStr;
    }
    const beforeQuery = finalUrl.split('?')[0];
    if (!/\.m3u8$/i.test(beforeQuery)) {
      const parts = finalUrl.split('?');
      finalUrl = beforeQuery.replace(/\/$/, '') + '.m3u8' + (parts[1] ? '?' + parts.slice(1).join('?') : '');
    }
    if (parsed.canPlayFHD === true) finalUrl += '&h=1';
    return finalUrl;
  }

  function buildFromTokenScript(scriptText) {
    const tokenMatch = scriptText.match(/'token':\s*'(\w+)'/);
    const expiresMatch = scriptText.match(/'expires':\s*'(\d+)'/);
    const serverUrlMatch = scriptText.match(/url:\s*'([^']+)'/);
    if (!tokenMatch || !expiresMatch || !serverUrlMatch) return null;

    let serverUrl = ensurePlaylistM3u8(serverUrlMatch[1]);
    let finalStreamUrl;
    let hadBOriginally = false;
    try {
      const urlObj = new URL(serverUrl);
      hadBOriginally = urlObj.searchParams.get('b') === '1';
      urlObj.search = '';
      finalStreamUrl = urlObj.toString();
    } catch {
      finalStreamUrl = serverUrl;
      hadBOriginally = /([?&])b=1(?!\d)/.test(serverUrl);
    }

    const fhd = scriptText.includes('window.canPlayFHD = true') || /window\.canPlayFHD\s*=\s*true/.test(scriptText);
    const parts = [];
    if (hadBOriginally) parts.push('b=1');
    parts.push(`token=${tokenMatch[1]}`);
    parts.push(`expires=${expiresMatch[1]}`);
    if (fhd) parts.push('h=1');
    finalStreamUrl += (finalStreamUrl.includes('?') ? '&' : '?') + parts.join('&');

    try {
      const u = new URL(finalStreamUrl);
      const token = u.searchParams.get('token');
      const expires = u.searchParams.get('expires');
      const h = u.searchParams.get('h');
      const b = u.searchParams.get('b');
      u.search = '';
      if (b) u.searchParams.set('b', b);
      if (token) u.searchParams.set('token', token);
      if (expires) u.searchParams.set('expires', expires);
      if (h) u.searchParams.set('h', h);
      finalStreamUrl = u.toString();
    } catch {}

    return finalStreamUrl;
  }

  function ensureHlsReady() {
    if (typeof Hls !== 'undefined') return Promise.resolve(Hls);
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsReady) return hlsReady;
    hlsReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_SRC;
      s.async = true;
      s.onload = () => resolve(window.Hls || (typeof Hls !== 'undefined' ? Hls : null));
      s.onerror = () => reject(new Error('hls.js load failed'));
      document.head.appendChild(s);
    });
    return hlsReady;
  }

  function buildRequestHeaders(referer) {
    const headers = { Accept: '*/*' };
    if (referer) {
      headers.Referer = referer;
      try {
        headers.Origin = new URL(referer).origin;
      } catch {}
    }
    return headers;
  }

  function createGmHlsLoader(referer) {
    const baseHeaders = buildRequestHeaders(referer);
    const initStats = (now) => ({
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      trequest: now,
      tfirst: 0,
      tload: 0,
      bwEstimate: 0,
      chunkCount: 0,
      loading: { start: now, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 }
    });
    return class GmHlsLoader {
      constructor(config) {
        this.config = config;
        this.stats = initStats(0);
        this.context = null;
        this.callbacks = null;
        this.request = null;
      }

      load(context, config, callbacks) {
        this.context = context;
        this.callbacks = callbacks;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        this.stats = initStats(now);
        const isBinary = context.responseType === 'arraybuffer' || context.type === 'fragment' || context.type === 'key';
        const responseType = context.responseType || (isBinary ? 'arraybuffer' : 'text');
        const headers = Object.assign({}, baseHeaders, config.headers || {}, context.headers || {});

        // Non inviare Range header per sottotitoli o playlist
        const isSubtitle = context.type === 'subtitle' || /\.vtt$/i.test(context.url);
        const isPlaylist = context.type === 'manifest' || /\.m3u8$/i.test(context.url);

        if (isBinary && !isSubtitle && !isPlaylist) {
          const hasRangeStart = typeof context.rangeStart === 'number' && isFinite(context.rangeStart) && context.rangeStart >= 0;
          const hasRangeEnd = typeof context.rangeEnd === 'number' && isFinite(context.rangeEnd) && context.rangeEnd > 0;
          const hasRangeLength = typeof context.rangeLength === 'number' && isFinite(context.rangeLength) && context.rangeLength > 0;

          if (hasRangeStart && hasRangeEnd && context.rangeEnd > context.rangeStart) {
            headers.Range = `bytes=${context.rangeStart}-${context.rangeEnd - 1}`;
          } else if (hasRangeStart && hasRangeLength) {
            headers.Range = `bytes=${context.rangeStart}-${context.rangeStart + context.rangeLength - 1}`;
          }
        }
        this.request = GM_XHR({
          method: 'GET',
          url: context.url,
          headers,
          responseType,
          timeout: config.timeout || 20000,
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              callbacks.onError({ code: res.status || 0, text: 'HTTP ' + res.status }, context, res);
              return;
            }
            const tload = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            this.stats.tload = tload;
            if (!this.stats.tfirst) {
              this.stats.tfirst = tload;
              this.stats.loading.first = tload;
            }
            const data = isBinary ? res.response : (res.responseText || res.response || '');
            const size = isBinary && data ? data.byteLength : (data ? data.length : 0);
            this.stats.loaded = size;
            this.stats.total = size;
            this.stats.loading.end = tload;
            callbacks.onSuccess({ url: context.url, data }, this.stats, context, res);
          },
          onprogress: (res) => {
            if (!this.stats.tfirst) {
              this.stats.tfirst = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
              this.stats.loading.first = this.stats.tfirst;
            }
            if (res.lengthComputable) {
              this.stats.loaded = res.loaded;
              this.stats.total = res.total;
            }
            if (callbacks.onProgress) callbacks.onProgress(this.stats, context, res);
          },
          onerror: (res) => {
            callbacks.onError({ code: res && res.status ? res.status : 0, text: 'GM xhr error' }, context, res);
          },
          ontimeout: () => {
            callbacks.onTimeout(this.stats, context, null);
          }
        });
      }

      abort() {
        if (this.request && this.request.abort) this.request.abort();
      }

      destroy() {
        this.abort();
        this.request = null;
        this.context = null;
        this.callbacks = null;
      }
    };
  }

  function closePlayer() {
    if (!activePlayer) return;
    try {
      if (activePlayer.hls) activePlayer.hls.destroy();
    } catch {}
    if (activePlayer.overlay && activePlayer.overlay.parentNode) {
      activePlayer.overlay.parentNode.removeChild(activePlayer.overlay);
    }
    if (activePlayer.onKey) {
      document.removeEventListener('keydown', activePlayer.onKey);
    }
    activePlayer = null;
  }

  async function resolveVixStream(url) {
    if (!GM_XHR) return null;
    const primaryHtml = await gmFetchText(url, location.href);
    let html = primaryHtml;
    let referer = url;
    try {
      const doc = parseHtml(primaryHtml);
      const iframe = doc.querySelector('iframe');
      const iframeSrc = iframe && iframe.getAttribute('src');
      if (iframeSrc) {
        const iframeUrl = new URL(iframeSrc, url).toString();
        html = await gmFetchText(iframeUrl, url);
        referer = iframeUrl;
      }
    } catch {}

    const doc = parseHtml(html);
    const masterScript = findScriptText(doc, t => t.includes('masterPlaylist'));
    if (masterScript) {
      const fromMaster = buildFromMasterPlaylist(masterScript);
      if (fromMaster) return { streamUrl: fromMaster, referer };
    }
    const tokenScript = findScriptText(doc, t => t.includes("'token':") && t.includes("'expires':") && t.includes('url:'));
    if (tokenScript) {
      const fromToken = buildFromTokenScript(tokenScript);
      if (fromToken) return { streamUrl: fromToken, referer };
    }
    return null;
  }

  function openPlayer(streamUrl, title, referer) {
    closePlayer();
    const safeTitle = title || 'VixSrc Stream';
    const overlay = document.createElement('div');
    overlay.className = 'vix-player-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      background: 'rgba(0,0,0,0.88)',
      zIndex: '100000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px'
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      width: 'min(1200px, 96vw)',
      background: '#0b0b0b',
      borderRadius: '10px',
      boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      padding: '14px',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px'
    });

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' });
    const titleEl = document.createElement('div');
    titleEl.textContent = safeTitle;
    Object.assign(titleEl.style, { fontSize: '14px', opacity: '0.85' });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Chiudi';
    Object.assign(closeBtn.style, {
      background: '#e50914',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      padding: '6px 10px',
      cursor: 'pointer',
      fontSize: '12px'
    });
    closeBtn.addEventListener('click', closePlayer);
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const statusEl = document.createElement('div');
    statusEl.textContent = 'Inizializzo player...';
    Object.assign(statusEl.style, { fontSize: '13px', opacity: '0.75' });

    const qualityRow = document.createElement('div');
    Object.assign(qualityRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '12px',
      opacity: '0.85',
      visibility: 'visible',
      width: '100%',
      padding: '4px 0'
    });
    const qualityLabel = document.createElement('span');
    qualityLabel.textContent = 'Qualità:';
    Object.assign(qualityLabel.style, {
      whiteSpace: 'nowrap'
    });
    const qualitySelect = document.createElement('select');
    qualitySelect.disabled = true;
    Object.assign(qualitySelect.style, {
      background: '#141414',
      color: '#fff',
      border: '1px solid #2a2a2a',
      borderRadius: '6px',
      padding: '4px 6px',
      cursor: 'pointer',
      minWidth: '100px',
      fontSize: '12px'
    });
    qualitySelect.appendChild(new Option('Auto', 'auto'));
    qualityRow.appendChild(qualityLabel);
    qualityRow.appendChild(qualitySelect);

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    Object.assign(video.style, {
      width: '100%',
      maxHeight: '70vh',
      background: '#000',
      borderRadius: '8px'
    });

    panel.appendChild(header);
    panel.appendChild(statusEl);
    panel.appendChild(qualityRow);
    panel.appendChild(video);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) closePlayer();
    });
    const onKey = (ev) => {
      if (ev.key === 'Escape') closePlayer();
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    activePlayer = { overlay, hls: null, onKey };

    ensureHlsReady().then((HlsLib) => {
      if (!HlsLib || !HlsLib.isSupported() || !GM_XHR) {
        statusEl.textContent = 'Player HLS non disponibile, apro il flusso diretto.';
        video.src = streamUrl;
        return;
      }
      statusEl.textContent = 'Carico stream...';
      const Loader = createGmHlsLoader(referer);
      const hls = new HlsLib({
        loader: Loader,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60
      });
      activePlayer.hls = hls;
      hls.attachMedia(video);
      hls.on(HlsLib.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(streamUrl);
      });
      hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
        statusEl.textContent = 'In riproduzione';
        const levels = (hls.levels || []).slice();
        const unique = [];
        const seen = new Set();
        levels.forEach((lvl, idx) => {
          const h = lvl.height || 0;
          if (!h || seen.has(h)) return;
          seen.add(h);
          unique.push({ height: h, index: idx });
        });
        unique.sort((a, b) => b.height - a.height);
        qualitySelect.innerHTML = '';
        qualitySelect.appendChild(new Option('Auto', 'auto'));
        unique.forEach(lvl => {
          qualitySelect.appendChild(new Option(`${lvl.height}p`, String(lvl.index)));
        });
        qualitySelect.disabled = unique.length === 0;

        const pickDefault = () => {
          let target = unique.find(lvl => lvl.height === 1080);
          if (!target && unique.length) target = unique[0];
          if (target) {
            qualitySelect.value = String(target.index);
            hls.autoLevelEnabled = false;
            hls.currentLevel = target.index;
            hls.loadLevel = target.index;
          }
        };
        pickDefault();
        qualitySelect.addEventListener('change', () => {
          const val = qualitySelect.value;
          if (val === 'auto') {
            hls.autoLevelEnabled = true;
            hls.currentLevel = -1;
            return;
          }
          const idx = parseInt(val, 10);
          if (!Number.isNaN(idx)) {
            hls.autoLevelEnabled = false;
            hls.currentLevel = idx;
            hls.loadLevel = idx;
          }
        });

        video.play().catch(() => {});
      });
      hls.on(HlsLib.Events.ERROR, (_, data) => {
        if (!data) return;
        const detail = data.details ? ` (${data.details})` : '';
        const msg = 'Errore player: ' + (data.type || 'unknown') + detail;
        statusEl.textContent = msg;
        if (data.fatal) {
          try { hls.destroy(); } catch {}
        }
      });
    }).catch(() => {
      statusEl.textContent = 'Errore nel caricamento del player.';
      video.src = streamUrl;
    });
  }

  async function openDirectOrFallback(url, btn) {
    const fallbackUrl = url + '?autoplay=true&theme=dark&lang=it&res=1080';
    if (!GM_XHR) {
      window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (btn.dataset.vixLoading === '1') return;
    const prevText = btn.textContent;
    btn.dataset.vixLoading = '1';
    btn.textContent = '...';
    closePlayer();
    try {
      const result = await resolveVixStream(url);
      if (result && result.streamUrl) {
        openPlayer(result.streamUrl, document.title, result.referer);
      } else {
        window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
    } finally {
      btn.textContent = prevText;
      btn.dataset.vixLoading = '0';
    }
  }

  // ◆ Crea il pallino rosso ▶
  function createCircleBtn(url) {
    const a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.removeAttribute('target');
    a.rel = 'noopener noreferrer';
    a.textContent = '▶';
    Object.assign(a.style, {
      position:      'absolute',
      bottom:        '10px',
      right:         '10px',
      width:         '36px',
      height:        '36px',
      background:    '#e50914',
      color:         '#fff',
      fontSize:      '18px',
      lineHeight:    '36px',
      textAlign:     'center',
      borderRadius:  '50%',
      textDecoration:'none',
      zIndex:        '9999',
      cursor:        'pointer',
      pointerEvents: 'auto'
    });
    a.className = 'vix-circle-btn';
    ['pointerdown', 'touchstart'].forEach(evt => {
      a.addEventListener(evt, (ev) => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }, { capture: true, passive: false });
    });
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      openDirectOrFallback(url, a);
    }, true);
    return a;
  }

  // ◆ Inietta il pulsante se non già presente
  function injectCircle(container, url) {
    if (!container || container.querySelector('.vix-circle-btn')) return;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(createCircleBtn(url));
  }

  // ◆ Cache delle liste TMDB e verifica presenza
  const tmdbCache = { movie: null, tv: null };
  async function tmdbExists(type, id, season, ep) {
    const url = type === 'movie'
      ? 'https://raw.githubusercontent.com/nzo66/TV/refs/heads/main/film.m3u'
      : 'https://raw.githubusercontent.com/nzo66/TV/refs/heads/main/serie.m3u';
    if (!tmdbCache[type]) {
      try {
        const res = await fetch(url);
        tmdbCache[type] = await res.text();
      } catch {
        tmdbCache[type] = '';
      }
    }
    const list = tmdbCache[type];
    if (type === 'movie') {
      return list.includes(`/movie/${id}/`);
    } else {
      return list.includes(`/tv/${id}/${season}/${ep}`);
    }
  }

  // ◆ Processa ogni <a> “movie” o “episode” nelle liste/dashboard
  async function processAnchor(a) {
    if (a.__vix_processed) return;
    a.__vix_processed = true;

    const href = a.getAttribute('href');
    // solo link interni Trakt
    if (!href.startsWith('/movies/') && !href.startsWith('/shows/')) return;

    // container candidato
    const container = a.closest('div.poster.with-overflow')
                   || a.closest('div.fanart')
                   || a.closest('div.poster');

    // se già dentro una pagina dettaglio, skip
    if (!container) return;

    // Estrai la path
    const path = href.split('?')[0];

    // — Film
    if (/^\/movies\/[^/]+/.test(path)) {
      // chiamo il dettaglio in pagina per recuperare TMDB ID
      const el = document.querySelector('a[href*="themoviedb.org/movie/"]');
      if (el) {
        const m = el.href.match(/themoviedb\.org\/movie\/(\d+)/);
        if (m && await tmdbExists('movie', m[1])) {
          injectCircle(container, `https://vixsrc.to/movie/${m[1]}`);
          return;
        }
      }
      // fallback fetch se non in pagina (liste/dashboard)
      const traktId = a.closest('[data-movie-id]')?.getAttribute('data-movie-id');
      if (traktId) {
        try {
          const res = await fetch(`/movies/${traktId}`,{credentials:'include'});
          const txt = await res.text();
          const doc = new DOMParser().parseFromString(txt,'text/html');
          const el2 = doc.querySelector('a[href*="themoviedb.org/movie/"]');
          const m2 = el2 && el2.href.match(/themoviedb\.org\/movie\/(\d+)/);
          if (m2 && await tmdbExists('movie', m2[1]))
            injectCircle(container, `https://vixsrc.to/movie/${m2[1]}`);
        } catch {}
      }
      return;
    }

    // — Episodio
    const epMatch = path.match(/^\/shows\/[^/]+\/seasons\/(\d+)\/episodes\/(\d+)/);
    if (epMatch) {
      // prova in pagina
      const el = document.querySelector('a[href*="themoviedb.org/tv/"]');
      if (el) {
        const m = el.href.match(/themoviedb\.org\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)/);
        if (m && await tmdbExists('tv', m[1], m[2], m[3])) {
          injectCircle(container, `https://vixsrc.to/tv/${m[1]}/${m[2]}/${m[3]}`);
          return;
        }
      }
      // fallback fetch
      const epId = a.closest('[data-episode-id]')?.getAttribute('data-episode-id');
      if (epId) {
        try {
          const res = await fetch(`/episodes/${epId}`,{credentials:'include'});
          const txt = await res.text();
          const doc = new DOMParser().parseFromString(txt,'text/html');
          const el2 = doc.querySelector('a[href*="themoviedb.org/tv/"]');
          const m2 = el2 && el2.href.match(/themoviedb\.org\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)/);
          if (m2 && await tmdbExists('tv', m2[1], m2[2], m2[3]))
            injectCircle(container, `https://vixsrc.to/tv/${m2[1]}/${m2[2]}/${m2[3]}`);
        } catch {}
      }
    }
  }

  // ◆ Scansiona tutti gli <a> rilevanti già presenti
  function scanAllAnchors() {
    document.querySelectorAll('a[href^="/movies/"], a[href^="/shows/"]').forEach(processAnchor);
  }

  // ── Aggiunge anche direttamente sulle pagine di dettaglio, senza click su <a>
  function scanDetailPage() {
    const path = location.pathname.split('?')[0];

    // — DETTAGLIO FILM
    if (/^\/movies\/[^/]+/.test(path)) {
      const el = document.querySelector('a[href*="themoviedb.org/movie/"]');
      const poster = document.querySelector('.sidebar.sticky.posters .poster.with-overflow');
      if (el && poster) {
        const m = el.href.match(/themoviedb\.org\/movie\/(\d+)/);
        if (m)
          tmdbExists('movie', m[1]).then(ok => {
            if (ok) injectCircle(poster, `https://vixsrc.to/movie/${m[1]}`);
          });
      }
    }

    // — DETTAGLIO EPISODIO
    if (/^\/shows\/[^/]+\/seasons\/\d+\/episodes\/\d+/.test(path)) {
      const el = document.querySelector('a[href*="themoviedb.org/tv/"]');
      const poster = document.querySelector('.sidebar.sticky.posters .poster.with-overflow');
      if (el && poster) {
        const m = el.href.match(/themoviedb\.org\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)/);
        if (m)
          tmdbExists('tv', m[1], m[2], m[3]).then(ok => {
            if (ok) injectCircle(poster, `https://vixsrc.to/tv/${m[1]}/${m[2]}/${m[3]}`);
          });
      }
    }
  }

  // ── Hook SPA navigation: pushState + replaceState ────────────────────────
  ['pushState','replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function(...args) {
      const ret = orig.apply(this, args);
      setTimeout(() => {
        scanDetailPage();
        scanAllAnchors();
      }, 300);
      return ret;
    };
  });
  function rescan() {
    setTimeout(() => {
      scanDetailPage();
      scanAllAnchors();
    }, 300);
  }
  window.addEventListener('popstate', rescan);
  window.addEventListener('hashchange', rescan);
  window.addEventListener('pageshow', rescan);

  // ── Observer per intercettare nuovi <a> nel DOM ──────────────────────────
  const observer = new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        if (node.matches('a[href^="/movies/"], a[href^="/shows/"]')) {
          processAnchor(node);
        }
        node.querySelectorAll && node.querySelectorAll('a[href^="/movies/"], a[href^="/shows/"]')
            .forEach(processAnchor);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Esegui al caricamento iniziale ────────────────────────────────────────
  window.addEventListener('load', rescan);

})();
