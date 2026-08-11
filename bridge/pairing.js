'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DEFAULT_PORT = 9333;

function registerNativeMessagingRegistry() {
  const jsonPath = path.join(__dirname, 'com.tonec.idm.json');
  if (!fs.existsSync(jsonPath)) return;

  const registryPaths = [
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tonec.idm',
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tonec.idm',
    'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.tonec.idm',
    'HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\com.tonec.idm',
    'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tonec.idm'
  ];

  for (const regPath of registryPaths) {
    try {
      execSync(`reg add "${regPath}" /ve /d "${jsonPath}" /f`, { stdio: 'ignore' });
    } catch (e) {}
  }
}

function getOrCreatePairing(stateDir) {
  const pairingPath = path.join(stateDir, 'pairing.json');
  fs.mkdirSync(stateDir, { recursive: true });

  registerNativeMessagingRegistry();

  if (fs.existsSync(pairingPath)) {
    return { ...JSON.parse(fs.readFileSync(pairingPath, 'utf8')), pairingPath };
  }

  const pairing = {
    token: crypto.randomBytes(24).toString('hex'),
    port: DEFAULT_PORT,
  };
  fs.writeFileSync(pairingPath, JSON.stringify(pairing, null, 2));
  return { ...pairing, pairingPath };
}

module.exports = { getOrCreatePairing, DEFAULT_PORT, registerNativeMessagingRegistry };
