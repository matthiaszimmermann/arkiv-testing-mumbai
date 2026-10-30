FROM mcr.microsoft.com/devcontainers/base:bookworm

# bun from its official image, pinned to a minor version; no curl | bash
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Mount point for the volume that keeps the Claude Code login across rebuilds; created here so
# the volume starts out owned by vscode rather than root.
RUN mkdir -p /home/vscode/.claude && chown vscode:vscode /home/vscode/.claude
