import { exec } from 'child_process';
import { promisify } from 'util';
import { getServers } from './config.js';

const execAsync = promisify(exec);

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
