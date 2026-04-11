;(function () {
    'use strict';

    var PLUGIN_NAME = 'Умный большой буфер';
    var PLUGIN_VERSION = '1.1';

    console.log('[Умный большой буфер] v' + PLUGIN_VERSION + ' загружен');

    // Защита от повторной загрузки
    if (window.__buffer_control_ready) return;
    window.__buffer_control_ready = true;

    var STORAGE_KEY = 'advanced_buffer_minutes';
    var DEFAULT_MINUTES = 20;
    var ALLOWED = [5, 10, 15, 20, 25, 30, 35, 40];

    function getMinutes() {
        var val = Lampa.Storage.get(STORAGE_KEY, DEFAULT_MINUTES);
        return ALLOWED.indexOf(parseInt(val)) !== -1 ? parseInt(val) : DEFAULT_MINUTES;
    }

    function saveMinutes(val) {
        Lampa.Storage.set(STORAGE_KEY, parseInt(val));
    }

    // Добавляем настройку (самый стабильный способ)
    function addSetting() {
        if (typeof Lampa.SettingsApi === 'undefined') return;

        Lampa.SettingsApi.addParam({
            component: 'player',
            param: {
                name: STORAGE_KEY,
                type: 'select',
                values: {
                    '5': '5 минут', '10': '10 минут', '15': '15 минут',
                    '20': '20 минут', '25': '25 минут', '30': '30 минут',
                    '35': '35 минут', '40': '40 минут'
                },
                "default": String(DEFAULT_MINUTES)
            },
            field: {
                name: 'Максимальный размер буфера видео',
                description: 'Сколько минут видео заранее буферизировать (макс. 40)'
            },
            onChange: function (value) {
                saveMinutes(value);
                console.log('[Умный большой буфер] Новое значение:', value, 'минут');
            }
        });
    }

    // Основная магия — перехватываем создание hls.js
    function hookHls() {
        if (!window.Hls || window.Hls.__buffer_patched) return;

        var OriginalHls = window.Hls;

        function PatchedHls(config) {
            var minutes = getMinutes();
            var seconds = minutes * 60;
            var bytes = minutes * 16 * 1024 * 1024; // ~16 МБ на минуту

            config = config || {};
            config.maxBufferLength = seconds;
            config.maxMaxBufferLength = seconds;
            config.maxBufferSize = Math.min(Math.max(bytes, 96*1024*1024), 512*1024*1024);

            var instance = new OriginalHls(config);

            // Дополнительно форсируем при attach
            var originalAttach = instance.attachMedia;
            instance.attachMedia = function (media) {
                var result = originalAttach.apply(this, arguments);
                // Повторно применяем конфиг после attach
                if (this.config) {
                    this.config.maxBufferLength = seconds;
                    this.config.maxMaxBufferLength = seconds;
                    this.config.maxBufferSize = bytes;
                }
                return result;
            };

            return instance;
        }

        // Копируем статические методы (isSupported и т.д.)
        Object.keys(OriginalHls).forEach(function (key) {
            if (key !== 'prototype') PatchedHls[key] = OriginalHls[key];
        });

        PatchedHls.prototype = OriginalHls.prototype;
        PatchedHls.__buffer_patched = true;

        window.Hls = PatchedHls;
        console.log('[Умный большой буфер] Hls.js успешно перехвачен');
    }

    // Запуск плагина
    function start() {
        addSetting();
        hookHls();

        // Перехватываем запуск плеера (на всякий случай)
        if (Lampa.Player && typeof Lampa.Player.play === 'function') {
            var orig = Lampa.Player.play;
            Lampa.Player.play = function () {
                hookHls();
                return orig.apply(this, arguments);
            };
        }

        console.log('[Умный большой буфер] v' + PLUGIN_VERSION + ' полностью запущен');
    }

    // Ждём готовности Lampa
    if (window.Lampa && Lampa.Storage) {
        start();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
