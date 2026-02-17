import 'dotenv/config';
import bolt from '@slack/bolt';
import { startDiscord } from './discord.js';
import {
  getAllServersGpuStatus,
  getLocalGpuStatus,
  parseGpuInfo,
  getServerGpuStatus,
  startGpuOccupation,
  killUserProcesses,
  cancelAllOccupations,
  getOccupations,
} from './gpu.js';
import { formatMultiServerMessage, formatGpuMessage, formatErrorMessage } from './format.js';
import { addServer, removeServer, editServer, getServers } from './config.js';

const { App } = bolt;

// Initialize the Slack app with Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Store for scheduled monitoring (channel -> intervalId)
const scheduledChannels = new Map();

// Store for auto-occupy monitors (id -> { intervalId, config })
const autoOccupyMonitors = new Map();

// /gpu command handler
app.command('/gpu', async ({ command, ack, respond }) => {
  await ack();

  const args = command.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  try {
    switch (subcommand) {
      case 'start':
        await handleStartMonitoring(command.channel_id, respond, args[1]);
        break;

      case 'stop':
        await handleStopMonitoring(command.channel_id, respond);
        break;

      case 'help':
        await respond(getHelpMessage());
        break;

      default:
        await handleGpuStatus(respond);
        break;
    }
  } catch (error) {
    console.error('Error handling /gpu command:', error);
    await respond(formatErrorMessage(error.message));
  }
});

// /config command handler
app.command('/config', async ({ command, ack, respond }) => {
  await ack();

  const args = command.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  try {
    switch (subcommand) {
      case 'add':
        await handleConfigAdd(args.slice(1), respond);
        break;

      case 'remove':
      case 'rm':
        await handleConfigRemove(args.slice(1), respond);
        break;

      case 'edit':
        await handleConfigEdit(args.slice(1), respond);
        break;

      case 'list':
      case 'ls':
      case '':
      case undefined:
        await handleConfigList(respond);
        break;

      case 'help':
        await respond(getConfigHelpMessage());
        break;

      default:
        await respond({
          text: `Unknown subcommand: \`${subcommand}\`. Use \`/config help\` for usage.`,
        });
        break;
    }
  } catch (error) {
    console.error('Error handling /config command:', error);
    await respond(formatErrorMessage(error.message));
  }
});

// /occupy command handler - occupy GPUs on a server
app.command('/occupy', async ({ command, ack, respond }) => {
  await ack();

  const args = command.text.trim().split(/\s+/);

  if (args.length < 4 || args[0] === 'help') {
    await respond(getOccupyHelpMessage());
    return;
  }

  try {
    // Parse: <server> <gpu_ids> <memory_gb> <python_path>
    // e.g., /occupy grandrapids 0,1,2 40 /home/user/miniconda3/bin/python
    const serverName = args[0];
    const gpuIds = args[1].split(',').map(id => parseInt(id.trim()));
    const memoryGB = parseFloat(args[2]);
    const pythonPath = args[3];

    // Validate inputs
    if (gpuIds.some(isNaN)) {
      await respond({ text: '❌ Invalid GPU IDs. Use comma-separated numbers (e.g., 0,1,2)' });
      return;
    }

    if (isNaN(memoryGB) || memoryGB <= 0) {
      await respond({ text: '❌ Invalid memory amount. Provide a positive number in GB.' });
      return;
    }

    await respond({ text: `⏳ Starting GPU occupation on ${serverName}...` });

    // Find server and start occupation
    const servers = await getServers();
    const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

    if (!server) {
      await respond({ text: `❌ Server not found: ${serverName}. Use \`/config list\` to see available servers.` });
      return;
    }

    const result = await startGpuOccupation(server, pythonPath, gpuIds, memoryGB);

    await respond({
      text: `✅ GPU occupation started on *${serverName}*\n• GPUs: ${gpuIds.join(', ')}\n• Memory: ${memoryGB}GB each\n• PID: ${result.pid}\n\nUse \`/cancel ${serverName} <username>\` to stop.`,
    });
  } catch (error) {
    console.error('Error in /occupy:', error);
    await respond({ text: `❌ Failed to occupy GPUs: ${error.message}` });
  }
});

