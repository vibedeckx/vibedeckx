# Vibedeckx

AI-powered app generator with project management support.

## Project Structure

```
vibedeckx/
├── packages/vibedeckx/     # CLI package (publishable to npm)
│   └── src/
│       ├── bin.ts          # CLI entry point
│       ├── command.ts      # CLI commands
│       ├── server.ts       # Fastify server
│       ├── dialog.ts       # Folder selection dialog
│       └── storage/        # SQLite storage layer
└── apps/vibedeckx-ui/      # Next.js frontend
    ├── app/                # Next.js app router
    ├── components/         # React components
    └── hooks/              # React hooks
```

## Development

```bash
# Install dependencies
pnpm install

# Run frontend in development mode
pnpm dev

# Run CLI in watch mode
pnpm dev:server
```

## Build

```bash
# Build everything (CLI + UI)
pnpm build

# Build individual parts
pnpm build:main    # Build CLI package
pnpm build:ui      # Build UI (static export)
pnpm copy:ui       # Copy UI to CLI dist
```

## Usage

### Run from built files

```bash
pnpm start
# or
node packages/vibedeckx/dist/bin.js
```

### Specify port

```bash
node packages/vibedeckx/dist/bin.js --port 8080
```

## Distribution

### 本地打包

使用 `scripts/pack.sh` 一键构建分发包，产物输出到 `dist-out/` 目录：

```bash
./scripts/pack.sh              # 构建两种包（npm + 平台归档）
./scripts/pack.sh npm          # 只构建 npm 包
./scripts/pack.sh platform     # 只构建平台归档
./scripts/pack.sh --skip-build # 跳过 pnpm build（复用已有的 dist/）
```

参数可组合使用，例如 `./scripts/pack.sh platform --skip-build`。

产出两种包：

| 类型 | 文件示例 | 说明 |
|------|---------|------|
| npm 包 | `vibedeckx-0.1.0.tgz` | 轻量包，用户安装时编译 native 模块 |
| 平台归档 | `vibedeckx-0.1.0-linux-x64.tar.gz` | 预编译依赖，开箱即用 |

#### npm 包使用方式

```bash
# 直接运行
npx /path/to/vibedeckx-0.1.0.tgz

# 或全局安装后运行
npm install -g /path/to/vibedeckx-0.1.0.tgz
vibedeckx
```

> 注意：npm 包方式需要用户机器上有 C++ 编译工具链（用于编译 better-sqlite3、node-pty）。

#### 平台归档使用方式

```bash
# 解压后直接运行
tar -xzf vibedeckx-0.1.0-linux-x64.tar.gz
node vibedeckx-0.1.0-linux-x64/dist/bin.js
```

### 发布到 npm

```bash
cd packages/vibedeckx
npm publish
```

用户可直接运行：

```bash
npx vibedeckx
```

## Features

- **Project Management**: Create and manage multiple workspace projects
- **Folder Selection**: Native OS folder picker (macOS, Windows, Linux)
- **SQLite Storage**: Project data stored in `~/.vibedeckx/data.sqlite`
- **Static UI**: Frontend bundled with CLI for easy distribution
- **Remote Projects**: Connect to remote vibedeckx servers to manage projects on remote machines

## Remote Project Support

Vibedeckx supports connecting to remote vibedeckx servers, allowing you to manage projects on remote machines through a local UI.

### Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  Browser UI  │◄───►│  Local vibedeckx    │◄───►│ Remote vibedeckx │
│  (Next.js)   │     │  (Management)       │     │  (Execution)     │
└──────────────┘     └─────────────────────┘     └──────────────────┘
                            │                           │
                            ▼                           ▼
                      Local SQLite                Remote Agent
                    (all project data)           (execution only)
```

**Data Storage** (本地管理，远程执行):
- **Local SQLite**: 存储所有项目配置（本地是数据主源）
  - 项目信息（名称、路径、远程连接配置）
  - Executors 配置（命令、工作目录）
  - 远程连接信息（URL、API Key）
- **Remote Server**: 只负责执行
  - 运行 Agent 会话（访问远程文件系统）
  - 执行 Executor 命令
  - 浏览远程目录

### Setting Up a Remote Server

1. Start vibedeckx on the remote machine with an API key:

```bash
# On the remote server
VIBEDECKX_API_KEY=your-secret-key vibedeckx start --port 5174
```

The `VIBEDECKX_API_KEY` environment variable enables API authentication. All API requests must include the `X-Vibedeckx-Api-Key` header.

2. Ensure the port is accessible from your local machine (firewall rules, SSH tunneling, etc.)

### Connecting to a Remote Server

1. In the UI, click "Create Project" and select the **Remote** tab

2. Enter the remote server details:
   - **Remote Server URL**: e.g., `http://192.168.1.100:5174`
   - **API Key**: The key set via `VIBEDECKX_API_KEY` on the remote server

3. Click **Test** to verify the connection

4. Once connected, browse the remote filesystem and select a project directory

5. Enter a project name and click **Create Project**

### How It Works

- **Connection Config**: Remote project connection details (URL, API key) are stored locally
- **Request Proxying**: All API requests for remote projects are proxied through your local vibedeckx server
- **WebSocket Proxying**: Agent session WebSocket connections are transparently proxied to the remote server
- **Data Locality**: Project files and agent processes run on the remote server; only the UI runs locally

### Security Considerations

- API keys are stored in plain text in the local SQLite database
- Use HTTPS in production environments
- Consider SSH tunneling for secure connections over untrusted networks:

```bash
# Create an SSH tunnel to the remote server
ssh -L 5174:localhost:5174 user@remote-server

# Then connect to http://localhost:5174 in the UI
```

### Remote Project Indicators

Remote projects are visually distinguished in the UI:
- A **Remote** badge appears next to the project name
- The path shows the remote URL prefix (e.g., `http://server:5174:/path/to/project`)

## Release

项目使用 GitHub Actions 自动构建和发布。推送 `v*` 格式的 tag 即可触发，不限分支。

```bash
# 1. 确保代码已提交
git add .
git commit -m "release: v0.1.0"

# 2. 创建 tag
git tag v0.1.0

# 3. 推送 tag 触发构建
git push origin v0.1.0
```

构建完成后会自动在 GitHub Releases 页面创建 Release，附带以下平台的预编译包：

| 平台 | 文件格式 |
|------|---------|
| Linux x64 | `.tar.gz` |
| macOS ARM (Apple Silicon) | `.tar.gz` |
| Windows x64 | `.zip` |

下载解压后使用 Node.js 22+ 运行：

```bash
node dist/bin.js
```

## CLI Commands

```
vibedeckx start [options]        Start the server
  --port <value>                 Port to run the server on (default: 3000)
  --auth                         Enable Clerk authentication
  --data-dir <path>              Directory for storing database file (default: ~/.vibedeckx)
vibedeckx --help                 Show help
vibedeckx --version              Show version
```

### Custom Data Directory

Use `--data-dir` to specify a custom directory for the database file:

```bash
vibedeckx --data-dir /path/to/data
# Database will be stored at /path/to/data/data.sqlite
```

## Data Storage

- **Global config**: `~/.vibedeckx/`
- **Database**: `~/.vibedeckx/data.sqlite`
