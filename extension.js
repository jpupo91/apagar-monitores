import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const UUID = 'apagar-monitores@jpupo91';
const DISPLAY_CONFIG_BUS = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';
const DISPLAY_CONFIG_IFACE = 'org.gnome.Mutter.DisplayConfig';
const APPLY_MONITORS_CONFIG_METHOD = 'ApplyMonitorsConfig';
const APPLY_TEMPORARILY = 1;

function _notify(message, title = 'Apagar Monitores') {
    Main.notify(title, message);
}

function _getCurrentState(callback) {
    Gio.DBus.session.call(
        DISPLAY_CONFIG_BUS,
        DISPLAY_CONFIG_PATH,
        DISPLAY_CONFIG_IFACE,
        'GetCurrentState',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (connection, result) => {
            try {
                callback(null, connection.call_finish(result).deep_unpack());
            } catch (error) {
                callback(error, null);
            }
        }
    );
}

function _applyConfiguration(serial, logicalMonitors, properties, callback) {
    const applyProperties = {};
    if (properties && properties['layout-mode'])
        applyProperties['layout-mode'] = properties['layout-mode'];

    const params = new GLib.Variant(
        '(uua(iiduba(ssa{sv}))a{sv})',
        [serial, APPLY_TEMPORARILY, logicalMonitors, applyProperties]
    );

    Gio.DBus.session.call(
        DISPLAY_CONFIG_BUS,
        DISPLAY_CONFIG_PATH,
        DISPLAY_CONFIG_IFACE,
        APPLY_MONITORS_CONFIG_METHOD,
        params,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (connection, result) => {
            try {
                connection.call_finish(result);
                callback(null);
            } catch (error) {
                callback(error);
            }
        }
    );
}

function _getApplyLogicalMonitors(state, builtinConnectors = null) {
    const monitorInfoByConnector = new Map(
        state[1].map(monitor => [monitor[0][0], monitor])
    );

    return state[2]
        .map(monitor => {
            const connectors = builtinConnectors
                ? monitor[5].filter(connector => builtinConnectors.has(connector[0]))
                : monitor[5];
            if (connectors.length === 0)
                return null;

            const outputs = connectors.map(connector => {
                const monitorInfo = monitorInfoByConnector.get(connector[0]);
                const currentMode = monitorInfo?.[1].find(
                    mode => mode[6]['is-current']?.deep_unpack()
                );
                if (!currentMode)
                    throw new Error(`No se encontró el modo activo de ${connector[0]}.`);

                const outputProperties = {};
                const underscanning = monitorInfo[2]['is-underscanning'];
                if (underscanning)
                    outputProperties.underscanning = underscanning;

                return [connector[0], currentMode[0], outputProperties];
            });

            return [
                monitor[0],
                monitor[1],
                monitor[2],
                monitor[3],
                monitor[4],
                outputs,
                monitor[6],
            ];
        })
        .filter(monitor => monitor !== null);
}

function _disableExternalMonitors(state) {
    const builtinConnectors = new Set(
        state[1]
            .filter(monitor => monitor[2]['is-builtin']?.deep_unpack())
            .map(monitor => monitor[0][0])
    );

    if (builtinConnectors.size === 0)
        throw new Error('Mutter no identificó ninguna pantalla integrada.');

    const hasActiveExternal = state[2].some(monitor =>
        monitor[5].some(connector => !builtinConnectors.has(connector[0]))
    );
    if (!hasActiveExternal)
        throw new Error('No hay monitores externos activos para apagar.');

    const logicalMonitors = _getApplyLogicalMonitors(state, builtinConnectors);
    const minX = Math.min(...logicalMonitors.map(monitor => monitor[0]));
    const minY = Math.min(...logicalMonitors.map(monitor => monitor[1]));
    return logicalMonitors.map(monitor => [
        monitor[0] - minX,
        monitor[1] - minY,
        monitor[2],
        monitor[3],
        monitor[4],
        monitor[5],
        monitor[6],
    ]);
}

export default class ApagarMonitoresExtension extends Extension {
    enable() {
        this._savedConfiguration = null;
        this._busy = false;

        this._button = new PanelMenu.Button(0.0, 'Apagar monitores');
        this._button.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));
        Main.panel.addToStatusArea(UUID, this._button);

        this._disableItem = new PopupMenu.PopupMenuItem(
            'Apagar monitores externos'
        );
        this._disableItem.connect('activate', () => this._turnOffExternal());
        this._button.menu.addMenuItem(this._disableItem);

        this._restoreItem = new PopupMenu.PopupMenuItem(
            'Restaurar monitores externos'
        );
        this._restoreItem.setSensitive(false);
        this._restoreItem.connect('activate', () => this._restoreExternal());
        this._button.menu.addMenuItem(this._restoreItem);

        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sessionItem = new PopupMenu.PopupMenuItem(
            'Controlado por Mutter'
        );
        this._sessionItem.setSensitive(false);
        this._button.menu.addMenuItem(this._sessionItem);
    }

    disable() {
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }

        this._disableItem = null;
        this._restoreItem = null;
        this._sessionItem = null;
    }

    _setBusy(busy) {
        this._busy = busy;
        this._disableItem?.setSensitive(!busy && !this._savedConfiguration);
        this._restoreItem?.setSensitive(!busy && !!this._savedConfiguration);
    }

    _turnOffExternal() {
        if (this._busy || this._savedConfiguration)
            return;

        this._setBusy(true);
        _getCurrentState((error, state) => {
            if (error) {
                this._setBusy(false);
                _notify(`No se pudo consultar la configuración de pantallas: ${error.message}`);
                return;
            }

            let filteredMonitors;
            try {
                filteredMonitors = _disableExternalMonitors(state);
            } catch (filterError) {
                this._setBusy(false);
                _notify(filterError.message);
                return;
            }

            let savedConfiguration;
            try {
                savedConfiguration = {
                    logicalMonitors: _getApplyLogicalMonitors(state),
                    properties: state[3],
                };
            } catch (configurationError) {
                this._setBusy(false);
                _notify(`No se pudo guardar la configuración actual: ${configurationError.message}`);
                return;
            }

            _applyConfiguration(
                state[0],
                filteredMonitors,
                state[3],
                applyError => {
                    if (applyError) {
                        this._setBusy(false);
                        _notify(`No se pudieron apagar los monitores externos: ${applyError.message}`);
                        return;
                    }

                    this._savedConfiguration = savedConfiguration;
                    this._setBusy(false);
                    _notify('Los monitores externos están apagados.');
                }
            );
        });
    }

    _restoreExternal() {
        if (this._busy || !this._savedConfiguration)
            return;

        this._setBusy(true);
        _getCurrentState((error, state) => {
            if (error) {
                this._setBusy(false);
                _notify(`No se pudo consultar la configuración de pantallas: ${error.message}`);
                return;
            }

            _applyConfiguration(
                state[0],
                this._savedConfiguration.logicalMonitors,
                this._savedConfiguration.properties,
                applyError => {
                    if (applyError) {
                        this._setBusy(false);
                        _notify(`No se pudieron restaurar los monitores: ${applyError.message}`);
                        return;
                    }

                    this._savedConfiguration = null;
                    this._setBusy(false);
                    _notify('Se restauró la disposición original de las pantallas.');
                }
            );
        });
    }
}