// /monitor command handler - auto-monitor and occupy when available
app.command('/monitor', async ({ command, ack, respond }) => {
  await ack();

  const args = command.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  try {
    switch (subcommand) {
      case 'start':
        await handleMonitorStart(args.slice(1), respond, command.channel_id);
        break;

      case 'stop':
        await handleMonitorStop(args.slice(1), respond);
        break;

      case 'list':
        await handleMonitorList(respond);
        break;

      case 'help':
      case '':
      case undefined:
        await respond(getMonitorHelpMessage());
        break;

      default:
        await respond({ text: `Unknown subcommand: \`${subcommand}\`. Use \`/monitor help\` for usage.` });
        break;
    }
  } catch (error) {
    console.error('Error in /monitor:', error);
    await respond({ text: `❌ Error: ${error.message}` });
  }
});

// /cancel command handler - kill occupation processes
app.command('/cancel', async ({ command, ack, respond }) => {
  await ack();

  const args = command.text.trim().split(/\s+/).filter(Boolean);

  if (args[0] === 'help') {
    await respond({
      text: '*Cancel Command*\n\n`/cancel` - Cancel all tracked GPU occupations on all servers\n`/cancel <server_name> <username>` - Kill occupation processes for a user on a server\n\n*Example:*\n`/cancel` or `/cancel grandrapids john`',
    });
    return;
  }

  try {
    // No args: cancel all tracked occupations
    if (args.length === 0) {
      const occs = await getOccupations();
      if (occs.length === 0) {
        await respond({ text: '📋 No tracked GPU occupations to cancel.' });
        return;
      }

      await respond({ text: `⏳ Cancelling ${occs.length} tracked occupation(s) across all servers...` });
      const { killed, failed, results } = await cancelAllOccupations();

      const lines = results.map(r =>
        `• *${r.serverName}* PID ${r.pid} (GPUs: ${r.gpuIds.join(',')}) → ${r.status}`
      ).join('\n');

      await respond({ text: `✅ Done. Killed: ${killed}, Not found/failed: ${failed}\n${lines}` });
      return;
    }

    // With args: legacy cancel by server + username
    if (args.length < 2) {
      await respond({ text: '⚠️ Usage: `/cancel` (cancel all) or `/cancel <server> <username>`' });
      return;
    }

    const serverName = args[0];
    const username = args[1];

    const servers = await getServers();
    const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

    if (!server) {
      await respond({ text: `❌ Server not found: ${serverName}` });
      return;
    }

    await respond({ text: `⏳ Killing processes for ${username} on ${serverName}...` });

    const success = await killUserProcesses(server, username);

    if (success) {
      await respond({ text: `✅ Killed GPU occupation processes for *${username}* on *${serverName}*` });
    } else {
      await respond({ text: `⚠️ Command executed, but no processes may have been found for ${username}` });
    }
  } catch (error) {
    console.error('Error in /cancel:', error);
    await respond({ text: `❌ Failed to cancel: ${error.message}` });
  }
});

// /gpuhelp command - main help for the plugin
app.command('/gpuhelp', async ({ command, ack, respond }) => {
  await ack();
  await respond(getMainHelpMessage());
});

// Handle direct messages to the app (App Home)
app.event('message', async ({ event, say }) => {
  // Only handle DMs (im type)
  if (event.channel_type !== 'im') return;

  const text = event.text?.toLowerCase().trim() || '';

  // Simple command parsing for DMs
  if (text === 'help' || text === 'hi' || text === 'hello') {
    await say(getMainHelpMessage());
  } else if (text === 'status' || text === 'gpu') {
    try {
      const servers = await getServers();
      if (servers.length === 0) {
        await say({ text: '⚠️ No servers configured. Use `/config add` to add servers.' });
      } else {
        const results = await getAllServersGpuStatus();
        await say(formatMultiServerMessage(results));
      }
    } catch (error) {
      await say({ text: `❌ Error: ${error.message}` });
    }
  } else if (text.startsWith('servers') || text.startsWith('list')) {
    const servers = await getServers();
    if (servers.length === 0) {
      await say({ text: '📋 No servers configured.' });
    } else {
      const list = servers.map((s, i) => `${i + 1}. *${s.name}* - \`${s.host}\``).join('\n');
      await say({ text: `*Configured Servers:*\n${list}` });
    }
  } else {
    await say({
      text: `I didn't understand that. Try:\n• \`help\` - Show all commands\n• \`status\` - Check GPU status\n• \`servers\` - List configured servers\n\nOr use slash commands like \`/gpu\`, \`/occupy\`, \`/monitor\`, \`/cancel\``,
    });
  }
});

