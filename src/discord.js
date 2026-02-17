import { Client, GatewayIntentBits, Events } from 'discord.js';
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
import {
  formatMultiServerEmbeds,
  formatGpuEmbed,
  formatErrorEmbed,
  formatHelpEmbed,
} from './discord-format.js';
import { addServer, removeServer, editServer, getServers } from './config.js';

// Per-platform in-memory state (separate from Slack)
const scheduledChannels = new Map();
const autoOccupyMonitors = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

export async function startDiscord() {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.log('DISCORD_BOT_TOKEN not set, skipping Discord bot.');
    return;
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord bot logged in as ${c.user.tag}`);
  });

  client.on(Events.InteractionCreate, handleInteraction);

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'gpu':     await handleGpu(interaction); break;
      case 'config':  await handleConfig(interaction); break;
      case 'occupy':  await handleOccupy(interaction); break;
      case 'monitor': await handleMonitor(interaction); break;
      case 'cancel':  await handleCancel(interaction); break;
      case 'gpuhelp': await handleGpuHelp(interaction); break;
    }
  } catch (error) {
    console.error(`Discord command error (${commandName}):`, error);
    const embeds = [formatErrorEmbed(error.message)];
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds });
    } else {
      await interaction.reply({ embeds, ephemeral: true });
    }
  }
}

// /gpu [action] [interval]
async function handleGpu(interaction) {
  const action = interaction.options.getString('action') || 'status';

  switch (action) {
    case 'status': {
      await interaction.deferReply();
      const servers = await getServers();

      if (servers.length === 0) {
        try {
          const gpuData = await getLocalGpuStatus();
          const gpuInfo = parseGpuInfo(gpuData);
          const embed = formatGpuEmbed(gpuInfo, 'Local');
          await interaction.editReply({ embeds: [embed] });
        } catch {
          await interaction.editReply({
            content: 'No servers configured and no local GPU found. Use `/config add` to add a server.',
          });
        }
        return;
      }

      const results = await getAllServersGpuStatus();
      const embeds = formatMultiServerEmbeds(results);
      await interaction.editReply({ embeds });
      break;
    }

    case 'start': {
      const intervalMinutes = interaction.options.getInteger('interval') || 5;
      const channelId = interaction.channelId;

      if (scheduledChannels.has(channelId)) {
        await interaction.reply({
          content: 'Monitoring is already running in this channel. Use `/gpu action:stop` to stop it first.',
          ephemeral: true,
        });
        return;
      }

      if (intervalMinutes < 1 || intervalMinutes > 60) {
        await interaction.reply({ content: 'Interval must be between 1 and 60 minutes.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const servers = await getServers();
      let embeds;

      if (servers.length === 0) {
        try {
          const gpuData = await getLocalGpuStatus();
          const gpuInfo = parseGpuInfo(gpuData);
          embeds = [formatGpuEmbed(gpuInfo, 'Local')];
        } catch {
          await interaction.editReply({ content: 'No servers configured and no local GPU found.' });
          return;
        }
      } else {
        const results = await getAllServersGpuStatus();
        embeds = formatMultiServerEmbeds(results);
      }

      await interaction.editReply({ embeds });

      const intervalMs = intervalMinutes * 60 * 1000;
      const intervalId = setInterval(async () => {
        try {
          const channel = await client.channels.fetch(channelId);
          const srvs = await getServers();
          let msg;

          if (srvs.length === 0) {
            const gpuData = await getLocalGpuStatus();
            const gpuInfo = parseGpuInfo(gpuData);
            msg = { embeds: [formatGpuEmbed(gpuInfo, 'Local')] };
          } else {
            const results = await getAllServersGpuStatus();
            msg = { embeds: formatMultiServerEmbeds(results) };
          }

          await channel.send(msg);
        } catch (error) {
          console.error('Error in Discord scheduled monitoring:', error);
        }
      }, intervalMs);

      scheduledChannels.set(channelId, intervalId);

      const channel = await client.channels.fetch(channelId);
      await channel.send({
        content: `GPU monitoring started! Updates every ${intervalMinutes} minute(s). Use \`/gpu action:stop\` to stop.`,
      });
      break;
    }

    case 'stop': {
      const channelId = interaction.channelId;
      const intervalId = scheduledChannels.get(channelId);

      if (!intervalId) {
        await interaction.reply({
          content: 'No monitoring is currently running in this channel.',
          ephemeral: true,
        });
        return;
      }

      clearInterval(intervalId);
      scheduledChannels.delete(channelId);
      await interaction.reply({ content: 'GPU monitoring stopped.' });
      break;
    }

    case 'help': {
      await interaction.reply({ embeds: [formatHelpEmbed()], ephemeral: true });
      break;
    }
  }
}

