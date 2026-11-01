#!/usr/bin/env bash
# Instala a extensão para o usuário atual (~/.local/share/gnome-shell/extensions).
set -euo pipefail
UUID="gpu-monitor@eli.local"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
FILES=(metadata.json extension.js prefs.js utils.js gpuload.js schemas)

command -v glib-compile-schemas >/dev/null || { echo "Falta glib-compile-schemas (pacote libglib2.0-bin)." >&2; exit 1; }

rm -rf "$DST"
mkdir -p "$DST"
for f in "${FILES[@]}"; do cp -r "$SRC/$f" "$DST/"; done
glib-compile-schemas "$DST/schemas"

if ! gnome-extensions enable "$UUID" 2>/dev/null; then
  # O shell em execução ainda não conhece a extensão (comum no Wayland):
  # marca como habilitada via GSettings; ela carrega no próximo login.
  cur=$(gsettings get org.gnome.shell enabled-extensions)
  if ! grep -q "'$UUID'" <<<"$cur"; then
    if [[ "$cur" == "@as []" || "$cur" == "[]" ]]; then new="['$UUID']"; else new="${cur%]}, '$UUID']"; fi
    gsettings set org.gnome.shell enabled-extensions "$new"
  fi
  echo "Instalado em $DST."
  echo "Wayland: faça logout e login para carregar. Xorg: Alt+F2, digite r, Enter."
else
  echo "Instalado e habilitado: $UUID"
fi
