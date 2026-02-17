import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServers } from './config.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OCCUPATIONS_FILE = path.join(__dirname, '..', 'occupations.json');

const NVIDIA_SMI_CMD =
  'nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits';

/**
 * Execute nvidia-smi locally and return raw output
 */
export async function getLocalGpuStatus() {
  try {
    const { stdout } = await execAsync(NVIDIA_SMI_CMD);
    return stdout.trim();
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('command not found')) {
      throw new Error('nvidia-smi not found. Make sure NVIDIA drivers are installed.');
    }
    if (error.message.includes('NVIDIA-SMI has failed')) {
      throw new Error('nvidia-smi failed. No NVIDIA GPU detected or driver issue.');
    }
    throw error;
  }
}

/**
 * Execute nvidia-smi on a remote server via SSH
 * @param {Object} server - Server configuration
 */
export async function getRemoteGpuStatus(server) {
  const sshOptions = [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
  ];

  if (server.port && server.port !== 22) {
    sshOptions.push('-p', server.port.toString());
  }

  if (server.identityFile) {
    sshOptions.push('-i', server.identityFile);
  }

  if (server.proxyJump) {
    sshOptions.push('-J', server.proxyJump);
  }

  const sshCmd = `ssh ${sshOptions.join(' ')} ${server.host} "${NVIDIA_SMI_CMD}"`;

  try {
    const { stdout } = await execAsync(sshCmd, { timeout: 30000 });
    return stdout.trim();
  } catch (error) {
    if (error.message.includes('Permission denied')) {
      throw new Error(`SSH authentication failed for ${server.name}. Check your SSH key.`);
    }
    if (error.message.includes('Connection refused')) {
      throw new Error(`Connection refused to ${server.name}. Check if SSH is running.`);
    }
    if (error.message.includes('Connection timed out') || error.killed) {
      throw new Error(`Connection timed out to ${server.name}.`);
    }
    if (error.message.includes('Could not resolve hostname')) {
      throw new Error(`Could not resolve hostname for ${server.name}.`);
    }
    if (error.message.includes('nvidia-smi') || error.message.includes('not found')) {
      throw new Error(`nvidia-smi not found on ${server.name}.`);
    }
    throw new Error(`Failed to connect to ${server.name}: ${error.message}`);
  }
}

/**
 * Get GPU status from all configured servers
 * Returns an array of { server, gpus, error } objects
 */
export async function getAllServersGpuStatus() {
  const servers = await getServers();
  const results = [];

  // Query all servers in parallel
  const promises = servers.map(async (server) => {
    try {
      const csvOutput = await getRemoteGpuStatus(server);
      const gpus = parseGpuInfo(csvOutput);
      return { server, gpus, error: null };
    } catch (error) {
      return { server, gpus: [], error: error.message };
    }
  });

  const serverResults = await Promise.all(promises);
  results.push(...serverResults);

  return results;
}

/**
 * Get GPU status - if servers are configured, query them; otherwise query local
 */
export async function getGpuStatus() {
  const servers = await getServers();

  if (servers.length === 0) {
    // No servers configured, query local
    return getLocalGpuStatus();
  }

  // Return raw data for the first server (for backward compatibility)
  // Use getAllServersGpuStatus() for multi-server support
  const csvOutput = await getRemoteGpuStatus(servers[0]);
  return csvOutput;
}

/**
 * Parse nvidia-smi CSV output into structured data
 */
export function parseGpuInfo(csvOutput) {
  const lines = csvOutput.split('\n').filter((line) => line.trim());

  return lines.map((line) => {
    const [
      index,
      name,
      temperature,
      gpuUtil,
      memUtil,
      memUsed,
      memTotal,
      powerDraw,
      powerLimit,
    ] = line.split(',').map((s) => s.trim());

    return {
      index: parseInt(index),
      name,
      temperature: parseInt(temperature),
      gpuUtilization: parseInt(gpuUtil),
      memoryUtilization: parseInt(memUtil),
      memoryUsed: parseInt(memUsed),
      memoryTotal: parseInt(memTotal),
      powerDraw: parseFloat(powerDraw),
      powerLimit: parseFloat(powerLimit),
    };
  });
}