// App Home opened event
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🖥️ GPU Monitor', emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Monitor and manage GPU resources across your servers.',
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Available Commands:*\n\n• `/gpu` - Check GPU status\n• `/occupy` - Occupy GPUs on a server\n• `/monitor` - Auto-monitor and occupy\n• `/cancel` - Cancel GPU occupation\n• `/config` - Manage servers\n• `/gpuhelp` - Show help',
            },
          },
          { type: 'divider' },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: '💬 You can also send me direct messages! Try typing `help` or `status`.' },
            ],
          },
        ],
      },
    });
  } catch (error) {
    console.error('Error publishing home view:', error);
  }
});

// Handle monitor start
async function handleMonitorStart(args, respond, channelId) {
  // Parse: <server> <gpu_ids> <memory_gb> <python_path> <frequency_min> [min_free_gb]
  if (args.length < 5) {
    await respond({
      text: '⚠️ Usage: `/monitor start <server> <gpu_ids> <memory_gb> <python_path> <frequency_min> [min_free_gb]`\n\nExample: `/monitor start grandrapids 0,1 40 /usr/bin/python3 30 45`',
    });
    return;
  }

  const serverName = args[0];
  const gpuIds = args[1].split(',').map(id => parseInt(id.trim()));
  const memoryGB = parseFloat(args[2]);
  const pythonPath = args[3];
  const frequencyMin = parseInt(args[4]);
  const minFreeGB = parseFloat(args[5]) || memoryGB + 2; // Default: need memory + 2GB buffer

  // Validate
  if (gpuIds.some(isNaN) || isNaN(memoryGB) || isNaN(frequencyMin)) {
    await respond({ text: '❌ Invalid arguments. Check numbers and try again.' });
    return;
  }

  if (frequencyMin < 1 || frequencyMin > 1440) {
    await respond({ text: '❌ Frequency must be between 1 and 1440 minutes.' });
    return;
  }

  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

  if (!server) {
    await respond({ text: `❌ Server not found: ${serverName}` });
    return;
  }

  const monitorId = `${serverName}-${Date.now()}`;
  const intervalMs = frequencyMin * 60 * 1000;

  const intervalId = setInterval(async () => {
    try {
      const { gpus } = await getServerGpuStatus(serverName);

      // Check if target GPUs have enough free memory
      let allAvailable = true;
      for (const gpuId of gpuIds) {
        const gpu = gpus.find(g => g.index === gpuId);
        if (!gpu) {
          console.log(`Monitor ${monitorId}: GPU ${gpuId} not found`);
          allAvailable = false;
          break;
        }
        const freeGB = (gpu.memoryTotal - gpu.memoryUsed) / 1024;
        if (freeGB < minFreeGB) {
          console.log(`Monitor ${monitorId}: GPU ${gpuId} has ${freeGB.toFixed(1)}GB free, need ${minFreeGB}GB`);
          allAvailable = false;
          break;
        }
      }

      if (allAvailable) {
        // GPUs available! Start occupation and stop monitoring
        console.log(`Monitor ${monitorId}: GPUs available, starting occupation`);

        try {
          const result = await startGpuOccupation(server, pythonPath, gpuIds, memoryGB);

          // Notify user
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: channelId,
            text: `🎉 *Auto-occupy triggered!*\n\nServer: *${serverName}*\nGPUs: ${gpuIds.join(', ')}\nMemory: ${memoryGB}GB each\nPID: ${result.pid}\n\nMonitor has been stopped.`,
          });

          // Stop this monitor (one-shot)
          clearInterval(intervalId);
          autoOccupyMonitors.delete(monitorId);
        } catch (occupyError) {
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: channelId,
            text: `⚠️ Monitor ${monitorId}: GPUs were available but occupation failed: ${occupyError.message}`,
          });
        }
      }
    } catch (error) {
      console.error(`Monitor ${monitorId} error:`, error.message);
    }
  }, intervalMs);

  autoOccupyMonitors.set(monitorId, {
    intervalId,
    serverName,
    gpuIds,
    memoryGB,
    pythonPath,
    frequencyMin,
    minFreeGB,
    channelId,
    createdAt: new Date(),
  });

  await respond({
    text: `✅ Auto-occupy monitor started!\n\n• *ID:* ${monitorId}\n• *Server:* ${serverName}\n• *GPUs:* ${gpuIds.join(', ')}\n• *Memory:* ${memoryGB}GB each\n• *Check every:* ${frequencyMin} min\n• *Min free required:* ${minFreeGB}GB\n\nWill auto-occupy when GPUs are available (one-time). Use \`/monitor stop ${monitorId}\` to cancel.`,
  });
}

