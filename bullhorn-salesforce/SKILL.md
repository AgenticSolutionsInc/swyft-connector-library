---
name: bullhorn-salesforce
description: Query, create, and update Bullhorn for Salesforce records and download Contact Documents using Salesforce OAuth client credentials. Use for Talent Rover or Bullhorn Recruitment Cloud on Salesforce; not the separate Bullhorn ATS/CRM REST API. Does not support deleting records.
---

# Bullhorn for Salesforce

Use the bundled Node.js scripts for SOQL, schema discovery, single-record reads, authorized creates/updates, and Contact Document downloads. Requires Node.js 22.15+ with `process.loadEnvFile`, internet access, and no npm packages or Salesforce CLI login.

## Credentials and execution

Run scripts by absolute path from this skill's `scripts/` directory. Examples below assume the current directory is the skill folder. Keep payloads and downloads in the user's workspace, not the installed skill.

Required environment variables:

```text
SALESFORCE_TOKEN_URL=https://YOUR_DOMAIN.my.salesforce.com/services/oauth2/token
SALESFORCE_CLIENT_ID=...
SALESFORCE_CLIENT_SECRET=...
```

Provide credentials in the environment, pass `--env-file /absolute/path/to/.env` on either script, or set `BULLHORN_ENV_FILE`. Otherwise scripts optionally load `.env` from the current working directory. Existing environment variables take precedence. Do not put credentials, tokens, signed URLs, or candidate records in this skill. If you are currently inside an openclaw runtime, then you can use the `.env` fine in the root `.openclaw` folder.

Both scripts obtain a fresh client-credentials token per invocation. Permissions belong to the app's execution user, which may differ from a CLI user. Verify permissions with these scripts rather than relying on CLI access.

## Read and discover

```bash
node scripts/salesforce-rest.mjs describe --object TR1__Job__c
node scripts/salesforce-rest.mjs query --soql "SELECT Id, Name FROM TR1__Job__c ORDER BY CreatedDate DESC LIMIT 10"
node scripts/salesforce-rest.mjs get --object Contact --id CONTACT_ID
```

- Output is JSON: `{ "ok": true, "result": ... }`; failures go to stderr with a nonzero exit code.
- Describe relevant objects before assuming fields, relationships, picklists, types, or writeability. Use explicit fields and targeted filters. Queries follow all result pages; use an appropriate `LIMIT` for samples.
- `SELECT FIELDS(ALL)` requires `LIMIT 200` or less. Schema and records are restricted by the execution user's permissions.
- `INVALID_TYPE` / `INVALID_FIELD` can indicate missing permissions or licenses. Zero visible records do not prove the object is empty org-wide.
- Validate IDs and escape backslashes and single quotes before inserting text values into SOQL.

For Job ↔ Opportunities Discussed ↔ Candidate ↔ Contact Document joins and screening fields, read [references/data-model.md](references/data-model.md). These are observed mappings, not a universal schema or access guarantee.

## Create and update (no delete)

Command availability is not authorization to change live data. Ensure the object, target record, and field values are within the user's current authorization. Resolve ambiguous targets with reads. If authorization is missing, prepare the exact target and JSON payload for review before asking; do not request authorization again when already provided.

Put the exact payload in a local JSON object file. Check describe's `createable`/`updateable`, required fields, picklists, and relationship IDs; server-side permissions and validation remain authoritative.

```bash
node scripts/salesforce-rest.mjs create --object OBJECT --body-file /absolute/path/payload.json --confirm yes
node scripts/salesforce-rest.mjs update --object OBJECT --id RECORD_ID --body-file /absolute/path/payload.json --confirm yes
```

`--confirm yes` is the execution gate after establishing authorization. It does not require a new user approval when the specific change was already authorized. Read back relevant fields after success. On a timeout or uncertain network result, inspect state before retrying: a create may already have committed. Do not loop on permission or validation failures; report the unmet requirement.

Deletion is intentionally unsupported. Do not add a delete command or bypass this boundary through another endpoint using this skill.

## Contact Document downloads

Use the `TR1__ContactDocument__c` record ID, not a Contact ID, ContentDocument ID, or legacy Attachment ID.

```bash
node scripts/bullhorn-documents.mjs url --id CONTACT_DOCUMENT_ID
node scripts/bullhorn-documents.mjs download --id CONTACT_DOCUMENT_ID --output /absolute/path/resume.docx
```

`url` outputs `{ "ok": true, "documentId": "...", "url": "..." }`; treat the temporary signed URL as a credential. Prefer `download` when the URL itself is not requested. Downloads return the path, byte count, and content type; stream to a temporary file; refuse existing destinations; and never forward the Salesforce bearer token to storage.

Bullhorn's API is `GET /services/apexrest/TR1/api/v1/contact-documents/{documentId}/public-url` for AWS-backed documents. Stored internal URLs and legacy IDs are not necessarily downloadable. See [resume selection and access requirements](references/data-model.md#resume-selection-and-download-access).

Request a fresh URL if expired. On missing-document or permission failures, report the problem; do not make files public or alter sharing. Verify file type/content when needed; HTTP success alone does not prove a valid PDF or DOCX.
