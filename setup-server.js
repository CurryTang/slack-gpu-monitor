#!/usr/bin/env node

/**
 * Interactive CLI script to add a GPU server with SSH key setup
 * Run: node setup-server.js
 *
 * This script will:
 * 1. Prompt for server details
 * 2. Test SSH connection
 * 3. If SSH fails, offer to copy SSH key using ssh-copy-id
 * 4. Save the server configuration
 */

import readline from 'readline';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { addServer, getServers, removeServer } from './src/config.js';

const execAsync = promisify(exec);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function testSSHConnection(host, port, identityFile) {
  const sshOptions = [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-p', port.toString(),
  ];

  if (identityFile) {
    sshOptions.push('-i', identityFile);
  }

  const cmd = `ssh ${sshOptions.join(' ')} ${host} "echo connected"`;

  try {
    await execAsync(cmd, { timeout: 15000 });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function testNvidiaSmi(host, port, identityFile) {
  const sshOptions = [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-p', port.toString(),
  ];

  if (identityFile) {
    sshOptions.push('-i', identityFile);
  }

  const cmd = `ssh ${sshOptions.join(' ')} ${host} "nvidia-smi --query-gpu=name --format=csv,noheader"`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    return { success: true, gpus: stdout.trim().split('\n') };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function copySSHKey(host, port, identityFile) {
  return new Promise((resolve) => {
    const args = ['-p', port.toString()];

    if (identityFile) {
      args.push('-i', identityFile);
    }

    args.push(host);

    console.log(`\nRunning: ssh-copy-id ${args.join(' ')}`);
    console.log('You may be prompted for the password...\n');

    const child = spawn('ssh-copy-id', args, {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', (err) => {
      console.error('Failed to run ssh-copy-id:', err.message);
      resolve(false);
    });
  });
}

async function listServers() {
  const servers = await getServers();

  if (servers.length === 0) {
    console.log('\nNo servers configured.\n');
    return;
  }

  console.log('\n=== Configured Servers ===\n');
  for (const server of servers) {
    console.log(`  ${server.name}`);
    console.log(`    Host: ${server.host}`);
    console.log(`    Port: ${server.port}`);
    if (server.identityFile) {
      console.log(`    Key:  ${server.identityFile}`);
    }
    console.log('');
  }
}

async function addNewServer() {
  console.log('\n=== Add New GPU Server ===\n');

  const name = await question('Server name (e.g., training-server-1): ');
  if (!name.trim()) {
    console.log('Server name is required.');
    return;
  }

  const host = await question('SSH host (e.g., root@192.168.1.100): ');
  if (!host.trim()) {
    console.log('Host is required.');
    return;
  }

  const portStr = await question('SSH port [22]: ');
  const port = parseInt(portStr) || 22;

  const identityFile = await question('SSH key path (leave empty for default): ');

  console.log('\nTesting SSH connection...');

  let sshResult = await testSSHConnection(host, port, identityFile || null);

  if (!sshResult.success) {
    console.log('❌ SSH connection failed:', sshResult.error);

    const shouldCopy = await question('\nWould you like to copy your SSH key to this server? (y/n): ');

    if (shouldCopy.toLowerCase() === 'y') {
      const success = await copySSHKey(host, port, identityFile || null);

      if (success) {
        console.log('\n✅ SSH key copied successfully!');
        console.log('Testing connection again...');
        sshResult = await testSSHConnection(host, port, identityFile || null);
      } else {
        console.log('\n❌ Failed to copy SSH key.');
      }
    }
  }

  if (!sshResult.success) {
    const addAnyway = await question('\nSSH connection failed. Add server anyway? (y/n): ');
    if (addAnyway.toLowerCase() !== 'y') {
      console.log('Server not added.');
      return;
    }
  } else {
    console.log('✅ SSH connection successful!');

    console.log('\nTesting nvidia-smi...');
    const nvidiaResult = await testNvidiaSmi(host, port, identityFile || null);

    if (nvidiaResult.success) {
      console.log(`✅ Found ${nvidiaResult.gpus.length} GPU(s):`);
      nvidiaResult.gpus.forEach((gpu, i) => console.log(`   GPU ${i}: ${gpu}`));
    } else {
      console.log('⚠️  nvidia-smi not found or failed on remote server.');
      const addAnyway = await question('Add server anyway? (y/n): ');
      if (addAnyway.toLowerCase() !== 'y') {
        console.log('Server not added.');
        return;
      }
    }
  }

  try {
    const server = await addServer({
      name: name.trim(),
      host: host.trim(),
      port,
      identityFile: identityFile.trim() || null,
    });
    console.log(`\n✅ Server "${server.name}" added successfully!\n`);
  } catch (error) {
    console.log(`\n❌ Failed to add server: ${error.message}\n`);
  }
}

async function removeExistingServer() {
  const servers = await getServers();

  if (servers.length === 0) {
    console.log('\nNo servers to remove.\n');
    return;
  }

  await listServers();

  const name = await question('Enter server name to remove: ');

  if (!name.trim()) {
    console.log('No server name provided.');
    return;
  }

  const confirm = await question(`Are you sure you want to remove "${name}"? (y/n): `);

  if (confirm.toLowerCase() === 'y') {
    try {
      await removeServer(name.trim());
      console.log(`\n✅ Server "${name}" removed.\n`);
    } catch (error) {
      console.log(`\n❌ ${error.message}\n`);
    }
  } else {
    console.log('Cancelled.');
  }
}

async function testAllServers() {
  const servers = await getServers();

  if (servers.length === 0) {
    console.log('\nNo servers configured.\n');
    return;
  }

  console.log('\n=== Testing All Servers ===\n');

  for (const server of servers) {
    process.stdout.write(`Testing ${server.name}... `);

    const sshResult = await testSSHConnection(server.host, server.port, server.identityFile);

    if (sshResult.success) {
      const nvidiaResult = await testNvidiaSmi(server.host, server.port, server.identityFile);
      if (nvidiaResult.success) {
        console.log(`✅ OK (${nvidiaResult.gpus.length} GPU(s))`);
      } else {
        console.log('⚠️  SSH OK, but nvidia-smi failed');
      }
    } else {
      console.log('❌ Connection failed');
    }
  }
  console.log('');
}

async function main() {
  console.log('╔════════════════════════════════════╗');
  console.log('║   GPU Monitor Server Setup Tool    ║');
  console.log('╚════════════════════════════════════╝');

  while (true) {
    console.log('\nOptions:');
    console.log('  1. List configured servers');
    console.log('  2. Add a new server');
    console.log('  3. Remove a server');
    console.log('  4. Test all servers');
    console.log('  5. Exit');

    const choice = await question('\nSelect option (1-5): ');

    switch (choice.trim()) {
      case '1':
        await listServers();
        break;
      case '2':
        await addNewServer();
        break;
      case '3':
        await removeExistingServer();
        break;
      case '4':
        await testAllServers();
        break;
      case '5':
        console.log('\nGoodbye!\n');
        rl.close();
        process.exit(0);
      default:
        console.log('Invalid option.');
    }
  }
}

main().catch((err) => {
  console.error('Error:', err);
  rl.close();
  process.exit(1);
});
