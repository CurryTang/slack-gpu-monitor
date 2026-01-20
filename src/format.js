import { getGpuStatusIndicator } from './gpu.js';

/**
 * Format GPU info into a Slack Block Kit message
 * @param {Array} gpuInfoArray - Array of GPU info objects
 * @param {string} [serverName] - Optional server name for header
 */
export function formatGpuMessage(gpuInfoArray, serverName = null) {
  const timestamp = new Date().toLocaleString();
  const headerText = serverName
    ? `🖥️ GPU Status - ${serverName}`
    : '🖥️ GPU Status Report';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Last updated: ${timestamp}`,
        },
      ],
    },
    {
      type: 'divider',
    },
  ];

  for (const gpu of gpuInfoArray) {
    const status = getGpuStatusIndicator(gpu);
    const memoryPercent = ((gpu.memoryUsed / gpu.memoryTotal) * 100).toFixed(1);
    const powerPercent = ((gpu.powerDraw / gpu.powerLimit) * 100).toFixed(1);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*GPU ${gpu.index}: ${gpu.name}*\n` +
          `${status.emoji} Status: *${status.status}*`,
      },
    });

    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*🌡️ Temperature*\n${gpu.temperature}°C`,
        },
        {
          type: 'mrkdwn',
          text: `*⚡ GPU Utilization*\n${gpu.gpuUtilization}%`,
        },
        {
          type: 'mrkdwn',
          text: `*💾 Memory*\n${gpu.memoryUsed} / ${gpu.memoryTotal} MiB (${memoryPercent}%)`,
        },
        {
          type: 'mrkdwn',
          text: `*🔌 Power*\n${gpu.powerDraw.toFixed(1)} / ${gpu.powerLimit.toFixed(1)} W (${powerPercent}%)`,
        },
      ],
    });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `GPU Load: ${createProgressBar(gpu.gpuUtilization)} | Memory: ${createProgressBar(parseFloat(memoryPercent))}`,
        },
      ],
    });

    blocks.push({
      type: 'divider',
    });
  }

  // Remove the last divider
  blocks.pop();

  return {
    text: `GPU Status Report - ${gpuInfoArray.length} GPU(s)`,
    blocks,
  };
}

/**
 * Format multi-server GPU status into a Slack Block Kit message
 * Uses a compact format to stay under Slack's 50 block limit
 * @param {Array} serverResults - Array of { server, gpus, error } objects
 */
export function formatMultiServerMessage(serverResults) {
  const timestamp = new Date().toLocaleString();
  const totalGpus = serverResults.reduce((sum, r) => sum + r.gpus.length, 0);
  const errorCount = serverResults.filter((r) => r.error).length;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🖥️ GPU Status Report',
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${serverResults.length} server(s) | ${totalGpus} GPU(s)${errorCount > 0 ? ` | ${errorCount} error(s)` : ''} | Updated: ${timestamp}`,
        },
      ],
    },
    {
      type: 'divider',
    },
  ];

  for (const result of serverResults) {
    // Server header
    const serverStatus = result.error ? '🔴' : '🟢';

    if (result.error) {
      // Show server with error in a single block
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${serverStatus} *${result.server.name}* (\`${result.server.host}\`)\n❌ ${result.error}`,
        },
      });
    } else {
      // Combine all GPUs for this server into a single text block
      // This drastically reduces the number of blocks used
      // Slack section text limit is 3000 chars, so we may need to split
      const serverHeader = `${serverStatus} *${result.server.name}* (\`${result.server.host}\`)`;
      const gpuLines = result.gpus.map((gpu) => {
        const status = getGpuStatusIndicator(gpu);
        const memoryPercent = ((gpu.memoryUsed / gpu.memoryTotal) * 100).toFixed(0);
        const memGB = (gpu.memoryUsed / 1024).toFixed(1);
        const memTotalGB = (gpu.memoryTotal / 1024).toFixed(1);
        return `${status.emoji} GPU ${gpu.index} ${gpu.name} | ${gpu.gpuUtilization}% | ${memGB}/${memTotalGB}GB (${memoryPercent}%) | ${gpu.temperature}°C`;
      });

      // Check if we need to split into multiple blocks (3000 char limit)
      let currentText = serverHeader;
      for (const line of gpuLines) {
        if ((currentText + '\n' + line).length > 2900) {
          // Push current block and start a new one
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: currentText },
          });
          currentText = line;
        } else {
          currentText += '\n' + line;
        }
      }
      // Push remaining text
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: currentText },
      });
    }

    blocks.push({
      type: 'divider',
    });
  }

  // Remove the last divider
  if (blocks.length > 0 && blocks[blocks.length - 1].type === 'divider') {
    blocks.pop();
  }

  // Safety check: if we still exceed 50 blocks, truncate and add a warning
  const MAX_BLOCKS = 50;
  if (blocks.length > MAX_BLOCKS) {
    const truncated = blocks.slice(0, MAX_BLOCKS - 1);
    truncated.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⚠️ Output truncated. Showing partial results (${MAX_BLOCKS} block limit).`,
        },
      ],
    });
    return {
      text: `GPU Status Report - ${serverResults.length} server(s), ${totalGpus} GPU(s)`,
      blocks: truncated,
    };
  }

  return {
    text: `GPU Status Report - ${serverResults.length} server(s), ${totalGpus} GPU(s)`,
    blocks,
  };
}

/**
 * Create a text-based progress bar
 */
function createProgressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${percent.toFixed(0)}%`;
}

/**
 * Format an error message for Slack
 */
export function formatErrorMessage(errorMessage) {
  return {
    text: `Error: ${errorMessage}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ *Error*\n${errorMessage}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Make sure `nvidia-smi` is available and NVIDIA drivers are properly installed.',
          },
        ],
      },
    ],
  };
}