// /config add|remove|edit|list
async function handleConfig(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'add': {
      const name = interaction.options.getString('name');
      const host = interaction.options.getString('host');
      const port = interaction.options.getInteger('port') || 22;
      const identityFile = interaction.options.getString('key') || null;

      const server = await addServer({ name, host, port, identityFile });
      await interaction.reply({
        content: `Server added!\n**Name:** ${server.name}\n**Host:** ${server.host}\n**Port:** ${server.port}${server.identityFile ? `\n**Key:** ${server.identityFile}` : ''}`,
        ephemeral: true,
      });
      break;
    }

    case 'remove': {
      const nameOrId = interaction.options.getString('name');
      const removed = await removeServer(nameOrId);
      await interaction.reply({
        content: `Server "${removed.name}" removed.`,
        ephemeral: true,
      });
      break;
    }

    case 'edit': {
      const nameOrId = interaction.options.getString('name');
      const updates = {};
      const host = interaction.options.getString('host');
      const port = interaction.options.getInteger('port');
      const key = interaction.options.getString('key');
      const newname = interaction.options.getString('newname');

      if (host) updates.host = host;
      if (port) updates.port = port;
      if (key) updates.identityFile = key;
      if (newname) updates.name = newname;

      if (Object.keys(updates).length === 0) {
        await interaction.reply({
          content: 'No updates provided. Use `host`, `port`, `key`, or `newname` options.',
          ephemeral: true,
        });
        return;
      }

      const server = await editServer(nameOrId, updates);
      await interaction.reply({
        content: `Server "${server.name}" updated!\n**Host:** ${server.host}\n**Port:** ${server.port}${server.identityFile ? `\n**Key:** ${server.identityFile}` : ''}`,
        ephemeral: true,
      });
      break;
    }

    case 'list': {
      const servers = await getServers();

      if (servers.length === 0) {
        await interaction.reply({
          content: 'No servers configured. Use `/config add` to add a server.',
          ephemeral: true,
        });
        return;
      }

      const list = servers
        .map((s, i) => `${i + 1}. **${s.name}** - \`${s.host}\` (port ${s.port})${s.identityFile ? ` | key: \`${s.identityFile}\`` : ''}`)
        .join('\n');

      await interaction.reply({
        content: `**Configured Servers (${servers.length})**\n${list}`,
        ephemeral: true,
      });
      break;
    }
  }
}

// /occupy <server> <gpu_ids> <memory_gb> <python_path>
async function handleOccupy(interaction) {
  const serverName = interaction.options.getString('server');
  const gpuIdsStr = interaction.options.getString('gpu_ids');
  const memoryGB = interaction.options.getNumber('memory_gb');
  const pythonPath = interaction.options.getString('python_path');

  const gpuIds = gpuIdsStr.split(',').map(id => parseInt(id.trim()));

  if (gpuIds.some(isNaN)) {
    await interaction.reply({ content: 'Invalid GPU IDs. Use comma-separated numbers (e.g., 0,1,2)', ephemeral: true });
    return;
  }

  if (isNaN(memoryGB) || memoryGB <= 0) {
    await interaction.reply({ content: 'Invalid memory amount. Provide a positive number in GB.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

  if (!server) {
    await interaction.editReply({ content: `Server not found: ${serverName}. Use \`/config list\` to see available servers.` });
    return;
  }

  const result = await startGpuOccupation(server, pythonPath, gpuIds, memoryGB);

  await interaction.editReply({
    content: `GPU occupation started on **${serverName}**\n\u2022 GPUs: ${gpuIds.join(', ')}\n\u2022 Memory: ${memoryGB}GB each\n\u2022 PID: ${result.pid}\n\nUse \`/cancel server:${serverName} username:<your_user>\` to stop.`,
  });
}

