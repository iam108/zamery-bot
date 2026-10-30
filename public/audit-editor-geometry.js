(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuditEditorGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EPSILON = 1e-12, MIN_AREA = 1e-8;
  const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  function finite(value, label) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(label + ' must be finite'); return value; }
  function point(p) { if (!p || typeof p !== 'object') throw new TypeError('Point required'); return { x: finite(p.x, 'x'), y: finite(p.y, 'y') }; }
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function clampPoint(p) { const q = point(p); return { x: clamp(q.x, 0, 1), y: clamp(q.y, 0, 1) }; }
  function distance(a, b) { const p = point(a), q = point(b); return Math.hypot(p.x - q.x, p.y - q.y); }
  function signedArea(points) {
    if (!Array.isArray(points)) throw new TypeError('Points must be an array');
    const ps = points.map(point);
    if (ps.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ps.length; i++) { const a = ps[i], b = ps[(i + 1) % ps.length]; sum += a.x * b.y - b.x * a.y; }
    return sum / 2;
  }
  const samePoint = (a, b) => Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  function onSegment(p, a, b) { return Math.abs(cross(a, b, p)) <= EPSILON && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON; }
  function intersects(a, b, c, d) {
    const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
    if (((c1 > EPSILON && c2 < -EPSILON) || (c1 < -EPSILON && c2 > EPSILON)) && ((c3 > EPSILON && c4 < -EPSILON) || (c3 < -EPSILON && c4 > EPSILON))) return true;
    return Math.abs(c1) <= EPSILON && onSegment(c, a, b) || Math.abs(c2) <= EPSILON && onSegment(d, a, b) || Math.abs(c3) <= EPSILON && onSegment(a, c, d) || Math.abs(c4) <= EPSILON && onSegment(b, c, d);
  }
  function cleanRing(points) {
    const result = points.map(point);
    // Both implicit closure and a repeated closing point are accepted.
    if (result.length > 1 && samePoint(result[0], result.at(-1))) result.pop();
    return result;
  }
  function closedContour(points) {
    try {
      if (!Array.isArray(points)) return false;
      const ring = cleanRing(points), n = ring.length;
      if (n < 3 || ring.some(p => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (samePoint(ring[i], ring[j])) return false;
      if (Math.abs(signedArea(ring)) <= MIN_AREA) return false;
      // Crossing boundaries cannot describe one unambiguous licensed area.
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || i === 0 && j === n - 1) continue;
        if (intersects(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
      }
      return true;
    } catch (_) { return false; }
  }
  function nearestVertex(marks, p, tolerance) {
    const q = point(p); finite(tolerance, 'tolerance');
    if (tolerance < 0) throw new RangeError('Tolerance cannot be negative');
    let found = null;
    // Equal distances prefer the last (visually topmost) committed contour.
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i];
      if (mark.type !== 'contour' || mark.isClosed !== true || !closedContour(mark.points)) continue;
      mark.points.forEach((vertex, index) => {
        const d = distance(vertex, q);
        if (d <= tolerance && (!found || d < found.distance)) found = { markId: mark.id, index, distance: d };
      });
    }
    return found;
  }
  function checkedMark(mark, index) {
    if (!mark || !Array.isArray(mark.points)) throw new TypeError('Mark points required');
    if (!Number.isInteger(index) || index < 0 || index >= mark.points.length) throw new RangeError('Vertex index is out of bounds');
    mark.points.forEach(point);
  }
  function validateClosed(mark) { if (mark.isClosed === true && !closedContour(mark.points)) throw new RangeError('Closed contour requires at least three distinct noncollinear vertices without intersections'); }
  function moveVertex(mark, index, p) {
    checkedMark(mark, index);
    const next = copy(mark); next.points[index] = clampPoint(p); validateClosed(next); return next;
  }
  function removeVertex(mark, index) {
    checkedMark(mark, index);
    const next = copy(mark); next.points.splice(index, 1); validateClosed(next); return next;
  }
  function moveContour(mark, dx, dy) {
    finite(dx, 'dx'); finite(dy, 'dy');
    if (!mark || !Array.isArray(mark.points) || !mark.points.length) throw new TypeError('Contour points required');
    const points = mark.points.map(point);
    if (points.some(p => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) throw new RangeError('Source vertices must be normalized');
    const tx = clamp(dx, -Math.min(...points.map(p => p.x)), 1 - Math.max(...points.map(p => p.x)));
    const ty = clamp(dy, -Math.min(...points.map(p => p.y)), 1 - Math.max(...points.map(p => p.y)));
    const next = copy(mark);
    next.points = points.map(p => ({ x: clamp(p.x + tx, 0, 1), y: clamp(p.y + ty, 0, 1) }));
    validateClosed(next); return next;
  }
  function pointInPolygon(p, points) {
    const q = point(p);
    if (!closedContour(points)) return false;
    const ring = cleanRing(points); let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      if (onSegment(q, a, b)) return true;
      if ((a.y > q.y) !== (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function segmentDistance(p, a, b) {
    const length2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (!length2) return distance(p, a);
    const t = clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length2, 0, 1);
    return distance(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }
  function hitTestContour(marks, p, tolerance = 0) {
    const q = point(p); finite(tolerance, 'tolerance'); if (tolerance < 0) throw new RangeError('Tolerance cannot be negative');
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i];
      if (mark.type !== 'contour' || mark.isClosed !== true || !closedContour(mark.points)) continue;
      const ring = cleanRing(mark.points);
      if (pointInPolygon(q, ring) || ring.some((a, j) => segmentDistance(q, a, ring[(j + 1) % ring.length]) <= tolerance)) return mark.id;
    }
    return null;
  }
  function getNextContourCode(marks, sequence = 0) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('Sequence must be a nonnegative safe integer');
    let value = sequence;
    for (const mark of marks) { const match = /^Г([1-9]\d*)$/u.exec(String(mark.code || '').trim()); if (match && Number.isSafeInteger(Number(match[1]))) value = Math.max(value, Number(match[1])); }
    if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError('Contour sequence exhausted');
    return { code: 'Г' + (value + 1), sequence: value + 1 };
  }
  function validateMarks(marks) {
    if (!Array.isArray(marks)) throw new TypeError('Marks must be an array');
    for (const mark of marks) if (mark.type === 'contour') {
      if (mark.isClosed !== true) throw new RangeError('Draft contour must stay separate from committed marks');
      validateClosed(mark);
    }
  }
  function canonical(value) { return value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'; }
  function createHistory(initial, limit = 60) {
    validateMarks(initial);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('History limit must be a positive integer');
    return { past: [], present: copy(initial), future: [], limit };
  }
  function commitHistory(history, marks) {
    validateMarks(marks);
    if (canonical(history.present) === canonical(marks)) return copy(history);
    const next = copy(history);
    next.past = [...next.past, copy(next.present)].slice(-next.limit);
    next.present = copy(marks); next.future = []; return next;
  }
  function undoHistory(history) {
    const next = copy(history); if (!next.past.length) return next;
    next.future.unshift(copy(next.present)); next.present = next.past.pop(); return next;
  }
  function redoHistory(history) {
    const next = copy(history); if (!next.future.length) return next;
    next.past = [...next.past, copy(next.present)].slice(-next.limit); next.present = next.future.shift(); return next;
  }
  function strokeWidth(displayScale, screenPixels = 2) {
    finite(displayScale, 'displayScale'); finite(screenPixels, 'screenPixels');
    if (displayScale <= 0 || screenPixels <= 0) throw new RangeError('Scale and stroke must be positive');
    return screenPixels / displayScale;
  }
  function badgeBounds(anchor, badge, viewport, padding = 4) {
    const a = point(anchor); finite(padding, 'padding');
    for (const size of [badge, viewport]) { finite(size.width, 'width'); finite(size.height, 'height'); if (size.width <= 0 || size.height <= 0) throw new RangeError('Size must be positive'); }
    if (padding < 0) throw new RangeError('Padding cannot be negative');
    // Reduce padding before reducing the badge; small viewports still get a visible badge.
    const px = Math.min(padding, Math.max(0, (viewport.width - badge.width) / 2));
    const py = Math.min(padding, Math.max(0, (viewport.height - badge.height) / 2));
    const width = Math.min(badge.width, viewport.width - 2 * px), height = Math.min(badge.height, viewport.height - 2 * py);
    return { x: clamp(a.x, px, viewport.width - px - width), y: clamp(a.y, py, viewport.height - py - height), width, height, clipped: width < badge.width || height < badge.height };
  }
  function buildLegend(marks) {
    return marks.filter(mark => mark.type !== 'draft-contour' && (mark.type !== 'contour' || mark.isClosed === true && closedContour(mark.points))).filter(mark => mark.id && mark.code)
      .map(mark => ({ markId: mark.id, code: mark.code, label: mark.label || '', type: mark.type }));
  }
  return { clampPoint, distance, closedContour, signedArea, nearestVertex, moveVertex, removeVertex, moveContour, pointInPolygon, hitTestContour, getNextContourCode,
    createHistory, commitHistory, undoHistory, redoHistory, strokeWidth, badgeBounds, buildLegend, MIN_AREA };
});
