'use strict';
/* ReChest update prompt. The app's state message carries `update` ({version, name, notes, url, size}) when GitHub has a
   newer release (Updater.cs). "Update now" asks the app to download and run the installer; the app reports back
   through ReUpdate.progress(pct) / ReUpdate.error(). "Later" hides it until the next start. */
(() => {
  if (!window.chrome?.webview) return;
  window.I18N?.add({
    'New version': 'Yeni sürüm', 'An update is ready': 'Güncelleme hazır', 'Installed': 'Yüklü', "What's new": 'Yenilikler',
    'Update now': 'Şimdi güncelle', 'Later': 'Sonra', 'Downloading…': 'İndiriliyor…', 'Starting the installer…': 'Kurulum başlatılıyor…',
    'Download failed. Check your connection and try again.': 'İndirme başarısız. Bağlantını kontrol edip tekrar dene.',
    'Try again': 'Tekrar dene', 'No notes for this release.': 'Bu sürüm için not yok.',
  });
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // the little Markdown GitHub release notes use: headings, bullets, **bold**, `code`
  const md = (s) => {
    let html = '', list = false;
    for (const raw of s.replace(/\r/g, '').split('\n')) {
      const line = esc(raw.trim()).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
      const li = /^[-*] (.*)/.exec(line);
      if (list && !li) { html += '</ul>'; list = false; }
      if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${li[1]}</li>`; }
      else if (/^#{1,6} /.test(line)) html += `<h4>${line.replace(/^#+ /, '')}</h4>`;
      else if (line) html += `<p>${line}</p>`;
    }
    return html + (list ? '</ul>' : '');
  };
  const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';
  let el = null, shown = null;
  const later = (v) => { try { sessionStorage.setItem('rechest.updLater', v); } catch { /* storage blocked */ } };
  const isLater = (v) => { try { return sessionStorage.getItem('rechest.updLater') === v; } catch { return false; } };

  function show(u, current) {
    if (shown === u.version || isLater(u.version)) return;
    shown = u.version;
    el?.remove();
    el = document.createElement('div');
    el.className = 'upd-veil';
    el.innerHTML = `<div class="upd" role="dialog" aria-modal="true" aria-labelledby="updTitle">
      <div class="upd-glow" aria-hidden="true"></div>
      <div class="upd-head">
        <span class="upd-badge">New version</span>
        <h2 id="updTitle">ReChest <em>${esc(u.version)}</em></h2>
        <div class="upd-sub"><span>An update is ready</span> · <span>Installed</span> <b>${esc(current || '')}</b> · <b>${mb(u.size || 0)}</b></div>
      </div>
      <div class="upd-notes"><h3>What's new</h3>${md(u.notes || '') || '<p>No notes for this release.</p>'}</div>
      <div class="upd-prog" hidden><div class="upd-bar"><i></i></div><div class="upd-st"><span class="upd-msg">Downloading…</span><b class="upd-pct">0%</b></div></div>
      <div class="upd-err" hidden>Download failed. Check your connection and try again.</div>
      <div class="upd-act"><button class="btn sm upd-later" data-u="later">Later</button><button class="btn accent big" data-u="now">Update now</button></div>
    </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-u]');
      if (!b) return;
      if (b.dataset.u === 'later') { later(u.version); close(); return; }
      el.querySelector('.upd-err').hidden = true;
      el.querySelector('.upd-prog').hidden = false;
      el.querySelector('.upd-act').hidden = true;
      window.chrome.webview.postMessage({ type: 'updateNow' });
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    el.querySelector('[data-u="now"]').focus();
  }
  function close() { const e = el; el = null; e?.classList.remove('on'); setTimeout(() => e?.remove(), 220); }

  window.ReUpdate = {
    progress(p) {
      if (!el) return;
      el.querySelector('.upd-bar i').style.width = p + '%';
      el.querySelector('.upd-pct').textContent = p + '%';
      if (p >= 100) el.querySelector('.upd-msg').textContent = T('Starting the installer…');
    },
    error() {
      if (!el) return;
      el.querySelector('.upd-prog').hidden = true;
      el.querySelector('.upd-err').hidden = false;
      el.querySelector('.upd-act').hidden = false;
      el.querySelector('[data-u="now"]').textContent = T('Try again');
    },
  };
  const T = (s) => (window.T ? window.T(s) : s);
  window.chrome.webview.addEventListener('message', (e) => { if (e.data?.update) show(e.data.update, e.data.version); });
})();
