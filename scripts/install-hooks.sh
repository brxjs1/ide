#!/usr/bin/env bash
# Ativa os hooks versionados em .githooks/
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
chmod +x "$root"/.githooks/*
git -C "$root" config core.hooksPath .githooks
echo "hooks ativos: $(ls "$root/.githooks" | tr '\n' ' ')"
