# Bundled Binaries

This directory contains platform-specific binaries for Windows support.

## Naming Convention

Binaries follow the Rust target triple naming:

- `claude-x86_64-pc-windows-msvc.exe` - Windows x64
- `claude-aarch64-apple-darwin` - macOS ARM64 (Apple Silicon)
- `claude-x86_64-apple-darwin` - macOS x64 (Intel)
- `claude-x86_64-unknown-linux-gnu` - Linux x64
- `claude-aarch64-unknown-linux-gnu` - Linux ARM64

Same pattern for `codex-*` binaries.

## How to Obtain

### Claude Code CLI

Download from the Claude Code releases or build from source.

### Codex CLI

Download from the Codex releases or build from source.

## Development

In development, you typically don't need bundled binaries if:
- `claude` is installed globally via npm
- `codex` is installed globally

The platform support layer will fall back to PATH lookup.
