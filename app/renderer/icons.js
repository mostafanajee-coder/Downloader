'use strict';

// Premium Dual-Tone & Gradient SVGs
const ICONS = {
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4" stroke="url(#accent-grad)"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" stroke="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor"/>',
  pause: '<path d="M8 6h3v12H8zM13 6h3v12h-3z" fill="url(#warning-grad)" stroke="none"/>',
  play: '<path d="M7 5.5v13l11-6.5-11-6.5Z" fill="url(#success-grad)" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="url(#danger-grad)" stroke="none"/>',
  stopAll: '<rect x="4" y="4" width="8" height="8" rx="2" fill="url(#danger-grad)" stroke="none"/><rect x="12" y="12" width="8" height="8" rx="2" fill="url(#danger-grad)" stroke="none"/>',
  x: '<path d="M18 6 6 18M6 6l12 12" stroke="currentColor"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" stroke="currentColor"/>',
  link: '<path d="M9.5 14.5 14.5 9.5M8 12l-2.3 2.3a3 3 0 0 0 4.2 4.2L12.2 16M16 12l2.3-2.3a3 3 0 0 0-4.2-4.2L11.8 8" stroke="currentColor"/>',
  copy: '<path d="M9 9h9v9H9zM6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" stroke="currentColor"/>',
  check: '<path d="M5 12.5 9.5 17 19 7" stroke="url(#success-grad)"/>',
  folder: '<path d="M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6Z" stroke="url(#accent-grad)" fill="rgba(59,130,246,0.1)"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" fill="url(#warning-grad)" stroke="none"/>',
  film: '<path d="M4 5h16v14H4z" stroke="currentColor" fill="rgba(255,255,255,0.05)"/><path d="M4 9h16M4 15h16M8 5v4M8 15v4M16 5v4" stroke="currentColor"/>',
  settings: '<path d="M4 6h10M18 6h2M4 18h2M8 18h12M4 12h6M14 12h6" stroke="currentColor"/><circle cx="16" cy="6" r="2" fill="url(#accent-grad)" stroke="none"/><circle cx="6" cy="18" r="2" fill="url(#accent-grad)" stroke="none"/><circle cx="10" cy="12" r="2" fill="url(#accent-grad)" stroke="none"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2" fill="url(#accent-grad)" stroke="none"/><rect x="13" y="4" width="7" height="7" rx="2" fill="url(#accent-grad)" stroke="none"/><rect x="4" y="13" width="7" height="7" rx="2" fill="url(#accent-grad)" stroke="none"/><rect x="13" y="13" width="7" height="7" rx="2" fill="url(#accent-grad)" stroke="none"/>',
  archive: '<rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" fill="rgba(255,255,255,0.05)"/><path d="M3 7l2-4h14l2 4" stroke="currentColor"/><path d="M10 12h4" stroke="url(#warning-grad)"/>',
  doc: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" fill="rgba(255,255,255,0.05)"/><path d="M14 3v5h5" stroke="currentColor"/>',
  music: '<path d="M9 18V5l11-2v13" stroke="currentColor"/><circle cx="6" cy="18" r="3" fill="url(#accent-grad)" stroke="none"/><circle cx="17" cy="16" r="3" fill="url(#accent-grad)" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9" stroke="currentColor" fill="rgba(255,255,255,0.05)"/><path d="M12 7v5l3 3" stroke="url(#warning-grad)"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" fill="rgba(255,255,255,0.05)"/><line x1="16" y1="2" x2="16" y2="6" stroke="currentColor"/><line x1="8" y1="2" x2="8" y2="6" stroke="currentColor"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor"/>',
  queue: '<path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor"/>',
  exe: '<rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" fill="rgba(255,255,255,0.05)"/><path d="M8 8l4 4-4 4" stroke="url(#success-grad)"/><path d="M14 16h2" stroke="currentColor"/>',
};

const DEFS = `
  <defs>
    <linearGradient id="accent-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#60a5fa" />
      <stop offset="100%" stop-color="#3b82f6" />
    </linearGradient>
    <linearGradient id="success-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#10b981" />
    </linearGradient>
    <linearGradient id="warning-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="100%" stop-color="#f59e0b" />
    </linearGradient>
    <linearGradient id="danger-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f87171" />
      <stop offset="100%" stop-color="#ef4444" />
    </linearGradient>
  </defs>
`;

function icon(name, size = 20) {
  const body = ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${DEFS}${body}</svg>`;
}
