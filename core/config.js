'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  startup: false,
  autoClipboard: false,
  // General tab — browser integration toggles (the extension covers Chromium).
  integration: {
    chrome: true,
    edge: true,
    firefox: false,
    brave: false
  },
  fileTypes: '3GP 7Z AAC ACE AIF APK ARJ ASF AVI BIN BZ2 EXE GZ GZIP IMG ISO LZH M4A M4V MKV MOV MP3 MP4 MPA MPE MPEG MPG MSI MSU OGG OGV PDF PLJ PPS PPT QT R0* R1* RA RAR RM RMVB SEA SIT SITX TAR TIF TIFF WAV WMA WMV Z ZIP 7Z ISO SRT VTT ASS SUB M2TS TS M3U8 M3U WEBM FLV MPD F4M TTML',
  excludedSites: '*.update.microsoft.com download.windowsupdate.com *.download.windowsupdate.com siteseal.thawte.com ecom.cimetz.com *.voice2page.com 192.168.100.148 localhost chatgpt.com chat.openai.com',
  destDirs: {
    General: path.join(app.getPath('downloads'), 'General'),
    Compressed: path.join(app.getPath('downloads'), 'Compressed'),
    Documents: path.join(app.getPath('downloads'), 'Documents'),
    Music: path.join(app.getPath('downloads'), 'Music'),
    Programs: path.join(app.getPath('downloads'), 'Programs'),
    Video: path.join(app.getPath('downloads'), 'Video')
  },
  // Save To tab — temporary folder for in-progress segments/remuxing.
  tempDir: path.join(app.getPath('temp'), 'IDM_Temp'),
  rememberLast: true,
  showStartDialog: true,
  showCompleteDialog: true,
  duplicateAction: 'ask',
  // Connection tab.
  connectionType: 'High speed (LAN, cable, DSL)',
  maxConnections: 8,
  maxConcurrentDownloads: 4,
  speedLimitKBps: 0,
  // The limiter is a toggle with a remembered value, like IDM's: switching it
  // off keeps the KB/s figure so switching back on needs no retyping.
  speedLimiterEnabled: false,
  downloadLimits: false,
  // Scheduler (main-process; see core/scheduler.js for the shape).
  schedule: {
    enabled: false,
    queueId: 'main',
    startTime: null,
    stopTime: null,
    days: [0, 1, 2, 3, 4, 5, 6],
    onComplete: 'none',
    quota: { enabled: false, mb: 200, hours: 5 },
  },
  // Site Logins: [{ host: 'nas.local' | '*.example.com', username, password }].
  siteLogins: [],
  // Escape hatch for self-signed certificates (a home NAS, a corporate MITM
  // proxy). Off by default: certificates are verified, because these requests
  // replay the session cookies the browser extension captured.
  allowInsecureTLS: false,
  // Proxy tab. mode: 'direct' | 'manual' | 'pac'. Empty host = that protocol
  // is not proxied; exceptions are shell globs matched against the hostname.
  proxy: {
    mode: 'direct',
    http: { host: '', port: 8080, username: '', password: '' },
    https: { host: '', port: 8080, username: '', password: '' },
    ftp: { host: '', port: 8080, username: '', password: '' },
    socks: { host: '', port: 1080, username: '', password: '', remoteDns: true },
    useSocksForAll: false,
    exceptions: '<local> localhost 127.0.0.1 192.168.*',
    pacUrl: '',
  },
  // Sounds tab — play a tone on these events.
  sounds: {
    complete: true,
    error: true,
    queueComplete: false
  },
  lastUsedCategory: 'General'
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Saved values over defaults, recursively for nested sections. A plain spread
 * replaced whole sections: a config saved before `schedule.quota` existed came
 * back with no quota at all, and every new nested setting was silently missing
 * for existing users until they happened to re-save that dialog.
 */
function mergeWithDefaults(defaults, saved) {
  if (!isPlainObject(saved)) return defaults;
  const out = { ...defaults };
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(defaults[key]) && isPlainObject(value) ? mergeWithDefaults(defaults[key], value) : value;
  }
  return out;
}

class ConfigManager {
  constructor(stateDir) {
    this.configPath = path.join(stateDir, 'config.json');
    this.config = mergeWithDefaults(DEFAULT_CONFIG, {});
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        this.config = mergeWithDefaults(DEFAULT_CONFIG, JSON.parse(data));
      }
    } catch (e) {
      console.error('Failed to load config', e);
      // Keep the unreadable file for inspection instead of overwriting the
      // user's settings with defaults on the next save.
      try {
        fs.copyFileSync(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
      } catch (copyErr) {
        /* nothing more we can do */
      }
    }
    this.applySystemSettings();
  }

  save() {
    try {
      // Write-then-rename, like the download sidecars: a crash mid-write used
      // to leave truncated JSON and every setting reset on the next launch.
      const tmp = `${this.configPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf8');
      fs.renameSync(tmp, this.configPath);
      this.applySystemSettings();
    } catch (e) {
      console.error('Failed to save config', e);
    }
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
    this.save();
  }

  setAll(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.save();
  }
  
  getAll() {
    return this.config;
  }

  applySystemSettings() {
    // Apply Startup setting
    try {
      const currentSettings = app.getLoginItemSettings();
      if (Boolean(this.config.startup) !== currentSettings.openAtLogin) {
        app.setLoginItemSettings({
          openAtLogin: Boolean(this.config.startup),
          openAsHidden: true,
          // Launched at login, the app belongs in the tray, not in the user's face.
          args: this.config.startup ? ['--hidden'] : [],
        });
      }
    } catch (e) {
      console.warn('Could not update the start-with-Windows setting:', e.message);
    }
  }
}

module.exports = { ConfigManager, DEFAULT_CONFIG, mergeWithDefaults };