/**
 * Get a simple status indicator based on GPU utilization
 */
export function getGpuStatusIndicator(gpuInfo) {
  const util = gpuInfo.gpuUtilization;
  if (util >= 90) return { emoji: '🔴', status: 'High Load' };
  if (util >= 50) return { emoji: '🟡', status: 'Moderate' };
  if (util > 0) return { emoji: '🟢', status: 'Low Load' };
  return { emoji: '⚪', status: 'Idle' };
}

/**
 * Execute a command on a remote server via SSH
 * @param {Object} server - Server configuration
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in ms (default 60s)
 */
export async function executeRemoteCommand(server, command, timeout = 60000) {
  const sshOptions = [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
  ];

  if (server.port && server.port !== 22) {
    sshOptions.push('-p', server.port.toString());
  }

  if (server.identityFile) {
    sshOptions.push('-i', server.identityFile);
  }

  if (server.proxyJump) {
    sshOptions.push('-J', server.proxyJump);
  }

  const sshCmd = `ssh ${sshOptions.join(' ')} ${server.host} "${command.replace(/"/g, '\\"')}"`;

  try {
    const { stdout, stderr } = await execAsync(sshCmd, { timeout });
    return { stdout: stdout.trim(), stderr: stderr.trim(), success: true };
  } catch (error) {
    return { stdout: '', stderr: error.message, success: false, error };
  }
}

/**
 * Start GPU occupation on a remote server
 * @param {Object} server - Server configuration
 * @param {string} pythonPath - Path to Python executable
 * @param {number[]} gpuIds - GPU IDs to occupy
 * @param {number} memoryGB - Memory per GPU in GB
 */
export async function startGpuOccupation(server, pythonPath, gpuIds, memoryGB) {
  // First, check if python and torch are available
  const checkCmd = `${pythonPath} -c "import torch; print('cuda:', torch.cuda.is_available())"`;
  const checkResult = await executeRemoteCommand(server, checkCmd, 30000);

  if (!checkResult.success) {
    if (checkResult.stderr.includes('No such file')) {
      throw new Error(`Python not found at: ${pythonPath}`);
    }
    if (checkResult.stderr.includes('ModuleNotFoundError') || checkResult.stderr.includes('No module named')) {
      throw new Error(`PyTorch not installed. Run: ${pythonPath} -m pip install torch`);
    }
    throw new Error(`Python check failed: ${checkResult.stderr}`);
  }

  if (!checkResult.stdout.includes('cuda: True')) {
    throw new Error('CUDA not available on this server');
  }

  // Create the occupy script inline and run it in background
  const occupyScript = `
import torch
import time
import signal
import sys

def handler(sig, frame):
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)
signal.signal(signal.SIGINT, handler)

gpus = [${gpuIds.join(',')}]
mem_gb = ${memoryGB}
tensors = []

for gpu_id in gpus:
    device = torch.device(f'cuda:{gpu_id}')
    num_elements = int((mem_gb * 1024 * 1024 * 1024) / 4)
    t = torch.zeros(num_elements, dtype=torch.float32, device=device)
    t += 1
    tensors.append(t)
    print(f'GPU {gpu_id}: {mem_gb}GB allocated', flush=True)

print('Holding GPUs...', flush=True)
while True:
    time.sleep(60)
    for t in tensors:
        t += 0.0001
        t -= 0.0001
`;

  // Write script and run in background with nohup
  const scriptPath = `/tmp/nano_vllm_server_${Date.now()}.py`;
  const writeAndRun = `cat > ${scriptPath} << 'OCCUPY_EOF'
${occupyScript}
OCCUPY_EOF
nohup ${pythonPath} ${scriptPath} > /tmp/nano_vllm.log 2>&1 &
echo $!`;

  const result = await executeRemoteCommand(server, writeAndRun, 30000);

  if (!result.success) {
    throw new Error(`Failed to start occupation: ${result.stderr}`);
  }

  const pid = result.stdout.trim();

  // Record this occupation for tracking
  await recordOccupation(server.name, pid, gpuIds, memoryGB, scriptPath);

  return { pid, gpuIds, memoryGB };
}

