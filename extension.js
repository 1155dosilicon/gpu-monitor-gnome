// gpu-monitor@eli.local — GNOME Shell 46, GJS ESM.
//
// Uso da GPU: tempo de execução acumulado por cliente DRM (fdinfo), dividido
// pelo tempo real de cada período de atualização — ver gpuload.js. Sem EMA,
// sem filtro: é a fração exata do período em que a GPU executou trabalho.
// mem_busy_percent já é suave no Polaris: média de amostras a cada 50 ms.
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    SysfsReader, Sampler, PeriodMean, Cylinder, HoverTip,
    detectarCardAmdgpu, detectarHwmon, fileExists, fmtPct, fmtBytes,
} from './utils.js';
import {FdinfoGpuLoad} from './gpuload.js';

const POLL_MS = 50;
const DETECT_RETRY_MS = 10000;

// Sensores secundários: [chave, arquivo, base ('dev'|'hwmon')]
const SECONDARY = [
    ['vramUsed', 'mem_info_vram_used', 'dev'],
    ['vramTotal', 'mem_info_vram_total', 'dev'],
    ['gttUsed', 'mem_info_gtt_used', 'dev'],
    ['gttTotal', 'mem_info_gtt_total', 'dev'],
    ['temp', 'temp1_input', 'hwmon'],
    ['tempCrit', 'temp1_crit', 'hwmon'],
    ['sclk', 'freq1_input', 'hwmon'],
    ['mclk', 'freq2_input', 'hwmon'],
    ['fan', 'fan1_input', 'hwmon'],
    ['pwm', 'pwm1', 'hwmon'],
    ['pwmMax', 'pwm1_max', 'hwmon'],
    ['power', 'power1_input', 'hwmon'],
    ['powerCap', 'power1_cap', 'hwmon'], // somente leitura
];

