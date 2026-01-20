import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'servers.json');

/**
 * Default configuration structure
 */
const DEFAULT_CONFIG = {
  servers: [],
};

/**
 * Load configuration from file
 */
export async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, create default
      await saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    throw error;
  }
}

/**
 * Save configuration to file
 */
export async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Add a new server
 * @param {Object} server - Server configuration
 * @param {string} server.name - Display name for the server
 * @param {string} server.host - SSH host (user@hostname or just hostname)
 * @param {number} [server.port=22] - SSH port
 * @param {string} [server.identityFile] - Path to SSH private key
 */
export async function addServer(server) {
  const config = await loadConfig();

  // Check if server with same name exists
  const existingIndex = config.servers.findIndex(
    (s) => s.name.toLowerCase() === server.name.toLowerCase()
  );

  if (existingIndex !== -1) {
    throw new Error(`Server "${server.name}" already exists. Use edit to modify it.`);
  }

  const newServer = {
    id: generateId(),
    name: server.name,
    host: server.host,
    port: server.port || 22,
    identityFile: server.identityFile || null,
    createdAt: new Date().toISOString(),
  };

  config.servers.push(newServer);
  await saveConfig(config);

  return newServer;
}

/**
 * Remove a server by name or id
 */
export async function removeServer(nameOrId) {
  const config = await loadConfig();

  const index = config.servers.findIndex(
    (s) =>
      s.id === nameOrId ||
      s.name.toLowerCase() === nameOrId.toLowerCase()
  );

  if (index === -1) {
    throw new Error(`Server "${nameOrId}" not found.`);
  }

  const removed = config.servers.splice(index, 1)[0];
  await saveConfig(config);

  return removed;
}

/**
 * Edit an existing server
 */
export async function editServer(nameOrId, updates) {
  const config = await loadConfig();

  const index = config.servers.findIndex(
    (s) =>
      s.id === nameOrId ||
      s.name.toLowerCase() === nameOrId.toLowerCase()
  );

  if (index === -1) {
    throw new Error(`Server "${nameOrId}" not found.`);
  }

  // Apply updates
  if (updates.name) config.servers[index].name = updates.name;
  if (updates.host) config.servers[index].host = updates.host;
  if (updates.port) config.servers[index].port = updates.port;
  if (updates.identityFile !== undefined) {
    config.servers[index].identityFile = updates.identityFile || null;
  }

  config.servers[index].updatedAt = new Date().toISOString();
  await saveConfig(config);

  return config.servers[index];
}

/**
 * Get all servers
 */
export async function getServers() {
  const config = await loadConfig();
  return config.servers;
}

/**
 * Get a single server by name or id
 */
export async function getServer(nameOrId) {
  const config = await loadConfig();
  return config.servers.find(
    (s) =>
      s.id === nameOrId ||
      s.name.toLowerCase() === nameOrId.toLowerCase()
  );
}

/**
 * Generate a simple unique ID
 */
function generateId() {
  return Math.random().toString(36).substring(2, 10);
}
