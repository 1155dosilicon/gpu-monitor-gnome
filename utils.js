// utils.js — compartilhado (cópia idêntica) entre cpu-monitor e gpu-monitor.
// GJS ESM (GNOME Shell 46). Sem GObject.registerClass aqui: as duas extensões
// carregam cópias deste módulo no mesmo processo e nomes de GType colidiriam.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const decoder = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// Leitura assíncrona [R3]: reabre o arquivo a cada leitura, timeout 500ms,
// cancelável em massa no destroy().
// ---------------------------------------------------------------------------
export class SysfsReader {
    constructor() {
        this._pending = new Set();
        this._timeouts = new Set();
        this._destroyed = false;
    }

    /** Resolve com o texto do arquivo, ou null em erro/timeout/cancelamento. */
    read(path, timeoutMs = 500) {
        return new Promise(resolve => {
            if (this._destroyed) {
                resolve(null);
                return;
            }
            const cancellable = new Gio.Cancellable();
            this._pending.add(cancellable);
            let tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                this._timeouts.delete(tid);
                tid = 0;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(tid);
            const file = Gio.File.new_for_path(path);
            file.load_contents_async(cancellable, (f, res) => {
                if (tid) {
                    GLib.Source.remove(tid);
                    this._timeouts.delete(tid);
                    tid = 0;
                }
                this._pending.delete(cancellable);
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    resolve(this._destroyed ? null : decoder.decode(bytes));
                } catch {
                    resolve(null);
                }
            });
        });
    }

    async readInt(path, timeoutMs = 500) {
        const txt = await this.read(path, timeoutMs);
        if (txt === null)
            return null;
        const v = parseInt(txt.trim(), 10);
        return Number.isFinite(v) ? v : null;
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._timeouts)
            GLib.Source.remove(id);
        this._timeouts.clear();
        for (const c of this._pending)
            c.cancel();
        this._pending.clear();
    }
}

/** stat() simples — não aciona o driver (não é leitura de atributo). */
export function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/** Lista diretório de forma assíncrona. Resolve com Gio.FileInfo[] ou null. */
export function listDirAsync(path, attrs = 'standard::name', cancellable = null) {
    return new Promise(resolve => {
        const dir = Gio.File.new_for_path(path);
        dir.enumerate_children_async(attrs, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, cancellable, (d, res) => {
                let en;
                try {
                    en = d.enumerate_children_finish(res);
                } catch {
                    resolve(null);
                    return;
                }
                const out = [];
                const finish = () => {
                    try {
                        en.close(null);
                    } catch {}
                    resolve(out);
                };
                const next = () => {
                    en.next_files_async(128, GLib.PRIORITY_LOW, cancellable, (e, r) => {
                        let infos;
                        try {
                            infos = e.next_files_finish(r);
                        } catch {
                            finish();
                            return;
                        }
                        if (!infos || infos.length === 0) {
                            finish();
                            return;
                        }
                        out.push(...infos);
                        next();
                    });
                };
                next();
            });
    });
}

// ---------------------------------------------------------------------------
// Detectores (hwmonN / cardN mudam entre boots — nunca hardcodar)
// ---------------------------------------------------------------------------
export async function detectarCardAmdgpu(reader) {
    const infos = await listDirAsync('/sys/class/drm');
    if (!infos)
        return null;
    const cards = infos.map(i => i.get_name()).filter(n => /^card\d+$/.test(n)).sort();
    for (const c of cards) {
        const dev = `/sys/class/drm/${c}/device`;
        // eslint-disable-next-line no-await-in-loop
        const uevent = await reader.read(`${dev}/uevent`);
        if (uevent && /^DRIVER=amdgpu$/m.test(uevent))
            return {card: c, device: dev};
    }
    return null;
}

