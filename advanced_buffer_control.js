var manifest = {
    type: 'other',
    version: '1.2.0',
    name: 'Умный большой буфер',
    title: 'Умный большой буфер',
    author: '@lampa',
    description: 'Управление большим буфером HLS в плеере Lampa',
    icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="14" width="44" height="8" rx="4" fill="currentColor"/><rect x="10" y="30" width="34" height="8" rx="4" fill="currentColor"/><rect x="10" y="46" width="24" height="8" rx="4" fill="currentColor"/></svg>'
};

;(function () {
    'use strict';

    var PLUGIN_ID = 'advanced_buffer_control';
    var PLUGIN_NAME = 'Умный большой буфер';
    var PLUGIN_VERSION = '1.2.0';
    var STORAGE_KEY = 'advanced_buffer_control_minutes';
    var DEFAULT_MINUTES = 20;
    var VALUES = [5, 10, 15, 20, 25, 30, 35, 40];
    var PLUGIN_URL = (document.currentScript && document.currentScript.src) || '';
    var ICON = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="14" width="44" height="8" rx="4" fill="currentColor"/><rect x="10" y="30" width="34" height="8" rx="4" fill="currentColor"/><rect x="10" y="46" width="24" height="8" rx="4" fill="currentColor"/></svg>';

    var state = {
        hls: null,
        video: null,
        video_handlers: [],
        timer: 0,
        last_force: 0
    };

    console.log('[Advanced Buffer Control] v' + PLUGIN_VERSION + ' start');

    if (window[PLUGIN_ID + '_ready']) {
        console.log('[Advanced Buffer Control] v' + PLUGIN_VERSION + ' already loaded');
        return;
    }

    window[PLUGIN_ID + '_ready'] = true;
    window[PLUGIN_ID + '_manifest'] = manifest;

    /* 
     * Нормализуем URL, чтобы можно было сопоставить исходный адрес плагина
     * с адресом скрипта, который Lampa загрузила с дополнительными query-параметрами.
     */
    function normalizeUrl(url) {
        return String(url || '')
            .replace(/[?#].*$/, '')
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '')
            .toLowerCase();
    }

    /* 
     * Читаем текущее значение настройки из Storage.
     * Если значение сломано или не входит в список разрешённых, возвращаем дефолт.
     */
    function getMinutes() {
        var value = parseInt(Lampa.Storage.get(STORAGE_KEY, DEFAULT_MINUTES), 10);
        return VALUES.indexOf(value) >= 0 ? value : DEFAULT_MINUTES;
    }

    /* Переводим минуты в секунды, потому что hls.js работает именно с секундами. */
    function getSeconds() {
        return getMinutes() * 60;
    }

    /* 
     * Для maxBufferSize нужен размер в байтах.
     * Здесь берём безопасную грубую оценку: 16 МБ на минуту, но не больше 512 МБ.
     */
    function getBufferSize() {
        return Math.min(getMinutes() * 16 * 1024 * 1024, 512 * 1024 * 1024);
    }

    /* 
     * Автоматически прописываем имя и описание в локальный список расширений.
     * Именно поле name используется экраном расширений, иначе он показывает "Без названия".
     */
    function registerPluginCard() {
        var list = Lampa.Storage.get('plugins', []);
        var changed = false;
        var current = normalizeUrl(PLUGIN_URL);

        if (typeof list === 'string') {
            try {
                list = JSON.parse(list);
            }
            catch (e) {
                list = [];
            }
        }

        if (!Array.isArray(list) || !current) return;

        list.forEach(function (item) {
            if (!item || !item.url) return;

            var stored = normalizeUrl(item.url);
            if (current.indexOf(stored) >= 0 || stored.indexOf(current) >= 0) {
                if (item.name !== PLUGIN_NAME) changed = true;
                item.name = PLUGIN_NAME;
                item.author = '@lampa';
                item.descr = 'Управление большим буфером видео';
            }
        });

        if (changed) Lampa.Storage.set('plugins', list);
    }

    /* 
     * Добавляем настройку в стандартный раздел "Плеер".
     * Используем короткую и надёжную структуру SettingsApi.addParam.
     */
    function addSettings() {
        var values = {};

        if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.addParam !== 'function') return;
        if (window[PLUGIN_ID + '_settings_ready']) return;

        VALUES.forEach(function (value) {
            values[String(value)] = value + ' минут';
        });

        Lampa.Storage.set(STORAGE_KEY, getMinutes());

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
            onChange: function (value) {
                Lampa.Storage.set(STORAGE_KEY, parseInt(value, 10) || DEFAULT_MINUTES);
                applyHlsConfig(state.hls);
                checkBuffer();
            }
        });

        window[PLUGIN_ID + '_settings_ready'] = true;
    }

    /* Копируем статические свойства конструктора Hls, чтобы не ломать Hls.isSupported() и Events. */
    function copyStatics(target, source) {
        Object.getOwnPropertyNames(source).forEach(function (name) {
            if (name !== 'prototype') {
                try { target[name] = source[name]; } catch (e) {}
            }
        });
    }

    /* Применяем нужные лимиты буфера к конфигу hls.js. */
    function patchConfig(config) {
        config = config || {};
        config.maxBufferLength = getSeconds();
        config.maxMaxBufferLength = getSeconds();
        config.maxBufferSize = getBufferSize();
        config.backBufferLength = Math.min(120, Math.max(60, Math.round(getSeconds() / 12)));
        return config;
    }

    /* Применяем лимиты уже к готовому экземпляру hls.js. */
    function applyHlsConfig(hls) {
        if (!hls) return;

        hls.config = patchConfig(hls.config || {});
        if (hls.userConfig) hls.userConfig = patchConfig(hls.userConfig || {});
    }

    /* 
     * Подключаем текущий video к плагину.
     * На video вешаем только базовые события, которые нужны для контроля buffered.
     */
    function unbindVideo() {
        state.video_handlers.forEach(function (item) {
            try {
                item.video.removeEventListener(item.event, item.handler, false);
            }
            catch (e) {}
        });

        state.video_handlers = [];
    }

    function bindVideo(video) {
        if (!video || state.video === video) return;

        unbindVideo();
        state.video = video;
        video.preload = 'auto';
        video.setAttribute('preload', 'auto');

        ['loadedmetadata', 'progress', 'timeupdate', 'waiting', 'seeking', 'play'].forEach(function (event) {
            video.addEventListener(event, checkBuffer, false);
            state.video_handlers.push({
                video: video,
                event: event,
                handler: checkBuffer
            });
        });
    }

    /* Находим количество секунд буфера впереди текущей позиции. */
    function getBufferedAhead(video) {
        var time = video.currentTime || 0;
        var i;

        if (!video.buffered) return 0;

        for (i = 0; i < video.buffered.length; i++) {
            if (time >= video.buffered.start(i) - 0.5 && time <= video.buffered.end(i) + 0.5) {
                return Math.max(0, video.buffered.end(i) - time);
            }
        }

        return 0;
    }

    /* Порог низкого буфера: от 45 до 60 секунд, как и требовалось. */
    function getThreshold(target) {
        if (target >= 1500) return 60;
        if (target >= 900) return 50;
        return 45;
    }

    /* 
     * Если буфер почти кончился, а до выбранного максимума ещё далеко,
     * сразу просим hls.js продолжить загрузку дальше.
     */
    function forceLoad() {
        var time = Date.now();

        if (!state.hls || !state.video) return;
        if (time - state.last_force < 8000) return;

        state.last_force = time;
        applyHlsConfig(state.hls);

        try {
            if (typeof state.hls.startLoad === 'function') {
                state.hls.startLoad(state.video.currentTime || -1);
            }
            else if (typeof state.hls.resumeBuffering === 'function') {
                state.hls.resumeBuffering();
            }
        }
        catch (e) {
            console.log('[Advanced Buffer Control] forceLoad error', e);
        }
    }

    /* Основная проверка буфера. */
    function checkBuffer() {
        var video = state.video || document.querySelector('video');
        var target;
        var ahead;
        var remain;

        if (state.video && document.body && !document.body.contains(state.video)) {
            state.video = null;
            video = document.querySelector('video');
        }

        if (!video) return;
        if (!state.video) bindVideo(video);

        target = getSeconds();
        ahead = getBufferedAhead(video);
        remain = isFinite(video.duration) ? Math.max(0, video.duration - (video.currentTime || 0)) : target;
        target = Math.min(target, Math.max(0, remain - 5));

        if (!target || remain <= 70) return;
        if (ahead <= getThreshold(target) && ahead < target - 15) forceLoad();
    }

    /* 
     * Регистрируем экземпляр hls.js.
     * attachMedia для нас ключевой: именно там мы получаем реальный video-элемент плеера.
     */
    function captureHls(hls) {
        if (!hls || hls.__advanced_buffer_control_ready) return;

        hls.__advanced_buffer_control_ready = true;
        state.hls = hls;
        applyHlsConfig(hls);

        if (typeof hls.attachMedia === 'function') {
            var originalAttach = hls.attachMedia;
            hls.attachMedia = function (media) {
                var result = originalAttach.apply(this, arguments);
                state.hls = this;
                bindVideo(media);
                applyHlsConfig(this);
                checkBuffer();
                return result;
            };
        }

        if (hls.media) bindVideo(hls.media);
    }

    /* 
     * Перехватываем глобальный конструктор Hls.
     * Это позволяет подменить конфиг ДО запуска загрузки сегментов.
     */
    function hookHls() {
        var NativeHls;

        if (!window.Hls || window.Hls.__advanced_buffer_control_wrapped) return;

        NativeHls = window.Hls;

        function WrappedHls(config) {
            var instance = new NativeHls(patchConfig(config));
            captureHls(instance);
            return instance;
        }

        copyStatics(WrappedHls, NativeHls);
        WrappedHls.prototype = NativeHls.prototype;
        WrappedHls.__advanced_buffer_control_wrapped = true;
        window.Hls = WrappedHls;
    }

    /* 
     * Один лёгкий polling-цикл.
     * Он нужен только для двух задач: дождаться появления window.Hls и подхватить новое video.
     */
    function startLoop() {
        if (state.timer) clearInterval(state.timer);

        state.timer = setInterval(function () {
            var video = document.querySelector('video');

            hookHls();
            if (window.hls) captureHls(window.hls);
            if (video && video !== state.video) bindVideo(video);
            checkBuffer();
        }, 2500);
    }

    function init() {
        registerPluginCard();
        addSettings();
        hookHls();
        startLoop();
    }

    if (window.appready) {
        init();
    }
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }

    console.log('[Advanced Buffer Control] v' + PLUGIN_VERSION + ' end');
})();
