var manifest = {
    type: 'other',
    version: '1.3',
    name: 'Умный большой буфер',
    title: 'Умный большой буфер',
    author: '@lampa',
    description: 'Большой буфер видео до 40 минут в плеере Lampa'
};

;(function () {
    'use strict';

    console.log('[Умный большой буфер] v1.3 — запуск');

    if (window.__advanced_buffer_control_ready) {
        console.log('[Умный большой буфер] уже загружен');
        return;
    }
    window.__advanced_buffer_control_ready = true;
    window.advanced_buffer_control_manifest = manifest;

    var STORAGE_KEY = 'advanced_buffer_control_minutes';
    var DEFAULT_MINUTES = 20;
    var VALUES = [5, 10, 15, 20, 25, 30, 35, 40];

    function getMinutes() {
        var val = Lampa.Storage.get(STORAGE_KEY, DEFAULT_MINUTES);
        return VALUES.indexOf(parseInt(val)) !== -1 ? parseInt(val) : DEFAULT_MINUTES;
    }

    function getSeconds() {
        return getMinutes() * 60;
    }

    function getBufferSize() {
        return Math.min(getMinutes() * 16 * 1024 * 1024, 512 * 1024 * 1024);
    }

    // Добавляем настройку в раздел «Плеер»
    function addSetting() {
        if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.addParam !== 'function') return;

        var values = {};
        VALUES.forEach(function (v) {
            values[String(v)] = v + ' минут';
        });

        Lampa.SettingsApi.addParam({
            component: 'player',
            param: {
                name: STORAGE_KEY,
                type: 'select',
                values: values,
                "default": String(DEFAULT_MINUTES)
            },
            field: {
                name: 'Максимальный размер буфера видео',
                description: 'Сколько минут видео заранее буферизировать (максимум 40 минут)'
            },
            onChange: function (val) {
                Lampa.Storage.set(STORAGE_KEY, parseInt(val) || DEFAULT_MINUTES);
                console.log('[Умный большой буфер] новое значение:', val, 'минут');
            }
        });
    }

    // Перехватываем Hls
    function hookHls() {
        if (!window.Hls || window.Hls.__buffer_patched) return;

        var Original = window.Hls;

        function Patched(config) {
            config = config || {};
            config.maxBufferLength = getSeconds();
            config.maxMaxBufferLength = getSeconds();
            config.maxBufferSize = getBufferSize();
            config.backBufferLength = Math.min(120, Math.max(60, Math.round(getSeconds() / 12)));

            var instance = new Original(config);
            return instance;
        }

        Object.keys(Original).forEach(function (key) {
            if (key !== 'prototype') Patched[key] = Original[key];
        });
        Patched.prototype = Original.prototype;
        Patched.__buffer_patched = true;

        window.Hls = Patched;
        console.log('[Умный большой буфер] Hls.js перехвачен');
    }

    // Запуск
    function start() {
        addSetting();
        hookHls();

        // Перехват запуска плеера
        if (Lampa.Player && Lampa.Player.play) {
            var originalPlay = Lampa.Player.play;
            Lampa.Player.play = function () {
                hookHls();
                return originalPlay.apply(this, arguments);
            };
        }

        console.log('[Умный большой буфер] v1.3 полностью готов');
    }

    if (window.appready) {
        start();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
