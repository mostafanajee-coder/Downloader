'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * A throwaway self-signed certificate for 127.0.0.1, generated on demand.
 *
 * Deliberately NOT committed to the repository: a checked-in private key is a
 * bad habit even when it only protects a localhost test server, and it tends to
 * trip secret scanners. Generated into the OS temp directory instead, and
 * cached there for the run.
 *
 * Returns `{ key, cert }`, or null when OpenSSL isn't available — callers
 * should skip the TLS-specific assertions rather than fail the suite, since
 * everything else it covers is unrelated to certificates.
 */
let cached;

function selfSignedCert() {
  if (cached !== undefined) return cached;

  const dir = path.join(os.tmpdir(), 'downloader-test-tls');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  try {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048',
          '-keyout', keyPath, '-out', certPath,
          '-days', '2', '-nodes',
          '-subj', '/CN=127.0.0.1',
          '-addext', 'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
      );
    }
    cached = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (err) {
    cached = null;
  }
  return cached;
}

module.exports = { selfSignedCert };
