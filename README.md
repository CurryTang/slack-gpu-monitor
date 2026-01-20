# Slack GPU Monitor Bot

A Slack bot that monitors NVIDIA GPU status across multiple remote servers using `nvidia-smi` via SSH and reports to Slack channels.

## Features

- **Multi-server monitoring** - Monitor GPUs across multiple remote servers via SSH
- **Server management** - Add, remove, and edit server configurations via `/config`
- **Real-time status** - Check GPU status on-demand with `/gpu`
- **Scheduled monitoring** - Set up periodic updates with `/gpu start`
- **Rich formatting** - Visual progress bars, status indicators, and detailed metrics

---

## Part 1: Creating the Slack App

Before running the bot, you need to create and configure a Slack App.

### Step 1: Create a New Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Select **"From scratch"**
4. Enter an App Name (e.g., "GPU Monitor")
5. Select the workspace where you want to install the app
6. Click **"Create App"**

### Step 2: Configure Bot Permissions

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to **"Scopes"** → **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add:
   - `chat:write` - Allows the bot to send messages
   - `commands` - Allows the bot to handle slash commands

### Step 3: Enable Socket Mode

Socket Mode allows the bot to receive events without exposing a public URL.

1. In the left sidebar, click **"Socket Mode"**
2. Toggle **"Enable Socket Mode"** to ON
3. You'll be prompted to create an App-Level Token:
   - Name it (e.g., "GPU Monitoring socket token")
   - Add the scope `connections:write`
   - Click **"Generate"**
4. **Copy and save the App-Level Token** (starts with `xapp-`) - you'll need this later

### Step 4: Create the Slash Commands

1. In the left sidebar, click **"Slash Commands"**
2. Click **"Create New Command"** and create TWO commands:

**Command 1: /gpu**
- **Command:** `/gpu`
- **Short Description:** `Check GPU status`
- **Usage Hint:** `[start|stop|help]`

**Command 2: /config**
- **Command:** `/config`
- **Short Description:** `Manage GPU server configurations`
- **Usage Hint:** `[add|remove|edit|list|help]`

3. Click **"Save"** for each command

### Step 5: Install the App to Your Workspace

1. In the left sidebar, click **"Install App"**
2. Click **"Install to Workspace"**
3. Review the permissions and click **"Allow"**
4. **Copy the Bot User OAuth Token** (starts with `xoxb-`) - you'll need this later

---

## Part 2: Local Installation

### Step 1: Clone/Download the Project

```bash
cd /path/to/slack-gpu
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Slack Bot Token (from Step 5 above)
SLACK_BOT_TOKEN=xoxb-your-bot-token-here

# Slack App-Level Token (from Step 3 above)
SLACK_APP_TOKEN=xapp-your-app-token-here
```

### Step 4: Set Up SSH Access (for remote servers)

The bot connects to remote servers via SSH. Use the interactive setup tool to add servers and configure SSH keys:

```bash
npm run setup
```

This will:
1. Prompt for server details (name, host, port, SSH key)
2. Test the SSH connection
3. If SSH fails, offer to copy your SSH key using `ssh-copy-id` (will prompt for password)
4. Test that `nvidia-smi` works on the remote server
5. Save the server configuration

**Example session:**
```
╔════════════════════════════════════╗
║   GPU Monitor Server Setup Tool    ║
╚════════════════════════════════════╝

Options:
  1. List configured servers
  2. Add a new server
  3. Remove a server
  4. Test all servers
  5. Exit

Select option (1-5): 2

=== Add New GPU Server ===

Server name (e.g., training-server-1): gpu-server-1
SSH host (e.g., root@192.168.1.100): root@192.168.1.100
SSH port [22]: 22
SSH key path (leave empty for default):

Testing SSH connection...
❌ SSH connection failed: Permission denied

Would you like to copy your SSH key to this server? (y/n): y

Running: ssh-copy-id -p 22 root@192.168.1.100
You may be prompted for the password...

root@192.168.1.100's password: ********

✅ SSH key copied successfully!
Testing connection again...
✅ SSH connection successful!

Testing nvidia-smi...
✅ Found 2 GPU(s):
   GPU 0: NVIDIA A100-SXM4-80GB
   GPU 1: NVIDIA A100-SXM4-80GB

✅ Server "gpu-server-1" added successfully!
```

