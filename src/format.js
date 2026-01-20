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
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${serverStatus} *${result.server.name}* (\`${result.server.host}\`)`,
      },
    });

    if (result.error) {
      // Show error
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `❌ ${result.error}`,
          },
        ],
      });
    } else {
      // Show GPUs
      for (const gpu of result.gpus) {
        const status = getGpuStatusIndicator(gpu);
        const memoryPercent = ((gpu.memoryUsed / gpu.memoryTotal) * 100).toFixed(1);

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `  └ *GPU ${gpu.index}: ${gpu.name}*\n` +
              `     ${status.emoji} ${gpu.gpuUtilization}% util | ${gpu.memoryUsed}/${gpu.memoryTotal} MiB (${memoryPercent}%) | ${gpu.temperature}°C`,
          },
        });

        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `     GPU: ${createProgressBar(gpu.gpuUtilization, 8)} | Mem: ${createProgressBar(parseFloat(memoryPercent), 8)}`,
            },
          ],
        });
      }
    }

    blocks.push({
      type: 'divider',
    });
  }

  // Remove the last divider
  if (blocks.length > 0 && blocks[blocks.length - 1].type === 'divider') {
    blocks.pop();
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
