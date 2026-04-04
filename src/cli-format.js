import { getGpuStatusIndicator, getTopUserForGpu, getUserProcesses } from './gpu.js';

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

function colorByUtil(util) {
  if (util >= 90) return c.red;
  if (util >= 50) return c.yellow;
  if (util > 0) return c.green;
  return c.gray;
}

function progressBar(percent, length = 20) {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  const color = colorByUtil(percent);
  return `${color}${'█'.repeat(filled)}${c.gray}${'░'.repeat(empty)}${c.reset} ${percent.toFixed(0).padStart(3)}%`;
}

/**
 * Format multi-server GPU status for terminal output
 * @param {Array} serverResults - Array of { server, gpus, processes, error }
 * @param {string|null} username - Username to highlight processes for
 */
export function formatCliStatus(serverResults, username = null) {
  const lines = [];
  const timestamp = new Date().toLocaleString();

  const totalGpus = serverResults.reduce((sum, r) => sum + r.gpus.length, 0);
  const errorCount = serverResults.filter(r => r.error).length;

  lines.push(`${c.bold}${c.cyan}GPU Status Report${c.reset}  ${c.dim}${timestamp}${c.reset}`);
  lines.push(`${c.dim}${serverResults.length} server(s) | ${totalGpus} GPU(s)${errorCount > 0 ? ` | ${c.red}${errorCount} error(s)${c.reset}` : ''}${c.reset}`);
  lines.push('');

  for (const result of serverResults) {
    if (result.error) {
      lines.push(`${c.red}■${c.reset} ${c.bold}${result.server.name}${c.reset} ${c.dim}(${result.server.host})${c.reset}`);
      lines.push(`  ${c.red}✗ ${result.error}${c.reset}`);
      lines.push('');
      continue;
    }

    lines.push(`${c.green}■${c.reset} ${c.bold}${result.server.name}${c.reset} ${c.dim}(${result.server.host})${c.reset}`);

    const processes = result.processes || new Map();

    for (const gpu of result.gpus) {
      const memPercent = (gpu.memoryUsed / gpu.memoryTotal) * 100;
      const memGB = (gpu.memoryUsed / 1024).toFixed(1);
      const memTotalGB = (gpu.memoryTotal / 1024).toFixed(1);
      const shortName = gpu.name.replace(/NVIDIA\s*(RTX\s*)?/i, '').replace(/\s+NVL.*$/i, '').trim();

      // Top user info
      const topUser = getTopUserForGpu(processes, gpu.index);
      const topUserStr = topUser
        ? `  ${c.dim}top:${c.reset} ${c.yellow}${topUser.user}${c.reset} ${c.dim}(${(topUser.memoryMB / 1024).toFixed(1)}GB)${c.reset}`
        : '';

      const utilColor = colorByUtil(gpu.gpuUtilization);
      lines.push(
        `  GPU ${gpu.index}: ${c.bold}${shortName}${c.reset}` +
        `  ${utilColor}${gpu.gpuUtilization}%${c.reset}` +
        `  ${c.dim}mem:${c.reset} ${memGB}/${memTotalGB}GB` +
        `  ${c.dim}temp:${c.reset} ${gpu.temperature}°C` +
        `  ${c.dim}pwr:${c.reset} ${gpu.powerDraw.toFixed(0)}/${gpu.powerLimit.toFixed(0)}W` +
        topUserStr
      );
      lines.push(`       ${progressBar(gpu.gpuUtilization)} gpu  ${progressBar(memPercent)} mem`);
    }

    // Show user's processes if username is configured
    if (username) {
      const userProcs = getUserProcesses(processes, username);
      if (userProcs.length > 0) {
        lines.push(`  ${c.cyan}→ Your processes (${username}):${c.reset}`);
        for (const p of userProcs) {
          lines.push(`    GPU ${p.gpuIndex}  PID ${p.pid}  ${(p.memoryMB / 1024).toFixed(1)}GB`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format server list for terminal
 */
export function formatCliServerList(servers) {
  if (servers.length === 0) {
    return `${c.dim}No servers configured. Use: gpu-cli config add <name> <user@host>${c.reset}`;
  }

  const lines = [`${c.bold}Configured Servers (${servers.length})${c.reset}`, ''];
  for (const [i, s] of servers.entries()) {
    lines.push(
      `  ${i + 1}. ${c.bold}${s.name}${c.reset}` +
      `  ${c.dim}host:${c.reset} ${s.host}` +
      `  ${c.dim}port:${c.reset} ${s.port}` +
      (s.identityFile ? `  ${c.dim}key:${c.reset} ${s.identityFile}` : '') +
      (s.proxyJump ? `  ${c.dim}jump:${c.reset} ${s.proxyJump}` : '')
    );
  }
  return lines.join('\n');
}

/**
 * Format user's processes across all servers
 */
export function formatCliMyProcesses(serverResults, username) {
  const lines = [];
  lines.push(`${c.bold}${c.cyan}Processes for ${username}${c.reset}`);
  lines.push('');

  let totalProcs = 0;

  for (const result of serverResults) {
    if (result.error) continue;
    const processes = result.processes || new Map();
    const userProcs = getUserProcesses(processes, username);
    if (userProcs.length === 0) continue;

    totalProcs += userProcs.length;
    lines.push(`${c.bold}${result.server.name}${c.reset}`);
    for (const p of userProcs) {
      const gpu = result.gpus.find(g => g.index === p.gpuIndex);
      const gpuName = gpu ? gpu.name.replace(/NVIDIA\s*(RTX\s*)?/i, '').replace(/\s+NVL.*$/i, '').trim() : '';
      lines.push(
        `  GPU ${p.gpuIndex} ${c.dim}(${gpuName})${c.reset}` +
        `  PID ${c.bold}${p.pid}${c.reset}` +
        `  ${(p.memoryMB / 1024).toFixed(1)}GB`
      );
    }
    lines.push('');
  }

  if (totalProcs === 0) {
    lines.push(`${c.dim}No GPU processes found for ${username}.${c.reset}`);
  } else {
    lines.push(`${c.dim}Total: ${totalProcs} process(es)${c.reset}`);
  }

  return lines.join('\n');
}

/**
 * Format help for CLI
 */
export function formatCliHelp() {
  return `${c.bold}${c.cyan}gpu-cli${c.reset} - GPU Monitor CLI

${c.bold}Usage:${c.reset}
  gpu-cli status [server]         Show GPU status (with top user per GPU)
  gpu-cli my-processes            Show all your GPU processes
  gpu-cli config list             List configured servers
  gpu-cli config add <name> <user@host> [port] [--key path] [--jump host]
  gpu-cli config remove <name>    Remove a server
  gpu-cli config edit <name> [--host h] [--port p] [--key k] [--name n]
  gpu-cli set-user <username>     Set your username for process filtering
  gpu-cli occupy <server> <gpus> <mem_gb> <python_path>
  gpu-cli cancel [server username]
  gpu-cli help                    Show this help

${c.bold}Examples:${c.reset}
  gpu-cli status                  # All servers
  gpu-cli status chatdse          # Specific server
  gpu-cli set-user myuser          # Configure your username
  gpu-cli my-processes            # See your processes across all servers
`;
}