/**
 * Load tracked occupations from file
 */
async function loadOccupations() {
  try {
    const data = await fs.readFile(OCCUPATIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Save tracked occupations to file
 */
async function saveOccupations(occupations) {
  await fs.writeFile(OCCUPATIONS_FILE, JSON.stringify(occupations, null, 2));
}

/**
 * Record a new occupation
 */
async function recordOccupation(serverName, pid, gpuIds, memoryGB, scriptPath) {
  const occupations = await loadOccupations();
  occupations.push({
    serverName,
    pid,
    gpuIds,
    memoryGB,
    scriptPath,
    startedAt: new Date().toISOString(),
  });
  await saveOccupations(occupations);
}

/**
 * Get all tracked occupations
 */
export async function getOccupations() {
  return loadOccupations();
}

/**
 * Kill a specific occupation by PID on a server
 */
async function killOccupationByPid(server, pid) {
  const killCmd = `kill ${pid} 2>/dev/null && echo killed || echo not_found`;
  const result = await executeRemoteCommand(server, killCmd, 15000);
  return result.stdout.includes('killed');
}

/**
 * Cancel all tracked occupations across all servers
 * @returns {{ killed: number, failed: number, results: Array }}
 */
export async function cancelAllOccupations() {
  const occupations = await loadOccupations();
  if (occupations.length === 0) {
    return { killed: 0, failed: 0, results: [] };
  }

  const servers = await getServers();
  const results = [];
  let killed = 0;
  let failed = 0;

  for (const occ of occupations) {
    const server = servers.find(s => s.name.toLowerCase() === occ.serverName.toLowerCase());
    if (!server) {
      results.push({ ...occ, status: 'server_not_found' });
      failed++;
      continue;
    }

    try {
      const success = await killOccupationByPid(server, occ.pid);
      results.push({ ...occ, status: success ? 'killed' : 'not_found' });
      if (success) killed++;
      else failed++;
    } catch (error) {
      results.push({ ...occ, status: 'error', error: error.message });
      failed++;
    }
  }

  // Clear all tracked occupations
  await saveOccupations([]);
  return { killed, failed, results };
}

/**
 * Cancel tracked occupations on a specific server
 */
export async function cancelServerOccupations(serverName) {
  const occupations = await loadOccupations();
  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

  if (!server) {
    throw new Error(`Server not found: ${serverName}`);
  }

  const serverOccs = occupations.filter(o => o.serverName.toLowerCase() === serverName.toLowerCase());
  const otherOccs = occupations.filter(o => o.serverName.toLowerCase() !== serverName.toLowerCase());

  let killed = 0;
  for (const occ of serverOccs) {
    try {
      const success = await killOccupationByPid(server, occ.pid);
      if (success) killed++;
    } catch { /* ignore */ }
  }

  // Keep only non-target server occupations
  await saveOccupations(otherOccs);
  return { killed, total: serverOccs.length };
}

/**
 * Kill all processes for a user on a remote server
 * @param {Object} server - Server configuration
 * @param {string} username - Username whose processes to kill
 */
export async function killUserProcesses(server, username) {
  const killCmd = `pkill -u ${username} -f "nano_vllm_server" 2>/dev/null; echo "done"`;
  const result = await executeRemoteCommand(server, killCmd, 15000);

  // Also remove tracked occupations for this server
  const occupations = await loadOccupations();
  const remaining = occupations.filter(o => o.serverName.toLowerCase() !== server.name.toLowerCase());
  await saveOccupations(remaining);

  return result.success;
}

/**
 * Get GPU status for a specific server by name
 * @param {string} serverName - Name of the server
 */
export async function getServerGpuStatus(serverName) {
  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

  if (!server) {
    throw new Error(`Server not found: ${serverName}`);
  }

  const csvOutput = await getRemoteGpuStatus(server);
  const gpus = parseGpuInfo(csvOutput);
  return { server, gpus };
}