**Alternative: Manual SSH setup**
```bash
# Generate SSH key if needed
ssh-keygen -t ed25519 -C "gpu-monitor-bot"

# Copy to each server
ssh-copy-id user@gpu-server

# Test connection
ssh user@gpu-server "nvidia-smi"
```

### Step 5: Start the Bot

```bash
npm start
```

You should see:
```
⚡️ GPU Monitor bot is running!
[INFO] socket-mode:SocketModeClient:0 Now connected to Slack
```

---

## Part 3: Deployment Options

### Option A: Run as a Background Process (Linux/Mac)

Using `nohup`:
```bash
nohup npm start > gpu-bot.log 2>&1 &
```

Using `screen`:
```bash
screen -S gpu-bot
npm start
# Press Ctrl+A, then D to detach
```

### Option B: Run with PM2 (Recommended for Production)

Install PM2:
```bash
npm install -g pm2
```

Start the bot:
```bash
pm2 start src/app.js --name "gpu-monitor"
```

Useful PM2 commands:
```bash
pm2 status              # Check status
pm2 logs gpu-monitor    # View logs
pm2 restart gpu-monitor # Restart the bot
pm2 stop gpu-monitor    # Stop the bot
pm2 save                # Save process list
pm2 startup             # Auto-start on system boot
```

### Option C: Run with Docker

Create a `Dockerfile`:
```dockerfile
FROM node:20-slim

# Install SSH client
RUN apt-get update && apt-get install -y openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t gpu-monitor .
docker run -d \
  --env-file .env \
  -v ~/.ssh:/root/.ssh:ro \
  --name gpu-bot \
  gpu-monitor
```

### Option D: Deploy on DigitalOcean Droplet (Cheapest Option)

The cheapest option is a **$4/month Basic Droplet** (512MB RAM, 1 vCPU). This bot uses minimal resources.

#### Step 1: Create a Droplet

