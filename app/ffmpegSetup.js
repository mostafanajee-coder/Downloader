'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');
const { spawn } = require('child_process');

const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function checkFFmpeg() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function ensureFFmpeg() {
  const isInstalled = await checkFFmpeg();
  if (isInstalled) return 'ffmpeg'; // System ffmpeg is available

  const binDir = path.join(app.getPath('userData'), 'bin');
  const ffmpegExe = path.join(binDir, 'ffmpeg.exe');

  if (fs.existsSync(ffmpegExe)) return ffmpegExe;

  console.log('FFmpeg not found in PATH. Downloading local copy...');
  fs.mkdirSync(binDir, { recursive: true });

  // In a real production app, we would download the zip, extract it, and place ffmpeg.exe here.
  // For this prototype, we'll just log a warning that the user needs ffmpeg in their PATH.
  console.warn('Please install FFmpeg or place ffmpeg.exe in:', binDir);
  return 'ffmpeg';
}

module.exports = { ensureFFmpeg };
