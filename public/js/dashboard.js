// ─── Dashboard view ─────────────────────────────────────────────────────────
// Self-contained combined view: rotating hologram globe (left) + flat map
// (right) on top, live connection log below. Reuses buildMapPoints() and
// getFilteredConnections() / getHomeCoord() so it shares data with the other
// views without touching their renderers.

var dashGlobeSvg = null, dashGlobeProj = null;
var dashFlatSvg = null, dashFlatProj = null, dashFlatPath = null;
var dashGlobeRotate = null; // initialised lazily from home country
var dashSpin = true, dashSpinTimer = null, dashSpinResume = null;
var dashColorScale = null;

function dashEnsureGeo(cb) {
  if (worldGeo) { cb(); return; }
  d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
    .then(topo => { worldGeo = topojson.feature(topo, topo.objects.countries); cb(); })
    .catch(err => console.error('[dashboard] geo load failed', err));
}

function dashColor(d) {
  return d.threat ? '#ff2d55' : (dashColorScale ? dashColorScale(d.totalSessions) : '#9333ea');
}

// ── Globe ───────────────────────────────────────────────────────────────────

function dashRenderGlobeBase() {
  const cell = document.getElementById('dash-globe');
  const w = cell.clientWidth, h = cell.clientHeight;
  if (!w || !h) return false;

  dashGlobeSvg = d3.select('#dash-globe-svg').attr('viewBox', `0 0 ${w} ${h}`);
  dashGlobeSvg.selectAll('*').remove();
  dashGlobeSvg.append('defs').html(`
    <radialGradient id="dg-ocean" cx="42%" cy="38%" r="70%">
      <stop offset="0" stop-color="#0e2548"/><stop offset="60%" stop-color="#091530"/><stop offset="100%" stop-color="#04070f"/>
    </radialGradient>
    <radialGradient id="dg-atmo" cx="50%" cy="50%" r="50%">
      <stop offset="84%" stop-color="#38bdf8" stop-opacity="0"/><stop offset="98%" stop-color="#38bdf8" stop-opacity="0.4"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <filter id="dg-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="dg-glowS" x="-90%" y="-90%" width="280%" height="280%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);

  if (!dashGlobeRotate) {
    const home = getHomeCoord();
    dashGlobeRotate = [-home.lon, -home.lat * 0.4];
  }
  dashGlobeProj = d3.geoOrthographic()
    .fitSize([Math.min(w, h) - 16, Math.min(w, h) - 16], { type: 'Sphere' })
    .translate([w / 2, h / 2]).rotate(dashGlobeRotate);
  const R = dashGlobeProj.scale();

  dashGlobeSvg.append('circle').attr('cx', w / 2).attr('cy', h / 2).attr('r', R + 6).attr('fill', 'url(#dg-atmo)');
  dashGlobeSvg.append('path').attr('class', 'dg-ocean').datum({ type: 'Sphere' }).attr('fill', 'url(#dg-ocean)');
  dashGlobeSvg.append('path').attr('class', 'dg-grat').datum(d3.geoGraticule()()).attr('fill', 'none').attr('stroke', '#2dd4bf').attr('stroke-width', 0.25).attr('stroke-opacity', 0.13);
  dashGlobeSvg.append('g').attr('class', 'dg-countries').attr('filter', 'url(#dg-glow)')
    .selectAll('path').data(worldGeo.features).join('path')
    .attr('fill', '#0c2036').attr('fill-opacity', 0.5).attr('stroke', '#38bdf8').attr('stroke-width', 0.5).attr('stroke-opacity', 0.8);
  dashGlobeSvg.append('path').attr('class', 'dg-rim').datum({ type: 'Sphere' }).attr('fill', 'none').attr('stroke', '#38bdf8').attr('stroke-width', 0.9).attr('stroke-opacity', 0.5).attr('filter', 'url(#dg-glow)');
  dashGlobeSvg.append('g').attr('class', 'dg-back').attr('filter', 'url(#dg-glow)');   // far-side (dim, behind)
  dashGlobeSvg.append('g').attr('class', 'dg-arcs').attr('filter', 'url(#dg-glow)');   // great-circle arcs (auto-clipped)
  dashGlobeSvg.append('g').attr('class', 'dg-front').attr('filter', 'url(#dg-glow)');  // near-side (bright)
  dashGlobeSvg.append('g').attr('class', 'dg-pulses');

  // simple drag rotation (no versor dependency) + pause/resume auto-spin
  dashGlobeSvg.call(d3.drag()
    .on('start', () => { dashSpin = false; if (dashSpinResume) clearTimeout(dashSpinResume); })
    .on('drag', ev => {
      dashGlobeRotate[0] += ev.dx * 0.4;
      dashGlobeRotate[1] = Math.max(-90, Math.min(90, dashGlobeRotate[1] - ev.dy * 0.4));
      dashGlobeProj.rotate(dashGlobeRotate);
      dashRenderGlobeData();
    })
    .on('end', () => { dashSpinResume = setTimeout(() => { dashSpin = true; }, 2500); }));
  return true;
}

function dashRenderGlobeData() {
  if (!dashGlobeSvg || !dashGlobeProj) return;
  const p = d3.geoPath(dashGlobeProj);
  dashGlobeSvg.selectAll('.dg-ocean,.dg-grat,.dg-rim').attr('d', p);
  dashGlobeSvg.select('.dg-countries').selectAll('path').attr('d', p);

  const home = getHomeCoord();
  const HLL = [home.lon, home.lat];
  const rot = dashGlobeProj.rotate();
  const center = [-rot[0], -rot[1]];
  const near = ll => d3.geoDistance(ll, center) < Math.PI / 2 - 0.02;

  const pts = buildMapPoints();
  const maxS = Math.max(2, ...pts.map(d => d.totalSessions));
  dashColorScale = d3.scaleSequentialLog().domain([1, maxS]).interpolator(d3.interpolate('#6d28d9', '#f97316'));
  const rScale = d => 2 + Math.sqrt(d.totalSessions / maxS) * 5;

  const items = pts.map(d => ({ d, n: near([d.lon, d.lat]), xy: dashGlobeProj([d.lon, d.lat]) }));
  const hN = near(HLL), hxy = dashGlobeProj(HLL);

  // arcs: great-circle, geoPath auto-clips to the near hemisphere → if the
  // destination is visible the arc appears over the horizon even when home is behind
  dashGlobeSvg.select('.dg-arcs').selectAll('path').data(items).join('path')
    .attr('d', o => p({ type: 'LineString', coordinates: [HLL, [o.d.lon, o.d.lat]] }))
    .attr('fill', 'none').attr('stroke', o => dashColor(o.d))
    .attr('stroke-width', o => o.d.threat ? 1.5 : 1).attr('stroke-linecap', 'round')
    .attr('stroke-opacity', o => o.n ? (o.d.threat ? 0.95 : 0.6) : 0.13);

  // far-side dots: dim, show through the translucent globe
  dashGlobeSvg.select('.dg-back').selectAll('circle').data(items.filter(o => !o.n)).join('circle')
    .attr('cx', o => o.xy[0]).attr('cy', o => o.xy[1]).attr('r', o => rScale(o.d))
    .attr('fill', o => dashColor(o.d)).attr('fill-opacity', 0.2);
  // near-side dots: bright
  dashGlobeSvg.select('.dg-front').selectAll('circle').data(items.filter(o => o.n)).join('circle')
    .attr('cx', o => o.xy[0]).attr('cy', o => o.xy[1]).attr('r', o => rScale(o.d))
    .attr('fill', o => dashColor(o.d)).attr('fill-opacity', 0.95)
    .attr('filter', o => o.d.threat ? 'url(#dg-glowS)' : null);

  // home + threat pulses
  const pulses = dashGlobeSvg.select('.dg-pulses');
  pulses.selectAll('*').remove();
  pulses.append('circle').attr('cx', hxy[0]).attr('cy', hxy[1]).attr('r', 4)
    .attr('fill', '#ffe9a6').attr('fill-opacity', hN ? 1 : 0.25).attr('filter', 'url(#dg-glow)');
  items.filter(o => o.d.threat && o.n).forEach(o => {
    const ring = pulses.append('circle').attr('cx', o.xy[0]).attr('cy', o.xy[1]).attr('r', 5)
      .attr('fill', 'none').attr('stroke', '#ff2d55').attr('stroke-width', 1.8);
    ring.append('animate').attr('attributeName', 'r').attr('values', '5;20').attr('dur', '1.4s').attr('repeatCount', 'indefinite');
    ring.append('animate').attr('attributeName', 'stroke-opacity').attr('values', '0.9;0').attr('dur', '1.4s').attr('repeatCount', 'indefinite');
  });
}

// ── Flat map ──────────────────────────────────────────────────────────────────

function dashRenderFlatBase() {
  const cell = document.getElementById('dash-flat');
  const w = cell.clientWidth, h = cell.clientHeight;
  if (!w || !h) return false;
  dashFlatSvg = d3.select('#dash-flat-svg').attr('viewBox', `0 0 ${w} ${h}`);
  dashFlatSvg.selectAll('*').remove();
  dashFlatSvg.append('defs').html(`
    <radialGradient id="df-ocean" cx="48%" cy="42%" r="80%"><stop offset="0" stop-color="#10254a"/><stop offset="55%" stop-color="#0a1730"/><stop offset="100%" stop-color="#050a14"/></radialGradient>
    <filter id="df-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  dashFlatProj = d3.geoNaturalEarth1().rotate(getMapRotation()).fitSize([w, h], worldGeo);
  dashFlatPath = d3.geoPath(dashFlatProj);
  dashFlatSvg.append('path').datum({ type: 'Sphere' }).attr('fill', 'url(#df-ocean)').attr('d', dashFlatPath);
  dashFlatSvg.append('path').datum(d3.geoGraticule()()).attr('fill', 'none').attr('stroke', '#2dd4bf').attr('stroke-width', 0.3).attr('stroke-opacity', 0.2).attr('d', dashFlatPath);
  dashFlatSvg.append('g').attr('filter', 'url(#df-glow)').selectAll('path').data(worldGeo.features).join('path')
    .attr('fill', '#0c2036').attr('stroke', '#38bdf8').attr('stroke-width', 0.5).attr('stroke-opacity', 0.85).attr('d', dashFlatPath);
  dashFlatSvg.append('g').attr('class', 'df-arcs').attr('filter', 'url(#df-glow)');
  dashFlatSvg.append('g').attr('class', 'df-dots').attr('filter', 'url(#df-glow)');
  dashFlatSvg.append('g').attr('class', 'df-pulses');
  return true;
}

function dashRenderFlatData() {
  if (!dashFlatSvg || !dashFlatProj) return;
  const home = getHomeCoord();
  const hxy = dashFlatProj([home.lon, home.lat]);
  const pts = buildMapPoints();
  const maxS = Math.max(2, ...pts.map(d => d.totalSessions));
  const rScale = d => 2.5 + Math.sqrt(d.totalSessions / maxS) * 6;
  const arc = (a, b) => { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, lf = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.3, 80); return `M${a[0]},${a[1]} Q${mx},${my - lf} ${b[0]},${b[1]}`; };
  const items = pts.map(d => ({ d, xy: dashFlatProj([d.lon, d.lat]) || [-100, -100] }));

  dashFlatSvg.select('.df-arcs').selectAll('path').data(items).join('path')
    .attr('d', o => arc(hxy, o.xy)).attr('fill', 'none').attr('stroke', o => dashColor(o.d))
    .attr('stroke-width', o => o.d.threat ? 1.6 : 1).attr('stroke-linecap', 'round')
    .attr('stroke-opacity', o => o.d.threat ? 0.9 : 0.5);
  dashFlatSvg.select('.df-dots').selectAll('circle').data(items).join('circle')
    .attr('cx', o => o.xy[0]).attr('cy', o => o.xy[1]).attr('r', o => rScale(o.d))
    .attr('fill', o => dashColor(o.d)).attr('fill-opacity', 0.9)
    .attr('filter', o => o.d.threat ? 'url(#df-glow)' : null);

  const pulses = dashFlatSvg.select('.df-pulses');
  pulses.selectAll('*').remove();
  pulses.append('circle').attr('cx', hxy[0]).attr('cy', hxy[1]).attr('r', 4).attr('fill', '#ffe9a6').attr('filter', 'url(#df-glow)');
  items.filter(o => o.d.threat).forEach(o => {
    const ring = pulses.append('circle').attr('cx', o.xy[0]).attr('cy', o.xy[1]).attr('r', 5).attr('fill', 'none').attr('stroke', '#ff2d55').attr('stroke-width', 1.8);
    ring.append('animate').attr('attributeName', 'r').attr('values', '5;22').attr('dur', '1.4s').attr('repeatCount', 'indefinite');
    ring.append('animate').attr('attributeName', 'stroke-opacity').attr('values', '0.9;0').attr('dur', '1.4s').attr('repeatCount', 'indefinite');
  });
}