1. Go to [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Click **"Create"** → **"Droplets"**
3. Choose:
   - **Region:** Closest to your GPU servers
   - **Image:** Ubuntu 24.04 LTS
   - **Droplet Type:** Basic (Regular SSD)
   - **Size:** $4/mo (512 MB / 1 CPU) or $6/mo (1 GB / 1 CPU)
   - **Authentication:** SSH Key (recommended) or Password
4. Click **"Create Droplet"**
5. Note the IP address once created

#### Step 2: Connect to Your Droplet

```bash
ssh root@YOUR_DROPLET_IP
```

#### Step 3: Install Node.js

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version
```

#### Step 4: Create a Non-Root User (Recommended)

```bash
# Create user
adduser gpubot
usermod -aG sudo gpubot

# Switch to new user
su - gpubot
```

#### Step 5: Clone/Upload Your Project

**Option A: Using Git**
```bash
cd ~
git clone https://github.com/YOUR_USERNAME/slack-gpu.git
cd slack-gpu
```

**Option B: Using SCP (from your local machine)**
```bash
# Run this on your LOCAL machine
scp -r /path/to/slack-gpu gpubot@YOUR_DROPLET_IP:~/
```

#### Step 6: Install Dependencies and Configure

```bash
cd ~/slack-gpu
npm install

# Create .env file
nano .env
```

Add your Slack tokens:
```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

Save with `Ctrl+X`, then `Y`, then `Enter`.

#### Step 7: Set Up SSH Keys for GPU Servers

```bash
# Generate SSH key for the bot
ssh-keygen -t ed25519 -C "gpu-monitor-bot"

# Run the setup tool to add servers and copy keys
npm run setup
```

#### Step 8: Install PM2 and Start the Bot

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the bot
pm2 start src/app.js --name "gpu-monitor"

# Make PM2 start on boot
pm2 startup
# Copy and run the command it outputs

# Save the process list
pm2 save
```

#### Step 9: Verify It's Running

```bash
pm2 status
pm2 logs gpu-monitor
```

#### Useful Commands

```bash
pm2 logs gpu-monitor     # View logs
pm2 restart gpu-monitor  # Restart bot
pm2 stop gpu-monitor     # Stop bot
pm2 monit                # Real-time monitoring
```

#### Cost Summary

| Resource | Cost |
|----------|------|
| Basic Droplet (512MB) | $4/month |
| Basic Droplet (1GB) | $6/month |
| Bandwidth | Usually free (included) |

---

### Option E: Run as a Systemd Service (Linux)

Create `/etc/systemd/system/gpu-monitor.service`:
```ini
[Unit]
Description=Slack GPU Monitor Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/slack-gpu
ExecStart=/usr/bin/node src/app.js
Restart=on-failure
EnvironmentFile=/path/to/slack-gpu/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable gpu-monitor
sudo systemctl start gpu-monitor
```

---

## Part 4: Usage

### Invite the Bot to a Channel

1. Go to the Slack channel where you want to use the bot
2. Type `/invite @GPU Monitor` (or your bot's name)
3. The bot is now ready to use in that channel

### Server Configuration Commands (`/config`)

| Command | Description |
|---------|-------------|
| `/config list` | List all configured servers |
| `/config add <name> <user@host> [port] [--key /path/to/key]` | Add a new server |
| `/config remove <name>` | Remove a server |
| `/config edit <name> [--host user@host] [--port port] [--key path] [--name newname]` | Edit a server |
| `/config help` | Show config help |

**Examples:**
```
/config add server1 root@192.168.1.100
/config add server2 ubuntu@10.0.0.50 22 --key ~/.ssh/gpu_key
/config remove server1
/config edit server2 --port 2222
```

### GPU Monitoring Commands (`/gpu`)

| Command | Description |
|---------|-------------|
| `/gpu` | Show GPU status from all configured servers |
| `/gpu start` | Start monitoring every 5 minutes |
| `/gpu start 10` | Start monitoring every 10 minutes |
| `/gpu stop` | Stop periodic monitoring |
| `/gpu help` | Show help message |

### Example Output (Multi-Server)

```
🖥️ GPU Status Report
3 server(s) | 6 GPU(s) | Updated: 1/20/2026, 3:45:00 PM
────────────────────────────────────────
🟢 training-server-1 (root@192.168.1.100)
  └ GPU 0: NVIDIA A100-SXM4-80GB
     🟡 52% util | 45000/81920 MiB (54.9%) | 65°C
     GPU: █████░░░ 52% | Mem: ████░░░░ 55%
  └ GPU 1: NVIDIA A100-SXM4-80GB
     🔴 95% util | 78000/81920 MiB (95.2%) | 72°C
     GPU: ████████ 95% | Mem: ████████ 95%
────────────────────────────────────────
🟢 training-server-2 (root@192.168.1.101)
  └ GPU 0: NVIDIA RTX 4090
     ⚪ 0% util | 512/24576 MiB (2.1%) | 35°C
     GPU: ░░░░░░░░ 0% | Mem: ░░░░░░░░ 2%
────────────────────────────────────────
🔴 offline-server (root@192.168.1.102)
❌ Connection timed out to offline-server.
```

---

## Troubleshooting

### Bot not responding to commands
- Ensure the bot is running (`npm start`)
- Check that the bot is invited to the channel
- Verify your tokens in `.env` are correct

### "nvidia-smi not found" error
- Ensure NVIDIA drivers are installed on the remote server
- Verify `nvidia-smi` works via SSH: `ssh user@host "nvidia-smi"`

### SSH connection issues
- Test SSH manually: `ssh user@host "echo connected"`
- Ensure SSH keys are set up correctly
- Check that the SSH port is correct
- Verify the identity file path if using `--key`

### Connection issues
- Check your internet connection
- Verify the App-Level Token has `connections:write` scope
- Ensure Socket Mode is enabled in Slack app settings

---

## Project Structure

```
slack-gpu/
├── .env                 # Environment variables (Slack tokens)
├── .gitignore           # Git ignore file
├── package.json         # Dependencies and scripts
├── servers.json         # Server configurations (auto-created)
├── setup-server.js      # Interactive CLI for server setup
├── README.md            # This documentation
└── src/
    ├── app.js           # Main bot application
    ├── config.js        # Server configuration management
    ├── gpu.js           # GPU monitoring (local + SSH)
    └── format.js        # Slack message formatting
```

---

## Acknowledgements

This project was built with the assistance of **Claude Code** by Anthropic - an AI-powered coding assistant that helped design, implement, and document this Slack bot.

- **Claude Code**: [https://claude.ai/claude-code](https://claude.ai/claude-code)
- **Anthropic**: [https://anthropic.com](https://anthropic.com)

Special thanks to the open-source community and the Slack Bolt framework team.

---

## License

MIT