// Handle monitor stop
async function handleMonitorStop(args, respond) {
  if (args.length < 1) {
    await respond({ text: '⚠️ Usage: `/monitor stop <monitor_id>` or `/monitor stop all`' });
    return;
  }

  const monitorId = args[0];

  if (monitorId === 'all') {
    const count = autoOccupyMonitors.size;
    for (const [id, monitor] of autoOccupyMonitors) {
      clearInterval(monitor.intervalId);
    }
    autoOccupyMonitors.clear();
    await respond({ text: `✅ Stopped all ${count} monitor(s).` });
    return;
  }

  const monitor = autoOccupyMonitors.get(monitorId);
  if (!monitor) {
    await respond({ text: `❌ Monitor not found: ${monitorId}. Use \`/monitor list\` to see active monitors.` });
    return;
  }

  clearInterval(monitor.intervalId);
  autoOccupyMonitors.delete(monitorId);
  await respond({ text: `✅ Monitor *${monitorId}* stopped.` });
}

// Handle monitor list
async function handleMonitorList(respond) {
  if (autoOccupyMonitors.size === 0) {
    await respond({ text: '📋 No active auto-occupy monitors.' });
    return;
  }

  const list = Array.from(autoOccupyMonitors.entries())
    .map(([id, m]) => `• *${id}*\n  Server: ${m.serverName} | GPUs: ${m.gpuIds.join(',')} | Every ${m.frequencyMin}min`)
    .join('\n\n');

  await respond({
    text: `*Active Auto-Occupy Monitors (${autoOccupyMonitors.size}):*\n\n${list}`,
  });
}

// Handle showing current GPU status (multi-server)
async function handleGpuStatus(respond) {
  const servers = await getServers();

  if (servers.length === 0) {
    // No servers configured, try local
    try {
      const gpuData = await getLocalGpuStatus();
      const gpuInfo = parseGpuInfo(gpuData);
      const message = formatGpuMessage(gpuInfo, 'Local');
      await respond(message);
    } catch (error) {
      await respond({
        text: '⚠️ No servers configured and no local GPU found.\nUse `/config add <name> <host>` to add a remote server.',
      });
    }
    return;
  }

  // Query all servers
  const results = await getAllServersGpuStatus();
  const message = formatMultiServerMessage(results);
  await respond(message);
}

// Handle starting scheduled monitoring
async function handleStartMonitoring(channelId, respond, intervalArg) {
  if (scheduledChannels.has(channelId)) {
    await respond({
      text: '⚠️ Monitoring is already running in this channel. Use `/gpu stop` to stop it first.',
    });
    return;
  }

  const intervalMinutes = parseInt(intervalArg) || 5;
  if (intervalMinutes < 1 || intervalMinutes > 60) {
    await respond({
      text: '⚠️ Interval must be between 1 and 60 minutes.',
    });
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  // Send initial status
  await handleGpuStatus(respond);

  // Set up interval for periodic updates
  const intervalId = setInterval(async () => {
    try {
      const servers = await getServers();
      let message;

      if (servers.length === 0) {
        const gpuData = await getLocalGpuStatus();
        const gpuInfo = parseGpuInfo(gpuData);
        message = formatGpuMessage(gpuInfo, 'Local');
      } else {
        const results = await getAllServersGpuStatus();
        message = formatMultiServerMessage(results);
      }

      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        ...message,
      });
    } catch (error) {
      console.error('Error in scheduled monitoring:', error);
    }
  }, intervalMs);

  scheduledChannels.set(channelId, intervalId);

  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: channelId,
    text: `✅ GPU monitoring started! Updates every ${intervalMinutes} minute(s). Use \`/gpu stop\` to stop.`,
  });
}

