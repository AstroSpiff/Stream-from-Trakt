// ==UserScript==
// @name         VixSrc Play HD – Trakt Anchor Observer + Detail Pages
// @namespace    http://tampermonkey.net/
// @version      1.15
// @description  ▶ pallino rosso in basso-destra su film & episodi Trakt (liste SPA + pagine dettaglio)  
// @match        https://trakt.tv/*  
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      vixsrc.to
// @connect      vixcloud.co
// @connect      vixcloud.to
// ==/UserScript==

;(function(){
  'use strict';

  const GM_XHR = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);

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

  function openPlayer(streamUrl, title) {
    const safeTitle = title || 'VixSrc Stream';
    const html = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + safeTitle.replace(/</g, '&lt;') + '</title>',
      '<style>',
      'html,body{margin:0;padding:0;background:#0b0b0b;color:#fff;height:100%;font-family:Arial,sans-serif;}',
      '#wrap{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;}',
      'video{width:92vw;max-width:1200px;max-height:76vh;background:#000;border-radius:8px;}',
      '#status{font-size:14px;opacity:0.8;}',
      '</style>',
      '</head>',
      '<body>',
      '<div id="wrap">',
      '<div id="status">Loading stream...</div>',
      '<video id="v" controls autoplay playsinline></video>',
      '</div>',
      '<script>',
      'const streamUrl=' + JSON.stringify(streamUrl) + ';',
      'const statusEl=document.getElementById("status");',
      'const video=document.getElementById("v");',
      'function fail(msg){statusEl.textContent=msg;}',
      'if (video.canPlayType("application/vnd.apple.mpegurl")) {',
      '  video.src=streamUrl;',
      '  statusEl.textContent="Playing (native HLS)";',
      '} else {',
      '  const s=document.createElement("script");',
      '  s.src="https://cdn.jsdelivr.net/npm/hls.js@1.5.15";',
      '  s.onload=function(){',
      '    if (window.Hls && window.Hls.isSupported()) {',
      '      const hls=new window.Hls({enableWorker:true});',
      '      hls.loadSource(streamUrl);',
      '      hls.attachMedia(video);',
      '      hls.on(window.Hls.Events.MANIFEST_PARSED,function(){statusEl.textContent="Playing (hls.js)";});',
      '    } else {',
      '      fail("HLS not supported in this browser");',
      '    }',
      '  };',
      '  s.onerror=function(){fail("Failed to load hls.js");};',
      '  document.head.appendChild(s);',
      '}',
      '</script>',
      '</body>',
      '</html>'
    ].join('');
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      window.location.href = streamUrl;
      return;
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
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
    try {
      const result = await resolveVixStream(url);
      if (result && result.streamUrl) {
        openPlayer(result.streamUrl, document.title);
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
    a.href = url + '?autoplay=true&theme=dark&lang=it&res=1080';
    a.target = '_blank';
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
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openDirectOrFallback(url, a);
    });
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
