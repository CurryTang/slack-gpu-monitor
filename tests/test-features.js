/**
 * Test cases for GPU Monitor Slack Bot features
 * Run with: node tests/test-features.js
 */

import { getServers } from '../src/config.js';
import {
  executeRemoteCommand,
  getServerGpuStatus,
  parseGpuInfo,
} from '../src/gpu.js';

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
};

function log(status, message) {
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '•';
  const color = status === 'pass' ? COLORS.green : status === 'fail' ? COLORS.red : COLORS.yellow;
  console.log(`${color}${icon}${COLORS.reset} ${message}`);
}

async function runTests() {
  console.log('\n🧪 GPU Monitor Feature Tests\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Config loading
  console.log('--- Config Tests ---');
  try {
    const servers = await getServers();
    log('pass', `Config loaded: ${servers.length} server(s) configured`);
    passed++;

    if (servers.length > 0) {
      log('info', `  First server: ${servers[0].name} (${servers[0].host})`);
    }
  } catch (error) {
    log('fail', `Config load failed: ${error.message}`);
    failed++;
  }

  // Test 2: GPU info parsing
  console.log('\n--- GPU Parsing Tests ---');
  try {
    const sampleCsv = `0, NVIDIA RTX A6000, 45, 80, 65, 31000, 48000, 120.5, 300.0
1, NVIDIA H100 NVL, 50, 100, 90, 70000, 94000, 250.0, 350.0`;

    const gpus = parseGpuInfo(sampleCsv);

    if (gpus.length === 2) {
      log('pass', 'Parsed 2 GPUs from sample CSV');
      passed++;
    } else {
      log('fail', `Expected 2 GPUs, got ${gpus.length}`);
      failed++;
    }

    if (gpus[0].name === 'NVIDIA RTX A6000' && gpus[0].gpuUtilization === 80) {
      log('pass', 'GPU fields parsed correctly');
      passed++;
    } else {
      log('fail', 'GPU fields incorrect');
      failed++;
    }

    if (gpus[1].memoryUsed === 70000 && gpus[1].memoryTotal === 94000) {
      log('pass', 'Memory values parsed correctly');
      passed++;
    } else {
      log('fail', 'Memory values incorrect');
      failed++;
    }
  } catch (error) {
    log('fail', `GPU parsing failed: ${error.message}`);
    failed++;
  }

  // Test 3: Remote command execution (if servers configured)
  console.log('\n--- Remote Execution Tests ---');
  const servers = await getServers();

  if (servers.length === 0) {
    log('info', 'Skipping remote tests (no servers configured)');
  } else {
    const server = servers[0];

    // Test basic command
    try {
      const result = await executeRemoteCommand(server, 'echo "test"', 10000);
      if (result.success && result.stdout === 'test') {
        log('pass', `Remote echo command on ${server.name}`);
        passed++;
      } else {
        log('fail', `Echo returned: ${result.stdout || result.stderr}`);
        failed++;
      }
    } catch (error) {
      log('fail', `Remote command failed: ${error.message}`);
      failed++;
    }

    // Test Python availability
    try {
      const result = await executeRemoteCommand(server, 'which python3 || which python', 10000);
      if (result.success && result.stdout) {
        log('pass', `Python found at: ${result.stdout}`);
        passed++;
      } else {
        log('info', 'Python not in default path');
      }
    } catch (error) {
      log('info', `Python check: ${error.message}`);
    }

    // Test GPU status fetch
    try {
      const { gpus } = await getServerGpuStatus(server.name);
      log('pass', `Fetched ${gpus.length} GPU(s) from ${server.name}`);
      passed++;

      for (const gpu of gpus) {
        const freeGB = ((gpu.memoryTotal - gpu.memoryUsed) / 1024).toFixed(1);
        log('info', `  GPU ${gpu.index}: ${gpu.gpuUtilization}% util, ${freeGB}GB free`);
      }
    } catch (error) {
      log('fail', `GPU status fetch failed: ${error.message}`);
      failed++;
    }
  }

  // Test 4: Command parsing simulation
  console.log('\n--- Command Parsing Tests ---');

  // /occupy argument parsing
  const occupyArgs = 'grandrapids 0,1,2 40 /home/user/python'.split(/\s+/);
  try {
    const serverName = occupyArgs[0];
    const gpuIds = occupyArgs[1].split(',').map(id => parseInt(id.trim()));
    const memoryGB = parseFloat(occupyArgs[2]);
    const pythonPath = occupyArgs[3];

    if (serverName === 'grandrapids' && gpuIds.length === 3 && memoryGB === 40) {
      log('pass', '/occupy argument parsing');
      passed++;
    } else {
      log('fail', '/occupy parsing incorrect');
      failed++;
    }
  } catch (error) {
    log('fail', `/occupy parsing: ${error.message}`);
    failed++;
  }

  // /monitor argument parsing
  const monitorArgs = 'grandrapids 0,1 40 /usr/bin/python3 30 45'.split(/\s+/);
  try {
    const serverName = monitorArgs[0];
    const gpuIds = monitorArgs[1].split(',').map(id => parseInt(id.trim()));
    const memoryGB = parseFloat(monitorArgs[2]);
    const pythonPath = monitorArgs[3];
    const frequencyMin = parseInt(monitorArgs[4]);
    const minFreeGB = parseFloat(monitorArgs[5]);

    if (
      serverName === 'grandrapids' &&
      gpuIds.length === 2 &&
      frequencyMin === 30 &&
      minFreeGB === 45
    ) {
      log('pass', '/monitor argument parsing');
      passed++;
    } else {
      log('fail', '/monitor parsing incorrect');
      failed++;
    }
  } catch (error) {
    log('fail', `/monitor parsing: ${error.message}`);
    failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${COLORS.green}${passed} passed${COLORS.reset}, ${COLORS.red}${failed} failed${COLORS.reset}`);
  console.log('='.repeat(40) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
