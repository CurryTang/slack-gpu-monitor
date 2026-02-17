import { EmbedBuilder } from 'discord.js';
import { getGpuStatusIndicator } from './gpu.js';

/**
 * Create a text-based progress bar
 */
function createProgressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + ` ${percent.toFixed(0)}%`;
}

/**
 * Get embed color based on max GPU utilization
 */
function getEmbedColor(gpus) {
  const maxUtil = Math.max(...gpus.map(g => g.gpuUtilization), 0);
  if (maxUtil >= 90) return 0xFF0000; // red
  if (maxUtil >= 50) return 0xFFFF00; // yellow
  if (maxUtil > 0) return 0x00FF00;   // green
  return 0x888888;                     // grey (idle)
}

/**
 * Format GPU info into a Discord embed
 * @param {Array} gpuInfoArray - Array of GPU info objects
 * @param {string} [serverName] - Optional server name for title
 * @returns {EmbedBuilder}
 */
export function formatGpuEmbed(gpuInfoArray, serverName = null) {
  const title = serverName ? `GPU Status - ${serverName}` : 'GPU Status Report';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(getEmbedColor(gpuInfoArray))
    .setTimestamp();

  for (const gpu of gpuInfoArray.slice(0, 25)) { // max 25 fields
    const status = getGpuStatusIndicator(gpu);
    const memoryPercent = ((gpu.memoryUsed / gpu.memoryTotal) * 100).toFixed(1);
    const memGB = (gpu.memoryUsed / 1024).toFixed(1);
    const memTotalGB = (gpu.memoryTotal / 1024).toFixed(1);

    embed.addFields({
      name: `${status.emoji} GPU ${gpu.index}: ${gpu.name}`,
      value: [
        `**Status:** ${status.status}`,
        `\uD83C\uDF21\uFE0F ${gpu.temperature}\u00B0C | \u26A1 ${gpu.gpuUtilization}% | \uD83D\uDCBE ${memGB}/${memTotalGB} GB (${memoryPercent}%)`,
        `\uD83D\uDD0C ${gpu.powerDraw.toFixed(1)}/${gpu.powerLimit.toFixed(1)} W`,
        `\`${createProgressBar(gpu.gpuUtilization)}\` | \`${createProgressBar(parseFloat(memoryPercent))}\``,
      ].join('\n'),
      inline: false,
    });
  }

  return embed;
}

/**
 * Format multi-server GPU status into Discord embeds (one per server)
 * @param {Array} serverResults - Array of { server, gpus, error } objects
 * @returns {EmbedBuilder[]}
 */
export function formatMultiServerEmbeds(serverResults) {
  const embeds = [];

  for (const result of serverResults.slice(0, 10)) { // max 10 embeds per message
    if (result.error) {
      embeds.push(
        new EmbedBuilder()
          .setTitle(`\uD83D\uDD34 ${result.server.name}`)
          .setDescription(`\u274C ${result.error}`)
          .setColor(0xFF0000)
          .setTimestamp()
      );
      continue;
    }

    const gpuLines = result.gpus.map(gpu => {
      const status = getGpuStatusIndicator(gpu);
      const memGB = (gpu.memoryUsed / 1024).toFixed(1);
      const memTotalGB = (gpu.memoryTotal / 1024).toFixed(1);
      const shortName = gpu.name.replace(/NVIDIA\s*(RTX\s*)?/i, '').replace(/\s+NVL.*$/i, '').trim();
      return `${status.emoji} **${gpu.index}:** ${shortName} | ${gpu.gpuUtilization}% | ${memGB}/${memTotalGB}GB`;
    });

    embeds.push(
      new EmbedBuilder()
        .setTitle(`\uD83D\uDFE2 ${result.server.name}`)
        .setDescription(gpuLines.join('\n').slice(0, 4096))
        .setColor(getEmbedColor(result.gpus))
        .setTimestamp()
    );
  }

  return embeds;
}

/**
 * Format an error message as a Discord embed
 * @param {string} errorMessage
 * @returns {EmbedBuilder}
 */
export function formatErrorEmbed(errorMessage) {
  return new EmbedBuilder()
    .setTitle('\u274C Error')
    .setDescription(errorMessage)
    .setColor(0xFF0000)
    .setFooter({ text: 'Make sure nvidia-smi is available and NVIDIA drivers are installed.' });
}

/**
 * Format help message as a Discord embed
 * @returns {EmbedBuilder}
 */
export function formatHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('\uD83D\uDDA5\uFE0F GPU Monitor - Help')
    .setColor(0x5865F2) // Discord blurple
    .addFields(
      {
        name: '\uD83D\uDCCA Status Commands',
        value: [
          '`/gpu` - Check GPU status across all servers',
          '`/gpu action:start` - Start periodic monitoring',
          '`/gpu action:stop` - Stop periodic monitoring',
        ].join('\n'),
        inline: false,
      },
      {
        name: '\uD83D\uDD12 GPU Occupation',
        value: [
          '`/occupy` - Occupy GPUs on a server',
          '`/cancel` - Kill occupation processes',
        ].join('\n'),
        inline: false,
      },
      {
        name: '\uD83E\uDD16 Auto-Monitor',
        value: [
          '`/monitor start` - Watch and auto-occupy when available',
          '`/monitor stop` - Stop a monitor',
          '`/monitor list` - List active monitors',
        ].join('\n'),
        inline: false,
      },
      {
        name: '\u2699\uFE0F Server Config',
        value: [
          '`/config list` - List configured servers',
          '`/config add` - Add a server',
          '`/config remove` - Remove a server',
          '`/config edit` - Edit a server',
        ].join('\n'),
        inline: false,
      },
    );
}
