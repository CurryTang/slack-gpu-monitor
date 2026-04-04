#!/usr/bin/env node
import 'dotenv/config';
import {
  getAllServersGpuStatusWithProcesses,
  getLocalGpuStatus,
  getLocalGpuProcesses,
  parseGpuInfo,
  startGpuOccupation,
  cancelAllOccupations,
  killUserProcesses,
  getOccupations,
  getServerGpuStatus,
  getRemoteGpuProcesses,
} from './gpu.js';
import {
  addServer,
  removeServer,
  editServer,
  getServers,
  getServer,
  getUsername,
  setUsername,
} from './config.js';
import {
  formatCliStatus,
  formatCliServerList,
  formatCliMyProcesses,
  formatCliHelp,
} from './cli-format.js';

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();
const subcommand = args[1]?.toLowerCase();

async function main() {
  try {
    switch (command) {
      case 'status':
        await cmdStatus();
        break;
      case 'my-processes':
      case 'ps':
        await cmdMyProcesses();
        break;
      case 'config':
        await cmdConfig();
        break;
      case 'set-user':
        await cmdSetUser();
        break;
      case 'occupy':
        await cmdOccupy();
        break;
      case 'cancel':
        await cmdCancel();
        break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        console.log(formatCliHelp());
        break;
      default:
        console.error(`Unknown command: ${command}\nRun 'gpu-cli help' for usage.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

async function cmdStatus() {
  const serverName = args[1];
  const username = await getUsername();
  const servers = await getServers();

  if (servers.length === 0) {
    // Local fallback
    const csvOutput = await getLocalGpuStatus();
    const gpus = parseGpuInfo(csvOutput);
    const processes = await getLocalGpuProcesses();
    const results = [{ server: { name: 'Local', host: 'localhost' }, gpus, processes, error: null }];
    console.log(formatCliStatus(results, username));
    return;
  }

  if (serverName) {
    // Single server
    const server = await getServer(serverName);
    if (!server) {
      throw new Error(`Server not found: ${serverName}`);
    }
    const [{ gpus }, processes] = await Promise.all([
      getServerGpuStatus(serverName),
      getRemoteGpuProcesses(server),
    ]);
    const results = [{ server, gpus, processes, error: null }];
    console.log(formatCliStatus(results, username));
  } else {
    // All servers
    const results = await getAllServersGpuStatusWithProcesses();
    console.log(formatCliStatus(results, username));
  }
}

async function cmdMyProcesses() {
  const username = await getUsername();
  if (!username) {
    console.error("No username configured. Run: gpu-cli set-user <username>");
    process.exit(1);
  }

  const servers = await getServers();
  if (servers.length === 0) {
    const csvOutput = await getLocalGpuStatus();
    const gpus = parseGpuInfo(csvOutput);
    const processes = await getLocalGpuProcesses();
    console.log(formatCliMyProcesses(
      [{ server: { name: 'Local', host: 'localhost' }, gpus, processes, error: null }],
      username
    ));
    return;
  }

  const results = await getAllServersGpuStatusWithProcesses();
  console.log(formatCliMyProcesses(results, username));
}

async function cmdConfig() {
  switch (subcommand) {
    case 'list':
    case 'ls':
    case undefined: {
      const servers = await getServers();
      console.log(formatCliServerList(servers));
      break;
    }
    case 'add': {
      const name = args[2];
      const host = args[3];
      if (!name || !host) {
        console.error("Usage: gpu-cli config add <name> <user@host> [port] [--key path] [--jump host]");
        process.exit(1);
      }
      let port = 22;
      let identityFile = null;
      let proxyJump = null;
      for (let i = 4; i < args.length; i++) {
        if (args[i] === '--key' || args[i] === '-i') { identityFile = args[++i]; }
        else if (args[i] === '--jump' || args[i] === '-J') { proxyJump = args[++i]; }
        else if (/^\d+$/.test(args[i])) { port = parseInt(args[i]); }
      }
      const server = await addServer({ name, host, port, identityFile, proxyJump });
      console.log(`Added server: ${server.name} (${server.host}:${server.port})`);
      break;
    }
    case 'remove':
    case 'rm': {
      const nameOrId = args[2];
      if (!nameOrId) {
        console.error("Usage: gpu-cli config remove <name>");
        process.exit(1);
      }
      const removed = await removeServer(nameOrId);
      console.log(`Removed server: ${removed.name}`);
      break;
    }
    case 'edit': {
      const nameOrId = args[2];
      if (!nameOrId) {
        console.error("Usage: gpu-cli config edit <name> [--host h] [--port p] [--key k] [--name n]");
        process.exit(1);
      }
      const updates = {};
      for (let i = 3; i < args.length; i++) {
        switch (args[i]) {
          case '--host': updates.host = args[++i]; break;
          case '--port': updates.port = parseInt(args[++i]); break;
          case '--key': case '-i': updates.identityFile = args[++i]; break;
          case '--name': updates.name = args[++i]; break;
          case '--jump': case '-J': updates.proxyJump = args[++i]; break;
        }
      }
      if (Object.keys(updates).length === 0) {
        console.error("No updates provided. Use --host, --port, --key, --name, --jump.");
        process.exit(1);
      }
      const server = await editServer(nameOrId, updates);
      console.log(`Updated server: ${server.name}`);
      break;
    }
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      process.exit(1);
  }
}

async function cmdSetUser() {
  const username = args[1];
  if (!username) {
    const current = await getUsername();
    if (current) {
      console.log(`Current username: ${current}`);
    } else {
      console.log("No username set. Usage: gpu-cli set-user <username>");
    }
    return;
  }
  await setUsername(username);
  console.log(`Username set to: ${username}`);
}

async function cmdOccupy() {
  // gpu-cli occupy <server> <gpus> <mem_gb> <python_path>
  const serverName = args[1];
  const gpuIdsStr = args[2];
  const memGBStr = args[3];
  const pythonPath = args[4];

  if (!serverName || !gpuIdsStr || !memGBStr || !pythonPath) {
    console.error("Usage: gpu-cli occupy <server> <gpu_ids> <memory_gb> <python_path>");
    console.error("Example: gpu-cli occupy chatdse 0,1 40 /usr/bin/python3");
    process.exit(1);
  }

  const gpuIds = gpuIdsStr.split(',').map(id => parseInt(id.trim()));
  const memoryGB = parseFloat(memGBStr);

  if (gpuIds.some(isNaN) || isNaN(memoryGB) || memoryGB <= 0) {
    console.error("Invalid GPU IDs or memory amount.");
    process.exit(1);
  }

  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());
  if (!server) throw new Error(`Server not found: ${serverName}`);

  console.log(`Starting GPU occupation on ${serverName}...`);
  const result = await startGpuOccupation(server, pythonPath, gpuIds, memoryGB);
  console.log(`GPU occupation started. GPUs: ${gpuIds.join(',')} | Memory: ${memoryGB}GB each | PID: ${result.pid}`);
}

async function cmdCancel() {
  const serverName = args[1];
  const username = args[2];

  if (!serverName) {
    // Cancel all
    const occs = await getOccupations();
    if (occs.length === 0) {
      console.log("No tracked GPU occupations.");
      return;
    }
    console.log(`Cancelling ${occs.length} occupation(s)...`);
    const { killed, failed } = await cancelAllOccupations();
    console.log(`Done. Killed: ${killed}, Failed/not found: ${failed}`);
    return;
  }

  if (!username) {
    console.error("Usage: gpu-cli cancel [server username]");
    process.exit(1);
  }

  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());
  if (!server) throw new Error(`Server not found: ${serverName}`);

  console.log(`Killing processes for ${username} on ${serverName}...`);
  await killUserProcesses(server, username);
  console.log("Done.");
}

main();
