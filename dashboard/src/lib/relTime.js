// Coarse relative time for history rows and monitor notices. Accepts a
// ms-epoch number (localStorage history) or an ISO string (backend payloads).
export function relTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
