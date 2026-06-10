/*
 * Advanced Buffer Control / Умный большой буфер
* Версия: 1.2.0
 *
 * Эта версия делает только то, что реально безопасно на Android / Android TV:
 * - добавляет переключатели в существующий раздел настроек плеера;
 * - если плагин включён, то старается заполнять буфер не только для HLS, но и для обычного video-воспроизведения;
 * - предел определяется автоматически по non-fatal ошибкам bufferFullError / bufferAppendingError;
 * - найденный предел запоминается в Storage и используется на следующих запусках;
 * - при стабильном воспроизведении плагин понемногу пробует поднять предел выше, чтобы адаптироваться под конкретное устройство.
 *
 * Важно:
 * - никакого кастомного fLoader здесь нет;
 * - никакого внешнего кэша сегментов здесь нет;
 * - значит, здесь нет рекурсии и нет проблем вида "Maximum call stack size exceeded".
 */
(function () {
    'use strict';

console.log('[Advanced Buffer Control] v1.2.0: file begin');

    // Защита от повторной инициализации.
    if (window.advanced_buffer_control_plugin_ready_v1) {
    console.log('[Advanced Buffer Control] v1.2.0: already initialized');
    console.log('[Advanced Buffer Control] v1.2.0: file end');
        return;
    }

    window.advanced_buffer_control_plugin_ready_v1 = true;

    // Основные идентификаторы плагина и ключи Storage.
    var PLUGIN_NAME = 'Advanced Buffer Control';
var PLUGIN_VERSION = '1.2.0';
    var ENABLED_KEY = 'advanced_buffer_control_enabled';
    var LEARNED_LIMIT_KEY = 'advanced_buffer_control_learned_limit_sec';
    var LEARNED_LIMIT_MIGRATION_KEY = 'advanced_buffer_control_learned_limit_migration_v120';
    var MENU_TEXT = {
        enabled_name: {
            ru: 'Умное заполнение буфера',
            en: 'Smart Buffer Fill'
        },
        enabled_description: {
            ru: 'Автоматически заполнять буфер до фактического предела устройства',
            en: 'Automatically fill the buffer up to the actual device limit'
        }
    };

    // Значения по умолчанию и безопасные пределы.
    var ENABLED_DEFAULT = true;
    var MIN_TARGET_SEC = 15;
    var DISCOVERY_START_SEC = 480;
    var ABSOLUTE_MAX_SEC = 900;
    var SAFE_MARGIN_AFTER_ERROR_SEC = 15;
    var SUSPICIOUS_LEARNED_LIMIT_SEC = 60;
    var PROBE_STEP_SEC = 30;
    var PROBE_MARGIN_SEC = 20;
    var LOW_BUFFER_THRESHOLD_SEC = 55;
    var WATCHDOG_INTERVAL = 2000;
    var STARTLOAD_COOLDOWN = 7000;
    var HLS_KEEPER_COOLDOWN_MS = 1500;
    var HLS_KEEPER_TARGET_MARGIN_SEC = 5;
    var HLS_KEEPER_STALLED_MS = 10000;
    var HLS_KEEPER_STOPSTART_COOLDOWN_MS = 12000;
    var HLS_KEEPER_LOG_INTERVAL_MS = 15000;
    var HLS_KEEPER_LEVEL_DOWN_STALLS = 2;
    var HLS_KEEPER_LEVEL_RESTORE_PROGRESS_COUNT = 4;
    var BACK_BUFFER_KEEP_SEC = 20;
    var BACK_BUFFER_LEARN_POSTPONE_MAX = 1;
    var NATIVE_LOW_BUFFER_THRESHOLD_SEC = 18;
    var NATIVE_CRITICAL_BUFFER_SEC = 6;
    var NATIVE_KICK_COOLDOWN_MS = 12000;
    var NATIVE_KICK_RETURN_MS = 80;
    var NATIVE_KICK_FORWARD_SEC = 0.6;
    var NATIVE_PROGRESS_GRACE_MS = 2500;
    var STALL_PREDICTOR_HOLD_MS = 30000;
    var STALL_PREDICTOR_ACTION_COOLDOWN_MS = 5000;
    var STALL_SIGNAL_WINDOW_MS = 15000;
    var HLS_LOW_LEARNED_LIMIT_HOLD_MS = 120000;
    var HLS_CEILING_EXPAND_INTERVAL_MS = 5000;
    var HLS_CEILING_EXPAND_MARGIN_SEC = 8;
    var HLS_BUFFER_CONFIG_FIELDS = [
        'maxBufferLength',
        'maxMaxBufferLength',
        'maxBufferSize',
        'backBufferLength',
        'liveBackBufferLength',
        'lowLatencyMode'
    ];
    var LIVE_LIKE_FLAG = '__advancedBufferLiveLike';
    var VOD_LIKE_FLAG = '__advancedBufferVodLike';

    // Общее состояние плагина.
    var state = {
        hlsPatched: false,
        originalHlsDefaults: null,
        defaultHlsDefaultsBeforeApply: null,
        defaultConfigApplied: false,
        lastHls: null,
        currentSession: null,
        errorCleanerBound: false,
        startToken: 0
    };

    // Единый логгер.
    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Advanced Buffer Control]');
        console.log.apply(console, args);
    }

    // Единый warn.
    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Advanced Buffer Control]');
        console.warn.apply(console, args);
    }

    function getMenuLanguageCode() {
        var lang = 'en';

        try {
            if (Lampa && Lampa.Storage && typeof Lampa.Storage.get === 'function') {
                lang = String(Lampa.Storage.get('language', 'en') || 'en').toLowerCase();
            }
        } catch (e) {
            lang = 'en';
        }

        return lang === 'ru' ? 'ru' : 'en';
    }

    function getMenuText(key) {
        var code = getMenuLanguageCode();
        var text = MENU_TEXT[key] || {};

        return text[code] || text.en || '';
    }

    function createLocalizedField(nameKey, descriptionKey) {
        var field = {};

        Object.defineProperty(field, 'name', {
            configurable: true,
            enumerable: true,
            get: function () {
                return getMenuText(nameKey);
            }
        });

        Object.defineProperty(field, 'description', {
            configurable: true,
            enumerable: true,
            get: function () {
                return getMenuText(descriptionKey);
            }
        });

        return field;
    }

    // Безопасно приводим значение к числу.
    function toNumber(value, fallback) {
        var num = parseFloat(value);
        return isFinite(num) ? num : fallback;
    }

    // Округляем секунды до шага 15 секунд, чтобы limit в Storage не прыгал хаотично.
    function roundToSafeStep(seconds) {
        seconds = Math.round(seconds / 15) * 15;
        if (seconds < MIN_TARGET_SEC) seconds = MIN_TARGET_SEC;
        if (seconds > ABSOLUTE_MAX_SEC) seconds = ABSOLUTE_MAX_SEC;
        return seconds;
    }

    // Текущий статус переключателя.
    function isPluginEnabled() {
        var value;

        try {
            value = Lampa.Storage.get(ENABLED_KEY, ENABLED_DEFAULT);
        } catch (e) {
            value = ENABLED_DEFAULT;
        }

        return String(value) === 'true';
    }

    // Проверяем, включён ли основной функционал плагина.
    function isAnyFeatureEnabled() {
        return isPluginEnabled();
    }

    // Читаем запомненный безопасный предел устройства.
    function getLearnedLimitSec() {
        var value;

        try {
            value = toNumber(Lampa.Storage.get(LEARNED_LIMIT_KEY, 0), 0);
        } catch (e) {
            value = 0;
        }

        if (!isFinite(value) || value < MIN_TARGET_SEC) return 0;
        if (value > ABSOLUTE_MAX_SEC) value = ABSOLUTE_MAX_SEC;

        return roundToSafeStep(value);
    }

    // Сохраняем найденный безопасный предел.
    function saveLearnedLimitSec(seconds) {
        seconds = roundToSafeStep(seconds);

        try {
            Lampa.Storage.set(LEARNED_LIMIT_KEY, String(seconds));
        } catch (e) {
            warn('failed to save learned limit', e);
        }
    }

    // Стартовый target для новой сессии.
    function getInitialTargetSec() {
        var learned = getLearnedLimitSec();
        return learned || DISCOVERY_START_SEC;
    }

    // Проверка, что URL — это HLS m3u8.
    function isM3U8Url(url) {
        url = String(url || '');
        return /\.m3u8($|\?|#)/i.test(url);
    }

    function getPlayDataUrl(playData) {
        if (!playData) return '';
        return String(playData.url || playData.src || playData.file || playData.link || '');
    }

    function isLiveLikeUrl(url) {
        var text;

        url = String(url || '');
        if (!url) return false;

        try {
            text = decodeURIComponent(url);
        } catch (e) {
            text = url;
        }

        text = text.toLowerCase();

        return /(^|[?&#])(live|is_live|iptv|tv|channel|ch)=(1|true|yes|on)($|[&#])/i.test(text) ||
            /(^|[?&#])(type|mode|playlist)=live($|[&#])/i.test(text) ||
            /(^|\/)(live|iptv|tv|channels?|broadcast)(\/|$)/i.test(text);
    }

    function isHlsPlayData(playData) {
        return isM3U8Url(getPlayDataUrl(playData));
    }

    function hasFinitePlayDataDuration(playData) {
        var value;

        if (!playData) return false;

        value = toNumber(playData.duration, 0) ||
            toNumber(playData.runtime, 0) ||
            toNumber(playData.length, 0);

        return isFinite(value) && value > 0;
    }

    function markPlayDataFlag(playData, key) {
        if (!playData) return;

        try {
            Object.defineProperty(playData, key, {
                configurable: true,
                enumerable: false,
                writable: true,
                value: true
            });
        } catch (e) {
            try {
                playData[key] = true;
            } catch (e2) {
                // Некоторые host-объекты могут быть readonly.
            }
        }
    }

    function markPlayDataLiveLike(playData, reason) {
        if (!playData || playData[LIVE_LIKE_FLAG]) return false;

        markPlayDataFlag(playData, LIVE_LIKE_FLAG);

        try {
            if (playData[VOD_LIKE_FLAG]) playData[VOD_LIKE_FLAG] = false;
        } catch (e) {
            // Не критично.
        }

        log('live HLS detected, buffering disabled, reason =', reason || 'unknown');
        return true;
    }

    function markPlayDataVodLike(playData, reason) {
        if (!playData || playData[LIVE_LIKE_FLAG] || playData[VOD_LIKE_FLAG]) return false;

        markPlayDataFlag(playData, VOD_LIKE_FLAG);
        log('VOD HLS detected, buffering enabled, reason =', reason || 'unknown');
        return true;
    }

    function isLiveLikePlayData(playData) {
        if (!playData) return false;

        return !!(
            playData[LIVE_LIKE_FLAG] ||
            playData.iptv ||
            playData.tv ||
            playData.live ||
            playData.need_check_live_stream ||
            playData.channel ||
            isLiveLikeUrl(getPlayDataUrl(playData))
        );
    }

    function shouldUseBufferingForPlayData(playData) {
        if (!isPluginEnabled() || !playData || isLiveLikePlayData(playData)) return false;
        if (isHlsPlayData(playData) && !playData[VOD_LIKE_FLAG] && !hasFinitePlayDataDuration(playData)) return false;

        return true;
    }

    function shouldForceHlsJsForPlayData(playData) {
        return isPluginEnabled() && !!playData && !isLiveLikePlayData(playData);
    }

    // Инициализируем дефолтные значения Storage.
    function normalizeStorage() {
        var storedMigration;
        var storedLimit;

        try {
            if (Lampa.Storage.get(ENABLED_KEY, null) === null) {
                Lampa.Storage.set(ENABLED_KEY, ENABLED_DEFAULT);
            }
        } catch (e) {
            warn('failed to normalize enabled flag', e);
        }

        try {
            storedMigration = String(Lampa.Storage.get(LEARNED_LIMIT_MIGRATION_KEY, '') || '');
            storedLimit = toNumber(Lampa.Storage.get(LEARNED_LIMIT_KEY, 0), 0);

            if (storedMigration !== PLUGIN_VERSION) {
                if (storedLimit > 0 && storedLimit < SUSPICIOUS_LEARNED_LIMIT_SEC) {
                    Lampa.Storage.set(LEARNED_LIMIT_KEY, '0');
                    log('old suspicious learned buffer limit reset =', storedLimit, 'sec');
                }

                Lampa.Storage.set(LEARNED_LIMIT_MIGRATION_KEY, PLUGIN_VERSION);
            }
        } catch (e2) {
            warn('failed to migrate learned limit', e2);
        }

        try {
            var learned = getLearnedLimitSec();

            if (learned > 0) {
                Lampa.Storage.set(LEARNED_LIMIT_KEY, String(learned));
            }
        } catch (e3) {
            warn('failed to normalize learned limit', e3);
        }
    }

    // Добавляем параметры прямо в существующий раздел настроек плеера.
    function registerSettings() {
        if (!Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam) {
            warn('SettingsApi is not available, settings registration skipped');
            return;
        }

        normalizeStorage();

        Lampa.SettingsApi.addParam({
            component: 'player',
            param: {
                name: ENABLED_KEY,
                type: 'trigger',
                default: ENABLED_DEFAULT
            },
            field: createLocalizedField('enabled_name', 'enabled_description'),
            onChange: function (value) {
                var enabled = String(value) === 'true';

                if (!enabled) {
                    state.startToken += 1;
                    destroyCurrentSession();
                }

                applyDefaultHlsConfig(window.Hls, state.currentSession && state.currentSession.playData);
                syncCurrentSession('settings-change');
            }
        });
    }

    function readHlsBufferConfig(source) {
        var result = {};

        if (!source) return result;

        HLS_BUFFER_CONFIG_FIELDS.forEach(function (key) {
            result[key] = source[key];
        });

        return result;
    }

    function writeHlsBufferConfig(target, values) {
        if (!target || !values) return;

        HLS_BUFFER_CONFIG_FIELDS.forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                target[key] = values[key];
            }
        });
    }

    // Сохраняем оригинальные дефолты hls.js, чтобы уметь корректно отключать плагин.
    function captureOriginalHlsDefaults(HlsCtor) {
        if (!HlsCtor || !HlsCtor.DefaultConfig) return;
        if (state.originalHlsDefaults) return;

        state.originalHlsDefaults = readHlsBufferConfig(HlsCtor.DefaultConfig);
    }

    // Вычисляем лимит по байтам так, чтобы hls.js не упирался в слишком маленький maxBufferSize раньше времени.
    function getBufferSizeBytesForTarget(seconds) {
        var estimated = Math.round(seconds * 900000);
        var minBytes = 64 * 1024 * 1024;
        var maxBytes = 512 * 1024 * 1024;

        if (estimated < minBytes) estimated = minBytes;
        if (estimated > maxBytes) estimated = maxBytes;

        return estimated;
    }

    // Возвращаем текущий желаемый target в секундах.
    // Если есть живая сессия, приоритет у её target.
    function getCurrentDesiredTargetSec(session) {
        if (session && session.targetSec) return session.targetSec;
        return getInitialTargetSec();
    }

    function getEffectiveHlsTargetSec(session) {
        var target = getCurrentDesiredTargetSec(session);
        var now = Date.now();

        if (session && session.hls && target < DISCOVERY_START_SEC) {
            if (!session.lastBufferErrorAt || now - session.lastBufferErrorAt >= HLS_LOW_LEARNED_LIMIT_HOLD_MS) {
                target = DISCOVERY_START_SEC;
            }
        }

        return roundToSafeStep(target);
    }

    function getPreferredHlsFillTargetSec(session) {
        var target = getCurrentDesiredTargetSec(session);

        if (target < DISCOVERY_START_SEC) target = DISCOVERY_START_SEC;
        if (target > ABSOLUTE_MAX_SEC) target = ABSOLUTE_MAX_SEC;

        return roundToSafeStep(target);
    }

    // Применяем дефолтный конфиг hls.js в зависимости от статуса переключателя.
    function applyDefaultHlsConfig(HlsCtor, playData) {
        var targetSec;
        var shouldApply;

        if (!HlsCtor || !HlsCtor.DefaultConfig) return;

        captureOriginalHlsDefaults(HlsCtor);

        try {
            shouldApply = shouldUseBufferingForPlayData(playData);

            if (!shouldApply) {
                if (state.defaultConfigApplied) {
                    writeHlsBufferConfig(HlsCtor.DefaultConfig, state.defaultHlsDefaultsBeforeApply || state.originalHlsDefaults);
                    state.defaultConfigApplied = false;
                    state.defaultHlsDefaultsBeforeApply = null;
                }
                return;
            }

            if (!state.defaultConfigApplied) {
                state.defaultHlsDefaultsBeforeApply = readHlsBufferConfig(HlsCtor.DefaultConfig);
            }

            targetSec = getEffectiveHlsTargetSec(
                state.currentSession && state.currentSession.playData === playData ? state.currentSession : null
            );

            HlsCtor.DefaultConfig.maxBufferLength = targetSec;
            HlsCtor.DefaultConfig.maxMaxBufferLength = targetSec;
            HlsCtor.DefaultConfig.maxBufferSize = getBufferSizeBytesForTarget(targetSec);
            HlsCtor.DefaultConfig.backBufferLength = BACK_BUFFER_KEEP_SEC;
            HlsCtor.DefaultConfig.liveBackBufferLength = BACK_BUFFER_KEEP_SEC;
            HlsCtor.DefaultConfig.lowLatencyMode = false;
            state.defaultConfigApplied = true;
        } catch (e) {
            warn('failed to apply Hls.DefaultConfig', e);
        }
    }

    // Применяем те же настройки к уже созданному экземпляру hls.js.
    function applyHlsRuntimeConfig(hls, session) {
        var targetSec;
        var shouldApply;
        var fallbackConfig;

        if (!hls || !hls.config) return;

        captureOriginalHlsDefaults(window.Hls);

        try {
            shouldApply = shouldUseBufferingForPlayData(session && session.playData);

            if (!shouldApply) {
                fallbackConfig = hls.__advancedBufferRuntimeConfig || state.defaultHlsDefaultsBeforeApply || state.originalHlsDefaults;
                writeHlsBufferConfig(hls.config, fallbackConfig);
                return;
            }

            if (!hls.__advancedBufferRuntimeConfig) {
                hls.__advancedBufferRuntimeConfig = state.defaultHlsDefaultsBeforeApply || readHlsBufferConfig(hls.config);
            }

            targetSec = getEffectiveHlsTargetSec(session);

            hls.config.maxBufferLength = targetSec;
            hls.config.maxMaxBufferLength = targetSec;
            hls.config.maxBufferSize = getBufferSizeBytesForTarget(targetSec);
            hls.config.backBufferLength = BACK_BUFFER_KEEP_SEC;
            hls.config.liveBackBufferLength = BACK_BUFFER_KEEP_SEC;
            hls.config.lowLatencyMode = false;
        } catch (e) {
            warn('failed to apply HLS runtime config', e);
        }
    }

    // Прячем назойливые non-fatal buffer errors из инфо плеера.
    function bindBufferErrorCleaner() {
        if (state.errorCleanerBound) return;
        if (!Lampa || !Lampa.PlayerVideo || !Lampa.PlayerVideo.listener || !Lampa.PlayerVideo.listener.follow) return;

        Lampa.PlayerVideo.listener.follow('error', function (e) {
            var text;

            text = String(e.error || '');

            if (!isPluginEnabled()) return;
            if (!e || e.fatal) return;

            if (text.indexOf('bufferFullError') >= 0 || text.indexOf('bufferAppendingError') >= 0) {
                setTimeout(function () {
                    try {
                        $('.player-info__error').addClass('hide').text('');
                    } catch (err) {
                        // Ничего страшного, если элемента нет.
                    }
                }, 0);
            }
        });

        state.errorCleanerBound = true;
    }

    // Патчим только attachMedia/loadSource/destroy у Hls.
    // Конструктор Hls НЕ трогаем, чтобы избежать рекурсии.
    function ensureHlsPatched(playData) {
        var OriginalHls;
        var originalAttachMedia;
        var originalLoadSource;
        var originalDestroy;

        if (state.hlsPatched) {
            applyDefaultHlsConfig(window.Hls, playData);
            return true;
        }
        if (typeof window.Hls === 'undefined') return false;

        OriginalHls = window.Hls;

        captureOriginalHlsDefaults(OriginalHls);

        if (OriginalHls.prototype && !OriginalHls.prototype.__advancedBufferAttachPatched) {
            originalAttachMedia = OriginalHls.prototype.attachMedia;

            OriginalHls.prototype.attachMedia = function (media) {
                var result = originalAttachMedia.apply(this, arguments);

                try {
                    if (media) {
                        media.__advancedBufferHls = this;
                    }

                    window.__advancedBufferLastHls = this;
                    state.lastHls = this;

                    if (state.currentSession) {
                        state.currentSession.video = media || state.currentSession.video;
                        state.currentSession.hls = this;
                        bindHlsEvents(state.currentSession);
                        syncHlsPlaylistTypeFromState(state.currentSession, 'attach-media');

                        if (shouldUseBufferingForPlayData(state.currentSession.playData)) {
                            applyHlsRuntimeConfig(this, state.currentSession);
                        }
                    }
                } catch (e) {
                    warn('attachMedia patch failed', e);
                }

                return result;
            };

            OriginalHls.prototype.__advancedBufferAttachPatched = true;
        }

        if (OriginalHls.prototype && !OriginalHls.prototype.__advancedBufferLoadSourcePatched && typeof OriginalHls.prototype.loadSource === 'function') {
            originalLoadSource = OriginalHls.prototype.loadSource;

            OriginalHls.prototype.loadSource = function () {
                try {
                    window.__advancedBufferLastHls = this;
                    state.lastHls = this;

                    if (state.currentSession) {
                        state.currentSession.hls = this;
                        bindHlsEvents(state.currentSession);
                        syncHlsPlaylistTypeFromState(state.currentSession, 'load-source');

                        if (shouldUseBufferingForPlayData(state.currentSession.playData)) {
                            applyHlsRuntimeConfig(this, state.currentSession);
                        }
                    }
                } catch (e) {
                    warn('loadSource patch failed', e);
                }

                return originalLoadSource.apply(this, arguments);
            };

            OriginalHls.prototype.__advancedBufferLoadSourcePatched = true;
        }

        if (OriginalHls.prototype && !OriginalHls.prototype.__advancedBufferDestroyPatched) {
            originalDestroy = OriginalHls.prototype.destroy;

            OriginalHls.prototype.destroy = function () {
                try {
                    var media = this.media || this._media;

                    if (media && media.__advancedBufferHls === this) {
                        delete media.__advancedBufferHls;
                    }

                    if (window.__advancedBufferLastHls === this) {
                        window.__advancedBufferLastHls = null;
                    }

                    if (state.lastHls === this) {
                        state.lastHls = null;
                    }
                } catch (e) {
                    warn('destroy patch cleanup failed', e);
                }

                return originalDestroy.apply(this, arguments);
            };

            OriginalHls.prototype.__advancedBufferDestroyPatched = true;
        }

        state.hlsPatched = true;
        applyDefaultHlsConfig(window.Hls, playData);
        log('Hls patched successfully');
        return true;
    }

    // Получаем текущее video через API Lampa или DOM fallback.
    function getCurrentVideo() {
        try {
            if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.video === 'function') {
                return Lampa.PlayerVideo.video();
            }
        } catch (e) {
            warn('failed to read PlayerVideo.video()', e);
        }

        try {
            return document.querySelector('.player video') || document.querySelector('video');
        } catch (e2) {
            return null;
        }
    }

    // Ищем hls.js, привязанный к активному video.
    function getCurrentHls(video) {
        var candidates = [];
        var i;

        if (video && video.__advancedBufferHls) candidates.push(video.__advancedBufferHls);
        if (window.__advancedBufferLastHls) candidates.push(window.__advancedBufferLastHls);
        if (state.lastHls) candidates.push(state.lastHls);
        if (window.hls) candidates.push(window.hls);

        for (i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            var media;

            if (!candidate || typeof candidate.startLoad !== 'function') continue;

            media = candidate.media || candidate._media || null;

            if (!video || !media || media === video) {
                return candidate;
            }
        }

        return null;
    }

    // Приводим нативный video к максимально "буферизующему" режиму.
    function prepareVideoElement(video) {
        if (!video) return;

        try {
            video.preload = 'auto';
            video.setAttribute('preload', 'auto');
        } catch (e) {
            // Не критично.
        }
    }

    // Безопасный запуск воспроизведения без лишних ошибок в консоли.
    function safePlay(video) {
        var playPromise;

        if (!video || typeof video.play !== 'function') return;

        try {
            playPromise = video.play();

            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch(function () {});
            }
        } catch (e) {
            // Не критично, браузер сам решит, можно ли стартовать autoplay.
        }
    }

    // Пытаемся вернуть сохранённую позицию воспроизведения.
    function restoreCurrentTime(video, time) {
        if (!video || !isFinite(time) || time < 0) return;

        try {
            if (Math.abs(toNumber(video.currentTime, 0) - time) > 0.25) {
                video.currentTime = time;
            }
        } catch (e) {
            // На ранней стадии loadedmetadata seek может быть недоступен.
        }
    }

    // Нормализуем сессию для текущего запуска плеера.
    function ensureSession(playData) {
        if (!state.currentSession || state.currentSession.destroyed) {
            state.currentSession = {
                playData: playData || {},
                video: null,
                hls: null,
                handlers: null,
                watchdog: null,
                destroyed: false,
                targetSec: getInitialTargetSec(),
                lastStartLoadAt: 0,
                lastProbeAt: 0,
                lastBufferErrorAt: 0,
                backBufferFlushPostpones: 0,
                backBufferFlushTargetSec: 0,
                lastBackBufferFlushAt: 0,
                lastBackBufferFlushEndOffset: 0,
                observedMaxAhead: 0,
                lastBufferInfo: { ahead: 0, end: 0 },
                predictorLastAt: 0,
                predictorLastAhead: 0,
                predictorLastEnd: 0,
                predictorLastCurrent: 0,
                predictorRiskScore: 0,
                predictorHoldProbeUntil: 0,
                predictorLastActionAt: 0,
                stallSignalCount: 0,
                lastStallSignalAt: 0,
                limitLearnedThisSession: false,
                hlsBound: null,
                hlsHandlers: null,
                bound: false,
                boundVideo: null,
                lastStablePlaybackAt: 0,
                nativeKickInProgress: false,
                nativeKickReturnTo: null,
                nativeKickHadOwnRewind: false,
                nativeKickPreviousRewind: undefined,
                lastNativeKickAt: 0,
                lastNativeProgressAt: 0,
                nativeKickReturnTimer: null,
                nativeKickReleaseTimer: null,
                lastHlsKeeperAt: 0,
                lastHlsKeeperLogAt: 0,
                lastHlsBufferEnd: 0,
                lastHlsBufferGrowthAt: 0,
                lastHlsSoftRestartAt: 0,
                lastHlsCeilingExpandAt: 0,
                hlsKeeperStallCount: 0,
                hlsLevelCapBeforeKeeper: null,
                hlsLevelCapApplied: false,
                hlsLevelProgressCount: 0
            };
        }

        return state.currentSession;
    }

    // Снимаем все hls.js обработчики, которые были навешаны этой сессией.
    function unbindHlsEvents(session) {
        var hls;
        var HlsCtor;

        if (!session || !session.hlsBound || !session.hlsHandlers) {
            if (session) {
                session.hlsBound = null;
                session.hlsHandlers = null;
            }
            return;
        }

        hls = session.hlsBound;
        HlsCtor = window.Hls;

        if (HlsCtor && HlsCtor.Events && typeof hls.off === 'function') {
            try {
                if (session.hlsHandlers.manifestParsed) hls.off(HlsCtor.Events.MANIFEST_PARSED, session.hlsHandlers.manifestParsed);
                if (session.hlsHandlers.levelLoaded && HlsCtor.Events.LEVEL_LOADED) hls.off(HlsCtor.Events.LEVEL_LOADED, session.hlsHandlers.levelLoaded);
                if (session.hlsHandlers.levelSwitched) hls.off(HlsCtor.Events.LEVEL_SWITCHED, session.hlsHandlers.levelSwitched);
                if (session.hlsHandlers.fragBuffered) hls.off(HlsCtor.Events.FRAG_BUFFERED, session.hlsHandlers.fragBuffered);
                if (session.hlsHandlers.error) hls.off(HlsCtor.Events.ERROR, session.hlsHandlers.error);
            } catch (e) {
                warn('failed to unbind hls events', e);
            }
        }

        session.hlsBound = null;
        session.hlsHandlers = null;
    }

    function markNativeKickSeek(session, video) {
        if (!session || !video) return;

        try {
            session.nativeKickHadOwnRewind = Object.prototype.hasOwnProperty.call(video, 'rewind');
            session.nativeKickPreviousRewind = video.rewind;
            video.rewind = true;
        } catch (e) {
            // В старых WebView это может быть readonly-свойство.
        }
    }

    function clearNativeKickSeekMark(session) {
        var video;

        if (!session) return;

        video = session.video;

        try {
            if (video) {
                if (session.nativeKickHadOwnRewind) {
                    video.rewind = session.nativeKickPreviousRewind;
                } else {
                    delete video.rewind;
                }
            }
        } catch (e) {
            try {
                if (video) video.rewind = false;
            } catch (e2) {
                // Не критично.
            }
        }

        session.nativeKickHadOwnRewind = false;
        session.nativeKickPreviousRewind = undefined;
    }

    // Чистим все асинхронные хвосты текущей сессии, чтобы старая логика не вмешивалась в новый плеер.
    function clearSessionAsyncState(session) {
        if (!session) return;

        if (session.nativeKickInProgress && session.video && isFinite(session.nativeKickReturnTo)) {
            restoreCurrentTime(session.video, session.nativeKickReturnTo);
            clearNativeKickSeekMark(session);
        }

        if (session.nativeKickReturnTimer) {
            clearTimeout(session.nativeKickReturnTimer);
            session.nativeKickReturnTimer = null;
        }

        if (session.nativeKickReleaseTimer) {
            clearTimeout(session.nativeKickReleaseTimer);
            session.nativeKickReleaseTimer = null;
        }

        session.nativeKickInProgress = false;
        session.nativeKickReturnTo = null;
    }

    function markStablePlayback(session) {
        var video;

        if (!session) return;

        video = session.video;
        if (video && (video.paused || video.seeking || video.ended)) return;

        if (!session.lastStablePlaybackAt) {
            session.lastStablePlaybackAt = Date.now();
        }
    }

    function collectHlsDetailsCandidates(hls) {
        var result = [];

        function add(details) {
            if (details && typeof details === 'object' && typeof details.live === 'boolean') {
                result.push(details);
            }
        }

        if (!hls) return result;

        try {
            add(hls.latestLevelDetails);
            add(hls.levelDetails);
            add(hls.details);

            if (hls.streamController) {
                add(hls.streamController.latestLevelDetails);
                add(hls.streamController.levelDetails);
                add(hls.streamController.details);
            }

            if (hls.levels && hls.levels.length) {
                Array.prototype.forEach.call(hls.levels, function (level) {
                    if (level) add(level.details);
                });
            }
        } catch (e) {
            warn('failed to inspect hls playlist details', e);
        }

        return result;
    }

    function syncHlsPlaylistTypeFromState(session, reason) {
        var video;
        var rawDuration;
        var detailsList;
        var i;

        if (!session || !session.hls || !isHlsPlayData(session.playData)) return false;
        if (session.playData && session.playData[LIVE_LIKE_FLAG]) return true;

        video = session.video;

        if (video) {
            rawDuration = video.duration;

            if (rawDuration && !isFinite(rawDuration)) {
                markSessionLiveLike(session, reason || 'video-duration');
                return true;
            }

            if (rawDuration && isFinite(rawDuration) && rawDuration > 0) {
                markSessionVodLike(session, reason || 'video-duration');
                return true;
            }
        }

        detailsList = collectHlsDetailsCandidates(session.hls);

        for (i = 0; i < detailsList.length; i++) {
            if (detailsList[i].live === true) {
                markSessionLiveLike(session, reason || 'hls-state');
                return true;
            }
        }

        for (i = 0; i < detailsList.length; i++) {
            if (detailsList[i].live === false) {
                markSessionVodLike(session, reason || 'hls-state');
                return true;
            }
        }

        return false;
    }

    function maybeExpandHlsCeiling(session, info, reason) {
        var now = Date.now();
        var effectiveTarget;
        var preferredTarget;
        var nextTarget;

        if (!session || !session.hls || !info || !isFinite(info.ahead)) return false;
        if (!shouldUseBufferingForPlayData(session.playData)) return false;

        effectiveTarget = getEffectiveHlsTargetSec(session);
        preferredTarget = getPreferredHlsFillTargetSec(session);

        if (effectiveTarget >= preferredTarget - HLS_CEILING_EXPAND_MARGIN_SEC) return false;
        if (info.ahead < Math.max(0, effectiveTarget - HLS_CEILING_EXPAND_MARGIN_SEC)) return false;
        if (now - session.lastHlsCeilingExpandAt < HLS_CEILING_EXPAND_INTERVAL_MS) return false;
        if (session.lastBufferErrorAt && now - session.lastBufferErrorAt < 15000) return false;

        session.lastHlsCeilingExpandAt = now;

        nextTarget = roundToSafeStep(Math.min(preferredTarget, Math.max(session.targetSec || MIN_TARGET_SEC, effectiveTarget) + PROBE_STEP_SEC));

        if (nextTarget <= effectiveTarget) return false;

        session.targetSec = nextTarget;
        session.lastProbeAt = now;
        applyHlsRuntimeConfig(session.hls, session);

        log('hls target expanded after reaching short ceiling, reason =', reason || 'unknown', 'target =', session.targetSec);
        return true;
    }

    // Для обычного video браузер сам решает, сколько качать вперёд.
    // Здесь мы аккуратно "подталкиваем" его к дальнейшей загрузке кратким seek вперёд-назад.
    function forceNativeBuffer(session, reason) {
        var video;
        var duration;
        var info;
        var currentTime;
        var kickTime;
        var returnTime;
        var wasPaused;
        var isStressEvent;
        var now = Date.now();

        if (!session || !session.video) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;
        if (session.hls) return;
        if (session.nativeKickInProgress) return;
        if (now - session.lastNativeKickAt < NATIVE_KICK_COOLDOWN_MS) return;

        video = session.video;
        duration = video.duration;

        if (!isFinite(duration) || duration <= 0) return;
        if (video.seeking || video.ended) return;
        if (toNumber(video.currentTime, 0) >= duration - 5) return;

        info = getForwardBufferInfo(video, null);
        currentTime = toNumber(video.currentTime, 0);
        wasPaused = !!video.paused;
        isStressEvent = reason === 'waiting' || reason === 'stalled' || reason === 'suspend';

        if (wasPaused) return;

        if (!wasPaused && !isStressEvent && info.ahead > NATIVE_CRITICAL_BUFFER_SEC) {
            return;
        }

        if (video.networkState === 2 && now - session.lastNativeProgressAt < NATIVE_PROGRESS_GRACE_MS && info.ahead > 3) {
            return;
        }

        kickTime = Math.min(
            Math.max(currentTime + 0.4, info.end + NATIVE_KICK_FORWARD_SEC),
            Math.max(currentTime + 0.4, duration - 0.5)
        );

        if (!isFinite(kickTime) || kickTime <= currentTime + 0.05) return;

        returnTime = currentTime;

        session.nativeKickInProgress = true;
        session.nativeKickReturnTo = returnTime;
        session.lastNativeKickAt = now;

        log('native buffer kick, reason =', reason, 'from =', returnTime, 'to =', kickTime);

        try {
            markNativeKickSeek(session, video);
            video.currentTime = kickTime;
        } catch (e) {
            session.nativeKickInProgress = false;
            clearNativeKickSeekMark(session);
            warn('failed to seek forward for native buffering', e);
            return;
        }

        session.nativeKickReturnTimer = setTimeout(function () {
            session.nativeKickReturnTimer = null;
            try {
                video.currentTime = returnTime;
            } catch (e2) {
                warn('failed to seek back after native buffering', e2);
            }

            if (!wasPaused) {
                safePlay(video);
            }

            session.nativeKickReleaseTimer = setTimeout(function () {
                session.nativeKickReleaseTimer = null;
                session.nativeKickInProgress = false;
                session.nativeKickReturnTo = null;
                clearNativeKickSeekMark(session);
            }, 80);
        }, NATIVE_KICK_RETURN_MS);
    }

    function getVideoBufferedForwardInfo(video, current) {
        var buffered;
        var i;

        try {
            buffered = video.buffered;

            if (!buffered || !buffered.length) return null;

            for (i = 0; i < buffered.length; i++) {
                var start = buffered.start(i);
                var end = buffered.end(i);

                if (start - 0.35 <= current && end >= current) {
                    return {
                        ahead: Math.max(0, end - current),
                        end: end,
                        source: 'video'
                    };
                }
            }
        } catch (e) {
            warn('failed to read video.buffered', e);
        }

        return null;
    }

    function getHlsForwardBufferInfo(hls, current) {
        var ahead;

        try {
            if (hls && hls.mainForwardBufferInfo && isFinite(hls.mainForwardBufferInfo.len)) {
                ahead = Math.max(0, hls.mainForwardBufferInfo.len);

                return {
                    ahead: ahead,
                    end: current + ahead,
                    source: 'hls'
                };
            }
        } catch (e) {
            // Вернём null и дадим вызывающему коду использовать video.buffered.
        }

        return null;
    }

    // Считаем буфер вперёд от текущей позиции.
    function getForwardBufferInfo(video, hls) {
        var current;
        var videoInfo;
        var hlsInfo;

        if (!video) {
            return {
                ahead: 0,
                end: 0,
                source: 'none'
            };
        }

        current = toNumber(video.currentTime, 0);
        videoInfo = getVideoBufferedForwardInfo(video, current);
        hlsInfo = getHlsForwardBufferInfo(hls, current);

        // video.buffered отражает фактическое состояние MSE/HTMLMediaElement.
        // hls.js иногда держит устаревший mainForwardBufferInfo сразу после ошибок и seek.
        if (videoInfo) return videoInfo;
        if (hlsInfo) return hlsInfo;

        return {
            ahead: 0,
            end: current,
            source: 'none'
        };
    }

    // Освобождаем старый хвост позади текущей позиции, чтобы не тратить квоту MSE на уже просмотренное.
    function flushBackBuffer(session) {
        var hls;
        var HlsCtor;
        var endOffset;
        var result = {
            flushed: false,
            endOffset: 0
        };

        if (!session || session.destroyed || !session.video || !session.hls) return result;
        if (!shouldUseBufferingForPlayData(session.playData)) return result;

        hls = session.hls;
        HlsCtor = window.Hls;

        if (!hls.trigger || !HlsCtor || !HlsCtor.Events || !HlsCtor.Events.BUFFER_FLUSHING) return result;

        endOffset = Math.max(0, toNumber(session.video.currentTime, 0) - BACK_BUFFER_KEEP_SEC);

        if (endOffset <= 0) return result;

        try {
            hls.trigger(HlsCtor.Events.BUFFER_FLUSHING, {
                startOffset: 0,
                endOffset: endOffset
            });

            session.lastBackBufferFlushAt = Date.now();
            session.lastBackBufferFlushEndOffset = endOffset;

            result.flushed = true;
            result.endOffset = endOffset;
        } catch (e) {
            warn('failed to flush back buffer', e);
        }

        return result;
    }

    function shouldPostponeLimitLearningAfterBackFlush(session, flushInfo, observed) {
        if (!session || !flushInfo || !flushInfo.flushed) return false;
        if (observed >= Math.max(MIN_TARGET_SEC, session.targetSec - PROBE_MARGIN_SEC)) return false;

        if (session.backBufferFlushTargetSec !== session.targetSec) {
            session.backBufferFlushTargetSec = session.targetSec;
            session.backBufferFlushPostpones = 0;
        }

        if (session.backBufferFlushPostpones >= BACK_BUFFER_LEARN_POSTPONE_MAX) return false;

        session.backBufferFlushPostpones += 1;
        return true;
    }

    // Стартовый "толчок" для hls.js.
    function primeHlsBuffer(session, reason) {
        if (!session || session.destroyed || !session.video || !session.hls) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;
        if (typeof session.hls.startLoad !== 'function') return;

        try {
            applyHlsRuntimeConfig(session.hls, session);
            session.hls.startLoad();
            session.lastStartLoadAt = Date.now();
            log('hls.startLoad() forced on', reason || 'prime');
        } catch (e) {
            warn('failed to prime HLS buffer', e);
        }
    }

    // Когда буфер впереди почти закончился, снова просим hls.js грузить дальше.
    function forceHlsBuffer(session, reason) {
        if (!session || session.destroyed || !session.video || !session.hls) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;
        if (typeof session.hls.startLoad !== 'function') return;
        if (Date.now() - session.lastStartLoadAt < STARTLOAD_COOLDOWN) return;

        try {
            applyHlsRuntimeConfig(session.hls, session);
            session.hls.startLoad();
            session.lastStartLoadAt = Date.now();
            log('forced HLS buffering, reason =', reason, 'target =', getEffectiveHlsTargetSec(session));
        } catch (e) {
            warn('failed to force HLS buffering', e);
        }
    }

    function getDesiredHlsAheadSec(session) {
        var video;
        var target;
        var current;
        var duration;
        var remaining;

        if (!session) return 0;

        video = session.video;
        target = getEffectiveHlsTargetSec(session);

        if (!video) return target;

        current = toNumber(video.currentTime, 0);
        duration = toNumber(video.duration, 0);

        if (isFinite(duration) && duration > 0) {
            remaining = duration - current;
            if (remaining <= 3) return 0;
            target = Math.min(target, Math.max(0, remaining - 2));
        }

        return target;
    }

    function updateHlsBufferGrowth(session, info) {
        var now;

        if (!session || !session.hls || !info) return;

        now = Date.now();

        if (!session.lastHlsBufferGrowthAt) {
            session.lastHlsBufferGrowthAt = now;
        }

        if (!session.lastHlsBufferEnd || info.end > session.lastHlsBufferEnd + 0.25) {
            session.lastHlsBufferEnd = info.end;
            session.lastHlsBufferGrowthAt = now;
            session.hlsKeeperStallCount = 0;
            maybeRestoreHlsLevelAfterProgress(session, 'buffer-growth');
        }
    }

    function maybeLowerHlsLevelForKeeper(session, reason) {
        var hls;
        var levelsLength;
        var currentLevel;
        var nextAutoLevel;
        var loadLevel;
        var baseLevel;
        var newCap;

        if (!session || !session.hls || session.hlsKeeperStallCount < HLS_KEEPER_LEVEL_DOWN_STALLS) return;

        hls = session.hls;
        levelsLength = hls.levels && hls.levels.length ? hls.levels.length : 0;
        if (levelsLength <= 1) return;

        currentLevel = toNumber(hls.currentLevel, -1);
        nextAutoLevel = toNumber(hls.nextAutoLevel, -1);
        loadLevel = toNumber(hls.loadLevel, -1);
        baseLevel = currentLevel >= 0 ? currentLevel : (nextAutoLevel >= 0 ? nextAutoLevel : (loadLevel >= 0 ? loadLevel : levelsLength - 1));
        newCap = Math.max(0, Math.min(levelsLength - 1, baseLevel - 1));

        if (session.hlsLevelCapApplied && toNumber(hls.autoLevelCapping, -1) <= newCap) return;

        if (!session.hlsLevelCapApplied) {
            session.hlsLevelCapBeforeKeeper = toNumber(hls.autoLevelCapping, -1);
        }

        try {
            hls.autoLevelCapping = newCap;
            hls.nextAutoLevel = newCap;

            if (toNumber(hls.currentLevel, -1) > newCap) {
                hls.nextLevel = newCap;
            }

            session.hlsLevelCapApplied = true;
            session.hlsLevelProgressCount = 0;
            log('hls keeper lowered level cap, reason =', reason || 'keeper', 'cap =', newCap);
        } catch (e) {
            warn('failed to lower hls level cap', e);
        }
    }

    function maybeRestoreHlsLevelAfterProgress(session, reason) {
        var hls;
        var previousCap;

        if (!session || !session.hls || !session.hlsLevelCapApplied) return;

        session.hlsLevelProgressCount = Math.min(20, (session.hlsLevelProgressCount || 0) + 1);
        if (session.hlsLevelProgressCount < HLS_KEEPER_LEVEL_RESTORE_PROGRESS_COUNT) return;

        hls = session.hls;
        previousCap = session.hlsLevelCapBeforeKeeper;

        try {
            hls.autoLevelCapping = previousCap === null || previousCap === undefined ? -1 : previousCap;
            session.hlsLevelCapApplied = false;
            session.hlsLevelCapBeforeKeeper = null;
            session.hlsLevelProgressCount = 0;
            log('hls keeper restored level cap, reason =', reason || 'progress');
        } catch (e) {
            warn('failed to restore hls level cap', e);
        }
    }

    function keepHlsBufferFilling(session, info, reason) {
        var hls;
        var now;
        var desiredAhead;
        var noGrowthFor;
        var shouldSoftRestart;

        if (!session || session.destroyed || !session.video || !session.hls || !info) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;

        hls = session.hls;
        if (typeof hls.startLoad !== 'function') return;

        desiredAhead = getDesiredHlsAheadSec(session);
        if (desiredAhead <= 0) return;
        if (info.ahead >= Math.max(0, desiredAhead - HLS_KEEPER_TARGET_MARGIN_SEC)) return;

        now = Date.now();
        if (now - session.lastHlsKeeperAt < HLS_KEEPER_COOLDOWN_MS) return;

        noGrowthFor = session.lastHlsBufferGrowthAt ? now - session.lastHlsBufferGrowthAt : 0;
        shouldSoftRestart = noGrowthFor >= HLS_KEEPER_STALLED_MS &&
            now - session.lastHlsSoftRestartAt >= HLS_KEEPER_STOPSTART_COOLDOWN_MS &&
            typeof hls.stopLoad === 'function';

        try {
            applyHlsRuntimeConfig(hls, session);

            if (shouldSoftRestart) {
                hls.stopLoad();
                session.lastHlsSoftRestartAt = now;
                session.hlsKeeperStallCount = Math.min(10, (session.hlsKeeperStallCount || 0) + 1);
                session.lastStartLoadAt = 0;
                maybeLowerHlsLevelForKeeper(session, reason);
                log('hls loader soft restart, reason =', reason || 'keeper', 'ahead =', info.ahead, 'target =', desiredAhead);
            }

            hls.startLoad();
            session.lastHlsKeeperAt = now;
            session.lastStartLoadAt = now;

            if (shouldSoftRestart || now - session.lastHlsKeeperLogAt >= HLS_KEEPER_LOG_INTERVAL_MS) {
                session.lastHlsKeeperLogAt = now;
                log('hls buffer keeper startLoad, reason =', reason || 'keeper', 'ahead =', info.ahead, 'target =', desiredAhead, 'paused =', !!session.video.paused);
            }
        } catch (e) {
            warn('hls buffer keeper failed', e);
        }
    }

    // Когда устройство упёрлось в bufferFullError, вычисляем безопасный предел и запоминаем его.
    function learnDeviceLimit(session, reason) {
        var info;
        var observed;
        var learned;
        var stored;
        var flushInfo;

        if (!session || session.destroyed || !session.video) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;

        info = getForwardBufferInfo(session.video, session.hls);
        flushInfo = flushBackBuffer(session);
        observed = Math.max(info.ahead, session.observedMaxAhead || 0);

        if (shouldPostponeLimitLearningAfterBackFlush(session, flushInfo, observed)) {
            session.lastBufferErrorAt = Date.now();
            session.lastStartLoadAt = 0;
            log('back buffer flushed, limit learning postponed, reason =', reason, 'ahead =', info.ahead);
            return;
        }

        if (observed <= 0) return;

        learned = roundToSafeStep(Math.max(MIN_TARGET_SEC, observed - SAFE_MARGIN_AFTER_ERROR_SEC));
        stored = getLearnedLimitSec();

        session.targetSec = learned;
        session.backBufferFlushPostpones = 0;
        session.backBufferFlushTargetSec = 0;
        session.limitLearnedThisSession = true;
        session.lastBufferErrorAt = Date.now();

        if (!stored || Math.abs(stored - learned) >= 10 || learned < stored) {
            saveLearnedLimitSec(learned);
        }

        applyHlsRuntimeConfig(session.hls, session);
        if (!flushInfo.flushed) flushBackBuffer(session);

        log('learned device buffer limit =', learned, 'sec, reason =', reason);
    }

    function markStallSignal(session, reason) {
        if (!session) return;

        session.lastStallSignalAt = Date.now();
        session.stallSignalCount = Math.min(6, (session.stallSignalCount || 0) + 1);
        session.predictorRiskScore = Math.min(10, (session.predictorRiskScore || 0) + 2);

        log('stall signal observed, reason =', reason || 'unknown', 'count =', session.stallSignalCount);
    }

    function updateStallPredictor(session, info, reason) {
        var now;
        var dt;
        var current;
        var downloadRate;
        var consumeRate;
        var netAheadRate;
        var lowThreshold;
        var recentStall;
        var risk = 0;

        if (!session || session.destroyed || !session.video || !info) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;

        now = Date.now();
        current = toNumber(session.video.currentTime, 0);

        if (!session.predictorLastAt) {
            session.predictorLastAt = now;
            session.predictorLastAhead = info.ahead;
            session.predictorLastEnd = info.end;
            session.predictorLastCurrent = current;
            return;
        }

        dt = (now - session.predictorLastAt) / 1000;
        if (dt < 0.75) return;

        downloadRate = (info.end - session.predictorLastEnd) / dt;
        consumeRate = Math.max(0, (current - session.predictorLastCurrent) / dt);
        netAheadRate = (info.ahead - session.predictorLastAhead) / dt;
        lowThreshold = session.hls ?
            Math.min(LOW_BUFFER_THRESHOLD_SEC, Math.max(8, session.targetSec * 0.25)) :
            NATIVE_LOW_BUFFER_THRESHOLD_SEC;
        recentStall = session.lastStallSignalAt && now - session.lastStallSignalAt <= STALL_SIGNAL_WINDOW_MS;

        if (recentStall) risk += 2;
        if (info.ahead <= lowThreshold) risk += 1;
        if (consumeRate > 0.2 && downloadRate < consumeRate * 0.65 && info.ahead < session.targetSec * 0.5) risk += 2;
        if (netAheadRate < -0.25 && info.ahead < session.targetSec * 0.5) risk += 1;

        session.predictorRiskScore = Math.max(0, (session.predictorRiskScore || 0) * 0.65 + risk);

        if (risk >= 2 || session.predictorRiskScore >= 3) {
            session.predictorHoldProbeUntil = now + STALL_PREDICTOR_HOLD_MS;

            if (now - session.predictorLastActionAt >= STALL_PREDICTOR_ACTION_COOLDOWN_MS) {
                session.predictorLastActionAt = now;

                if (session.hls) {
                    session.lastStartLoadAt = 0;
                    forceHlsBuffer(session, 'stall-predictor');
                } else {
                    forceNativeBuffer(session, 'stall-predictor');
                }

                log('stall predictor acted, ahead =', info.ahead, 'downloadRate =', downloadRate, 'consumeRate =', consumeRate, 'reason =', reason);
            }
        }

        if (!recentStall && session.stallSignalCount > 0 && now - session.lastStallSignalAt > STALL_SIGNAL_WINDOW_MS) {
            session.stallSignalCount = Math.max(0, session.stallSignalCount - 1);
        }

        session.predictorLastAt = now;
        session.predictorLastAhead = info.ahead;
        session.predictorLastEnd = info.end;
        session.predictorLastCurrent = current;
    }

    // Если устройство стабильно выдерживает текущий target, пробуем поднять его чуть выше.
    function maybeProbeHigherLimit(session) {
        var now;
        var stored;
        var proposed;

        if (!session || session.destroyed || !session.hls) return;
        if (!shouldUseBufferingForPlayData(session.playData)) return;

        now = Date.now();

        if (session.lastBufferInfo.ahead < session.targetSec - PROBE_MARGIN_SEC) return;
        if (now - session.lastProbeAt < 15000) return;
        if (now - session.lastBufferErrorAt < 20000) return;
        if (session.predictorHoldProbeUntil && now < session.predictorHoldProbeUntil) return;
        if (session.targetSec >= ABSOLUTE_MAX_SEC) return;

        // Если текущее значение уже устойчиво держится, сохраняем его как рабочий предел.
        stored = getLearnedLimitSec();

        if (session.targetSec > stored && session.lastBufferInfo.ahead >= session.targetSec - PROBE_MARGIN_SEC) {
            saveLearnedLimitSec(session.targetSec);
        }

        proposed = roundToSafeStep(Math.min(ABSOLUTE_MAX_SEC, session.targetSec + PROBE_STEP_SEC));

        if (proposed <= session.targetSec) return;

        session.targetSec = proposed;
        session.backBufferFlushPostpones = 0;
        session.backBufferFlushTargetSec = 0;
        session.lastProbeAt = now;

        applyHlsRuntimeConfig(session.hls, session);
        log('probing higher device limit ->', proposed, 'sec');
    }

    function markSessionLiveLike(session, reason) {
        var marked;

        if (!session) return;

        marked = markPlayDataLiveLike(session.playData, reason);
        session.observedMaxAhead = 0;
        session.lastBufferInfo = { ahead: 0, end: 0 };
        session.backBufferFlushPostpones = 0;
        session.backBufferFlushTargetSec = 0;

        if (marked) applyDefaultHlsConfig(window.Hls, session.playData);

        if (session.hls) {
            applyHlsRuntimeConfig(session.hls, session);
        }
    }

    function markSessionVodLike(session, reason) {
        var marked;

        if (!session) return;

        marked = markPlayDataVodLike(session.playData, reason);

        if (shouldUseBufferingForPlayData(session.playData)) {
            if (marked) applyDefaultHlsConfig(window.Hls, session.playData);

            if (session.hls) {
                applyHlsRuntimeConfig(session.hls, session);
                if (marked) primeHlsBuffer(session, reason || 'vod-detected');
            }
        }
    }

    // Подписываемся на события hls.js ровно один раз на текущий экземпляр.
    function bindHlsEvents(session) {
        var hls;
        var HlsCtor;

        if (!session || !session.hls) return;
        if (session.hlsBound && session.hlsBound !== session.hls) {
            unbindHlsEvents(session);
        }
        if (session.hlsBound === session.hls) return;

        hls = session.hls;
        HlsCtor = window.Hls;

        if (!HlsCtor || !HlsCtor.Events || typeof hls.on !== 'function') return;

        session.hlsBound = hls;
        session.hlsHandlers = {
            manifestParsed: function () {
                syncHlsPlaylistTypeFromState(session, 'hls-manifest-parsed');

                if (shouldUseBufferingForPlayData(session.playData)) {
                    applyHlsRuntimeConfig(hls, session);
                }
            },
            levelLoaded: function (event, data) {
                var details = data && data.details;

                if (!details) return;

                if (details.live) {
                    markSessionLiveLike(session, 'hls-level-loaded');
                    return;
                }

                markSessionVodLike(session, 'hls-level-loaded');
                evaluateSession('hls-level-loaded');
            },
            levelSwitched: function () {
                session.observedMaxAhead = 0;
                session.lastBufferInfo = { ahead: 0, end: 0 };
                session.backBufferFlushPostpones = 0;
                session.backBufferFlushTargetSec = 0;
                session.predictorLastAt = 0;
                session.predictorRiskScore = 0;
                session.predictorHoldProbeUntil = Date.now() + STALL_PREDICTOR_HOLD_MS;
                session.lastProbeAt = Date.now();

                if (shouldUseBufferingForPlayData(session.playData)) {
                    applyHlsRuntimeConfig(hls, session);
                }
            },
            fragBuffered: function () {
                syncHlsPlaylistTypeFromState(session, 'hls-frag-buffered');
                maybeRestoreHlsLevelAfterProgress(session, 'buffered-fragments');
                evaluateSession('hls-frag-buffered');
            },
            error: function (event, data) {
                if (!data || !data.details) return;

                syncHlsPlaylistTypeFromState(session, 'hls-error');

                if (!shouldUseBufferingForPlayData(session.playData)) return;
                if (data.fatal) {
                    markStallSignal(session, data.details);
                    return;
                }

                if (data.details === HlsCtor.ErrorDetails.BUFFER_FULL_ERROR || data.details === HlsCtor.ErrorDetails.BUFFER_APPENDING_ERROR) {
                    learnDeviceLimit(session, data.details);
                    return;
                }

                if (data.details === HlsCtor.ErrorDetails.BUFFER_STALLED_ERROR) {
                    forceHlsBuffer(session, data.details);
                }
            }
        };

        try {
            hls.on(HlsCtor.Events.MANIFEST_PARSED, session.hlsHandlers.manifestParsed);
            if (HlsCtor.Events.LEVEL_LOADED) hls.on(HlsCtor.Events.LEVEL_LOADED, session.hlsHandlers.levelLoaded);
            hls.on(HlsCtor.Events.LEVEL_SWITCHED, session.hlsHandlers.levelSwitched);
            hls.on(HlsCtor.Events.FRAG_BUFFERED, session.hlsHandlers.fragBuffered);
            hls.on(HlsCtor.Events.ERROR, session.hlsHandlers.error);
            syncHlsPlaylistTypeFromState(session, 'hls-bind-state');
        } catch (e) {
            warn('failed to bind hls events', e);
        }
    }

    // Основной цикл оценки текущего плеера.
    function evaluateSession(reason) {
        var session = state.currentSession;
        var video;
        var duration;
        var rawDuration;
        var info;
        var hlsLowBufferThreshold;
        var effectiveHlsTarget;
        var playerIsOpened = !Lampa.Player || typeof Lampa.Player.opened !== 'function' || Lampa.Player.opened();

        if (!session || session.destroyed || !playerIsOpened) return;
        if (!isAnyFeatureEnabled()) return;

        video = session.video || getCurrentVideo();

        if (!video || typeof video.addEventListener !== 'function') return;
        if (typeof video.buffered === 'undefined' || typeof video.currentTime === 'undefined') return;

        session.video = video;
        session.hls = getCurrentHls(video);

        if (session.bound && session.boundVideo && session.boundVideo !== video) {
            unbindSessionVideoEvents(session);
            bindSessionEvents(session);
        }

        if (session.hls) {
            bindHlsEvents(session);
            syncHlsPlaylistTypeFromState(session, reason || 'evaluate-hls-state');
        }

        prepareVideoElement(video);

        duration = toNumber(video.duration, 0);
        rawDuration = video.duration;

        if (rawDuration && !isFinite(rawDuration)) {
            markSessionLiveLike(session, 'video-duration');
            return;
        }

        if (session.hls && isHlsPlayData(session.playData) && rawDuration && isFinite(rawDuration) && rawDuration > 0) {
            markSessionVodLike(session, 'video-duration');
        }

        if (session.hls) {
            applyHlsRuntimeConfig(session.hls, session);
        }

        if (!shouldUseBufferingForPlayData(session.playData)) {
            return;
        }

        if (video.ended) return;
        if (isFinite(duration) && duration > 0 && video.currentTime >= duration - 10) return;

        info = getForwardBufferInfo(video, session.hls);
        session.lastBufferInfo = info;
        updateHlsBufferGrowth(session, info);

        if (info.ahead > session.observedMaxAhead) {
            session.observedMaxAhead = info.ahead;
        }

        maybeExpandHlsCeiling(session, info, reason || 'evaluate');

        keepHlsBufferFilling(session, info, reason || 'evaluate');

        updateStallPredictor(session, info, reason || 'evaluate');

        if (session.hls) {
            // Если hls.js сам урезал лимит после внутренней обработки ошибки, возвращаем наш target.
            if (toNumber(session.hls.config.maxMaxBufferLength, 0) < session.targetSec) {
                applyHlsRuntimeConfig(session.hls, session);
            }

            // Когда буфер почти кончился, пинаем startLoad.
            effectiveHlsTarget = getEffectiveHlsTargetSec(session);
            hlsLowBufferThreshold = Math.min(LOW_BUFFER_THRESHOLD_SEC, Math.max(5, effectiveHlsTarget * 0.45));

            if (info.ahead <= hlsLowBufferThreshold) {
                forceHlsBuffer(session, reason);
            }

            // Если буфер стабильно дорос до target, пробуем аккуратно поднять target ещё выше.
            maybeProbeHigherLimit(session);
        } else if (info.ahead <= NATIVE_LOW_BUFFER_THRESHOLD_SEC) {
            forceNativeBuffer(session, reason);
        }
    }

    // Навешиваем слушатели на video ровно на одну игровую сессию.
    function unbindSessionVideoEvents(session) {
        var video;

        if (!session) return;

        if (session.watchdog) {
            clearInterval(session.watchdog);
            session.watchdog = null;
        }

        video = session.boundVideo || session.video;

        if (video && session.handlers) {
            Object.keys(session.handlers).forEach(function (eventName) {
                try {
                    video.removeEventListener(eventName, session.handlers[eventName]);
                } catch (e) {
                    // На cleanup такие ошибки не критичны.
                }
            });
        }

        session.handlers = null;
        session.boundVideo = null;
        session.bound = false;
    }

    // Навешиваем слушатели на video ровно на одну игровую сессию.
    function bindSessionEvents(session) {
        if (!session || !session.video) return;

        session.handlers = {
            progress: function () {
                session.lastNativeProgressAt = Date.now();
                evaluateSession('progress');
            },
            timeupdate: function () {
                markStablePlayback(session);
                evaluateSession('timeupdate');
            },
            loadeddata: function () {
                session.hls = getCurrentHls(session.video);
                if (session.hls) {
                    applyHlsRuntimeConfig(session.hls, session);
                }
                evaluateSession('loadeddata');
            },
            canplay: function () {
                evaluateSession('canplay');
            },
            waiting: function () {
                markStallSignal(session, 'waiting');
                evaluateSession('waiting');
            },
            suspend: function () {
                markStallSignal(session, 'suspend');
                evaluateSession('suspend');
            },
            stalled: function () {
                markStallSignal(session, 'stalled');
                evaluateSession('stalled');
            },
            error: function () {
                evaluateSession('error');
            },
            pause: function () {
                evaluateSession('pause');
            },
            play: function () {
                evaluateSession('play');
            },
            playing: function () {
                markStablePlayback(session);
                evaluateSession('playing');
            }
        };

        Object.keys(session.handlers).forEach(function (eventName) {
            session.video.addEventListener(eventName, session.handlers[eventName]);
        });

        session.boundVideo = session.video;
        session.bound = true;
        session.watchdog = setInterval(function () {
            evaluateSession('watchdog');
        }, WATCHDOG_INTERVAL);
    }

    // Полностью удаляем текущую сессию.
    function destroyCurrentSession() {
        var session = state.currentSession;

        if (!session) return;

        session.destroyed = true;
        clearSessionAsyncState(session);
        unbindHlsEvents(session);
        unbindSessionVideoEvents(session);

        state.currentSession = null;
    }

    // Запускаем новую игровую сессию после готовности плеера.
    function startPlayerSession(playData, attempt, token) {
        var session;
        var video;
        var playerIsOpened = !Lampa.Player || typeof Lampa.Player.opened !== 'function' || Lampa.Player.opened();
        var isLiveLike = isLiveLikePlayData(playData);

        if (attempt === undefined) attempt = 0;
        if (token === undefined) token = state.startToken;
        if (token !== state.startToken) return;
        if (!playerIsOpened) return;
        if (!isAnyFeatureEnabled()) return;
        if (isLiveLike) return;

        if (!state.currentSession || state.currentSession.playData !== playData) {
            destroyCurrentSession();
            state.currentSession = ensureSession(playData);
        } else {
            session = ensureSession(playData);
            session.playData = playData || session.playData || {};
        }

        session = state.currentSession;
        video = getCurrentVideo();

        if (!video || typeof video.addEventListener !== 'function' || typeof video.buffered === 'undefined' || typeof video.currentTime === 'undefined') {
            if (attempt < 20) {
                setTimeout(function () {
                    startPlayerSession(playData, attempt + 1, token);
                }, 250);
            }

            return;
        }

        session.video = video;
        session.hls = getCurrentHls(video);

        if (session.bound && session.boundVideo === video) {
            evaluateSession('player-ready-reuse');
            return;
        }

        if (session.bound && session.boundVideo !== video) {
            unbindSessionVideoEvents(session);
        }

        try {
            prepareVideoElement(video);
        } catch (e) {
            // Не критично.
        }

        bindSessionEvents(session);

        if (session.hls) {
            bindHlsEvents(session);
            syncHlsPlaylistTypeFromState(session, 'player-ready-hls-state');
            applyHlsRuntimeConfig(session.hls, session);

            if (shouldUseBufferingForPlayData(session.playData)) {
                primeHlsBuffer(session, 'player-ready');
            }
        }

        evaluateSession('player-ready');

        log('session started, initial target =', session.targetSec, 'sec');
    }

    // Применяем новые настройки к активной сессии.
    function syncCurrentSession(reason) {
        var session = state.currentSession;

        applyDefaultHlsConfig(window.Hls, session && session.playData);

        if (!session || session.destroyed) return;
        if (!isAnyFeatureEnabled()) return;

        session.hls = getCurrentHls(session.video || getCurrentVideo());

        if (session.hls) {
            bindHlsEvents(session);
            syncHlsPlaylistTypeFromState(session, reason || 'sync-hls-state');

            if (shouldUseBufferingForPlayData(session.playData)) {
                applyHlsRuntimeConfig(session.hls, session);
                primeHlsBuffer(session, reason || 'sync');
            } else {
                applyHlsRuntimeConfig(session.hls, session);
            }
        }

        evaluateSession(reason || 'sync');
    }

    // Основной запуск плагина.
    function initPlugin() {
        normalizeStorage();
        registerSettings();
        ensureHlsPatched();
        bindBufferErrorCleaner();
        applyDefaultHlsConfig(window.Hls, null);

        // До создания Hls просим Lampa использовать именно hls.js для VOD m3u8,
        // иначе нативный HLS браузера/вебвью не даст контролировать буфер.
        Lampa.Player.listener.follow('start', function (data) {
            var playUrl;

            state.startToken += 1;
            destroyCurrentSession();
            ensureHlsPatched(data);

            if (!isAnyFeatureEnabled()) return;

            if (!isLiveLikePlayData(data)) {
                ensureSession(data);
            }

            playUrl = getPlayDataUrl(data);

            if (shouldForceHlsJsForPlayData(data) && playUrl && isM3U8Url(playUrl) && typeof window.Hls !== 'undefined' && window.Hls.isSupported && window.Hls.isSupported()) {
                data.hls_type = 'hlsjs';
            }
        });

        // После ready() video уже существует и можно стартовать сессию.
        Lampa.Player.listener.follow('ready', function (data) {
            startPlayerSession(data, 0, state.startToken);
        });

        // При закрытии плеера очищаем сессию.
        Lampa.Player.listener.follow('destroy', function () {
            state.startToken += 1;
            destroyCurrentSession();
        });

        log(PLUGIN_NAME + ' v' + PLUGIN_VERSION + ' initialized');
    }

    // Стандартная схема запуска Lampa-плагина.
    if (window.appready) initPlugin();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') initPlugin();
        });
    }

console.log('[Advanced Buffer Control] v1.2.0: file end');
}());