/** Procura hwmon pelo nome. Se baseDir for dado (ex.: <device>/hwmon), procura lá primeiro. */
export async function detectarHwmon(reader, name, baseDir = null) {
    for (const dir of [baseDir, '/sys/class/hwmon'].filter(Boolean)) {
        // eslint-disable-next-line no-await-in-loop
        const infos = await listDirAsync(dir);
        if (!infos)
            continue;
        const hw = infos.map(i => i.get_name()).filter(n => /^hwmon\d+$/.test(n)).sort();
        for (const h of hw) {
            const p = `${dir}/${h}`;
            // eslint-disable-next-line no-await-in-loop
            const n = await reader.read(`${p}/name`);
            if (n !== null && n.trim() === name)
                return p;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Média aritmética das leituras acumuladas desde o último take().
// Sem EMA/mediana: o valor exibido é exatamente o uso médio do período.
// ---------------------------------------------------------------------------
export class PeriodMean {
    constructor() {
        this._sum = 0;
        this._n = 0;
        this.value = null;
    }

    add(v) {
        this._sum += Math.min(100, Math.max(0, v));
        this._n++;
    }

    /** Fecha o período: atualiza .value (null se não houve leitura) e zera o acumulador. */
    take() {
        this.value = this._n ? this._sum / this._n : null;
        this._sum = 0;
        this._n = 0;
        return this.value;
    }
}

// ---------------------------------------------------------------------------
// StaleTracker [R4]: 3 falhas seguidas -> stale + backoff (dobra, máx 10s)
// ---------------------------------------------------------------------------
export class StaleTracker {
    constructor(baseMs, maxMs = 10000, threshold = 3) {
        this.baseMs = baseMs;
        this.maxMs = Math.max(maxMs, baseMs);
        this.threshold = threshold;
        this.fails = 0;
        this.intervalMs = baseMs;
        this.hasData = false;
    }

    ok() {
        this.fails = 0;
        this.intervalMs = this.baseMs;
        this.hasData = true;
    }

    fail() {
        this.fails++;
        if (this.fails >= this.threshold)
            this.intervalMs = Math.min(this.intervalMs * 2, this.maxMs);
    }

    get stale() {
        return this.fails >= this.threshold;
    }
}

// ---------------------------------------------------------------------------
// Sampler: executa fn assíncrona periodicamente, sem sobreposição, com backoff.
// fn deve resolver true (ok) / false (falha).
// ---------------------------------------------------------------------------
export class Sampler {
    constructor(intervalMs, fn, {maxMs = 10000} = {}) {
        this.tracker = new StaleTracker(intervalMs, maxMs);
        this._fn = fn;
        this._id = 0;
        this._stopped = true;
    }

    start() {
        this._stopped = false;
        this._schedule(1);
    }

    _schedule(ms) {
        if (this._stopped)
            return;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(ms)), () => {
            this._id = 0;
            this._run();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _run() {
        let ok = false;
        try {
            ok = await this._fn();
        } catch (e) {
            console.debug(`[monitor] sampler: ${e}`);
            ok = false;
        }
        if (this._stopped)
            return;
        if (ok)
            this.tracker.ok();
        else
            this.tracker.fail();
        this._schedule(this.tracker.intervalMs);
    }

    get stale() {
        return this.tracker.stale;
    }

    get hasData() {
        return this.tracker.hasData;
    }

    stop() {
        this._stopped = true;
        if (this._id) {
            GLib.Source.remove(this._id);
            this._id = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Cilindro vertical (St.DrawingArea + cairo).
// ---------------------------------------------------------------------------
const COLORS = {
    green: [0.30, 0.69, 0.31],
    yellow: [0.98, 0.75, 0.18],
    red: [0.90, 0.22, 0.21],
    gray: [0.55, 0.55, 0.55],
};

function levelColor(v) {
    if (v === null)
        return COLORS.gray;
    if (v < 50)
        return COLORS.green;
    if (v <= 80)
        return COLORS.yellow;
    return COLORS.red;
}

function ellipsePath(cr, cx, cy, rx, ry) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
}

export class Cylinder {
    constructor() {
        this.actor = new St.DrawingArea({
            style: 'width: 12px; height: 24px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value = null; // null = stale/sem dado
        this._drawn = undefined;
        this.actor.connect('repaint', a => this._repaint(a));
    }

    /** v: 0..100 ou null (sem dado). Redesenha quando o % inteiro muda. */
    setValue(v) {
        if (v !== null)
            v = Math.round(Math.min(100, Math.max(0, v)));
        if (v === this._drawn)
            return;
        this._value = v;
        this._drawn = v;
        this.actor.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const lw = Math.max(1, w / 12);
        const rx = w / 2 - lw;
        const ry = Math.max(1.5, h * 0.09);
        const cx = w / 2;
        const top = ry + lw / 2;
        const bottom = h - ry - lw / 2;
        const x0 = cx - rx;
        const x1 = cx + rx;
        const v = this._value;
        const [r, g, b] = levelColor(v);

        cr.setLineWidth(lw);

        // corpo vazio (vidro)
        cr.setSourceRGBA(1, 1, 1, 0.10);
        cr.rectangle(x0, top, 2 * rx, bottom - top);
        cr.fill();
        ellipsePath(cr, cx, bottom, rx, ry);
        cr.fill();

        // líquido
        const frac = v === null ? 1 : v / 100;
        if (frac > 0) {
            const level = bottom - frac * (bottom - top);
            const alpha = v === null ? 0.45 : 1.0;
            const grad = new Cairo.LinearGradient(x0, 0, x1, 0);
            grad.addColorStopRGBA(0.0, r * 0.55, g * 0.55, b * 0.55, alpha);
            grad.addColorStopRGBA(0.35, Math.min(1, r * 1.15), Math.min(1, g * 1.15), Math.min(1, b * 1.15), alpha);
            grad.addColorStopRGBA(1.0, r * 0.45, g * 0.45, b * 0.45, alpha);
            cr.setSource(grad);
            cr.rectangle(x0, level, 2 * rx, bottom - level);
            cr.fill();
            ellipsePath(cr, cx, bottom, rx, ry);
            cr.fill();
            // superfície do líquido (mais clara)
            cr.setSourceRGBA(Math.min(1, r * 1.3), Math.min(1, g * 1.3), Math.min(1, b * 1.3), alpha);
            ellipsePath(cr, cx, level, rx, ry);
            cr.fill();
        }

        // contorno: laterais, base e aro do topo
        cr.setSourceRGBA(1, 1, 1, 0.55);
        cr.moveTo(x0, top);
        cr.lineTo(x0, bottom);
        cr.stroke();
        cr.moveTo(x1, top);
        cr.lineTo(x1, bottom);
        cr.stroke();
        cr.save();
        cr.translate(cx, bottom);
        cr.scale(rx, ry);
        cr.arcNegative(0, 0, 1, Math.PI, 0);
        cr.restore();
        cr.stroke();
        ellipsePath(cr, cx, top, rx, ry);
        cr.stroke();

        cr.$dispose();
    }

    destroy() {
        this.actor.destroy();
        this.actor = null;
    }
}

// ---------------------------------------------------------------------------
// Tooltip ao passar o mouse sobre o botão do painel.
// ---------------------------------------------------------------------------
export class HoverTip {
    constructor(button) {
        this._button = button;
        this._text = '';
        this._label = new St.Label({
            style: 'background-color: rgba(20,20,20,0.92); color: #eee; ' +
                'padding: 5px 10px; border-radius: 8px; font-size: 12px;',
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._label);
        this._hoverId = button.connect('notify::hover', () => this._sync());
        this._menuId = button.menu.connect('open-state-changed', () => this._sync());
    }

    setText(t) {
        this._text = t;
        this._label.text = t;
        if (this._label.visible)
            this._place();
    }

    _sync() {
        const show = this._button.hover && !this._button.menu.isOpen && this._text;
        if (show) {
            this._label.show();
            this._place();
        } else {
            this._label.hide();
        }
    }

    _place() {
        const [bx, by] = this._button.get_transformed_position();
        const [bw, bh] = this._button.get_transformed_size();
        const [, lw] = this._label.get_preferred_width(-1);
        const [, lh] = this._label.get_preferred_height(lw);
        const mon = Main.layoutManager.findMonitorForActor(this._button) ?? Main.layoutManager.primaryMonitor;
        let x = Math.round(bx + bw / 2 - lw / 2);
        x = Math.max(mon.x + 4, Math.min(x, mon.x + mon.width - lw - 4));
        let y = Math.round(by + bh + 4);
        if (y + lh > mon.y + mon.height)
            y = Math.round(by - lh - 4); // painel embaixo
        this._label.set_position(x, y);
    }

    destroy() {
        this._button.disconnect(this._hoverId);
        this._button.menu.disconnect(this._menuId);
        this._label.destroy();
        this._label = null;
        this._button = null;
    }
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
export function fmtPct(v) {
    return v === null || v === undefined ? '—' : `${Math.round(v)}%`;
}

export function fmtBytes(b) {
    if (b === null || b === undefined)
        return 'N/A';
    if (b >= 1024 ** 3)
        return `${(b / 1024 ** 3).toFixed(1)}GiB`;
    return `${Math.round(b / 1024 ** 2)}MiB`;
}

export function pad(s, n) {
    s = String(s);
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
