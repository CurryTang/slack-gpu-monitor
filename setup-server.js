#!/usr/bin/env node

/**
 * Interactive CLI script to add GPU servers with SSH key setup
 * Run: node setup-server.js
 *
 * Supports:
 * - Direct SSH connections
 * - Proxy jump (bastion/jump host) connections
 * - Automatic ssh-copy-id for key setup
 */

import readline from 'readline';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { addServer, getServers, removeServer, editServer } from './src/config.js';

const execAsync = promisify(exec);

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

/**
 * Pause readline to allow spawned process to use stdin
 */
function pauseReadline() {
  rl.close();
}

/**
 * Resume readline after spawned process is done
 */
function resumeReadline() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Build SSH options array for a server
 */
function buildSSHOptions(server) {
  const options = [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
  ];

  if (server.port && server.port !== 22) {
    options.push('-p', server.port.toString());
  }

  if (server.identityFile) {
    options.push('-i', server.identityFile);
  }

  if (server.proxyJump) {
    options.push('-J', server.proxyJump);
  }

  return options;
}

/**
 * Copy SSH key to server using ssh-copy-id
 */
async function copySSHKey(server) {
  // Pause readline so ssh-copy-id can use stdin for password input
  pauseReadline();

  return new Promise((resolve) => {
    const args = [];

    if (server.port && server.port !== 22) {
      args.push('-p', server.port.toString());
    }

    if (server.identityFile) {
      args.push('-i', server.identityFile);
    }

    if (server.proxyJump) {
      args.push('-o', `ProxyJump=${server.proxyJump}`);
    }

    args.push(server.host);

    console.log(`\nRunning: ssh-copy-id ${args.join(' ')}`);
    console.log('You will be prompted for the password...\n');

    const child = spawn('ssh-copy-id', args, {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      // Resume readline after ssh-copy-id is done
      resumeReadline();
      resolve(code === 0);
    });

    child.on('error', (err) => {
      console.error('Failed to run ssh-copy-id:', err.message);
      resumeReadline();
      resolve(false);
    });
  });
}

/**
 * Test SSH connection to server
 */
async function testSSHConnection(server) {
  const options = buildSSHOptions(server);
  options.push('-o', 'BatchMode=yes');

  const cmd = `ssh ${options.join(' ')} ${server.host} "echo connected"`;

  try {
    await execAsync(cmd, { timeout: 15000 });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Test nvidia-smi on remote server
 */
async function testNvidiaSmi(server) {
  const options = buildSSHOptions(server);
  options.push('-o', 'BatchMode=yes');

  const cmd = `ssh ${options.join(' ')} ${server.host} "nvidia-smi --query-gpu=name --format=csv,noheader"`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    return { success: true, gpus: stdout.trim().split('\n') };
  } catch (error) {
    return { success: false, error: error.message };
  }
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
    if (server.proxyJump) {
      console.log(`    Proxy Jump: ${server.proxyJump}`);
    }
    if (server.identityFile) {
      console.log(`    Key: ${server.identityFile}`);
    }
    console.log('');
  }
}

