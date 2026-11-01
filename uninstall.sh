#!/usr/bin/env bash
# Desabilita e remove a extensão do usuário atual.
set -uo pipefail
UUID="gpu-monitor@eli.local"
DST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$DST"
echo "Removido: $UUID. Faça logout/login (Wayland) para descarregar do shell."
echo "As preferências ficam em dconf; para apagá-las também:"
echo "  dconf reset -f /org/gnome/shell/extensions/${UUID%%@*}/"