// Handle stopping scheduled monitoring
async function handleStopMonitoring(channelId, respond) {
  const intervalId = scheduledChannels.get(channelId);

  if (!intervalId) {
    await respond({
      text: '⚠️ No monitoring is currently running in this channel.',
    });
    return;
  }

  clearInterval(intervalId);
  scheduledChannels.delete(channelId);

  await respond({
    text: '🛑 GPU monitoring stopped.',
  });
}

// Handle /config add
async function handleConfigAdd(args, respond) {
  // Parse: name host [port] [--key path]
  if (args.length < 2) {
    await respond({
      text: '⚠️ Usage: `/config add <name> <user@host> [port] [--key /path/to/key]`',
    });
    return;
  }

  const name = args[0];
  const host = args[1];
  let port = 22;
  let identityFile = null;

  // Parse optional arguments
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--key' || args[i] === '-i') {
      identityFile = args[i + 1];
      i++;
    } else if (/^\d+$/.test(args[i])) {
      port = parseInt(args[i]);
    }
  }

  const server = await addServer({ name, host, port, identityFile });

  await respond({
    text: `✅ Server added successfully!\n• *Name:* ${server.name}\n• *Host:* ${server.host}\n• *Port:* ${server.port}${server.identityFile ? `\n• *Key:* ${server.identityFile}` : ''}`,
  });
}

// Handle /config remove
async function handleConfigRemove(args, respond) {
  if (args.length < 1) {
    await respond({
      text: '⚠️ Usage: `/config remove <name>`',
    });
    return;
  }

  const nameOrId = args[0];
  const removed = await removeServer(nameOrId);

  await respond({
    text: `✅ Server "${removed.name}" removed successfully.`,
  });
}

// Handle /config edit
async function handleConfigEdit(args, respond) {
  // Parse: name [--host newhost] [--port newport] [--key newkey] [--name newname]
  if (args.length < 2) {
    await respond({
      text: '⚠️ Usage: `/config edit <name> [--host user@host] [--port port] [--key /path/to/key] [--name newname]`',
    });
    return;
  }

  const nameOrId = args[0];
  const updates = {};

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        updates.host = args[++i];
        break;
      case '--port':
        updates.port = parseInt(args[++i]);
        break;
      case '--key':
      case '-i':
        updates.identityFile = args[++i];
        break;
      case '--name':
        updates.name = args[++i];
        break;
    }
  }

  if (Object.keys(updates).length === 0) {
    await respond({
      text: '⚠️ No updates provided. Use `--host`, `--port`, `--key`, or `--name` to specify changes.',
    });
    return;
  }

  const server = await editServer(nameOrId, updates);

  await respond({
    text: `✅ Server "${server.name}" updated successfully!\n• *Host:* ${server.host}\n• *Port:* ${server.port}${server.identityFile ? `\n• *Key:* ${server.identityFile}` : ''}`,
  });
}

// Handle /config list
async function handleConfigList(respond) {
  const servers = await getServers();

  if (servers.length === 0) {
    await respond({
      text: '📋 No servers configured.\nUse `/config add <name> <user@host>` to add a server.',
    });
    return;
  }

  const serverList = servers
    .map(
      (s, i) =>
        `${i + 1}. *${s.name}*\n   Host: \`${s.host}\` | Port: \`${s.port}\`${s.identityFile ? ` | Key: \`${s.identityFile}\`` : ''}`
    )
    .join('\n\n');

  await respond({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📋 Configured Servers (${servers.length})*`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: serverList,
        },
      },
    ],
  });
}

// Help message for /gpu
function getHelpMessage() {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*GPU Monitor Commands*',
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '`/gpu` - Show GPU status from all configured servers\n' +
            '`/gpu start [minutes]` - Start periodic monitoring (default: 5 min)\n' +
            '`/gpu stop` - Stop periodic monitoring\n' +
            '`/gpu help` - Show this help message\n\n' +
            '*Server Configuration*\n' +
            '`/config list` - List configured servers\n' +
            '`/config add` - Add a new server\n' +
            '`/config remove` - Remove a server\n' +
            '`/config help` - Show config help',
        },
      },
    ],
  };
}

