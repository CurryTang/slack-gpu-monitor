import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('gpu')
    .setDescription('Check GPU status across all servers')
    .addStringOption(opt =>
      opt.setName('action').setDescription('Action to perform')
        .addChoices(
          { name: 'status', value: 'status' },
          { name: 'start', value: 'start' },
          { name: 'stop', value: 'stop' },
          { name: 'help', value: 'help' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('interval').setDescription('Monitoring interval in minutes (1-60)')
        .setMinValue(1).setMaxValue(60)
    ),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Manage server configuration')
    .addSubcommand(sub =>
      sub.setName('add').setDescription('Add a server')
        .addStringOption(o => o.setName('name').setDescription('Server name').setRequired(true))
        .addStringOption(o => o.setName('host').setDescription('SSH host (user@hostname)').setRequired(true))
        .addIntegerOption(o => o.setName('port').setDescription('SSH port (default: 22)'))
        .addStringOption(o => o.setName('key').setDescription('Path to SSH key'))
    )
    .addSubcommand(sub =>
      sub.setName('remove').setDescription('Remove a server')
        .addStringOption(o => o.setName('name').setDescription('Server name').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('edit').setDescription('Edit a server')
        .addStringOption(o => o.setName('name').setDescription('Server name').setRequired(true))
        .addStringOption(o => o.setName('host').setDescription('New SSH host'))
        .addIntegerOption(o => o.setName('port').setDescription('New SSH port'))
        .addStringOption(o => o.setName('key').setDescription('New SSH key path'))
        .addStringOption(o => o.setName('newname').setDescription('New server name'))
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List all configured servers')
    ),

  new SlashCommandBuilder()
    .setName('occupy')
    .setDescription('Occupy GPUs on a server')
    .addStringOption(o => o.setName('server').setDescription('Server name').setRequired(true))
    .addStringOption(o => o.setName('gpu_ids').setDescription('Comma-separated GPU IDs (e.g., 0,1,2)').setRequired(true))
    .addNumberOption(o => o.setName('memory_gb').setDescription('Memory per GPU in GB').setRequired(true))
    .addStringOption(o => o.setName('python_path').setDescription('Path to Python with PyTorch').setRequired(true)),

  new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Auto-monitor and occupy GPUs')
    .addSubcommand(sub =>
      sub.setName('start').setDescription('Start auto-occupy monitor')
        .addStringOption(o => o.setName('server').setDescription('Server name').setRequired(true))
        .addStringOption(o => o.setName('gpu_ids').setDescription('GPU IDs (e.g., 0,1)').setRequired(true))
        .addNumberOption(o => o.setName('memory_gb').setDescription('Memory per GPU in GB').setRequired(true))
        .addStringOption(o => o.setName('python_path').setDescription('Python path with PyTorch').setRequired(true))
        .addIntegerOption(o => o.setName('frequency_min').setDescription('Check frequency in minutes').setRequired(true).setMinValue(1).setMaxValue(1440))
        .addNumberOption(o => o.setName('min_free_gb').setDescription('Min free GB required (default: memory_gb + 2)'))
    )
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('Stop a monitor')
        .addStringOption(o => o.setName('monitor_id').setDescription('Monitor ID or "all"').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List active monitors')
    ),

  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel GPU occupations (no args = cancel all tracked)')
    .addStringOption(o => o.setName('server').setDescription('Server name (optional)'))
    .addStringOption(o => o.setName('username').setDescription('Username whose processes to kill (optional)')),

  new SlashCommandBuilder()
    .setName('gpuhelp')
    .setDescription('Show all GPU Monitor commands'),
];

const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

async function register() {
  const commandData = commands.map(c => c.toJSON());

  if (process.env.DISCORD_GUILD_ID) {
    console.log(`Registering ${commandData.length} commands to guild ${process.env.DISCORD_GUILD_ID}...`);
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.DISCORD_GUILD_ID),
      { body: commandData },
    );
  } else {
    console.log(`Registering ${commandData.length} global commands (may take up to 1 hour to propagate)...`);
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_APP_ID),
      { body: commandData },
    );
  }

  console.log('Commands registered successfully!');
}

register().catch(console.error);
