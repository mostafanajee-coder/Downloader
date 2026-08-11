'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Merges a list of .ts or .m4s fragments into a single MP4 file.
 * Uses fast FFmpeg copy if available, or zero-dependency Native Stream Concatenation fallback.
 * @param {string[]} fragmentPaths - Array of absolute paths to the video chunks.
 * @param {string} outputPath - The final output .mp4 file path.
 * @returns {Promise<void>}
 */
async function mergeFragments(fragmentPaths, outputPath) {
  if (!fragmentPaths || fragmentPaths.length === 0) {
    throw new Error('No fragments to merge');
  }

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  // Test if FFmpeg is available
  const hasFFmpeg = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });

  if (hasFFmpeg) {
    // Attempt FFmpeg fast concat
    const listPath = outputPath + '.list.txt';
    const listContent = fragmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');

    try {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          outputPath,
        ]);

        ffmpeg.on('error', reject);
        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });
      });

      // Cleanup
      try { fs.unlinkSync(listPath); } catch (e) {}
      fragmentPaths.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
      return;
    } catch (err) {
      console.warn('[VideoMerger] FFmpeg concat failed, falling back to Native Stream Concatenation:', err.message);
    }
  }

  // 100% Zero-Dependency Fallback: Native Stream Concatenation (IDM Style)
  console.log('[VideoMerger] Merging fragments via Native Binary Stream Concatenation...');
  const outStream = fs.createWriteStream(outputPath);

  for (const fragPath of fragmentPaths) {
    if (fs.existsSync(fragPath)) {
      await new Promise((resolve, reject) => {
        const inStream = fs.createReadStream(fragPath);
        inStream.pipe(outStream, { end: false });
        inStream.on('end', resolve);
        inStream.on('error', reject);
      });
      try { fs.unlinkSync(fragPath); } catch (e) {}
    }
  }

  outStream.end();
}

/**
 * Merges separate audio and video files into a single unified .mp4 file.
 */
async function mergeAudioVideo(videoPath, audioPath, outputPath) {
  const hasFFmpeg = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });

  if (hasFFmpeg) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'copy',
        outputPath
      ]);
      ffmpeg.on('error', reject);
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`))));
    });
  } else {
    // If no FFmpeg, append audio after video or output video file
    fs.copyFileSync(videoPath, outputPath);
  }
}

module.exports = { mergeFragments, mergeAudioVideo };
