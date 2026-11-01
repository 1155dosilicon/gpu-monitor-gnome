# GPU Monitor (AMD) para GNOME Shell

Extensão do GNOME Shell que mostra o uso da GPU AMD (driver `amdgpu`) no painel superior: um cilindro vertical que enche conforme o uso e o nome `GPU`, opcionalmente com o percentual.

- **Painel:** cilindro de uso + `GPU` (ou `GPU  37%`).
- **Passar o mouse:** uso, temperatura e VRAM usada/total.
- **Clique:** detalhes completos e atalho para as Preferências.

```
Uso GPU      7%
Memória      2%
VRAM       512MiB / 4.0GiB
GTT        120MiB / 7.8GiB
Temp       48 °C  (crit 94 °C)
Clocks     núcleo 214 MHz  memória 300 MHz
Ventoinha  0 RPM  (0%)
Energia    6.0 W  (limite 50 W)
```

Sensores que a placa não expõe aparecem como `N/A`. Uma leitura que falha três vezes seguidas aparece como `—`.

## Como o uso é medido

Os valores são exatos, sem média móvel nem outro filtro.

- **Uso da GPU:** cada cliente DRM expõe em `/proc/<pid>/fdinfo/<fd>` o tempo acumulado (`drm-engine-gfx` e `drm-engine-compute`, em ns) em que a GPU executou o trabalho dele. A cada intervalo de atualização a extensão soma os Δns de todos os clientes da placa (filtrando por `drm-pdev`) e divide pelo Δt real, medido no relógio monotônico. O resultado é a fração exata do intervalo em que a GPU trabalhou. No hardware ele bateu com `GRBM_STATUS.GUI_ACTIVE` (o método do radeontop) com diferença de 1–3 pontos.
- **Por que não `gpu_busy_percent`:** no Polaris/Lexa esse arquivo muda a cada ~1 ms, em pulsos de ~5 ms. Lê-lo de tempos em tempos dá valores errados e instáveis (0–5% quando o uso real era ~7%).
- **Memória (`mem_busy_percent`):** já é estável no sysfs. É lido a cada 50 ms e o painel mostra a média do intervalo.
- **Demais sensores:** `mem_info_*` do dispositivo DRM e `hwmon` do `amdgpu` (temperatura, clocks, ventoinha, energia), lidos a cada intervalo de atualização.

A GPU é detectada automaticamente: a primeira `/sys/class/drm/cardN` com `DRIVER=amdgpu`. Se nenhuma for encontrada, a extensão tenta de novo a cada 10 s. Tudo é lido de forma assíncrona e sem root.

## Requisitos

- GNOME Shell **46**
- GPU AMD com o driver `amdgpu` (testada numa Radeon E9173 / Polaris "Lexa")
- Kernel com estatísticas DRM em fdinfo para o amdgpu (Linux 5.19+)
- `glib-compile-schemas` (pacote `libglib2.0-bin` no Debian/Ubuntu)

## Instalação

```bash
git clone https://github.com/1155dosilicon/gpu-monitor-gnome.git
cd gpu-monitor-gnome
./install.sh
```

O script copia os arquivos para `~/.local/share/gnome-shell/extensions/gpu-monitor@eli.local`, compila o schema e habilita a extensão.

- **Wayland:** o shell não recarrega em execução. Faça **logout e login**.
- **Xorg:** `Alt+F2`, digite `r`, `Enter`.

Para conferir se carregou:

```bash
gnome-extensions info gpu-monitor@eli.local
```

### Instalação manual

```bash
UUID=gpu-monitor@eli.local
DST=~/.local/share/gnome-shell/extensions/$UUID
mkdir -p "$DST"
cp -r metadata.json extension.js prefs.js utils.js gpuload.js schemas "$DST/"
glib-compile-schemas "$DST/schemas"
gnome-extensions enable "$UUID"   # depois de logout/login no Wayland
```

### Pacote zip

```bash
gnome-extensions pack --force --extra-source=utils.js --extra-source=gpuload.js .
gnome-extensions install --force gpu-monitor@eli.local.shell-extension.zip
```

## Preferências

Abra pelo menu da extensão (**Preferências**) ou com `gnome-extensions prefs gpu-monitor@eli.local`.

| Opção | Chave | Padrão | Descrição |
|---|---|---|---|
| Atualização (s) | `update-interval` | `1` | Duração de cada intervalo medido (1–10 s) |
| Texto ao lado do cilindro | `display-mode` | `nome` | `nome` ou `nome+percentual` |
| Posição | `panel-position` | `right` | `left`, `center` ou `right` |
| Índice na área | `panel-index` | `0` | Ordem dentro da área do painel (0 = primeiro) |

Pela linha de comando:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/gpu-monitor@eli.local/schemas \
  set org.gnome.shell.extensions.gpu-monitor display-mode 'nome+percentual'
```

## Desinstalação

```bash
./uninstall.sh
```

Para apagar também as preferências salvas:

```bash
dconf reset -f /org/gnome/shell/extensions/gpu-monitor/
```

## Estrutura

| Arquivo | Conteúdo |
|---|---|
| `extension.js` | Botão do painel, popup, detecção da GPU e ciclo de leitura |
| `gpuload.js` | Medição do uso da GPU pelos contadores DRM fdinfo |
| `utils.js` | Leitor assíncrono de sysfs, amostradores, cilindro e tooltip (compartilhado com o [cpu-monitor-gnome](https://github.com/1155dosilicon/cpu-monitor-gnome)) |
| `prefs.js` | Janela de preferências (libadwaita) |
| `schemas/` | Schema GSettings |

## Depuração

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell | grep -i gpu-monitor
```

Para testar sem sair da sessão Wayland, rode um shell aninhado:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

## Licença

[GPL-2.0-or-later](LICENSE), a mesma licença do GNOME Shell.
