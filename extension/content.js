'use strict';

const BTN_CLASS = 'ddl-float-btn';
const MENU_CLASS = 'ddl-float-menu';

function getPageTitle() {
  let title = '';
  try { title = window.top.document.title; } catch(e) {}
  if (!title) {
    try { title = document.title; } catch(e) {}
  }
  if (!title) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) title = ogTitle.getAttribute('content');
  }
  if (!title) {
    const h1 = document.querySelector('h1');
    if (h1) title = h1.textContent;
  }
  return title;
}

function cleanTitle(title) {
  if (!title) return '';
  title = title.replace(/^\(\d+\)\s*/, '').replace(/[ \t\r\n\u25B6]+/g, ' ').trim();
  return title
    .replace(/[-|_]?(مشاهدة|تحميل|اون لاين|فاصل اعلاني|FaselHD|Fasel|شاهد|انمي|مترجم).*/ig, '')
    .replace(/[\/\\?%*:|"<>]/g, '')
    .trim() || '';
}

// 1. Recursive Shadow DOM & DOM Video Scanner
function findVideosRecursive(root = document) {
  let results = [];
  try {
    const videos = Array.from(root.querySelectorAll('video, audio'));
    results.push(...videos);

    // Deep Shadow DOM traversal
    const allNodes = Array.from(root.querySelectorAll('*'));
    for (const node of allNodes) {
      if (node.shadowRoot) {
        results.push(...findVideosRecursive(node.shadowRoot));
      }
    }
  } catch (e) {}
  return results;
}

function positionOverlay(overlay, video) {
  const rect = video.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 15) {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';
  overlay.style.top = `${window.scrollY + rect.top + 8}px`;
  overlay.style.left = `${window.scrollX + rect.right - 185}px`;
  overlay.style.zIndex = '2147483647';
}

function closeMenus() {
  document.querySelectorAll(`.${MENU_CLASS}`).forEach((m) => m.remove());
}

async function buildMenuItems(video) {
  const items = [];
  let bgItems = [];
  let subtitles = [];

  try {
    const sendMessagePromise = chrome.runtime.sendMessage({ type: 'get-media-for-tab' });
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
    const res = await Promise.race([sendMessagePromise, timeoutPromise]);
    if (res) {
      bgItems = res.items || [];
      subtitles = res.subtitles || [];
    }
  } catch (e) {}

  if (bgItems.length) {
    items.push(...bgItems);
  }

  // Inspect direct video source
  const directSrc = video.currentSrc || video.src || video.querySelector('source')?.src;
  const titleClean = cleanTitle(getPageTitle());

  if (directSrc && !directSrc.startsWith('blob:') && !items.some((i) => i.url === directSrc)) {
    let fn = null;
    try {
      const last = new URL(directSrc).pathname.split('/').pop();
      if (last && /\.(mp4|webm)$/i.test(last)) fn = decodeURIComponent(last);
    } catch(e) {}
    items.push({ label: `${fn || titleClean || 'Video'} - Direct MP4 Video`, kind: 'file', url: directSrc });
  }

  // Inspect page performance resources for media streams
  try {
    const resources = performance.getEntriesByType('resource');
    for (const res of resources) {
      const u = res.name;
      if (u && (u.includes('.mp4') || u.includes('.m3u8') || u.includes('.webm') || u.includes('videoplayback') || u.includes('mime=video')) && !u.startsWith('blob:')) {
        const cleanU = u.replace(/&range=\d+-\d+/i, '').replace(/&bytestart=\d+/i, '');
        if (!items.some((i) => i.url === cleanU)) {
          const isHls = cleanU.includes('.m3u8');
          items.push({
            label: `${titleClean || 'Video'} - Captured ${isHls ? 'HLS Stream' : 'Video Stream'}`,
            kind: isHls ? 'hls' : 'file',
            url: cleanU,
          });
        }
      }
    }
  } catch (e) {}

  // Fallback: Guarantee no empty list
  if (!items.length) {
    const fallbackUrl = (directSrc && !directSrc.startsWith('blob:')) ? directSrc : window.location.href;
    items.push({
      label: `${titleClean || 'Video'} - Download Page Video Stream`,
      kind: fallbackUrl.includes('.m3u8') ? 'hls' : 'file',
      url: fallbackUrl,
    });
  }

  const subItems = [];
  video.querySelectorAll('track').forEach((track) => {
    if (track.src) {
      subItems.push({ label: `Subtitle: ${track.label || track.srclang || 'unknown'}`, kind: 'file', url: track.src });
    }
  });
  for (const sub of subtitles) {
    if (!subItems.some((s) => s.url === sub.url)) {
      subItems.push({ label: `Subtitle: ${sub.url.split('/').pop()}`, kind: 'file', url: sub.url });
    }
  }

  return { items, subItems };
}

async function onButtonClick(video, btn) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.style.zIndex = '2147483647';
  menu.textContent = 'Scanning available video qualities...';
  document.body.appendChild(menu);
  positionMenu(menu, btn);

  menu.addEventListener('mouseleave', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest(`.${BTN_CLASS}`)) {
      setTimeout(closeMenus, 300);
    }
  });

  const { items, subItems } = await buildMenuItems(video);
  menu.innerHTML = '';

  if (!items.length) {
    menu.innerHTML = '<div class="ddl-menu-empty">No video link captured yet</div>';
  }

  const pageTitleClean = cleanTitle(getPageTitle());

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'ddl-menu-item';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';

    const kindBadge = (item.kind || 'FILE').toUpperCase();
    
    const labelSpan = document.createElement('span');
    labelSpan.textContent = item.label;
    labelSpan.style.flex = '1';

    const actionsContainer = document.createElement('div');
    actionsContainer.style.display = 'flex';
    actionsContainer.style.gap = '6px';
    actionsContainer.style.alignItems = 'center';

    // Copy Link Action Button
    const copyBtn = document.createElement('button');
    copyBtn.innerHTML = '📋';
    copyBtn.title = 'Copy Media URL';
    copyBtn.style.background = 'none';
    copyBtn.style.border = 'none';
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.fontSize = '12px';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(item.url);
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
    });

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'ddl-menu-badge';
    badgeSpan.textContent = kindBadge;

    actionsContainer.appendChild(copyBtn);
    actionsContainer.appendChild(badgeSpan);

    row.appendChild(labelSpan);
    row.appendChild(actionsContainer);

    row.addEventListener('click', async () => {
      labelSpan.textContent = `${item.label} — sending...`;
      const res = await chrome.runtime.sendMessage({
        type: 'download-media',
        url: item.url,
        kind: item.kind,
        variantIndex: item.variantIndex,
        title: pageTitleClean,
      });
      labelSpan.textContent = res?.sent ? `${item.label} ✓ Sent to IDM` : `${item.label} — IDM not connected`;
      setTimeout(closeMenus, 1200);
    });
    menu.appendChild(row);
  }

  if (subItems.length) {
    const sep = document.createElement('div');
    sep.className = 'ddl-menu-sep';
    sep.textContent = 'Subtitles';
    menu.appendChild(sep);
    for (const item of subItems) {
      const row = document.createElement('div');
      row.className = 'ddl-menu-item';
      row.textContent = item.label;
      row.addEventListener('click', async () => {
        row.textContent = `${item.label} — sending...`;
        const res = await chrome.runtime.sendMessage({ type: 'download-media', url: item.url, kind: 'file', title: `${pageTitleClean}_sub` });
        row.textContent = res?.sent ? `${item.label} ✓ Sent to IDM` : `${item.label} — IDM not connected`;
        setTimeout(closeMenus, 1200);
      });
      menu.appendChild(row);
    }
  }
}