export default class GpuMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsId = this._settings.connect('changed', () => this._scheduleRebuild());
        this._rebuildId = 0;
        this._build();
    }

    disable() {
        if (this._rebuildId) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._settings.disconnect(this._settingsId);
        this._teardown();
        this._settings = null;
    }

    _scheduleRebuild() {
        if (this._rebuildId)
            GLib.Source.remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._rebuildId = 0;
            this._teardown();
            this._build();
            return GLib.SOURCE_REMOVE;
        });
    }

    // -----------------------------------------------------------------------
    _build() {
        const s = this._settings;
        this._uiS = s.get_int('update-interval');
        this._display = s.get_string('display-mode');

        this._reader = new SysfsReader();
        this._gpu = null; // {card, device, hwmon}
        this._load = null; // FdinfoGpuLoad
        this._busyV = null; // % do último período (null = sem dado)
        this._busyFails = 0;
        this._mem = new PeriodMean();
        this._memSampler = null;
        this._sec = {};
        this._samplers = [];
        this._detectId = 0;
        this._uiId = 0;

        // --- UI
        this._button = new PanelMenu.Button(0.5, 'GPU Monitor', false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box', y_align: Clutter.ActorAlign.CENTER});
        this._cyl = new Cylinder();
        this._label = new St.Label({
            text: 'GPU', y_align: Clutter.ActorAlign.CENTER,
            style: 'font-family: monospace; font-size: 10px; margin-left: 3px;',
        });
        box.add_child(this._cyl.actor);
        box.add_child(this._label);
        this._button.add_child(box);

        this._details = new St.Label({style: 'font-family: monospace; font-size: 11px;'});
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(this._details);
        this._button.menu.addMenuItem(item);
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._button.menu.addAction(_('Preferências'), () => this.openPrefs());
        this._menuId = this._button.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._updatePopup();
        });
        this._tip = new HoverTip(this._button);

        Main.panel.addToStatusArea(this.uuid, this._button,
            s.get_int('panel-index'), s.get_string('panel-position'));

        this._updateUi();
        this._detect();
    }

    _teardown() {
        if (this._uiId) {
            GLib.Source.remove(this._uiId);
            this._uiId = 0;
        }
        if (this._detectId) {
            GLib.Source.remove(this._detectId);
            this._detectId = 0;
        }
        this._samplers?.forEach(x => x.stop());
        this._load = null;
        this._samplers = null;
        this._reader?.destroy();
        this._reader = null;
        if (this._button) {
            this._button.menu.disconnect(this._menuId);
            this._tip.destroy();
            this._tip = null;
            this._button.destroy();
            this._button = null;
        }
        this._cyl = null;
        this._label = null;
        this._details = null;
        this._gpu = null;
    }

    // -----------------------------------------------------------------------
    async _detect() {
        const r = this._reader;
        if (!r)
            return;
        const card = await detectarCardAmdgpu(r);
        let hwmon = null;
        if (card)
            hwmon = await detectarHwmon(r, 'amdgpu', `${card.device}/hwmon`);
        if (this._reader !== r)
            return; // desativado nesse meio-tempo
        if (!card) {
            this._detectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DETECT_RETRY_MS, () => {
                this._detectId = 0;
                this._detect();
                return GLib.SOURCE_REMOVE;
            });
            this._updateUi();
            return;
        }
        const uevent = await r.read(`${card.device}/uevent`);
        if (this._reader !== r)
            return;
        const pdev = /^PCI_SLOT_NAME=(\S+)$/m.exec(uevent ?? '')?.[1] ?? null;
        this._gpu = {...card, hwmon, pdev};
        this._start();
    }

    _start() {
        const dev = this._gpu.device;
        this._load = new FdinfoGpuLoad(this._reader, this._gpu.pdev);
        this._load.sample(); // base do primeiro período
        this._memSampler = this._pollSampler(`${dev}/mem_busy_percent`, this._mem);
        this._samplers.push(this._memSampler);

        for (const [key, file, base] of SECONDARY) {
            const dir = base === 'dev' ? dev : this._gpu.hwmon;
            const path = dir ? `${dir}/${file}` : null;
            this._sec[key] = {path, v: null, fails: 0, missing: !path || !fileExists(path)};
        }
        this._samplers.push(new Sampler(this._uiS * 1000, () => this._sampleSecondary()));
        this._samplers.forEach(x => x.start());

        // fecha um período a cada update-interval e atualiza o painel
        this._uiId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._uiS * 1000, () => {
            this._tickBusy();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _tickBusy() {
        const load = this._load;
        let v = null;
        try {
            v = await load.sample();
        } catch (e) {
            console.debug(`[gpu-monitor] fdinfo: ${e}`);
        }
        if (this._load !== load)
            return; // reconstruído/desativado nesse meio-tempo
        if (v === null) {
            if (++this._busyFails >= 3)
                this._busyV = null; // stale
        } else {
            this._busyFails = 0;
            this._busyV = v;
        }
        this._mem.take();
        this._updateUi();
    }

    _pollSampler(path, acc) {
        return new Sampler(POLL_MS, async () => {
            const v = await this._reader?.readInt(path, 500);
            if (v === null || v === undefined || v < 0 || v > 100)
                return false;
            acc.add(v);
            return true;
        });
    }

    async _sampleSecondary() {
        const r = this._reader;
        if (!r)
            return false;
        const keys = Object.keys(this._sec).filter(k => !this._sec[k].missing);
        const vals = await Promise.all(keys.map(k => r.readInt(this._sec[k].path, 500)));
        if (!this._reader)
            return false;
        let any = false;
        keys.forEach((k, i) => {
            const e = this._sec[k];
            if (vals[i] === null) {
                if (++e.fails >= 3)
                    e.v = null;
            } else {
                e.fails = 0;
                e.v = vals[i];
                any = true;
            }
        });
        return any || keys.length === 0;
    }

    _secVal(key) {
        const e = this._sec[key];
        if (!e || e.missing)
            return undefined; // N/A
        return e.v; // null = sem leitura
    }

    // -----------------------------------------------------------------------
    _value(sampler, acc) {
        return !sampler || sampler.stale ? null : acc.value;
    }

    _updateUi() {
        if (!this._button)
            return;
        const v = this._gpu ? this._busyV : null;
        this._cyl.setValue(v);
        const txt = this._display === 'nome+percentual' ? `GPU ${fmtPct(v).padStart(4)}` : 'GPU';
        if (this._label.text !== txt)
            this._label.text = txt;

        if (!this._gpu) {
            this._tip.setText('GPU AMD não encontrada');
        } else {
            const parts = [`GPU ${fmtPct(v)}`];
            const temp = this._secVal('temp');
            if (typeof temp === 'number')
                parts.push(`${Math.round(temp / 1000)} °C`);
            const vu = this._secVal('vramUsed');
            const vt = this._secVal('vramTotal');
            if (typeof vu === 'number' && typeof vt === 'number')
                parts.push(`VRAM ${fmtBytes(vu)} / ${fmtBytes(vt)}`);
            this._tip.setText(parts.join('   ·   '));
        }

        if (this._button.menu.isOpen)
            this._updatePopup();
    }

    _fmt(key, fn) {
        const v = this._secVal(key);
        if (v === undefined)
            return 'N/A';
        return v === null ? '—' : fn(v);
    }

    _updatePopup() {
        const L = [];
        if (!this._gpu) {
            L.push('GPU AMD (amdgpu) não encontrada.');
            L.push('Tentando novamente a cada 10s…');
            this._details.text = L.join('\n');
            return;
        }
        const temp = v => `${Math.round(v / 1000)} °C`;
        const mhz = v => `${Math.round(v / 1e6)} MHz`;
        L.push(`Uso GPU    ${fmtPct(this._busyV).padStart(4)}`);
        L.push(`Memória    ${fmtPct(this._value(this._memSampler, this._mem)).padStart(4)}`);
        L.push(`VRAM       ${fmtBytes(this._secVal('vramUsed'))} / ${fmtBytes(this._secVal('vramTotal'))}`);
        L.push(`GTT        ${fmtBytes(this._secVal('gttUsed'))} / ${fmtBytes(this._secVal('gttTotal'))}`);
        L.push(`Temp       ${this._fmt('temp', temp)}  (crit ${this._fmt('tempCrit', temp)})`);
        L.push(`Clocks     núcleo ${this._fmt('sclk', mhz)}  memória ${this._fmt('mclk', mhz)}`);
        const pwm = this._secVal('pwm');
        const pwmMax = this._secVal('pwmMax');
        const pwmTxt = pwm === undefined ? 'N/A'
            : (pwm === null || !pwmMax ? '—' : `${Math.round(100 * pwm / pwmMax)}%`);
        L.push(`Ventoinha  ${this._fmt('fan', v => `${v} RPM`)}  (${pwmTxt})`);
        L.push(`Energia    ${this._fmt('power', v => `${(v / 1e6).toFixed(1)} W`)}  (limite ${this._fmt('powerCap', v => `${Math.round(v / 1e6)} W`)})`);
        this._details.text = L.join('\n');
    }
}