// Help message for /config
function getConfigHelpMessage() {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Server Configuration Commands*',
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*List servers:*\n`/config list`\n\n' +
            '*Add a server:*\n`/config add <name> <user@host> [port] [--key /path/to/key]`\n' +
            'Example: `/config add server1 root@192.168.1.100 22 --key ~/.ssh/id_rsa`\n\n' +
            '*Remove a server:*\n`/config remove <name>`\n\n' +
            '*Edit a server:*\n`/config edit <name> [--host user@host] [--port port] [--key path] [--name newname]`\n' +
            'Example: `/config edit server1 --port 2222`',
        },
      },
    ],
  };
}

// Help message for /occupy
function getOccupyHelpMessage() {
  return {
    text:
      '*GPU Occupation Command*\n\n' +
      'Occupy GPUs on a server to reserve resources.\n\n' +
      '*Usage:*\n`/occupy <server> <gpu_ids> <memory_gb> <python_path>`\n\n' +
      '*Arguments:*\n' +
      '• `server` - Server name from `/config list`\n' +
      '• `gpu_ids` - Comma-separated GPU IDs (e.g., 0,1,2)\n' +
      '• `memory_gb` - Memory to allocate per GPU in GB\n' +
      '• `python_path` - Full path to Python with PyTorch\n\n' +
      '*Example:*\n`/occupy grandrapids 0,1,2 40 /home/user/miniconda3/bin/python`\n\n' +
      '*Note:* PyTorch must be installed at the specified Python path.',
  };
}

// Help message for /monitor
function getMonitorHelpMessage() {
  return {
    text:
      '*Auto-Occupy Monitor Command*\n\n' +
      'Watch GPUs and automatically occupy them when available.\n\n' +
      '*Commands:*\n' +
      '`/monitor start <server> <gpu_ids> <mem_gb> <python_path> <freq_min> [min_free_gb]`\n' +
      '`/monitor stop <monitor_id>` or `/monitor stop all`\n' +
      '`/monitor list` - Show active monitors\n\n' +
      '*Arguments:*\n' +
      '• `server` - Server name\n' +
      '• `gpu_ids` - GPUs to occupy (e.g., 0,1)\n' +
      '• `mem_gb` - Memory per GPU\n' +
      '• `python_path` - Python with PyTorch\n' +
      '• `freq_min` - Check frequency in minutes\n' +
      '• `min_free_gb` - Min free memory required (default: mem_gb + 2)\n\n' +
      '*Example:*\n`/monitor start grandrapids 0,1 40 /usr/bin/python3 30 45`\n\n' +
      '*Note:* Monitor stops after first successful occupation (one-shot).',
  };
}

// Main help message for /gpuhelp
function getMainHelpMessage() {
  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🖥️ GPU Monitor - Help', emoji: true },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*📊 Status Commands*\n' +
            '`/gpu` - Check GPU status across all servers\n' +
            '`/gpu start [min]` - Start periodic monitoring\n' +
            '`/gpu stop` - Stop periodic monitoring',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*🔒 GPU Occupation*\n' +
            '`/occupy <server> <gpus> <mem_gb> <python>` - Occupy GPUs\n' +
            '`/cancel <server> <username>` - Kill occupation processes',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*🤖 Auto-Monitor*\n' +
            '`/monitor start ...` - Watch and auto-occupy when available\n' +
            '`/monitor stop <id>` - Stop a monitor\n' +
            '`/monitor list` - List active monitors',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*⚙️ Server Config*\n' +
            '`/config list` - List configured servers\n' +
            '`/config add <name> <host>` - Add server\n' +
            '`/config remove <name>` - Remove server',
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '💬 You can also DM me! Try: `help`, `status`, `servers`' },
        ],
      },
    ],
  };
}

// Start both bots
(async () => {
  await app.start();
  console.log('⚡️ Slack GPU Monitor bot is running!');

  await startDiscord();
})();
