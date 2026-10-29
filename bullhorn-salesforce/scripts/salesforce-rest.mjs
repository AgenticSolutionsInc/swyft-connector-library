#!/usr/bin/env node
/**
 * Direct Salesforce REST helper for OpenClaw.
 * - Uses OAuth 2.0 Client Credentials for each invocation.
 * - Supports safe read operations and confirmed create/update operations.
 * - Intentionally does not implement DELETE.
 * 
 * node salesforce-rest.mjs query --soql 'SELECT Id, Name FROM Lead ORDER BY LastModifiedDate DESC LIMIT 5'
 */

import fs from "node:fs";
import { loadConfig } from "./load-config.mjs";

const [action, ...argv] = process.argv.slice(2 );
const args = {};
for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index];
  if (!['--soql', '--object', '--id', '--body-file', '--confirm', '--env-file'].includes(flag)
      || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('Invalid arguments. See --help.');
  if (args[flag.slice(2)] !== undefined) fail(`Duplicate argument: ${flag}`);
  args[flag.slice(2)] = argv[index + 1];
}
if (!action || ['help', '--help', '-h'].includes(action)) {
  console.log(`Usage: node salesforce-rest.mjs ACTION [options]
  query --soql "SELECT Id, Name FROM Contact LIMIT 10"
  describe --object OBJECT
  get --object OBJECT --id RECORD_ID
  create --object OBJECT --body-file payload.json --confirm yes
  update --object OBJECT --id RECORD_ID --body-file payload.json --confirm yes
All actions accept --env-file PATH. Environment: SALESFORCE_TOKEN_URL,
SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET. Optional BULLHORN_ENV_FILE.
Queries follow all result pages. No delete operation is implemented.`);
  process.exit(0);
}
if (!['query', 'describe', 'get', 'create', 'update'].includes(action)) {
  fail('Use one of: query, describe, get, create, update. Delete is not supported.');
}
try { loadConfig(args['env-file']); } catch { fail('Could not load the environment file. Check its path and format.'); }
let session;
let apiBase;

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`Missing required environment variable: ${name}`);
  return value;
}

function validateObject(name) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name ?? "")) {
    fail("Object API name may contain only letters, digits, and underscores.");
  }
  return name;
}

function validateId(id) {
  if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id ?? "")) {
    fail("Record ID must be a 15- or 18-character Salesforce ID.");
  }
  return id;
}

function requireConfirmedWrite() {
  if (args.confirm !== "yes") {
    fail("Write operation blocked. Ensure the target and payload are authorized by the user, then pass --confirm yes. Prior explicit authorization can satisfy this requirement.");
  }
}

function readBody() {
  if (!args["body-file"]) fail("--body-file is required for a write operation.");
  try {
    const body = JSON.parse(fs.readFileSync(args["body-file"], "utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") {
      fail("The body file must contain one JSON object.");
    }
    return body;
  } catch (error) {
    fail(`Could not read a valid JSON body file: ${error.message}`);
  }
}

async function request(url, options, context = "Salesforce request") {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    fail('Could not reach Salesforce (network, redirect, or timeout).');
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 1000) };
  }
  if (!response.ok) {
    const errors = Array.isArray(payload) ? payload.map(item => item.errorCode).filter(Boolean) : [payload.error].filter(Boolean);
    fail(`${context} returned HTTP ${response.status}${errors.length ? ` (${errors.join(', ')})` : ''}.`);
  }
  return payload;
}

async function obtainAccessToken() {
  const tokenUrl = requireEnv("SALESFORCE_TOKEN_URL");
  validateHttpsUrl(tokenUrl);
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requireEnv("SALESFORCE_CLIENT_ID"),
    client_secret: requireEnv("SALESFORCE_CLIENT_SECRET"),
  });
  const token = await request(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form,
  }, "Salesforce token request");
  if (!token.access_token || !token.instance_url) {
    fail("Salesforce token response did not include access_token and instance_url.");
  }
  validateHttpsUrl(token.instance_url);
  return { accessToken: token.access_token, instanceUrl: token.instance_url.replace(/\/$/, "") };
}

function validateHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('Salesforce configuration contains an invalid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('Salesforce URLs must use HTTPS without embedded credentials.');
}

async function discoverApiBase(instanceUrl, accessToken) {
  const versions = await request(`${instanceUrl}/services/data/`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  }, "Salesforce API version discovery");

  const candidates = Array.isArray(versions)
    ? versions.filter(
        (entry) =>
          typeof entry.version === "string" &&
          typeof entry.url === "string" &&
          /^\d+\.\d+$/.test(entry.version),
      )
    : [];

  candidates.sort((left, right) => Number(right.version) - Number(left.version));

  if (!candidates[0]) {
    fail("Salesforce did not return an available REST API version.");
  }

  return candidates[0].url.replace(/\/$/, "");
}

async function rest(path, method = "GET", body) {
  session ??= await obtainAccessToken();
  const { accessToken, instanceUrl } = session;
  apiBase ??= await discoverApiBase(instanceUrl, accessToken);

  return request(`${instanceUrl}${apiBase}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, `Salesforce REST operation (${apiBase}/${path})`);
}

async function queryAll(soql) {
  const result = await rest(`query?q=${encodeURIComponent(soql)}`);
  let page = result;
  const seen = new Set();
  while (page.done === false) {
    const next = page.nextRecordsUrl;
    if (typeof next !== 'string' || !/^\/services\/data\/v\d+\.\d+\/query\/[A-Za-z0-9_-]+$/.test(next) || seen.has(next)) {
      fail('Salesforce returned an invalid or repeated query pagination URL.');
    }
    seen.add(next);
    page = await request(`${session.instanceUrl}${next}`, {
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
    }, 'Salesforce query pagination');
    if (!Array.isArray(page.records)) fail('Salesforce returned an invalid query page.');
    result.records.push(...page.records);
  }
  result.done = true;
  delete result.nextRecordsUrl;
  return result;
}

let result;
switch (action) {
  case "query":
    if (!args.soql) fail("query requires --soql.");
    result = await queryAll(args.soql);
    break;
  case "describe":
    result = await rest(`sobjects/${validateObject(args.object)}/describe`);
    break;
  case "get":
    result = await rest(`sobjects/${validateObject(args.object)}/${validateId(args.id)}`);
    break;
  case "create":
    requireConfirmedWrite();
    result = await rest(`sobjects/${validateObject(args.object)}`, "POST", readBody());
    break;
  case "update":
    requireConfirmedWrite();
    result = await rest(
      `sobjects/${validateObject(args.object)}/${validateId(args.id)}`,
      "PATCH",
      readBody(),
    );
    break;
  default:
    fail("Use one of: query, describe, get, create, update.");
}

process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