// /monitor start|stop|list
async function handleMonitor(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'start': {
      const serverName = interaction.options.getString('server');
      const gpuIdsStr = interaction.options.getString('gpu_ids');
      const memoryGB = interaction.options.getNumber('memory_gb');
      const pythonPath = interaction.options.getString('python_path');
      const frequencyMin = interaction.options.getInteger('frequency_min');
      const minFreeGB = interaction.options.getNumber('min_free_gb') || memoryGB + 2;

      const gpuIds = gpuIdsStr.split(',').map(id => parseInt(id.trim()));

      if (gpuIds.some(isNaN)) {
        await interaction.reply({ content: 'Invalid GPU IDs.', ephemeral: true });
        return;
      }

      const servers = await getServers();
      const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

      if (!server) {
        await interaction.reply({ content: `Server not found: ${serverName}`, ephemeral: true });
        return;
      }

      const monitorId = `${serverName}-${Date.now()}`;
      const intervalMs = frequencyMin * 60 * 1000;
      const channelId = interaction.channelId;

      const intervalId = setInterval(async () => {
        try {
          const { gpus } = await getServerGpuStatus(serverName);

          let allAvailable = true;
          for (const gpuId of gpuIds) {
            const gpu = gpus.find(g => g.index === gpuId);
            if (!gpu) { allAvailable = false; break; }
            const freeGB = (gpu.memoryTotal - gpu.memoryUsed) / 1024;
            if (freeGB < minFreeGB) { allAvailable = false; break; }
          }

          if (allAvailable) {
            try {
              const result = await startGpuOccupation(server, pythonPath, gpuIds, memoryGB);
              const channel = await client.channels.fetch(channelId);
              await channel.send({
                content: `**Auto-occupy triggered!**\n\nServer: **${serverName}**\nGPUs: ${gpuIds.join(', ')}\nMemory: ${memoryGB}GB each\nPID: ${result.pid}\n\nMonitor has been stopped.`,
              });
            } catch (occupyError) {
              const channel = await client.channels.fetch(channelId);
              await channel.send({
                content: `Monitor ${monitorId}: GPUs were available but occupation failed: ${occupyError.message}`,
              });
            }

            clearInterval(intervalId);
            autoOccupyMonitors.delete(monitorId);
          }
        } catch (error) {
          console.error(`Discord monitor ${monitorId} error:`, error.message);
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

      await interaction.reply({
        content: `Auto-occupy monitor started!\n\n\u2022 **ID:** ${monitorId}\n\u2022 **Server:** ${serverName}\n\u2022 **GPUs:** ${gpuIds.join(', ')}\n\u2022 **Memory:** ${memoryGB}GB each\n\u2022 **Check every:** ${frequencyMin} min\n\u2022 **Min free required:** ${minFreeGB}GB\n\nWill auto-occupy when GPUs are available (one-time). Use \`/monitor stop monitor_id:${monitorId}\` to cancel.`,
      });
      break;
    }

    case 'stop': {
      const monitorId = interaction.options.getString('monitor_id');

      if (monitorId === 'all') {
        const count = autoOccupyMonitors.size;
        for (const [, monitor] of autoOccupyMonitors) {
          clearInterval(monitor.intervalId);
        }
        autoOccupyMonitors.clear();
        await interaction.reply({ content: `Stopped all ${count} monitor(s).` });
        return;
      }

      const monitor = autoOccupyMonitors.get(monitorId);
      if (!monitor) {
        await interaction.reply({
          content: `Monitor not found: ${monitorId}. Use \`/monitor list\` to see active monitors.`,
          ephemeral: true,
        });
        return;
      }

      clearInterval(monitor.intervalId);
      autoOccupyMonitors.delete(monitorId);
      await interaction.reply({ content: `Monitor **${monitorId}** stopped.` });
      break;
    }

    case 'list': {
      if (autoOccupyMonitors.size === 0) {
        await interaction.reply({ content: 'No active auto-occupy monitors.', ephemeral: true });
        return;
      }

      const list = Array.from(autoOccupyMonitors.entries())
        .map(([id, m]) => `\u2022 **${id}**\n  Server: ${m.serverName} | GPUs: ${m.gpuIds.join(',')} | Every ${m.frequencyMin}min`)
        .join('\n\n');

      await interaction.reply({
        content: `**Active Auto-Occupy Monitors (${autoOccupyMonitors.size}):**\n\n${list}`,
        ephemeral: true,
      });
      break;
    }
  }
}

// /cancel [server] [username]
async function handleCancel(interaction) {
  const serverName = interaction.options.getString('server');
  const username = interaction.options.getString('username');

  await interaction.deferReply();

  // No args: cancel all tracked occupations
  if (!serverName && !username) {
    const occs = await getOccupations();
    if (occs.length === 0) {
      await interaction.editReply({ content: 'No tracked GPU occupations to cancel.' });
      return;
    }

    const { killed, failed, results } = await cancelAllOccupations();
    const lines = results.map(r =>
      `\u2022 **${r.serverName}** PID ${r.pid} (GPUs: ${r.gpuIds.join(',')}) \u2192 ${r.status}`
    ).join('\n');

    await interaction.editReply({ content: `Done. Killed: ${killed}, Not found/failed: ${failed}\n${lines}` });
    return;
  }

  if (!serverName || !username) {
    await interaction.editReply({ content: 'Usage: `/cancel` (cancel all) or `/cancel server:<name> username:<user>`' });
    return;
  }

  const servers = await getServers();
  const server = servers.find(s => s.name.toLowerCase() === serverName.toLowerCase());

  if (!server) {
    await interaction.editReply({ content: `Server not found: ${serverName}` });
    return;
  }

  const success = await killUserProcesses(server, username);

  if (success) {
    await interaction.editReply({ content: `Killed GPU occupation processes for **${username}** on **${serverName}**` });
  } else {
    await interaction.editReply({ content: `Command executed, but no processes may have been found for ${username}` });
  }
}

// /gpuhelp
async function handleGpuHelp(interaction) {
  await interaction.reply({ embeds: [formatHelpEmbed()], ephemeral: true });
}
