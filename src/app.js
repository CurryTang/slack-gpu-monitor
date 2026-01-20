import 'dotenv/config';
import bolt from '@slack/bolt';
import { getAllServersGpuStatus, getLocalGpuStatus, parseGpuInfo } from './gpu.js';
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

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ GPU Monitor bot is running!');
})();
