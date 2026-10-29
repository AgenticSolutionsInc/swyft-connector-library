#!/usr/bin/env node
/**
 * Read-only Bullhorn Contact Document downloads using Salesforce client credentials.
 * Uses the same .env as salesforce-rest.mjs; requires Node.js 22+ and no packages.
 *
 * node bullhorn-documents.mjs url --id a0BPn00000RNQBxMAP
 * node bullhorn-documents.mjs download --id a0BPn00000RNQBxMAP --output downloads/resume.docx
 *
 * `url` prints a temporary, signed URL. Treat that URL as a credential until it expires.
 * `download` streams bytes to disk and never overwrites an existing destination.
 */

import { createWriteStream } from 'node:fs';
import { access, link, mkdir, mkdtemp, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './load-config.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HELP = `Usage:
  node bullhorn-documents.mjs url --id CONTACT_DOCUMENT_ID
  node bullhorn-documents.mjs download --id CONTACT_DOCUMENT_ID --output FILE

Authenticates automatically with SALESFORCE_TOKEN_URL, SALESFORCE_CLIENT_ID,
and SALESFORCE_CLIENT_SECRET from the environment or .env in the working directory.
Both commands accept --env-file PATH (or set BULLHORN_ENV_FILE).
Outputs JSON; errors go to stderr. No Salesforce records are changed.
Existing output files are never overwritten. Temporary URLs expire; request a new one when needed.`;

function httpsUrl(value, context) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${context} is not a valid URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${context} must be an HTTPS URL without embedded credentials.`);
  }
  return url;
}

async function request(url, options, context) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${context} returned HTTP ${response.status}.`);
    }
    return response;
  } catch (error) {
    // Do not echo response bodies, credentials, or signed URLs in errors.
    if (error.message.startsWith(`${context} returned HTTP `)) throw error;
    throw new Error(`${context} failed (network, redirect, or timeout).`);
  }
}

async function temporaryUrl(documentId, envFile) {
  try { loadConfig(envFile); } catch { throw new Error('Could not load the environment file. Check its path and format.'); }
  const required = ['SALESFORCE_TOKEN_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  const tokenResponse = await request(
    httpsUrl(process.env.SALESFORCE_TOKEN_URL, 'Salesforce token URL'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SALESFORCE_CLIENT_ID,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET,
      }),
    },
    'Salesforce authentication',
  );
  const token = await tokenResponse.json();
  if (!token.access_token || !token.instance_url) {
    throw new Error('Salesforce did not return an access token and instance URL.');
  }
  const endpoint = new URL(
    `/services/apexrest/TR1/api/v1/contact-documents/${documentId}/public-url`,
    httpsUrl(token.instance_url, 'Salesforce instance URL'),
  );
  const response = await request(endpoint, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  }, 'Bullhorn temporary download URL request');
  const text = (await response.text()).trim();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (typeof value !== 'string') throw new Error('Bullhorn did not return a temporary download URL.');
  return httpsUrl(value, 'Bullhorn download URL').href;
}

async function download(url, destination) {
  const folder = path.dirname(destination);
  await mkdir(folder, { recursive: true });
  const temporaryFolder = await mkdtemp(path.join(folder, '.bullhorn-download-'));
  const temporaryFile = path.join(temporaryFolder, 'document');
  try {
    // Follow HTTPS redirects manually. Never send the Salesforce bearer token to file storage.
    let currentUrl = url;
    let response;
    for (let attempt = 0; attempt <= 5; attempt++) {
      response = await fetch(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || attempt === 5) throw new Error('Too many or invalid file download redirects.');
      currentUrl = httpsUrl(new URL(location, currentUrl).href, 'Download redirect').href;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`File download returned HTTP ${response.status}.`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryFile, { flags: 'wx', mode: 0o600 }));
    const size = (await stat(temporaryFile)).size;
    if (!size) throw new Error('Downloaded file is empty.');
    const expected = response.headers.get('content-length');
    if (expected !== null && !response.headers.get('content-encoding') && Number(expected) !== size) {
      throw new Error('Downloaded size does not match Content-Length.');
    }
    // Publish the completed file atomically, failing if the destination already exists.
    await link(temporaryFile, destination);
    return { output: destination, bytes: size, contentType: response.headers.get('content-type') };
  } finally {
    await unlink(temporaryFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(temporaryFolder);
  }
}

async function main() {
  const [action, ...argv] = process.argv.slice(2);
  if (!action || ['--help', '-h', 'help'].includes(action)) {
    console.log(HELP);
    return;
  }
  if (!['url', 'download'].includes(action)) throw new Error('Use url or download. See --help.');
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--id', '--output', '--env-file'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Expected --id DOCUMENT_ID and, for downloads, --output FILE.');
    }
    if (args[flag]) throw new Error(`Duplicate argument: ${flag}`);
    args[flag] = argv[i + 1];
  }
  if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(args['--id'] ?? '')) {
    throw new Error('--id must be a 15- or 18-character Contact Document record ID.');
  }
  if (action === 'url' && args['--output']) throw new Error('--output is only supported for download.');
  let destination;
  if (action === 'download') {
    if (!args['--output']) throw new Error('download requires --output FILE.');
    destination = path.resolve(args['--output']);
    try {
      await access(destination);
      throw new Error('Output already exists; choose a different --output file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const url = await temporaryUrl(args['--id'], args['--env-file']);
  const result = action === 'url' ? { url } : await download(url, destination);
  console.log(JSON.stringify({ ok: true, documentId: args['--id'], ...result }, null, 2));
}

main().catch(error => {
  const message = error.code === 'EEXIST' ? 'Output already exists; choose a different --output file.'
    : (error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'Request or file transfer failed (network or timeout).'
      : error.message;
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
