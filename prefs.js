// prefs.js — preferências (Adw). Cópia idêntica nas duas extensões.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, values, labels) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
    const sync = () => {
        const i = values.indexOf(settings.get_string(key));
        row.selected = i < 0 ? 0 : i;
    };
    sync();
    row.connect('notify::selected', () => {
        const v = values[row.selected];
        if (v !== undefined && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

export default class MonitorPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({title: _('Geral'), icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        const ui = new Adw.PreferencesGroup({title: _('Painel')});
        ui.add(spinRow(settings, 'update-interval', _('Atualização (s)'),
            _('Cada valor é o uso médio real desse intervalo'), 1, 10, 1));
        ui.add(comboRow(settings, 'display-mode', _('Texto ao lado do cilindro'),
            ['nome', 'nome+percentual'], [_('Nome'), _('Nome + percentual')]));
        ui.add(comboRow(settings, 'panel-position', _('Posição'),
            ['left', 'center', 'right'], [_('Esquerda'), _('Centro'), _('Direita')]));
        ui.add(spinRow(settings, 'panel-index', _('Índice na área'), _('0 = primeiro'), 0, 20, 1));
        page.add(ui);
    }
}
