;(function () {
    'use strict';

    /*
     * Основные данные плагина.
     * Их выносим в начало, чтобы было проще менять название, версию и ключи хранения.
     */
    var PLUGIN_NAME = 'Advanced Buffer Control';
    var PLUGIN_NAME_RU = 'Умный большой буфер';
    var PLUGIN_VERSION = '1.0.0';
    var COMPONENT_NAME = 'advanced_buffer_control';
    var STORAGE_KEY = 'advanced_buffer_control_minutes';

    /*
     * В начале файла выводим технический лог.
     * Это помогает сразу увидеть в консоли, что плагин был загружен.
     */
    console.log('[' + PLUGIN_NAME + '] v' + PLUGIN_VERSION + ' start');

    /*
     * Защита от повторной инициализации.
     * В Lampa плагин может быть подключен повторно после обновления, перезагрузки страницы
     * или при повторном выполнении скрипта, поэтому сразу ставим глобальный флаг.
     */
    if (window['plugin_' + COMPONENT_NAME + '_ready']) {
        console.log('[' + PLUGIN_NAME + '] v' + PLUGIN_VERSION + ' already initialized');
        return;
    }

    window['plugin_' + COMPONENT_NAME + '_ready'] = true;

    /*
     * Набор допустимых значений настройки.
     * Пользователь выбирает размер буфера в минутах, а внутри логики мы переводим это в секунды.
     */
    var ALLOWED_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40];
    var DEFAULT_MINUTES = 20;

    /*
     * Порог, при котором мы считаем буфер "почти закончившимся".
     * Требование пользователя: реагировать при остатке примерно 45–60 секунд.
     * Поэтому порог выбирается динамически, в зависимости от общего целевого буфера.
     */
    var LOW_BUFFER_SMALL = 45;
    var LOW_BUFFER_MEDIUM = 50;
    var LOW_BUFFER_BIG = 60;

    /*
     * Тайминги, которые удерживают плагин от лишних циклов и сетевого шума.
     * FORCE_COOLDOWN: как часто можно принудительно пытаться "толкнуть" загрузку дальше.
     * NUDGE_COOLDOWN: как часто разрешаем очень короткий seek-взад-вперёд для нативного video.
     * MONITOR_INTERVAL: периодическая перепроверка состояния буфера.
     */
    var FORCE_COOLDOWN = 12000;
    var NUDGE_COOLDOWN = 20000;
    var MONITOR_INTERVAL = 3000;

    /*
     * Оценка максимального размера буфера в байтах для hls.js.
     * Это не точная наука, потому что реальный битрейт у разных потоков разный.
     * Мы берём достаточно большой лимит, но ограничиваем его сверху ради стабильности памяти.
     */
    var MIN_BUFFER_SIZE_BYTES = 96 * 1024 * 1024;
    var MAX_BUFFER_SIZE_BYTES = 512 * 1024 * 1024;
    var APPROX_BYTES_PER_MINUTE = 16 * 1024 * 1024;

    /*
     * Простая SVG-иконка для раздела настроек плагина.
     * Она не обязательна для логики, но делает пункт в настройках аккуратнее.
     */
    var PLUGIN_ICON = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="8" y="12" width="48" height="8" rx="3" fill="currentColor"/>' +
        '<rect x="8" y="28" width="36" height="8" rx="3" fill="currentColor"/>' +
        '<rect x="8" y="44" width="24" height="8" rx="3" fill="currentColor"/>' +
        '</svg>';

    /*
     * Глобальное состояние плагина.
     * Здесь мы держим активный video, активный экземпляр hls.js, таймеры и служебные флаги.
     */
    var state = {
        started: false,
        settings_installed: false,
        player_wrapped: false,
        hls_wrapped: false,
        dom_observer: null,
        poll_timer: 0,
        last_hls: null
    };

    /*
     * Текущая активная сессия воспроизведения.
     * Это отдельный объект, чтобы можно было безопасно "отвязаться" от старого видео
     * и корректно подключиться к новому.
     */
    var session = {
        video: null,
        hls: null,
        source: '',
        listeners: [],
        monitor_timer: 0,
        monitor_pending: false,
        last_force_at: 0,
        last_nudge_at: 0,
        force_lock_until: 0
    };

    /*
     * Утилита для логирования.
     * Все сообщения помечаем одним префиксом, чтобы их было легко фильтровать в консоли.
     */
    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[' + PLUGIN_NAME + ']');
        console.log.apply(console, args);
    }

    /*
     * Безопасный аналог Date.now для старых окружений.
     */
    function now() {
        return Date.now ? Date.now() : new Date().getTime();
    }

    /*
     * Проверка конечного числа.
     * Нужна, чтобы не работать с NaN и Infinity из media API.
     */
    function isFiniteNumber(value) {
        return typeof value === 'number' && isFinite(value);
    }

    /*
     * Нормализация выбранного значения буфера.
     * Даже если в Storage случайно попадёт мусор, функция вернёт корректное значение.
     */
    function normalizeMinutes(value) {
        var numeric = parseInt(value, 10);
        var i;

        if (!isFiniteNumber(numeric)) numeric = DEFAULT_MINUTES;

        for (i = 0; i < ALLOWED_MINUTES.length; i++) {
            if (ALLOWED_MINUTES[i] === numeric) return numeric;
        }

        return DEFAULT_MINUTES;
    }

    /*
     * Безопасное чтение из Lampa.Storage.
     * В разных сборках удобнее использовать get либо field, поэтому поддерживаем оба пути.
     */
    function storageGet(key, fallback) {
        try {
            if (window.Lampa && Lampa.Storage) {
                if (typeof Lampa.Storage.get === 'function') {
                    return Lampa.Storage.get(key, fallback);
                }

                if (typeof Lampa.Storage.field === 'function') {
                    var value = Lampa.Storage.field(key);
                    return typeof value === 'undefined' ? fallback : value;
                }
            }
        }
        catch (e) {
            log('Ошибка чтения Storage:', e);
        }

        return fallback;
    }

    /*
     * Безопасная запись в Lampa.Storage.
     */
    function storageSet(key, value) {
        try {
            if (window.Lampa && Lampa.Storage && typeof Lampa.Storage.set === 'function') {
                Lampa.Storage.set(key, value);
                return true;
            }
        }
        catch (e) {
            log('Ошибка записи Storage:', e);
        }

        return false;
    }

    /*
     * Читаем текущее значение настройки буфера.
     */
    function getSelectedMinutes() {
        return normalizeMinutes(storageGet(STORAGE_KEY, DEFAULT_MINUTES));
    }

    /*
     * Сохраняем значение настройки буфера.
     */
    function setSelectedMinutes(value) {
        return storageSet(STORAGE_KEY, normalizeMinutes(value));
    }

    /*
     * Возвращаем целевой буфер уже в секундах.
     * Именно это значение нужно hls.js и внутренним расчётам.
     */
    function getSelectedSeconds() {
        return getSelectedMinutes() * 60;
    }

    /*
     * Рассчитываем размер буфера в байтах для hls.js.
     * Лимит держим большим, но ограничиваем сверху, чтобы меньше рисковать памятью устройства.
     */
    function getMaxBufferSizeBytes() {
        var bytes = getSelectedMinutes() * APPROX_BYTES_PER_MINUTE;

        if (bytes < MIN_BUFFER_SIZE_BYTES) bytes = MIN_BUFFER_SIZE_BYTES;
        if (bytes > MAX_BUFFER_SIZE_BYTES) bytes = MAX_BUFFER_SIZE_BYTES;

        return bytes;
    }

    /*
     * Подбираем порог "низкого" буфера.
     * Для маленьких значений хватает 45 секунд, для больших буферов поднимаем до 60 секунд.
     */
    function getLowBufferThreshold(targetSeconds) {
        if (targetSeconds >= 1500) return LOW_BUFFER_BIG;
        if (targetSeconds >= 900) return LOW_BUFFER_MEDIUM;
        return LOW_BUFFER_SMALL;
    }

    /*
     * Ставим значение по умолчанию, если пользователь ещё ничего не выбирал.
     */
    function ensureDefaultSetting() {
        var current = storageGet(STORAGE_KEY, null);

        if (current === null || typeof current === 'undefined' || current === '') {
            setSelectedMinutes(DEFAULT_MINUTES);
        }
    }

    /*
     * Формируем список значений для select-настройки Lampa.SettingsApi.
     * Ключи строковые, потому что так надёжнее работает с select во многих сборках.
     */
    function buildSettingsValues() {
        var values = {};
        var i;

        for (i = 0; i < ALLOWED_MINUTES.length; i++) {
            values[String(ALLOWED_MINUTES[i])] = ALLOWED_MINUTES[i] + ' минут';
        }

        return values;
    }

    /*
     * Добавляем раздел и параметр в настройки Lampa.
     * Основной современный путь для версий 2025–2026: Lampa.SettingsApi.
     * Сохранение всё равно дублируем через Storage, чтобы не зависеть от деталей реализации.
     */
    function installSettings() {
        if (state.settings_installed) return;

        if (!window.Lampa || !Lampa.SettingsApi || typeof Lampa.SettingsApi.addParam !== 'function') {
            log('SettingsApi недоступен, настройка в меню не добавлена, но Storage будет использоваться');
            return;
        }

        try {
            if (typeof Lampa.SettingsApi.addComponent === 'function') {
                Lampa.SettingsApi.addComponent({
                    component: COMPONENT_NAME,
                    name: PLUGIN_NAME_RU,
                    icon: PLUGIN_ICON
                });
            }
        }
        catch (e) {
            /*
             * Если компонент уже существует, это не критично.
             * Параметр ниже всё равно попытаемся добавить.
             */
            log('addComponent пропущен:', e);
        }

        try {
            Lampa.SettingsApi.addParam({
                component: COMPONENT_NAME,
                param: {
                    name: STORAGE_KEY,
                    type: 'select',
                    values: buildSettingsValues(),
                    default: String(DEFAULT_MINUTES)
                },
                field: {
                    name: 'Максимальный размер буфера видео',
                    description: 'Сколько минут видео заранее буферизировать (максимум 40 минут)'
                },
                onChange: function (value) {
                    /*
                     * Значение обязательно нормализуем и сразу применяем к уже открытому плееру,
                     * чтобы не требовалось перезапускать воспроизведение.
                     */
                    var minutes = normalizeMinutes(value);

                    setSelectedMinutes(minutes);
                    applyRuntimeSettings('settings-change');
                    scheduleMonitor(150, 'settings-change');

                    log('Новое значение буфера:', minutes + ' минут');
                }
            });

            state.settings_installed = true;
            log('Настройка успешно добавлена в меню Lampa');
        }
        catch (e2) {
            log('Ошибка добавления настройки:', e2);
        }
    }

    /*
     * Копируем статические свойства исходного конструктора Hls в наш прокси-конструктор.
     * Это нужно, чтобы не ломались проверки типа Hls.isSupported() и доступ к Hls.Events.
     */
    function copyStaticProps(target, source) {
        var names;
        var i;

        try {
            names = Object.getOwnPropertyNames(source);

            for (i = 0; i < names.length; i++) {
                if (names[i] === 'prototype') continue;

                try {
                    target[names[i]] = source[names[i]];
                }
                catch (e) {}
            }
        }
        catch (e2) {}
    }

    /*
     * Подготовка конфигурации hls.js ещё до создания экземпляра.
     * Здесь задаём максимальный размер буфера по времени и по памяти.
     */
    function patchHlsConfig(config) {
        var seconds = getSelectedSeconds();
        var bytes = getMaxBufferSizeBytes();
        var backBufferLength = Math.min(120, Math.max(60, Math.round(seconds / 12)));

        if (!config) config = {};

        config.maxBufferLength = seconds;
        config.maxMaxBufferLength = seconds;
        config.maxBufferSize = bytes;
        config.backBufferLength = backBufferLength;

        return config;
    }

    /*
     * Применение параметров к уже созданному экземпляру hls.js.
     * В некоторых версиях hls.js достаточно изменить config на лету, и дальше загрузчик сам
     * продолжит ориентироваться на новые лимиты буфера.
     */
    function applyHlsConfig(hls, reason) {
        var seconds;
        var bytes;
        var backBufferLength;

        if (!hls) return false;

        seconds = getSelectedSeconds();
        bytes = getMaxBufferSizeBytes();
        backBufferLength = Math.min(120, Math.max(60, Math.round(seconds / 12)));

        try {
            if (!hls.config) hls.config = {};

            hls.config.maxBufferLength = seconds;
            hls.config.maxMaxBufferLength = seconds;
            hls.config.maxBufferSize = bytes;
            hls.config.backBufferLength = backBufferLength;

            /*
             * В ряде сборок у hls.js отдельно существует userConfig.
             * Если он есть, тоже обновляем, чтобы конфиг не "откатился" при следующих операциях.
             */
            if (hls.userConfig && typeof hls.userConfig === 'object') {
                hls.userConfig.maxBufferLength = seconds;
                hls.userConfig.maxMaxBufferLength = seconds;
                hls.userConfig.maxBufferSize = bytes;
                hls.userConfig.backBufferLength = backBufferLength;
            }

            return true;
        }
        catch (e) {
            log('Ошибка применения HLS-конфига (' + reason + '):', e);
            return false;
        }
    }

    /*
     * Регистрируем экземпляр hls.js и вешаем на него защитные перехваты.
     * Это позволяет:
     * 1) держать ссылку на текущий hls;
     * 2) понимать, к какому video он прикреплён;
     * 3) повторно применять конфиг при attachMedia и destroy.
     */
    function registerHlsInstance(hls, reason) {
        if (!hls) return;

        state.last_hls = hls;
        window.__advanced_buffer_control_last_hls = hls;

        if (hls.__advanced_buffer_control_registered) {
            applyHlsConfig(hls, reason || 'reuse');
            return;
        }

        hls.__advanced_buffer_control_registered = true;

        try {
            if (typeof hls.attachMedia === 'function') {
                var originalAttachMedia = hls.attachMedia;

                hls.attachMedia = function (media) {
                    var result = originalAttachMedia.apply(this, arguments);

                    try {
                        if (media) {
                            media.__advanced_buffer_control_hls = this;
                            session.hls = this;
                            state.last_hls = this;
                            applyHlsConfig(this, 'attachMedia');
                            scheduleActivation('hls.attachMedia');
                        }
                    }
                    catch (e) {
                        log('Ошибка attachMedia hook:', e);
                    }

                    return result;
                };
            }
        }
        catch (e2) {
            log('Ошибка регистрации attachMedia:', e2);
        }

        try {
            if (typeof hls.destroy === 'function') {
                var originalDestroy = hls.destroy;

                hls.destroy = function () {
                    try {
                        if (session.hls === this) session.hls = null;
                        if (state.last_hls === this) state.last_hls = null;
                    }
                    catch (e) {}

                    return originalDestroy.apply(this, arguments);
                };
            }
        }
        catch (e3) {
            log('Ошибка регистрации destroy:', e3);
        }

        applyHlsConfig(hls, reason || 'register');
    }

    /*
     * Оборачиваем глобальный конструктор Hls.
     * Это самый надёжный способ подложить наши параметры буфера ДО того, как Lampa
     * создаст экземпляр hls.js для нового видео.
     */
    function hookHlsConstructor() {
        var NativeHls;

        if (!window.Hls) return false;
        if (window.Hls.__advanced_buffer_control_wrapped) return true;

        NativeHls = window.Hls;

        function HlsProxy(config) {
            var instance = new NativeHls(patchHlsConfig(config || {}));
            registerHlsInstance(instance, 'constructor');
            return instance;
        }

        copyStaticProps(HlsProxy, NativeHls);
        HlsProxy.prototype = NativeHls.prototype;
        HlsProxy.__advanced_buffer_control_wrapped = true;
        HlsProxy.__advanced_buffer_control_native = NativeHls;

        window.Hls = HlsProxy;
        state.hls_wrapped = true;

        log('Глобальный Hls успешно перехвачен');
        return true;
    }

    /*
     * Оборачиваем Lampa.Player.play.
     * Перед каждым запуском видео пытаемся снова подключить Hls-перехват,
     * а после вызова оригинального play несколько раз проверяем появление video-элемента.
     */
    function hookPlayer() {
        var originalPlay;

        if (state.player_wrapped) return;
        if (!window.Lampa || !Lampa.Player || typeof Lampa.Player.play !== 'function') return;

        originalPlay = Lampa.Player.play;

        Lampa.Player.play = function () {
            var result;

            hookHlsConstructor();
            result = originalPlay.apply(this, arguments);
            scheduleActivation('player.play');

            return result;
        };

        state.player_wrapped = true;
        log('Lampa.Player.play успешно перехвачен');
    }

    /*
     * Проверяем, есть ли у элемента реальный размер и присутствует ли он в интерфейсе.
     * Это помогает выбирать активный video, а не скрытые превью или уже снятые с экрана элементы.
     */
    function isVisibleElement(element) {
        try {
            if (!element) return false;
            if (element.offsetWidth > 0 || element.offsetHeight > 0) return true;
            if (element.getClientRects && element.getClientRects().length > 0) return true;
        }
        catch (e) {}

        return false;
    }

    /*
     * Получаем адрес текущего видео.
     * Используем несколько вариантов, потому что браузер и hls.js могут заполнять их по-разному.
     */
    function getVideoSource(video) {
        if (!video) return '';

        return video.currentSrc || video.src || video.getAttribute('src') || '';
    }

    /*
     * Выбираем наиболее вероятный активный video в DOM.
     * Счёт строится по видимости, состоянию воспроизведения, буферу и наличию src.
     */
    function findBestVideo() {
        var videos = document.querySelectorAll('video');
        var best = null;
        var bestScore = -1;
        var i;

        for (i = 0; i < videos.length; i++) {
            var video = videos[i];
            var score = 0;

            try {
                if (getVideoSource(video)) score += 10;
                if (video.readyState >= 2) score += 10;
                if (!video.paused) score += 12;
                if (video.buffered && video.buffered.length) score += 8;
                if (isVisibleElement(video)) score += 10;
                if (isFiniteNumber(video.duration) && video.duration > 60) score += 4;
                if (video.__advanced_buffer_control_hls) score += 8;

                if (typeof video.closest === 'function') {
                    if (video.closest('.player, .player-video, .fullscreen, .full-start')) score += 6;
                }
            }
            catch (e) {}

            if (score > bestScore) {
                bestScore = score;
                best = video;
            }
        }

        return best;
    }

    /*
     * Проверяем, что найденный экземпляр hls.js действительно можно использовать
     * для конкретного video-элемента, а не для уже завершённой предыдущей сессии.
     */
    function isValidHlsCandidate(candidate, video) {
        if (!candidate) return false;
        if (typeof candidate !== 'object') return false;
        if (typeof candidate.startLoad !== 'function' && typeof candidate.resumeBuffering !== 'function') return false;

        try {
            if (video && candidate.media && candidate.media !== video) return false;
        }
        catch (e) {}

        return true;
    }

    /*
     * Находим связанный экземпляр hls.js.
     * Порядок поиска:
     * 1) hls, который мы ранее привязали к video;
     * 2) window.hls, если конкретная сборка действительно его экспортирует;
     * 3) последний увиденный экземпляр hls.js;
     * 4) общий глобальный кеш плагина.
     */
    function detectHlsForVideo(video) {
        var candidate = null;

        if (video && video.__advanced_buffer_control_hls) {
            candidate = video.__advanced_buffer_control_hls;
        }
        else if (window.hls && typeof window.hls === 'object') {
            candidate = window.hls;
        }
        else if (session.hls) {
            candidate = session.hls;
        }
        else if (state.last_hls) {
            candidate = state.last_hls;
        }
        else if (window.__advanced_buffer_control_last_hls) {
            candidate = window.__advanced_buffer_control_last_hls;
        }

        if (!isValidHlsCandidate(candidate, video)) {
            return null;
        }

        registerHlsInstance(candidate, 'detect');

        return candidate;
    }

    /*
     * Удаляем все слушатели со старого video и останавливаем периодический мониторинг.
     * Это важно, чтобы не накапливать таймеры и обработчики при переключении серий и фильмов.
     */
    function cleanupSession() {
        var i;

        if (session.monitor_timer) {
            clearInterval(session.monitor_timer);
            session.monitor_timer = 0;
        }

        session.monitor_pending = false;
        session.force_lock_until = 0;

        for (i = 0; i < session.listeners.length; i++) {
            try {
                session.listeners[i].element.removeEventListener(session.listeners[i].type, session.listeners[i].handler, false);
            }
            catch (e) {}
        }

        session.listeners = [];
        session.video = null;
        session.hls = null;
        session.source = '';
        session.last_force_at = 0;
        session.last_nudge_at = 0;
    }

    /*
     * Унифицированное добавление слушателей на video с последующим безопасным снятием.
     */
    function addVideoListener(video, type, handler) {
        video.addEventListener(type, handler, false);
        session.listeners.push({
            element: video,
            type: type,
            handler: handler
        });
    }

    /*
     * Мягко применяем общие параметры к текущему плееру.
     * Для video включаем preload=auto, для hls.js обновляем конфиг буфера.
     */
    function applyRuntimeSettings(reason) {
        try {
            if (session.video) {
                session.video.preload = 'auto';
                session.video.autobuffer = true;
                session.video.setAttribute('preload', 'auto');
            }
        }
        catch (e) {}

        if (session.hls) {
            applyHlsConfig(session.hls, reason || 'runtime');
        }
    }

    /*
     * Прикрепляемся к новому видео.
     * Если video уже то же самое и src не изменился, просто обновляем параметры.
     * Если video новый или источник изменился, полностью пересобираем сессию.
     */
    function attachToVideo(video, reason) {
        var source;

        if (!video) return false;

        source = getVideoSource(video);

        if (session.video === video && session.source === source) {
            session.hls = detectHlsForVideo(video);
            applyRuntimeSettings('reattach:' + reason);
            return true;
        }

        cleanupSession();

        session.video = video;
        session.source = source;
        session.hls = detectHlsForVideo(video);

        applyRuntimeSettings('attach:' + reason);

        /*
         * Основные события, на которые мы реагируем:
         * - loadedmetadata/canplay: видео готово, можно применять лимиты и мониторить.
         * - progress: браузер догрузил новые данные.
         * - timeupdate: пользователь приблизился к концу текущего буфера.
         * - waiting/seeking/playing: нужно быстрее перепроверить буфер.
         * - ended/emptied: сессия сменится, поэтому заново ищем video.
         */
        addVideoListener(video, 'loadedmetadata', function () {
            session.hls = detectHlsForVideo(video);
            applyRuntimeSettings('loadedmetadata');
            scheduleMonitor(100, 'loadedmetadata');
        });

        addVideoListener(video, 'canplay', function () {
            session.hls = detectHlsForVideo(video);
            applyRuntimeSettings('canplay');
            scheduleMonitor(100, 'canplay');
        });

        addVideoListener(video, 'progress', function () {
            scheduleMonitor(120, 'progress');
        });

        addVideoListener(video, 'timeupdate', function () {
            scheduleMonitor(150, 'timeupdate');
        });

        addVideoListener(video, 'waiting', function () {
            scheduleMonitor(50, 'waiting');
        });

        addVideoListener(video, 'playing', function () {
            scheduleMonitor(100, 'playing');
        });

        addVideoListener(video, 'play', function () {
            scheduleMonitor(100, 'play');
        });

        addVideoListener(video, 'seeking', function () {
            scheduleMonitor(80, 'seeking');
        });

        addVideoListener(video, 'seeked', function () {
            scheduleMonitor(80, 'seeked');
        });

        addVideoListener(video, 'emptied', function () {
            scheduleActivation('video.emptied');
        });

        addVideoListener(video, 'ended', function () {
            scheduleActivation('video.ended');
        });

        session.monitor_timer = setInterval(function () {
            monitorBuffer('interval');
        }, MONITOR_INTERVAL);

        log('Подключено новое video:', reason, source || '<без src>', session.hls ? 'mode=hls.js' : 'mode=native');

        scheduleMonitor(150, 'attach');
        return true;
    }

    /*
     * Ищем интервал buffered, в котором находится текущая позиция.
     * Нас интересует именно буфер "вперёд" от currentTime, а не суммарный размер всех диапазонов.
     */
    function getCurrentBufferedRange(video) {
        var current;
        var i;
        var start;
        var end;
        var tolerance = 0.75;

        if (!video || !video.buffered) return null;

        current = isFiniteNumber(video.currentTime) ? video.currentTime : 0;

        try {
            for (i = 0; i < video.buffered.length; i++) {
                start = video.buffered.start(i);
                end = video.buffered.end(i);

                if (current + tolerance >= start && current <= end + tolerance) {
                    return {
                        start: start,
                        end: end
                    };
                }
            }
        }
        catch (e) {
            log('Ошибка чтения video.buffered:', e);
        }

        return null;
    }

    /*
     * Собираем все показатели, на основе которых принимается решение:
     * - сколько секунд уже есть впереди;
     * - сколько осталось до конца ролика;
     * - какой буфер мы хотим получить по настройке пользователя.
     */
    function getBufferStats(video) {
        var range;
        var current;
        var duration;
        var ahead;
        var remaining;
        var target;

        if (!video) return null;

        current = isFiniteNumber(video.currentTime) ? video.currentTime : 0;
        duration = isFiniteNumber(video.duration) ? video.duration : Infinity;
        range = getCurrentBufferedRange(video);
        ahead = range ? Math.max(0, range.end - current) : 0;
        remaining = isFiniteNumber(duration) ? Math.max(0, duration - current) : Infinity;
        target = getSelectedSeconds();

        /*
         * Если ролик короче выбранного буфера, смысла буферизировать "за пределы" видео нет,
         * поэтому целевое значение ограничиваем оставшейся длительностью.
         */
        if (isFiniteNumber(remaining)) {
            target = Math.min(target, Math.max(0, remaining - 5));
        }

        return {
            current: current,
            duration: duration,
            range_start: range ? range.start : current,
            range_end: range ? range.end : current,
            ahead: ahead,
            remaining: remaining,
            target: target
        };
    }

    /*
     * Пытаемся заставить hls.js продолжить загрузку вперёд.
     * Сначала используем startLoad(-1), а если конкретная версия это не принимает,
     * пробуем startLoad от текущей позиции.
     */
    function forceHlsLoad(hls, currentTime) {
        if (!hls) return false;

        try {
            if (typeof hls.startLoad === 'function') {
                hls.startLoad(-1);
                return true;
            }
        }
        catch (e1) {
            try {
                if (typeof hls.startLoad === 'function') {
                    hls.startLoad(currentTime || -1);
                    return true;
                }
            }
            catch (e2) {}
        }

        try {
            if (typeof hls.resumeBuffering === 'function') {
                hls.resumeBuffering();
                return true;
            }
        }
        catch (e3) {}

        return false;
    }

    /*
     * Осторожный "тычок" для нативного video, где прямого API наращивания буфера нет.
     * Мы делаем микро-seek внутри уже загруженного диапазона и сразу возвращаемся назад.
     * Это не идеальный способ, но в части браузеров помогает инициировать дальнейшую подгрузку.
     */
    function nudgeNativeVideo(video, stats) {
        var current;
        var probe;
        var wasPaused;

        if (!video || !stats) return false;
        if (video.seeking) return false;
        if (stats.ahead < 2) return false;
        if (now() - session.last_nudge_at < NUDGE_COOLDOWN) return false;

        current = isFiniteNumber(video.currentTime) ? video.currentTime : 0;
        probe = Math.min(stats.range_end - 0.15, current + 0.05);

        if (!isFiniteNumber(probe) || probe <= current) return false;

        wasPaused = !!video.paused;
        session.last_nudge_at = now();

        try {
            video.currentTime = probe;

            setTimeout(function () {
                try {
                    video.currentTime = current;

                    if (!wasPaused && video.paused && typeof video.play === 'function') {
                        var promise = video.play();

                        if (promise && typeof promise.catch === 'function') {
                            promise.catch(function () {});
                        }
                    }
                }
                catch (e) {}
            }, 80);

            return true;
        }
        catch (e2) {
            return false;
        }
    }

    /*
     * Основной механизм "дожима" буфера.
     * Вызывается только тогда, когда буфер впереди действительно становится малым,
     * чтобы не создавать лишние запросы и не зацикливать загрузку.
     */
    function forceForwardBuffer(reason, stats) {
        var currentTime;
        var usedMethod = false;

        if (!session.video) return false;

        if (session.force_lock_until && now() < session.force_lock_until) return false;
        if (now() - session.last_force_at < FORCE_COOLDOWN) return false;

        session.last_force_at = now();
        session.force_lock_until = now() + 2500;
        currentTime = isFiniteNumber(session.video.currentTime) ? session.video.currentTime : 0;

        applyRuntimeSettings('force:' + reason);

        if (session.hls) {
            usedMethod = forceHlsLoad(session.hls, currentTime);
        }

        /*
         * Для чистого нативного video применяем только аккуратный fallback.
         * Если hls.js уже есть, обычно хватает startLoad и смены его config.
         */
        if (!usedMethod) {
            usedMethod = nudgeNativeVideo(session.video, stats);
        }

        log(
            'Форс буфера:',
            reason,
            'ahead=' + Math.round(stats.ahead) + 's',
            'target=' + Math.round(stats.target) + 's',
            session.hls ? 'mode=hls.js' : 'mode=native',
            usedMethod ? 'triggered' : 'noop'
        );

        setTimeout(function () {
            session.force_lock_until = 0;
            scheduleMonitor(250, 'after-force');
        }, 2500);

        return usedMethod;
    }

    /*
     * Главный анализатор состояния буфера.
     * Если вперёд осталось слишком мало секунд, а целевой буфер ещё далеко,
     * сразу инициируем следующую загрузку.
     */
    function monitorBuffer(reason) {
        var video = session.video;
        var stats;
        var threshold;

        if (!video) {
            attachToVideo(findBestVideo(), 'monitor:' + reason);
            video = session.video;
        }

        if (!video) return;

        /*
         * Если DOM уже заменил video на новый элемент, быстро переподключаемся.
         */
        try {
            if (document.body && !document.body.contains(video)) {
                attachToVideo(findBestVideo(), 'video-replaced:' + reason);
                video = session.video;
            }
        }
        catch (e) {}

        if (!video) return;

        if (session.source !== getVideoSource(video)) {
            attachToVideo(video, 'source-changed:' + reason);
            video = session.video;
        }

        session.hls = detectHlsForVideo(video);
        applyRuntimeSettings('monitor:' + reason);

        stats = getBufferStats(video);
        if (!stats) return;

        /*
         * Если видео почти закончилось, специально ничего не дожимаем:
         * нет смысла пытаться добуферизировать "пустоту" после конца файла.
         */
        if (isFiniteNumber(stats.remaining) && stats.remaining <= 65) return;

        /*
         * Если целевой буфер почти нулевой из-за близкого конца ролика,
         * тоже ничего дополнительно не делаем.
         */
        if (stats.target <= 0) return;

        threshold = getLowBufferThreshold(stats.target);

        /*
         * Ключевое условие:
         * когда буфера впереди осталось мало, мы немедленно инициируем продолжение загрузки.
         * Отдельно убеждаемся, что до желаемого размера ещё далеко.
         */
        if (stats.ahead <= threshold && stats.ahead < (stats.target - 10)) {
            forceForwardBuffer(reason, stats);
        }
    }

    /*
     * Лёгкое отложенное планирование monitorBuffer.
     * Это дешевле, чем запускать тяжёлую проверку на каждом timeupdate и progress подряд.
     */
    function scheduleMonitor(delay, reason) {
        if (session.monitor_pending) return;

        session.monitor_pending = true;

        setTimeout(function () {
            session.monitor_pending = false;
            monitorBuffer(reason || 'scheduled');
        }, typeof delay === 'number' ? delay : 150);
    }

    /*
     * Несколько отложенных попыток найти player после старта воспроизведения.
     * Это важно, потому что в Lampa video часто появляется не мгновенно, а через фазу подготовки UI.
     */
    function scheduleActivation(reason) {
        var delays = [80, 300, 900, 1800, 3500];
        var i;

        for (i = 0; i < delays.length; i++) {
            (function (delay) {
                setTimeout(function () {
                    hookHlsConstructor();
                    attachToVideo(findBestVideo(), reason + ':' + delay);
                }, delay);
            })(delays[i]);
        }
    }

    /*
     * Наблюдаем за DOM.
     * Когда в интерфейсе появляется новый video или перестраивается плеер,
     * запускаем повторный поиск активного video-элемента.
     */
    function startDomObserver() {
        if (state.dom_observer) return;
        if (typeof MutationObserver !== 'function') return;
        if (!document.body) return;

        state.dom_observer = new MutationObserver(function (mutations) {
            var shouldCheck = false;
            var i;
            var j;
            var nodes;

            for (i = 0; i < mutations.length; i++) {
                if (mutations[i].type === 'attributes' && mutations[i].target && mutations[i].target.tagName === 'VIDEO') {
                    shouldCheck = true;
                    break;
                }

                if (mutations[i].type === 'childList') {
                    nodes = mutations[i].addedNodes;

                    for (j = 0; j < nodes.length; j++) {
                        if (!nodes[j]) continue;

                        if ((nodes[j].tagName && nodes[j].tagName.toLowerCase() === 'video') ||
                            (nodes[j].querySelector && nodes[j].querySelector('video'))) {
                            shouldCheck = true;
                            break;
                        }
                    }
                }

                if (shouldCheck) break;
            }

            if (shouldCheck) {
                scheduleActivation('dom');
            }
        });

        state.dom_observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
        });
    }

    /*
     * Резервный периодический опрос.
     * Он нужен как fallback на случай нестандартных пересборок DOM или старых WebView,
     * где MutationObserver срабатывает не всегда так, как ожидается.
     */
    function startPoller() {
        if (state.poll_timer) return;

        state.poll_timer = setInterval(function () {
            hookHlsConstructor();
            attachToVideo(findBestVideo(), 'poll');
        }, 4000);
    }

    /*
     * Основной запуск плагина после готовности приложения.
     */
    function startPlugin() {
        if (state.started) return;
        if (!window.Lampa || !Lampa.Storage) return;

        state.started = true;

        ensureDefaultSetting();
        installSettings();
        hookHlsConstructor();
        hookPlayer();
        startDomObserver();
        startPoller();
        scheduleActivation('start');

        log('Плагин инициализирован. Текущий буфер:', getSelectedMinutes() + ' минут');
    }

    /*
     * Ожидаем появления Lampa и события готовности приложения.
     * Если app уже готов, запускаемся сразу.
     */
    function waitForLampa() {
        if (!window.Lampa || !Lampa.Listener || !Lampa.Storage) {
            setTimeout(waitForLampa, 500);
            return;
        }

        if (window.appready) {
            startPlugin();
        }
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e && e.type === 'ready') {
                    startPlugin();
                }
            });
        }
    }

    /*
     * Запускаем ожидание Lampa сразу после загрузки файла.
     */
    waitForLampa();

    /*
     * В конце файла тоже оставляем лог по требованию.
     * Он показывает, что скрипт успешно полностью распарсился.
     */
    console.log('[' + PLUGIN_NAME + '] v' + PLUGIN_VERSION + ' end');

})();
