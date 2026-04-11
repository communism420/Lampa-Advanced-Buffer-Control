/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         Advanced Buffer Control — «Умный большой буфер»     ║
 * ║         Плагин для Lampa (Android / Android TV)             ║
 * ║         Версия: 1.2.0                                       ║
 * ║         Совместимость: Lampa 2025–2026                      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Установка: Lampa → Настройки → Расширения → Добавить плагин
 */

(function () {
    'use strict';

    /* ─── Константы плагина ─────────────────────────────────── */
    var PLUGIN_NAME    = 'AdvancedBufferControl';
    var PLUGIN_VERSION = '1.2.0';
    var STORAGE_KEY    = 'adv_buffer_minutes';   // ключ в Lampa.Storage
    var DEFAULT_MINS   = 20;                      // значение по умолчанию (минут)
    var CHECK_INTERVAL = 5000;                    // интервал проверки буфера (мс)
    /** Порог остатка буфера: если впереди осталось меньше N секунд — начать подгрузку */
    var LOW_BUFFER_THRESHOLD = 50;               // секунд

    console.log('[' + PLUGIN_NAME + '] v' + PLUGIN_VERSION + ' — загрузка...');

    /* ─── Внутреннее состояние плагина ──────────────────────── */
    var state = {
        intervalId   : null,   // ID таймера мониторинга
        video        : null,   // ссылка на текущий <video>
        hls          : null,   // ссылка на текущий hls.js-экземпляр
        isLoading    : false,  // флаг: идёт ли принудительная подгрузка
        lastSeekTime : 0,      // метка времени последнего «форсированного» seek
        destroyed    : false   // флаг: плеер уже уничтожен
    };

    /* ─── Вспомогательные функции ───────────────────────────── */

    /**
     * Получить выбранный пользователем размер буфера в МИНУТАХ.
     * Если значение ещё не установлено — вернуть DEFAULT_MINS.
     */
    function getBufferMinutes() {
        var val = Lampa.Storage.get(STORAGE_KEY);
        var num = parseInt(val, 10);
        if (isNaN(num) || num <= 0) return DEFAULT_MINS;
        return Math.min(num, 40); // никогда не превышать 40 минут
    }

    /** Перевод минут в секунды */
    function toSec(mins) {
        return mins * 60;
    }

    /**
     * Определить, сколько секунд видео уже буферизировано
     * ВПЕРЁД от текущей позиции воспроизведения.
     * Проходим по диапазонам video.buffered и ищем диапазон,
     * содержащий currentTime.
     */
    function getBufferedAhead(video) {
        if (!video || !video.buffered || video.buffered.length === 0) return 0;
        var ct = video.currentTime;
        for (var i = 0; i < video.buffered.length; i++) {
            var start = video.buffered.start(i);
            var end   = video.buffered.end(i);
            if (ct >= start - 0.5 && ct <= end) {
                return end - ct; // секунды буфера впереди
            }
        }
        return 0;
    }

    /**
     * Применить настройки буфера к экземпляру hls.js.
     * Устанавливаем maxBufferLength и maxMaxBufferLength
     * в соответствии с выбранным пользователем значением.
     */
    function applyHlsConfig(hls, bufSec) {
        if (!hls || !hls.config) return;
        try {
            hls.config.maxBufferLength    = bufSec;
            hls.config.maxMaxBufferLength = bufSec;
            // maxBufferSize — в байтах; примерно 500 КБ на секунду 1080p HLS
            hls.config.maxBufferSize = bufSec * 500 * 1024;
            console.log('[' + PLUGIN_NAME + '] hls.config обновлён: maxBufferLength=' + bufSec + 'с');
        } catch (e) {
            console.warn('[' + PLUGIN_NAME + '] Ошибка применения hls.config:', e);
        }
    }

    /**
     * Принудительно запустить подгрузку через hls.js.
     * hls.startLoad(currentTime) заставляет hls.js начать/продолжить
     * загрузку сегментов начиная с указанной позиции.
     */
    function forceHlsLoad(hls, video) {
        if (!hls || !video) return;
        try {
            hls.startLoad(video.currentTime);
            console.log('[' + PLUGIN_NAME + '] hls.startLoad() вызван для подгрузки буфера');
        } catch (e) {
            console.warn('[' + PLUGIN_NAME + '] Ошибка hls.startLoad():', e);
        }
    }

    /**
     * Форсированная подгрузка для нативного <video> (без hls.js).
     * Делаем «призрачный» seek: чуть вперёд, затем обратно.
     * Это вынуждает браузер/WebView начать буферизацию вперёд.
     * Throttle: не чаще чем раз в 3 секунды, чтобы не спамить.
     */
    function forceNativeLoad(video) {
        if (!video) return;
        var now = Date.now();
        if (now - state.lastSeekTime < 3000) return; // throttle
        state.lastSeekTime = now;

        var ct = video.currentTime;
        var probePos = ct + 2; // seek на 2 секунды вперёд
        if (probePos >= (video.duration || Infinity)) return;

        var paused = video.paused;
        try {
            video.currentTime = probePos;
            // Немедленно возвращаемся обратно
            setTimeout(function () {
                if (video && !state.destroyed) {
                    video.currentTime = ct;
                    if (!paused) video.play().catch(function () {});
                }
            }, 50);
            console.log('[' + PLUGIN_NAME + '] Native seek-probe выполнен для подгрузки');
        } catch (e) {
            console.warn('[' + PLUGIN_NAME + '] Ошибка native seek-probe:', e);
        }
    }

    /* ─── Основной цикл мониторинга буфера ─────────────────── */

    /**
     * Периодически проверяет состояние буфера.
     * Если буфера впереди меньше LOW_BUFFER_THRESHOLD секунд
     * и видео ещё не закончилось — запускает подгрузку.
     */
    function startMonitoring() {
        stopMonitoring(); // сначала сбросить предыдущий таймер

        state.intervalId = setInterval(function () {
            // Проверки безопасности
            if (state.destroyed) {
                stopMonitoring();
                return;
            }

            var video = state.video;
            var hls   = state.hls;

            if (!video) return;

            // Если видео уже закончилось — ничего не делаем
            var duration = video.duration || 0;
            if (duration > 0 && video.currentTime >= duration - 1) return;

            var bufferedAhead = getBufferedAhead(video);
            var bufferTarget  = toSec(getBufferMinutes());

            console.log('[' + PLUGIN_NAME + '] Буфер впереди: ' +
                Math.round(bufferedAhead) + 'с / цель: ' + bufferTarget + 'с');

            // Если буфера впереди меньше порогового значения — подгружаем
            if (bufferedAhead < LOW_BUFFER_THRESHOLD) {
                if (hls) {
                    // Для hls.js: убеждаемся, что конфиг актуален, и запускаем загрузку
                    applyHlsConfig(hls, bufferTarget);
                    forceHlsLoad(hls, video);
                } else {
                    // Для нативного видео: делаем seek-probe
                    forceNativeLoad(video);
                }
            } else if (hls && bufferedAhead < bufferTarget - 10) {
                // Буфер есть, но до целевого значения ещё далеко —
                // убеждаемся, что hls.js знает о нашем лимите и продолжает грузить
                applyHlsConfig(hls, bufferTarget);
                forceHlsLoad(hls, video);
            }

        }, CHECK_INTERVAL);

        console.log('[' + PLUGIN_NAME + '] Мониторинг буфера запущен (интервал ' + CHECK_INTERVAL + 'мс)');
    }

    /** Остановить таймер мониторинга */
    function stopMonitoring() {
        if (state.intervalId !== null) {
            clearInterval(state.intervalId);
            state.intervalId = null;
            console.log('[' + PLUGIN_NAME + '] Мониторинг буфера остановлен');
        }
    }

    /* ─── Инициализация для конкретного запуска видео ────────── */

    /**
     * Вызывается, когда плеер Lampa открыл видео.
     * Ищем <video> и hls-экземпляр, применяем начальную конфигурацию
     * и запускаем мониторинг.
     */
    function onPlayerReady() {
        // Сброс предыдущего состояния
        destroySession();

        state.destroyed = false;

        var bufSec = toSec(getBufferMinutes());

        // ── 1. Получить ссылку на <video> элемент ──
        // Lampa обычно создаёт один <video> на всю страницу
        state.video = document.querySelector('video');

        if (!state.video) {
            // Подождём немного — плеер мог ещё не вставить элемент в DOM
            setTimeout(function () {
                state.video = document.querySelector('video');
                if (state.video) {
                    initSession(bufSec);
                } else {
                    console.warn('[' + PLUGIN_NAME + '] <video> не найден, пропуск сессии');
                }
            }, 1500);
            return;
        }

        initSession(bufSec);
    }

    /**
     * Финальная инициализация после того, как <video> найден.
     */
    function initSession(bufSec) {
        // ── 2. Получить hls.js (если используется) ──
        // Lampa хранит hls-экземпляр в window.hls или внутри объекта плеера
        state.hls = window.hls || null;

        // Дополнительная попытка найти hls через Lampa.Player
        if (!state.hls) {
            try {
                var lp = Lampa.Player;
                if (lp && lp.hls) state.hls = lp.hls;
            } catch (e) { /* нет доступа — ничего страшного */ }
        }

        if (state.hls) {
            console.log('[' + PLUGIN_NAME + '] Обнаружен hls.js, применяем конфиг буфера');
            applyHlsConfig(state.hls, bufSec);
        } else {
            console.log('[' + PLUGIN_NAME + '] hls.js не обнаружен, используем нативный <video>');
        }

        // ── 3. Слушаем событие 'canplay' — к этому моменту видео точно готово ──
        state.video.addEventListener('canplay', onVideoCanPlay, { once: true });

        // ── 4. Запускаем периодический мониторинг ──
        startMonitoring();
    }

    /**
     * Видео готово к воспроизведению — принудительно запускаем первую подгрузку.
     */
    function onVideoCanPlay() {
        console.log('[' + PLUGIN_NAME + '] canplay: запуск первоначальной подгрузки');
        var bufSec = toSec(getBufferMinutes());
        if (state.hls) {
            applyHlsConfig(state.hls, bufSec);
            forceHlsLoad(state.hls, state.video);
        }
    }

    /**
     * Завершить текущую сессию: остановить мониторинг, очистить ссылки.
     */
    function destroySession() {
        state.destroyed = true;
        stopMonitoring();
        state.video      = null;
        state.hls        = null;
        state.isLoading  = false;
        state.lastSeekTime = 0;
    }

    /* ─── Регистрация настройки в меню Lampa ─────────────────── */

    /**
     * Добавляет пункт «Максимальный размер буфера видео»
     * в раздел настроек Lampa.
     * Используем Lampa.Settings.add() — стандартный способ
     * для плагинов Lampa 2024+.
     */
    function registerSettings() {
        // Проверяем наличие API настроек
        if (!Lampa.Settings || typeof Lampa.Settings.add !== 'function') {
            console.warn('[' + PLUGIN_NAME + '] Lampa.Settings.add недоступен — настройка пропущена');
            return;
        }

        Lampa.Settings.add(STORAGE_KEY, {
            name       : 'Максимальный размер буфера видео',
            description: 'Сколько минут видео заранее буферизировать (до 40 минут)',
            type       : 'select',
            values     : {
                '5' : '5 минут',
                '10': '10 минут',
                '15': '15 минут',
                '20': '20 минут (по умолчанию)',
                '25': '25 минут',
                '30': '30 минут',
                '35': '35 минут',
                '40': '40 минут (максимум)'
            },
            default    : String(DEFAULT_MINS),
            onChange   : function (value) {
                // Если настройка изменилась прямо во время просмотра —
                // применяем новое значение немедленно
                console.log('[' + PLUGIN_NAME + '] Буфер изменён на ' + value + ' мин');
                if (state.hls) {
                    applyHlsConfig(state.hls, toSec(parseInt(value, 10)));
                    forceHlsLoad(state.hls, state.video);
                }
            }
        });

        console.log('[' + PLUGIN_NAME + '] Настройка зарегистрирована в Lampa.Settings');
    }

    /* ─── Подписка на события плеера Lampa ──────────────────── */

    /**
     * Lampa использует глобальную шину событий Lampa.Listener.
     * Нас интересуют события жизненного цикла плеера.
     *
     * Основные события:
     *   player_start   — плеер открылся и начал воспроизведение
     *   player_stop    — плеер закрыт (пользователь вышел)
     *   player_destroy — плеер уничтожен
     *
     * В разных версиях Lampa имена могут немного отличаться,
     * поэтому подписываемся на несколько вариантов.
     */
    function subscribeToPlayerEvents() {
        // Ждём полной инициализации приложения
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') {
                // Приложение готово — регистрируем настройку
                registerSettings();
            }
        });

        // ── События плеера ──
        Lampa.Listener.follow('player', function (event) {
            var type = event.type;

            if (
                type === 'start'   ||   // плеер стартовал
                type === 'play'    ||   // нажата кнопка «воспроизвести»
                type === 'playing'      // видео реально началось
            ) {
                // Небольшая задержка, чтобы hls.js успел инициализироваться
                setTimeout(onPlayerReady, 800);
            }

            if (
                type === 'destroy' ||
                type === 'stop'    ||
                type === 'end'
            ) {
                // Плеер закрыт — освобождаем ресурсы
                destroySession();
            }
        });

        console.log('[' + PLUGIN_NAME + '] Подписка на события плеера установлена');
    }

    /* ─── Точка входа плагина ────────────────────────────────── */

    /**
     * Проверяем доступность Lampa API и запускаем плагин.
     * Если API ещё не загружен — ждём события DOMContentLoaded.
     */
    function bootstrap() {
        if (typeof Lampa === 'undefined' || !Lampa.Listener) {
            // Lampa ещё не загружена — подождём
            document.addEventListener('DOMContentLoaded', function () {
                if (typeof Lampa !== 'undefined') {
                    subscribeToPlayerEvents();
                } else {
                    console.error('[' + PLUGIN_NAME + '] Lampa API не обнаружен!');
                }
            });
        } else {
            subscribeToPlayerEvents();
        }
    }

    // ── Запуск ──
    bootstrap();

    console.log('[' + PLUGIN_NAME + '] v' + PLUGIN_VERSION + ' — плагин инициализирован ✓');

})();