function positionMenu(menu, btn) {
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${window.scrollY + rect.bottom + 4}px`;
  menu.style.left = `${window.scrollX + rect.left}px`;
}

function attachOverlay(video) {
  if (video.dataset.ddlAttached || video.dataset.ddlDismissed) return;
  video.dataset.ddlAttached = '1';

  const allVideos = findVideosRecursive();
  const countTag = allVideos.length > 1 ? ` (${allVideos.length})` : '';

  const btn = document.createElement('div');
  btn.className = BTN_CLASS;
  btn.innerHTML = `
    <span class="ddl-btn-main">
      <svg class="idm-icon" viewBox="0 0 24 24"><path d="M7 5.5v13l11-6.5-11-6.5Z"/></svg>
      Download this video${countTag}
    </span>
    <span class="ddl-btn-help" title="IDM Panel Help">?</span>
    <span class="ddl-btn-close" title="Hide panel">×</span>
  `;
  btn.title = 'Internet Download Manager Panel';
  document.body.appendChild(btn);

  const reposition = () => {
    if (video.dataset.ddlDismissed) {
      btn.remove();
      return;
    }
    positionOverlay(btn, video);
  };
  reposition();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  new ResizeObserver(reposition).observe(video);

  const mainBtn = btn.querySelector('.ddl-btn-main');
  const closeBtn = btn.querySelector('.ddl-btn-close');

  let hoverTimer = null;

  btn.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      onButtonClick(video, btn);
    }, 100);
  });

  btn.addEventListener('mouseleave', (e) => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!e.relatedTarget || !e.relatedTarget.closest(`.${MENU_CLASS}`)) {
        closeMenus();
      }
    }, 400);
  });

  mainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onButtonClick(video, btn);
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenus();
    video.dataset.ddlDismissed = '1';
    btn.remove();
  });
}

function scan() {
  findVideosRecursive().forEach(attachOverlay);
}

document.addEventListener('click', (e) => {
  if (!e.target.closest(`.${MENU_CLASS}`) && !e.target.closest(`.${BTN_CLASS}`)) closeMenus();
});

scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
