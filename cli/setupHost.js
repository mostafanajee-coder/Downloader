'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('=== IDM Twin: Native Messaging Setup ===');
console.log('To connect the extension to the desktop app seamlessly, we need your Extension ID.');
console.log('1. Go to chrome://extensions/');
console.log('2. Find "IDM Integration Module Twin"');
console.log('3. Copy the ID (e.g. abcdefghijklmnopqrstuvwxyz123456)\\n');

rl.question('Enter Extension ID: ', (extId) => {
  extId = extId.trim();
  if (!extId) {
    console.error('Extension ID is required!');
    process.exit(1);
  }

  const manifest = {
    name: "com.twin.idm",
    description: "IDM Twin Native Messaging Host",
    path: "nativeHost.bat",
    type: "stdio",
    allowed_origins: [
      `chrome-extension://${extId}/`
    ]
  };

  const appDir = path.join(__dirname, '..', 'app');
  const manifestPath = path.join(appDir, 'com.twin.idm.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Write a batch wrapper because Chrome on Windows needs an .exe or .bat for the host
  const batPath = path.join(appDir, 'nativeHost.bat');
  fs.writeFileSync(batPath, `@echo off\r\nnode "%~dp0nativeHost.js"`);

  console.log('\\nGenerated Native Host Manifest:', manifestPath);
  console.log('Generated Batch Wrapper:', batPath);

  // Register in Windows Registry
  console.log('\\nRegistering in Windows Registry...');
  const regKeyPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.twin.idm`;
  
  try {
    const regCmd = `REG ADD "${regKeyPath}" /ve /t REG_SZ /d "${manifestPath}" /f`;
    execSync(regCmd, { stdio: 'inherit' });
    
    // Also register for Edge just in case
    const edgeRegKeyPath = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.twin.idm`;
    const edgeRegCmd = `REG ADD "${edgeRegKeyPath}" /ve /t REG_SZ /d "${manifestPath}" /f`;
    execSync(edgeRegCmd, { stdio: 'inherit' });
    
    console.log('\\n✅ Registration Successful!');
    console.log('You can now reload the extension in chrome://extensions and it will connect via Native Messaging!');
  } catch (err) {
    console.error('\\n❌ Registration failed. Are you running on Windows?', err.message);
  }

  rl.close();
});
