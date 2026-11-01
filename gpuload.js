// gpuload.js — uso da GPU pelos contadores de tempo do DRM fdinfo.
//
// Por que não gpu_busy_percent: no Polaris/Lexa (smu7) ele muda a cada ~1 ms,
// em pulsos de ~5 ms que sobem a 50–90% e voltam a 0. Uma amostra a cada
// 50 ms cai nesses pulsos por acaso, e o resultado fica errado e varia a cada
// leitura (medido: 0–5% quando o uso real era ~7%).
//
// fdinfo: cada cliente DRM (/proc/<pid>/fdinfo/<fd>) expõe
// "drm-engine-gfx: <ns>", o tempo ACUMULADO em que a GPU executou o trabalho
// dele. Uso no período = Σ Δns / Δt real (relógio monotônico). É contagem
// exata, não amostragem: não depende de acertar o pulso, nem do atraso dos
// timers do shell. Comparado no hardware com GRBM_STATUS.GUI_ACTIVE amostrado
// a 300 kHz (método do radeontop): diferença ≤ ~1–3 pontos.
//
// Custo: a varredura completa de /proc (achar fds de /dev/dri) roda a cada
// RESCAN_TICKS ticks. Nos outros ticks são lidos só os poucos arquivos fdinfo
// já conhecidos.
import GLib from 'gi://GLib';
import {listDirAsync} from './utils.js';

const RESCAN_TICKS = 5;
const ENGINES = ['gfx', 'compute'];

export class FdinfoGpuLoad {
    /** pdev: slot PCI da GPU (ex.: 0000:01:00.0), comparado com drm-pdev. */
    constructor(reader, pdev) {
        this._reader = reader;
        this._pdev = pdev;
        this._paths = new Set(); // /proc/<pid>/fdinfo/<fd> de fds /dev/dri/*
        this._prev = null; // Map client-id -> ns acumulado
        this._prevT = 0;
        this._tick = 0;
        this._busy = false;
    }

    /** Lê o período fechado agora. Resolve com 0..100, ou null sem base/erro. */
    async sample() {
        if (this._busy)
            return null; // tick anterior ainda em andamento: não sobrepõe
        this._busy = true;
        try {
            if (this._tick++ % RESCAN_TICKS === 0)
                await this._rescan();
            const cur = await this._readClients();
            const t = GLib.get_monotonic_time(); // µs
            const prev = this._prev;
            const dt = (t - this._prevT) * 1000; // ns
            this._prev = cur;
            this._prevT = t;
            if (!prev || dt <= 0)
                return null;
            let busy = 0;
            for (const [id, ns] of cur) {
                const p = prev.get(id);
                if (p !== undefined && ns >= p)
                    busy += ns - p; // cliente novo: só vira base para o próximo período
            }
            return Math.min(100, 100 * busy / dt);
        } finally {
            this._busy = false;
        }
    }

    async _readClients() {
        const paths = [...this._paths];
        const txts = await Promise.all(paths.map(p => this._reader.read(p, 500)));
        const out = new Map();
        txts.forEach((txt, i) => {
            if (txt === null) {
                this._paths.delete(paths[i]); // fd fechado / processo saiu
                return;
            }
            const c = this._parse(txt);
            if (c)
                out.set(c.id, Math.max(out.get(c.id) ?? 0, c.ns)); // fds duplicados = mesmo cliente
        });
        return out;
    }

    _parse(txt) {
        if (!/^drm-driver:\s*amdgpu\s*$/m.test(txt))
            return null;
        const pdev = /^drm-pdev:\s*(\S+)/m.exec(txt);
        if (this._pdev && pdev && pdev[1] !== this._pdev)
            return null;
        const id = /^drm-client-id:\s*(\d+)/m.exec(txt);
        if (!id)
            return null;
        let ns = 0;
        for (const e of ENGINES) {
            const m = new RegExp(`^drm-engine-${e}:\\s*(\\d+)\\s*ns`, 'm').exec(txt);
            if (m)
                ns += Number(m[1]);
        }
        return {id: id[1], ns};
    }

    async _rescan() {
        const procs = await listDirAsync('/proc');
        if (!procs)
            return;
        const pids = procs.map(i => i.get_name()).filter(n => /^\d+$/.test(n));
        const found = new Set();
        await Promise.all(pids.map(async pid => {
            const fds = await listDirAsync(`/proc/${pid}/fd`, 'standard::name,standard::symlink-target');
            for (const fi of fds ?? []) {
                // fd fechado entre readdir e lstat chega sem o atributo
                if (fi.has_attribute('standard::symlink-target') &&
                    fi.get_symlink_target()?.startsWith('/dev/dri/'))
                    found.add(`/proc/${pid}/fdinfo/${fi.get_name()}`);
            }
        }));
        this._paths = found;
    }
}
