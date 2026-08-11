'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  startup: false,
  autoClipboard: false,
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
  rememberLast: true,
  showStartDialog: true,
  showCompleteDialog: true,
  duplicateAction: 'ask',
  maxConnections: 8,
  downloadLimits: false,
  lastUsedCategory: 'General'
};

class ConfigManager {
  constructor(stateDir) {
    this.configPath = path.join(stateDir, 'config.json');
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(data);
        this.config = { ...this.config, ...parsed };
      }
    } catch (e) {
      console.error('Failed to load config', e);
    }
    this.applySystemSettings();
  }

  save() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
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
    const currentSettings = app.getLoginItemSettings();
    if (this.config.startup !== currentSettings.openAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: this.config.startup,
        openAsHidden: true
      });
    }
  }
}

module.exports = { ConfigManager };
