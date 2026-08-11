'use strict';

const EXT_CATEGORY = {
  mp4: 'Video', mkv: 'Video', avi: 'Video', mov: 'Video', webm: 'Video', ts: 'Video', flv: 'Video', wmv: 'Video', m3u8: 'Video', mpd: 'Video',
  zip: 'Compressed', rar: 'Compressed', '7z': 'Compressed', tar: 'Compressed', gz: 'Compressed', iso: 'Compressed',
  pdf: 'Documents', doc: 'Documents', docx: 'Documents', xls: 'Documents', xlsx: 'Documents', ppt: 'Documents', pptx: 'Documents', txt: 'Documents',
  mp3: 'Music', wav: 'Music', flac: 'Music', aac: 'Music', ogg: 'Music', m4a: 'Music',
  exe: 'Programs', msi: 'Programs', apk: 'Programs', setup: 'Programs',
};

function getCategoryForUrl(url, kind, suggestedFilename) {
  if (kind === 'hls' || kind === 'dash') return 'Video';
  const name = suggestedFilename || url || '';
  // Extract extension, ignoring query parameters
  const ext = name.split('.').pop().toLowerCase().split('?')[0];
  return EXT_CATEGORY[ext] || 'General';
}

module.exports = { EXT_CATEGORY, getCategoryForUrl };
