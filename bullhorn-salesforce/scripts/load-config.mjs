import { loadEnvFile } from 'node:process';
import path from 'node:path';

// Existing environment variables take precedence over values loaded from a file.
export function loadConfig(explicitFile) {
  const file = explicitFile || process.env.BULLHORN_ENV_FILE;
  if (file) {
    loadEnvFile(path.resolve(file));
    return;
  }
  try { loadEnvFile(path.resolve('.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