async function addNewServer() {
  console.log('\n=== Add New GPU Server ===\n');

  // Get server details
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

  const proxyJump = await question('Proxy jump host (e.g., user@bastion.example.com, leave empty if none): ');

  const identityFile = await question('SSH private key path (leave empty for default ~/.ssh/id_*): ');

  const serverConfig = {
    name: name.trim(),
    host: host.trim(),
    port,
    proxyJump: proxyJump.trim() || null,
    identityFile: identityFile.trim() || null,
  };

  // Ask if user wants to copy SSH key
  const shouldCopy = await question('\nCopy SSH key to this server now? (y/n) [y]: ');

  if (shouldCopy.toLowerCase() !== 'n') {
    const success = await copySSHKey(serverConfig);

    if (success) {
      console.log('\n✅ SSH key copied successfully!');
    } else {
      console.log('\n⚠️  SSH key copy may have failed. You can try again later.');
      const continueAdd = await question('Add server anyway? (y/n): ');
      if (continueAdd.toLowerCase() !== 'y') {
        console.log('Server not added.');
        return;
      }
    }
  }

  // Test connection
  const shouldTest = await question('\nTest SSH connection now? (y/n) [y]: ');

  if (shouldTest.toLowerCase() !== 'n') {
    console.log('Testing SSH connection...');
    const sshResult = await testSSHConnection(serverConfig);

    if (sshResult.success) {
      console.log('✅ SSH connection successful!');

      console.log('Testing nvidia-smi...');
      const nvidiaResult = await testNvidiaSmi(serverConfig);

      if (nvidiaResult.success) {
        console.log(`✅ Found ${nvidiaResult.gpus.length} GPU(s):`);
        nvidiaResult.gpus.forEach((gpu, i) => console.log(`   GPU ${i}: ${gpu}`));
      } else {
        console.log('⚠️  nvidia-smi not found or failed on remote server.');
      }
    } else {
      console.log('❌ SSH connection failed:', sshResult.error);
      const continueAdd = await question('Add server anyway? (y/n): ');
      if (continueAdd.toLowerCase() !== 'y') {
        console.log('Server not added.');
        return;
      }
    }
  }

  // Save server
  try {
    const server = await addServer(serverConfig);
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

async function editExistingServer() {
  const servers = await getServers();

  if (servers.length === 0) {
    console.log('\nNo servers to edit.\n');
    return;
  }

  await listServers();

  const name = await question('Enter server name to edit: ');

  if (!name.trim()) {
    console.log('No server name provided.');
    return;
  }

  const server = servers.find(s => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!server) {
    console.log(`Server "${name}" not found.`);
    return;
  }

  console.log(`\nEditing "${server.name}" (press Enter to keep current value)\n`);

  const newName = await question(`Server name [${server.name}]: `);
  const newHost = await question(`SSH host [${server.host}]: `);
  const newPortStr = await question(`SSH port [${server.port}]: `);
  const newProxyJump = await question(`Proxy jump [${server.proxyJump || 'none'}]: `);
  const newIdentityFile = await question(`SSH key path [${server.identityFile || 'default'}]: `);

  const updates = {};
  if (newName.trim()) updates.name = newName.trim();
  if (newHost.trim()) updates.host = newHost.trim();
  if (newPortStr.trim()) updates.port = parseInt(newPortStr);
  if (newProxyJump.trim()) {
    updates.proxyJump = newProxyJump.trim() === 'none' ? null : newProxyJump.trim();
  }
  if (newIdentityFile.trim()) {
    updates.identityFile = newIdentityFile.trim() === 'default' ? null : newIdentityFile.trim();
  }

  if (Object.keys(updates).length === 0) {
    console.log('No changes made.');
    return;
  }

  try {
    await editServer(name.trim(), updates);
    console.log(`\n✅ Server updated successfully!\n`);
  } catch (error) {
    console.log(`\n❌ ${error.message}\n`);
  }
}

async function copyKeyToServer() {
  const servers = await getServers();

  if (servers.length === 0) {
    console.log('\nNo servers configured. Add a server first.\n');
    return;
  }

  await listServers();

  const name = await question('Enter server name to copy SSH key to: ');

  if (!name.trim()) {
    console.log('No server name provided.');
    return;
  }

  const server = servers.find(s => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!server) {
    console.log(`Server "${name}" not found.`);
    return;
  }

  const success = await copySSHKey(server);

  if (success) {
    console.log('\n✅ SSH key copied successfully!\n');
  } else {
    console.log('\n❌ Failed to copy SSH key.\n');
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

    const sshResult = await testSSHConnection(server);

    if (sshResult.success) {
      const nvidiaResult = await testNvidiaSmi(server);
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
    console.log('  3. Edit a server');
    console.log('  4. Remove a server');
    console.log('  5. Copy SSH key to a server');
    console.log('  6. Test all servers');
    console.log('  7. Exit');

    const choice = await question('\nSelect option (1-7): ');

    switch (choice.trim()) {
      case '1':
        await listServers();
        break;
      case '2':
        await addNewServer();
        break;
      case '3':
        await editExistingServer();
        break;
      case '4':
        await removeExistingServer();
        break;
      case '5':
        await copyKeyToServer();
        break;
      case '6':
        await testAllServers();
        break;
      case '7':
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
