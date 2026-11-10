# swyft-connector-library

Self-contained OpenClaw skills for Swyft agents. Each installable skill lives in
its own top-level folder, containing `SKILL.md`, supporting files, and a
`swyft.connector.json` manifest for Agent Deployer.

## Available skills

| Folder / skill ID | Description | Required configuration |
| --- | --- | --- |
| [`bullhorn-salesforce`](bullhorn-salesforce/SKILL.md) | Bullhorn Recruitment Cloud on Salesforce: record queries, creates/updates, and Contact Document downloads. | Salesforce token URL, client ID, and client secret. |

## Agent Deployer manifest

The folder name is the stable skill ID. Agent Deployer uses the manifest to show
the catalog entry and generate configuration prompts. See the
[Bullhorn manifest](bullhorn-salesforce/swyft.connector.json) for a complete example.

| Property | Meaning |
| --- | --- |
| `schemaVersion` | Manifest format version; currently `1`. |
| `name` | Display name in the catalog. |
| `description` | Short description of the skill. |
| `fields` | Configuration prompts; use an empty array for skills without configuration. |
| `fields[].env` | Exact environment variable expected by the skill. |
| `fields[].label` | User-facing prompt label. |
| `fields[].type` | `url` for an HTTPS endpoint, `secret` for credentials, or `text` for other configuration. |
| `fields[].required` | Whether the field must be configured before installation can complete. |
| `verification` | Optional identifier for an authentication check implemented by Agent Deployer. |

`verification` is a supported handler name, not a shell command. The Bullhorn
skill declares `salesforce-client-credentials`: the intended check requests an
OAuth token without reading or changing Salesforce business records. The manifest
is metadata; it does not itself install the skill or execute verification.

## Bullhorn configuration

- `SALESFORCE_TOKEN_URL`: the full HTTPS OAuth token URL, for example
  `https://YOUR_DOMAIN.my.salesforce.com/services/oauth2/token`.
- `SALESFORCE_CLIENT_ID`: the Salesforce app's client ID.
- `SALESFORCE_CLIENT_SECRET`: the Salesforce app's client secret.

See [the skill instructions](bullhorn-salesforce/SKILL.md) for execution and
permission requirements. No npm dependencies or Salesforce CLI login are needed.
For OpenClaw deployment, Agent Deployer should write the configuration to
`~/.openclaw/.env` and set `BULLHORN_ENV_FILE` to that file's absolute path, so the
scripts can find it regardless of their working directory.

Never commit credentials, `.env` files, access tokens, signed URLs, or customer
records to this repository. Manifests contain field definitions only; users supply
actual connection values through Agent Deployer or their local environment.