// ── Compact log ───────────────────────────────────────────────────────────────

function dashRenderLog() {
  const tbody = document.getElementById('dash-log-tbody');
  if (!tbody) return;
  const conns = getFilteredConnections()
    .slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).slice(0, 300);
  tbody.innerHTML = conns.map(c => {
    const host = c.dstHost && c.dstHost !== c.dst ? c.dstHost : c.dst;
    const flag = c.country && c.country.length === 2
      ? String.fromCodePoint(0x1F1E0 + c.country.charCodeAt(0) - 65, 0x1F1E0 + c.country.charCodeAt(1) - 65) : '';
    const threat = c.threat
      ? `<span class="dash-pill bad">${esc(t('dash.log.threat'))}</span>`
      : `<span class="dash-pill ok">${esc(t('dash.log.clean'))}</span>`;
    const srcName = c.srcMdnsName ? c.srcMdnsName.replace(/\.local$/, '') : (c.srcDnsName ? c.srcDnsName.split('.')[0] : '');
    return `<tr>
      <td>${esc(srcName || c.src)}</td>
      <td>${esc(host)}</td>
      <td>${esc(c.dport || '')}</td>
      <td>${esc([c.city, flag].filter(Boolean).join(' ') || c.country || '')}</td>
      <td>${threat}</td></tr>`;
  }).join('');
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function dashStartSpin() {
  if (dashSpinTimer) return;
  dashSpinTimer = d3.timer(() => {
    if (!dashMode) return;
    if (dashSpin) {
      dashGlobeRotate[0] += 0.16;
      dashGlobeProj.rotate(dashGlobeRotate);
      dashRenderGlobeData();
    }
  });
}
function dashStopSpin() {
  if (dashSpinTimer) { dashSpinTimer.stop(); dashSpinTimer = null; }
}

function initDashboard() {
  dashEnsureGeo(() => {
    if (!dashRenderGlobeBase()) { requestAnimationFrame(initDashboard); return; }
    dashRenderFlatBase();
    dashRenderGlobeData();
    dashRenderFlatData();
    dashRenderLog();
    dashStartSpin();
  });
}

// Refresh data layers (called from socket updates while dashboard is visible)
function updateDashboard() {
  if (!dashGlobeSvg) return;
  dashRenderGlobeData();
  dashRenderFlatData();
  dashRenderLog();
}

// Re-fit on window resize while the dashboard is active
window.addEventListener('resize', () => {
  if (typeof dashMode !== 'undefined' && dashMode && dashGlobeSvg) {
    dashRenderGlobeBase(); dashRenderFlatBase();
    dashRenderGlobeData(); dashRenderFlatData();
  }
});
