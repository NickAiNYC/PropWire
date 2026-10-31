(() => {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const root = document.getElementById('ufcFighter');
  const id = new URLSearchParams(location.search).get('id');
  fetch('/ufc_fighters.json', { cache: 'no-store' }).then((r) => r.json()).then((all) => {
    const f = all[id];
    if (!f) { root.innerHTML = '<p>Fighter not found. <a href="/">Back to PropStein</a></p>'; return; }
    document.title = `${f.name} · UFC · PropStein`;
    const img = /^https:\/\/a\.espncdn\.com\//.test(f.headshot || '') ? f.headshot : '';
    const stat = (label, value) => `<div><span>${esc(label)}</span><b>${esc(value ?? '—')}</b></div>`;
    root.innerHTML = `<p><a href="/">← PropStein</a></p>
      <div style="display:flex;gap:14px;align-items:center">${img ? `<img src="${esc(img)}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;object-position:top;background:#111">` : ''}
      <div><h1 style="margin:0;font-size:24px">${esc(f.name)}</h1><p style="margin:4px 0;color:#92afc2">${esc(f.weight_class || '')} · ${esc(f.record || '')} · ${esc(f.stance || '')}</p></div></div>
      <div class="ufc-stats">${stat('Elo rating', f.elo)}${stat('UFC fights (2020+)', f.ufc_fights)}${stat('Finish rate', f.finish_rate == null ? null : `${Math.round(f.finish_rate * 100)}%`)}${stat('Age', f.age)}${stat('Reach', f.reach_in ? `${f.reach_in}"` : null)}${stat('Height', f.height)}</div>
      <p style="font-size:12px;color:#fbbf24">NO EDGE · ratings are research only, not validated against closing lines.</p>
      <h2 style="font-size:16px">Recent UFC fights</h2>
      <table><thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th>How</th></tr></thead><tbody>
      ${(f.recent || []).map((h) => `<tr><td>${esc(h.date)}</td><td>${esc(h.opponent)}</td><td>${esc(h.result)}</td><td>${h.finish ? `Finish R${esc(h.round)}` : 'Decision'}</td></tr>`).join('') || '<tr><td colspan="4">No UFC fights since 2020</td></tr>'}
      </tbody></table>
      <p style="font-size:11px;color:#64748b">Bio and results: ESPN. Ratings: PropStein Elo (src/ufc/ratings.py).</p>`;
  }).catch(() => { root.innerHTML = '<p>Fighter data unavailable. <a href="/">Back to PropStein</a></p>'; });
})();
