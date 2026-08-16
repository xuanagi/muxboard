[中文版](README.zh-CN.md)

# Muxboard

Muxboard is a desktop workspace for **Codex + tmux remote development**. It connects directly to development servers over SSH and lets you manage tmux sessions, terminals, and files from one local application.

> This project is in an early stage. Feedback and contributions are welcome.

## Screenshots

Screenshots will be added here.

## Principles

- **Remote-first**: development environments, Codex, and tasks stay on the SSH server; the local app focuses on control and interaction.
- **Native tmux workflow**: preserve familiar shortcuts, copy mode, layouts, and TUI interactions.

## Features

### tmux enhancements for common Codex workflows

- Paste images with `Alt + V`.
- Paste text with `Ctrl + V`.
- Transfer files and folders directly, without WinSCP.
- Configure Codex profiles and switch model-provider settings in one click.

### tmux workspace

- Use common tmux workflows without learning tmux commands.
- Browse tmux sessions, windows, and panes on remote servers.
- Create, rename, and close sessions, windows, and panes.
- Split panes horizontally or vertically, and select windows or panes from the sidebar.
- Open multiple terminal tabs across different servers or tmux sessions.
- Pin sessions and restore saved workspaces when the app restarts.
- Adjust terminal font size and choose dark, gray, or light themes.

## Requirements

- Windows 10/11 (the primary supported target at present)
- [Bun](https://bun.sh/) 1.3 or later
- `tmux` installed and running on each remote server you connect to

## Local development

```bash
bun install
bun run dev
```

Common checks:

```bash
bun run typecheck
bun test
```

## Build and package

```bash
# Build the application only
bun run build

# Windows NSIS installer, output to release/
bun run dist:win

# Linux AppImage
bun run dist:linux
```

For an unpacked Windows build, run `npx electron-builder --win dir`; its default output is `release/win-unpacked/`.

## Security and data

Muxboard stores server profiles locally. When **Remember credentials** is selected, SSH passwords, private-key passphrases, and Codex API keys are encrypted using Electron's system secure storage. They are not written to project files or sent to a third-party Muxboard service. Only connect to servers you trust and protect your local account.

Report vulnerabilities according to [SECURITY.md](SECURITY.md). Do not disclose credentials or vulnerability details in public issues.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and run the type check and tests before submitting a pull request.

## License

[MIT](LICENSE) © Muxboard Contributors
