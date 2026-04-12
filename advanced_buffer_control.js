/*
 * Advanced Buffer Control / Умный большой буфер
 * Версия: 1.1.0
 *
 * Эта версия делает только то, что реально безопасно на Android / Android TV:
 * - добавляет переключатели в существующий раздел настроек плеера;
 * - если плагин включён, то для HLS-потоков старается заполнить буфер до фактического предела устройства;
 * - при decode/media ошибках умеет сбросить буфер в ноль, сохранить позицию и мягко восстановить воспроизведение;
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

    console.log('[Advanced Buffer Control] v1.1.0: file begin');

    // Защита от повторной инициализации.
    if (window.advanced_buffer_control_plugin_ready_v1) {
        console.log('[Advanced Buffer Control] v1.1.0: already initialized');
        console.log('[Advanced Buffer Control] v1.1.0: file end');
        return;
    }

    window.advanced_buffer_control_plugin_ready_v1 = true;

    // Основные идентификаторы плагина и ключи Storage.
    var PLUGIN_NAME = 'Advanced Buffer Control';
    var PLUGIN_VERSION = '1.1.0';
    var ENABLED_KEY = 'advanced_buffer_control_enabled';
    var RECOVERY_ENABLED_KEY = 'advanced_buffer_control_decode_recovery_enabled';
    var LEARNED_LIMIT_KEY = 'advanced_buffer_control_learned_limit_sec';
    var MENU_TEXT = {
        enabled_name: {
            ru: 'Умное заполнение буфера',
            en: 'Smart Buffer Fill'
        },
        enabled_description: {
            ru: 'Автоматически заполнять буфер до фактического предела устройства',
            en: 'Automatically fill the buffer up to the actual device limit'
        },
        recovery_name: {
            ru: 'Восстановление после decode-ошибок',
            en: 'Decode Error Recovery'
        },
        recovery_description: {
            ru: 'При decode/media ошибках сбрасывать буфер, сохранять позицию и мягко перезапускать воспроизведение',
            en: 'On decode/media errors, reset the buffer, keep the position and gently restart playback'
        }
    };

    // Значения по умолчанию и безопасные пределы.
    var ENABLED_DEFAULT = true;
    var RECOVERY_ENABLED_DEFAULT = true;
    var MIN_TARGET_SEC = 60;
    var DISCOVERY_START_SEC = 480;
    var ABSOLUTE_MAX_SEC = 900;
    var SAFE_MARGIN_AFTER_ERROR_SEC = 15;
    var PROBE_STEP_SEC = 30;
    var PROBE_MARGIN_SEC = 20;
    var LOW_BUFFER_THRESHOLD_SEC = 55;
    var WATCHDOG_INTERVAL = 2000;
    var STARTLOAD_COOLDOWN = 7000;
    var BACK_BUFFER_KEEP_SEC = 20;
    var RECOVERY_COOLDOWN_MS = 7000;
    var RECOVERY_ATTACH_TIMEOUT_MS = 2500;
    var RECOVERY_NATIVE_RELOAD_DELAY_MS = 120;
    var RECOVERY_MAX_ATTEMPTS = 4;
    var RECOVERY_STABLE_RESET_MS = 15000;

    // Общее состояние плагина.
    var state = {
        hlsPatched: false,
        originalHlsDefaults: null,
        lastHls: null,
        currentSession: null,
        errorCleanerBound: false
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

    // Упрощённый аналог Object.assign.
    function extend(target) {
        var i;
        var source;
        var key;

        target = target || {};

        for (i = 1; i < arguments.length; i++) {
            source = arguments[i] || {};

            for (key in source) {
                if (Object.prototype.hasOwnProperty.call(source, key)) {
                    target[key] = source[key];
                }
            }
        }

        return target;
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

    // Текущий статус автоматического восстановления после decode/media ошибок.
    function isRecoveryEnabled() {
        var value;

        try {
            value = Lampa.Storage.get(RECOVERY_ENABLED_KEY, RECOVERY_ENABLED_DEFAULT);
        } catch (e) {
            value = RECOVERY_ENABLED_DEFAULT;
        }

        return String(value) === 'true';
    }

    // Проверяем, включена ли хотя бы одна функция плагина.
    function isAnyFeatureEnabled() {
        return isPluginEnabled() || isRecoveryEnabled();
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

    // Инициализируем дефолтные значения Storage.
    function normalizeStorage() {
        try {
            if (Lampa.Storage.get(ENABLED_KEY, null) === null) {
                Lampa.Storage.set(ENABLED_KEY, ENABLED_DEFAULT);
            }
        } catch (e) {
            warn('failed to normalize enabled flag', e);
        }

        try {
            if (Lampa.Storage.get(RECOVERY_ENABLED_KEY, null) === null) {
                Lampa.Storage.set(RECOVERY_ENABLED_KEY, RECOVERY_ENABLED_DEFAULT);
            }
        } catch (e1) {
            warn('failed to normalize recovery flag', e1);
        }

        try {
            var learned = getLearnedLimitSec();

            if (learned > 0) {
                Lampa.Storage.set(LEARNED_LIMIT_KEY, String(learned));
            }
        } catch (e2) {
            warn('failed to normalize learned limit', e2);
        }
    }

    // Добавляем один параметр прямо в существующий раздел настроек плеера.
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

                if (!enabled && !isRecoveryEnabled()) {
                    destroyCurrentSession();
                }

                applyDefaultHlsConfig(window.Hls);
                syncCurrentSession('settings-change');
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'player',
            param: {
                name: RECOVERY_ENABLED_KEY,
                type: 'trigger',
                default: RECOVERY_ENABLED_DEFAULT
            },
            field: createLocalizedField('recovery_name', 'recovery_description'),
            onChange: function () {
                if (!isAnyFeatureEnabled()) {
                    destroyCurrentSession();
                    return;
                }

                syncCurrentSession('recovery-settings-change');
            }
        });
    }

    // Сохраняем оригинальные дефолты hls.js, чтобы уметь корректно отключать плагин.
    function captureOriginalHlsDefaults(HlsCtor) {
        if (!HlsCtor || !HlsCtor.DefaultConfig) return;
        if (state.originalHlsDefaults) return;

        state.originalHlsDefaults = {
            maxBufferLength: HlsCtor.DefaultConfig.maxBufferLength,
            maxMaxBufferLength: HlsCtor.DefaultConfig.maxMaxBufferLength,
            maxBufferSize: HlsCtor.DefaultConfig.maxBufferSize,
            backBufferLength: HlsCtor.DefaultConfig.backBufferLength,
            liveBackBufferLength: HlsCtor.DefaultConfig.liveBackBufferLength,
            lowLatencyMode: HlsCtor.DefaultConfig.lowLatencyMode
        };
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

    // Применяем дефолтный конфиг hls.js в зависимости от статуса переключателя.
    function applyDefaultHlsConfig(HlsCtor) {
        var targetSec;

        if (!HlsCtor || !HlsCtor.DefaultConfig) return;

        captureOriginalHlsDefaults(HlsCtor);

        try {
            if (!isPluginEnabled()) {
                if (state.originalHlsDefaults) {
                    extend(HlsCtor.DefaultConfig, state.originalHlsDefaults);
                }

                return;
            }

            targetSec = getCurrentDesiredTargetSec();

            HlsCtor.DefaultConfig.maxBufferLength = targetSec;
            HlsCtor.DefaultConfig.maxMaxBufferLength = targetSec;
            HlsCtor.DefaultConfig.maxBufferSize = getBufferSizeBytesForTarget(targetSec);
            HlsCtor.DefaultConfig.backBufferLength = BACK_BUFFER_KEEP_SEC;
            HlsCtor.DefaultConfig.liveBackBufferLength = BACK_BUFFER_KEEP_SEC;
            HlsCtor.DefaultConfig.lowLatencyMode = false;
        } catch (e) {
            warn('failed to apply Hls.DefaultConfig', e);
        }
    }

    // Применяем те же настройки к уже созданному экземпляру hls.js.
    function applyHlsRuntimeConfig(hls, session) {
        var targetSec;

        if (!hls || !hls.config) return;

        captureOriginalHlsDefaults(window.Hls);

        try {
            if (!isPluginEnabled()) {
                if (state.originalHlsDefaults) {
                    hls.config.maxBufferLength = state.originalHlsDefaults.maxBufferLength;
                    hls.config.maxMaxBufferLength = state.originalHlsDefaults.maxMaxBufferLength;
                    hls.config.maxBufferSize = state.originalHlsDefaults.maxBufferSize;
                    hls.config.backBufferLength = state.originalHlsDefaults.backBufferLength;
                    hls.config.liveBackBufferLength = state.originalHlsDefaults.liveBackBufferLength;
                    hls.config.lowLatencyMode = state.originalHlsDefaults.lowLatencyMode;
                }

                return;
            }

            targetSec = getCurrentDesiredTargetSec(session);

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
            var session;

            text = String(e.error || '');

            if (isRecoveryEnabled() && isRecoverablePlayerError(e)) {
                session = ensureSession();
                session.video = session.video || getCurrentVideo();
                session.hls = getCurrentHls(session.video) || session.hls;
                requestDecodeRecovery(session, 'player-listener:' + text);
            }

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

    // Патчим только attachMedia и destroy у Hls.
    // Конструктор Hls НЕ трогаем, чтобы избежать рекурсии.
    function ensureHlsPatched() {
        var OriginalHls;
        var originalAttachMedia;
        var originalDestroy;

        if (state.hlsPatched) return true;
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

                    if (isPluginEnabled()) {
                        applyHlsRuntimeConfig(this, state.currentSession);
                    }
                } catch (e) {
                    warn('attachMedia patch failed', e);
                }

                return result;
            };

            OriginalHls.prototype.__advancedBufferAttachPatched = true;
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
        applyDefaultHlsConfig(window.Hls);
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

    // Снимок <source>-элементов нужен для жёсткой перезагрузки нативного video.
    function captureVideoSources(video) {
        var result = [];

        if (!video || !video.querySelectorAll) return result;

        try {
            Array.prototype.forEach.call(video.querySelectorAll('source'), function (node) {
                result.push({
                    src: node.getAttribute('src') || '',
                    type: node.getAttribute('type') || ''
                });
            });
        } catch (e) {
            warn('failed to capture <source> nodes', e);
        }

        return result;
    }

    // Полностью убираем source-узлы, чтобы video.load() реально обнулил текущий буфер.
    function clearVideoSources(video) {
        if (!video || !video.querySelectorAll) return;

        try {
            Array.prototype.forEach.call(video.querySelectorAll('source'), function (node) {
                if (node && node.parentNode) {
                    node.parentNode.removeChild(node);
                }
            });
        } catch (e) {
            warn('failed to clear <source> nodes', e);
        }
    }

    // Возвращаем source-узлы после жёсткой перезагрузки video.
    function restoreVideoSources(video, sources) {
        if (!video || !sources || !sources.length) return;

        try {
            sources.forEach(function (item) {
                var sourceNode = document.createElement('source');

                if (item.src) sourceNode.setAttribute('src', item.src);
                if (item.type) sourceNode.setAttribute('type', item.type);

                video.appendChild(sourceNode);
            });
        } catch (e) {
            warn('failed to restore <source> nodes', e);
        }
    }

    // Нормализуем сессию, даже если recover нужно вызвать раньше, чем успел полностью подняться hls.js.
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
                observedMaxAhead: 0,
                lastBufferInfo: { ahead: 0, end: 0 },
                limitLearnedThisSession: false,
                hlsBound: null,
                bound: false,
                recoveryInProgress: false,
                recoveryAttempts: 0,
                lastRecoveryAt: 0,
                lastRecoveryReason: '',
                lastStablePlaybackAt: 0,
                nativeRecoveryJustReloaded: false
            };
        }

        return state.currentSession;
    }

    // Сбрасываем счётчик recover-циклов после стабильного воспроизведения.
    function resetRecoveryAttemptsIfStable(session) {
        if (!session || !session.recoveryAttempts || !session.lastRecoveryAt) return;
        if (Date.now() - session.lastRecoveryAt < RECOVERY_STABLE_RESET_MS) return;

        session.recoveryAttempts = 0;
    }

    // Определяем классические decode/media ошибки нативного <video>.
    function isNativeDecodeError(error) {
        var message;

        if (!error) return false;
        if (error.code === 3) return true;

        message = String(error.message || '').toLowerCase();

        return message.indexOf('decode') >= 0 ||
            message.indexOf('corrupt') >= 0 ||
            message.indexOf('mediasource') >= 0 ||
            message.indexOf('sourcebuffer') >= 0;
    }

    // Определяем ошибки, пришедшие через общий listener Lampa.PlayerVideo.
    function isRecoverablePlayerError(eventData) {
        var text = String((eventData && eventData.error) || '').toLowerCase();

        if (!text) return false;

        return text.indexOf('code [3]') >= 0 ||
            text.indexOf('decode') >= 0 ||
            text.indexOf('media error') >= 0 ||
            text.indexOf('mediasourcerequiresreset') >= 0 ||
            text.indexOf('bufferappenderror') >= 0 ||
            text.indexOf('bufferappendingerror') >= 0 ||
            text.indexOf('bufferaddcodecerror') >= 0 ||
            text.indexOf('bufferincompatiblecodecserror') >= 0 ||
            text.indexOf('fragparsingerror') >= 0;
    }

    // Определяем decode/media ошибки hls.js, которые разумно лечить полным сбросом буфера.
    function isRecoverableHlsError(data, HlsCtor) {
        var details;

        if (!data || !HlsCtor || !HlsCtor.ErrorDetails) return false;

        details = data.details;

        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && data.fatal) {
            return true;
        }

        return details === HlsCtor.ErrorDetails.BUFFER_APPEND_ERROR ||
            details === HlsCtor.ErrorDetails.BUFFER_APPENDING_ERROR ||
            details === HlsCtor.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
            details === HlsCtor.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
            details === HlsCtor.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET ||
            details === HlsCtor.ErrorDetails.FRAG_PARSING_ERROR ||
            details === HlsCtor.ErrorDetails.INTERNAL_EXCEPTION;
    }

    // Аккуратно завершаем recover и возвращаем позицию/воспроизведение.
    function finishDecodeRecovery(session, currentTime, wasPaused, reason) {
        var video;

        if (!session || session.destroyed) return;

        video = session.video || getCurrentVideo();
        if (!video) {
            session.recoveryInProgress = false;
            return;
        }

        session.video = video;
        session.hls = getCurrentHls(video) || session.hls;
        session.lastStartLoadAt = 0;

        if (session.hls && isPluginEnabled()) {
            applyHlsRuntimeConfig(session.hls, session);
        }

        restoreCurrentTime(video, currentTime);

        if (session.hls && typeof session.hls.startLoad === 'function') {
            try {
                session.hls.startLoad(currentTime);
                session.lastStartLoadAt = Date.now();
            } catch (e) {
                warn('failed to startLoad after decode recovery', e);
            }
        } else if (!session.nativeRecoveryJustReloaded) {
            try {
                video.load();
            } catch (e2) {
                // Для обычного mp4 это безопасный способ инициировать новый буфер.
            }
        }

        if (!wasPaused) {
            safePlay(video);
        }

        session.nativeRecoveryJustReloaded = false;
        session.recoveryInProgress = false;
        session.lastStablePlaybackAt = Date.now();

        log('decode recovery finished, reason =', reason);
        evaluateSession('decode-recovery-finished');
    }

    // Для HLS самый безопасный способ полностью обнулить MSE-буфер — detach/attach через recoverMediaError().
    function recoverHlsPlayback(session, reason, currentTime, wasPaused) {
        var hls = session && session.hls;
        var HlsCtor = window.Hls;
        var finished = false;
        var attachedHandler = null;

        if (!session || !hls || typeof hls.recoverMediaError !== 'function') {
            finishDecodeRecovery(session, currentTime, wasPaused, reason + ':fallback');
            return;
        }

        function finalize(tag) {
            if (finished) return;
            finished = true;

            try {
                if (attachedHandler && HlsCtor && HlsCtor.Events && typeof hls.off === 'function') {
                    hls.off(HlsCtor.Events.MEDIA_ATTACHED, attachedHandler);
                }
            } catch (e) {
                // На cleanup ошибки не критичны.
            }

            setTimeout(function () {
                finishDecodeRecovery(session, currentTime, wasPaused, reason + ':' + tag);
            }, 100);
        }

        try {
            if (typeof hls.stopLoad === 'function') {
                hls.stopLoad();
            }
        } catch (e1) {
            warn('failed to stopLoad before decode recovery', e1);
        }

        if (HlsCtor && HlsCtor.Events && typeof hls.on === 'function') {
            attachedHandler = function () {
                finalize('media-attached');
            };

            try {
                hls.on(HlsCtor.Events.MEDIA_ATTACHED, attachedHandler);
            } catch (e3) {
                warn('failed to subscribe MEDIA_ATTACHED after recoverMediaError', e3);
            }
        }

        try {
            session.recoveryInProgress = true;
            hls.recoverMediaError();
        } catch (e2) {
            warn('hls.recoverMediaError failed', e2);
            finalize('recover-error');
            return;
        }

        setTimeout(function () {
            finalize('timeout');
        }, RECOVERY_ATTACH_TIMEOUT_MS);
    }

    // Для обычного video без hls.js жёстко пересоздаём источник, чтобы буфер ушёл в ноль.
    function recoverNativePlayback(session, reason, currentTime, wasPaused) {
        var video;
        var sourceAttr;
        var sources;
        var completed = false;
        var loadedHandler;
        var canPlayHandler;
        var timeoutId = null;

        if (!session || !session.video) return;

        video = session.video;
        sourceAttr = video.getAttribute('src') || video.currentSrc || video.src || '';
        sources = captureVideoSources(video);

        function cleanup() {
            if (loadedHandler) video.removeEventListener('loadedmetadata', loadedHandler);
            if (canPlayHandler) video.removeEventListener('canplay', canPlayHandler);
            if (timeoutId) clearTimeout(timeoutId);

            try {
                if (session.handlers && session.handlers.error) {
                    video.removeEventListener('error', session.handlers.error);
                    video.addEventListener('error', session.handlers.error);
                }
            } catch (e) {
                // На cleanup это не критично.
            }
        }

        function finalize(tag) {
            if (completed) return;
            completed = true;
            cleanup();
            finishDecodeRecovery(session, currentTime, wasPaused, reason + ':' + tag);
        }

        loadedHandler = function () {
            finalize('loadedmetadata');
        };

        canPlayHandler = function () {
            finalize('canplay');
        };

        session.recoveryInProgress = true;
        session.nativeRecoveryJustReloaded = false;

        try {
            video.pause();
        } catch (e1) {
            // Не критично.
        }

        try {
            video.removeEventListener('error', session.handlers && session.handlers.error);
        } catch (e2) {
            // Временный шум от video.load() не должен создавать рекурсию.
        }

        try {
            video.removeAttribute('src');
            clearVideoSources(video);
            video.load();
        } catch (e3) {
            warn('failed to clear native video source', e3);
        }

        setTimeout(function () {
            try {
                if (sourceAttr) {
                    video.setAttribute('src', sourceAttr);
                    video.src = sourceAttr;
                } else {
                    restoreVideoSources(video, sources);
                }

                video.addEventListener('loadedmetadata', loadedHandler);
                video.addEventListener('canplay', canPlayHandler);
                video.load();
                session.nativeRecoveryJustReloaded = true;
            } catch (e4) {
                warn('failed to restore native video source', e4);
                finalize('restore-error');
                return;
            }

            timeoutId = setTimeout(function () {
                finalize('timeout');
            }, RECOVERY_ATTACH_TIMEOUT_MS);
        }, RECOVERY_NATIVE_RELOAD_DELAY_MS);
    }

    // Центральная точка восстановления после decode/media ошибок.
    function requestDecodeRecovery(session, reason) {
        var video;
        var currentTime;
        var wasPaused;
        var now = Date.now();

        if (!isRecoveryEnabled()) return;

        session = session || ensureSession();
        if (!session || session.destroyed) return;

        video = session.video || getCurrentVideo();
        if (!video) return;

        session.video = video;
        session.hls = getCurrentHls(video) || session.hls;

        if (session.recoveryInProgress) return;
        if (now - session.lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
        if (session.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) return;

        currentTime = toNumber(video.currentTime, 0);
        wasPaused = !!video.paused;

        session.lastRecoveryAt = now;
        session.lastRecoveryReason = String(reason || 'unknown');
        session.recoveryAttempts += 1;

        log('decode recovery started, reason =', session.lastRecoveryReason, 'attempt =', session.recoveryAttempts, 'time =', currentTime);

        if (session.hls && typeof session.hls.recoverMediaError === 'function') {
            recoverHlsPlayback(session, session.lastRecoveryReason, currentTime, wasPaused);
            return;
        }

        recoverNativePlayback(session, session.lastRecoveryReason, currentTime, wasPaused);
    }

    // Считаем буфер вперёд от текущей позиции.
    function getForwardBufferInfo(video, hls) {
        var current;
        var buffered;
        var i;

        if (!video) {
            return {
                ahead: 0,
                end: 0
            };
        }

        current = toNumber(video.currentTime, 0);

        try {
            if (hls && hls.mainForwardBufferInfo && isFinite(hls.mainForwardBufferInfo.len)) {
                return {
                    ahead: Math.max(0, hls.mainForwardBufferInfo.len),
                    end: current + Math.max(0, hls.mainForwardBufferInfo.len)
                };
            }
        } catch (e) {
            // Ниже есть fallback через video.buffered.
        }

        try {
            buffered = video.buffered;

            if (!buffered || !buffered.length) {
                return {
                    ahead: 0,
                    end: current
                };
            }

            for (i = 0; i < buffered.length; i++) {
                var start = buffered.start(i);
                var end = buffered.end(i);

                if (start - 0.35 <= current && end >= current) {
                    return {
                        ahead: Math.max(0, end - current),
                        end: end
                    };
                }
            }
        } catch (e2) {
            warn('failed to read video.buffered', e2);
        }

        return {
            ahead: 0,
            end: current
        };
    }

    // Освобождаем старый хвост позади текущей позиции, чтобы не тратить квоту MSE на уже просмотренное.
    function flushBackBuffer(session) {
        var hls;
        var HlsCtor;
        var endOffset;

        if (!session || !session.video || !session.hls) return;

        hls = session.hls;
        HlsCtor = window.Hls;

        if (!hls.trigger || !HlsCtor || !HlsCtor.Events || !HlsCtor.Events.BUFFER_FLUSHING) return;

        endOffset = Math.max(0, toNumber(session.video.currentTime, 0) - BACK_BUFFER_KEEP_SEC);

        if (endOffset <= 0) return;

        try {
            hls.trigger(HlsCtor.Events.BUFFER_FLUSHING, {
                startOffset: 0,
                endOffset: endOffset
            });
        } catch (e) {
            warn('failed to flush back buffer', e);
        }
    }

    // Стартовый "толчок" для hls.js.
    function primeHlsBuffer(session, reason) {
        if (!session || !session.video || !session.hls) return;
        if (typeof session.hls.startLoad !== 'function') return;

        try {
            applyHlsRuntimeConfig(session.hls, session);
            session.hls.startLoad(toNumber(session.video.currentTime, -1));
            session.lastStartLoadAt = Date.now();
            log('hls.startLoad() forced on', reason || 'prime');
        } catch (e) {
            warn('failed to prime HLS buffer', e);
        }
    }

    // Когда буфер впереди почти закончился, снова просим hls.js грузить дальше.
    function forceHlsBuffer(session, reason) {
        if (!session || !session.video || !session.hls) return;
        if (typeof session.hls.startLoad !== 'function') return;
        if (Date.now() - session.lastStartLoadAt < STARTLOAD_COOLDOWN) return;

        try {
            applyHlsRuntimeConfig(session.hls, session);
            session.hls.startLoad(toNumber(session.video.currentTime, -1));
            session.lastStartLoadAt = Date.now();
            log('forced HLS buffering, reason =', reason, 'target =', session.targetSec);
        } catch (e) {
            warn('failed to force HLS buffering', e);
        }
    }

    // Когда устройство упёрлось в bufferFullError, вычисляем безопасный предел и запоминаем его.
    function learnDeviceLimit(session, reason) {
        var info;
        var observed;
        var learned;
        var stored;

        if (!session || !session.video) return;

        info = getForwardBufferInfo(session.video, session.hls);
        observed = Math.max(info.ahead, session.observedMaxAhead || 0);

        if (observed <= 0) return;

        learned = roundToSafeStep(Math.max(MIN_TARGET_SEC, observed - SAFE_MARGIN_AFTER_ERROR_SEC));
        stored = getLearnedLimitSec();

        session.targetSec = learned;
        session.limitLearnedThisSession = true;
        session.lastBufferErrorAt = Date.now();

        if (!stored || Math.abs(stored - learned) >= 10 || learned < stored) {
            saveLearnedLimitSec(learned);
        }

        applyHlsRuntimeConfig(session.hls, session);
        flushBackBuffer(session);

        log('learned device buffer limit =', learned, 'sec, reason =', reason);
    }

    // Если устройство стабильно выдерживает текущий target, пробуем поднять его чуть выше.
    function maybeProbeHigherLimit(session) {
        var now;
        var stored;
        var proposed;

        if (!session || !session.hls) return;
        if (!isPluginEnabled()) return;

        now = Date.now();

        if (session.lastBufferInfo.ahead < session.targetSec - PROBE_MARGIN_SEC) return;
        if (now - session.lastProbeAt < 15000) return;
        if (now - session.lastBufferErrorAt < 20000) return;
        if (session.targetSec >= ABSOLUTE_MAX_SEC) return;

        // Если текущее значение уже устойчиво держится, сохраняем его как рабочий предел.
        stored = getLearnedLimitSec();

        if (session.targetSec > stored && session.lastBufferInfo.ahead >= session.targetSec - PROBE_MARGIN_SEC) {
            saveLearnedLimitSec(session.targetSec);
        }

        proposed = roundToSafeStep(Math.min(ABSOLUTE_MAX_SEC, session.targetSec + PROBE_STEP_SEC));

        if (proposed <= session.targetSec) return;

        session.targetSec = proposed;
        session.lastProbeAt = now;

        applyHlsRuntimeConfig(session.hls, session);
        log('probing higher device limit ->', proposed, 'sec');
    }

    // Подписываемся на события hls.js ровно один раз на текущий экземпляр.
    function bindHlsEvents(session) {
        var hls;
        var HlsCtor;

        if (!session || !session.hls) return;
        if (session.hlsBound === session.hls) return;

        hls = session.hls;
        HlsCtor = window.Hls;

        if (!HlsCtor || !HlsCtor.Events || typeof hls.on !== 'function') return;

        session.hlsBound = hls;

        try {
            hls.on(HlsCtor.Events.MANIFEST_PARSED, function () {
                applyHlsRuntimeConfig(hls, session);
            });

            hls.on(HlsCtor.Events.LEVEL_SWITCHED, function () {
                applyHlsRuntimeConfig(hls, session);
            });

            hls.on(HlsCtor.Events.FRAG_BUFFERED, function () {
                evaluateSession('hls-frag-buffered');
            });

            hls.on(HlsCtor.Events.ERROR, function (event, data) {
                if (!data || !data.details) return;

                if (isRecoveryEnabled() && isRecoverableHlsError(data, HlsCtor)) {
                    requestDecodeRecovery(session, 'hls:' + data.details);
                }

                if (data.fatal) return;

                if (data.details === HlsCtor.ErrorDetails.BUFFER_FULL_ERROR || data.details === HlsCtor.ErrorDetails.BUFFER_APPENDING_ERROR) {
                    learnDeviceLimit(session, data.details);
                    return;
                }

                if (data.details === HlsCtor.ErrorDetails.BUFFER_STALLED_ERROR) {
                    forceHlsBuffer(session, data.details);
                }
            });
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
        var playerIsOpened = !Lampa.Player || typeof Lampa.Player.opened !== 'function' || Lampa.Player.opened();

        if (!session || session.destroyed || !playerIsOpened) return;
        if (!isAnyFeatureEnabled()) return;

        video = session.video || getCurrentVideo();

        if (!video || typeof video.addEventListener !== 'function') return;
        if (typeof video.buffered === 'undefined' || typeof video.currentTime === 'undefined') return;

        session.video = video;
        session.hls = getCurrentHls(video);
        resetRecoveryAttemptsIfStable(session);

        if (session.recoveryInProgress) return;
        if (!isPluginEnabled()) return;
        if (!session.hls) return;

        applyHlsRuntimeConfig(session.hls, session);
        bindHlsEvents(session);

        try {
            video.preload = 'auto';
            video.setAttribute('preload', 'auto');
        } catch (e) {
            // Не критично.
        }

        duration = toNumber(video.duration, 0);
        rawDuration = video.duration;

        if ((session.playData && (session.playData.iptv || session.playData.tv || session.playData.need_check_live_stream)) || (rawDuration && !isFinite(rawDuration))) {
            return;
        }

        if (video.ended) return;
        if (isFinite(duration) && duration > 0 && video.currentTime >= duration - 10) return;

        info = getForwardBufferInfo(video, session.hls);
        session.lastBufferInfo = info;

        if (info.ahead > session.observedMaxAhead) {
            session.observedMaxAhead = info.ahead;
        }

        // Если hls.js сам урезал лимит после внутренней обработки ошибки, возвращаем наш target.
        if (toNumber(session.hls.config.maxMaxBufferLength, 0) < session.targetSec) {
            applyHlsRuntimeConfig(session.hls, session);
        }

        // Когда буфер почти кончился, пинаем startLoad.
        if (info.ahead <= LOW_BUFFER_THRESHOLD_SEC) {
            forceHlsBuffer(session, reason);
        }

        // Если буфер стабильно дорос до target, пробуем аккуратно поднять target ещё выше.
        maybeProbeHigherLimit(session);
    }

    // Навешиваем слушатели на video ровно на одну игровую сессию.
    function bindSessionEvents(session) {
        if (!session || !session.video) return;

        session.handlers = {
            progress: function () {
                evaluateSession('progress');
            },
            timeupdate: function () {
                resetRecoveryAttemptsIfStable(session);
                evaluateSession('timeupdate');
            },
            loadeddata: function () {
                session.hls = getCurrentHls(session.video);
                if (session.hls) applyHlsRuntimeConfig(session.hls, session);
                evaluateSession('loadeddata');
            },
            canplay: function () {
                evaluateSession('canplay');
            },
            waiting: function () {
                evaluateSession('waiting');
            },
            error: function () {
                var error = session.video ? session.video.error : null;

                if (isRecoveryEnabled() && isNativeDecodeError(error)) {
                    requestDecodeRecovery(session, 'video-error-code-' + String(error && error.code));
                    return;
                }

                evaluateSession('error');
            },
            play: function () {
                evaluateSession('play');
            },
            playing: function () {
                session.recoveryInProgress = false;
                session.lastStablePlaybackAt = Date.now();
                resetRecoveryAttemptsIfStable(session);
                evaluateSession('playing');
            }
        };

        Object.keys(session.handlers).forEach(function (eventName) {
            session.video.addEventListener(eventName, session.handlers[eventName]);
        });

        session.watchdog = setInterval(function () {
            evaluateSession('watchdog');
        }, WATCHDOG_INTERVAL);
    }

    // Полностью удаляем текущую сессию.
    function destroyCurrentSession() {
        var session = state.currentSession;

        if (!session) return;

        session.destroyed = true;

        if (session.watchdog) {
            clearInterval(session.watchdog);
            session.watchdog = null;
        }

        if (session.video && session.handlers) {
            Object.keys(session.handlers).forEach(function (eventName) {
                try {
                    session.video.removeEventListener(eventName, session.handlers[eventName]);
                } catch (e) {
                    // На cleanup такие ошибки не критичны.
                }
            });
        }

        state.currentSession = null;
    }

    // Запускаем новую игровую сессию после готовности плеера.
    function startPlayerSession(playData, attempt) {
        var session;
        var video;
        var playerIsOpened = !Lampa.Player || typeof Lampa.Player.opened !== 'function' || Lampa.Player.opened();
        var isLiveLike = playData && (playData.iptv || playData.tv || playData.need_check_live_stream);

        if (attempt === undefined) attempt = 0;
        if (!playerIsOpened) return;
        if (!isAnyFeatureEnabled()) return;
        if (isLiveLike && !isRecoveryEnabled()) return;

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
                    startPlayerSession(playData, attempt + 1);
                }, 250);
            }

            return;
        }

        session.video = video;
        session.hls = getCurrentHls(video);

        if (session.bound) {
            evaluateSession('player-ready-reuse');
            return;
        }

        try {
            video.preload = 'auto';
            video.setAttribute('preload', 'auto');
        } catch (e) {
            // Не критично.
        }

        bindSessionEvents(session);
        session.bound = true;

        if (session.hls && isPluginEnabled()) {
            applyHlsRuntimeConfig(session.hls, session);
            primeHlsBuffer(session, 'player-ready');
        }

        evaluateSession('player-ready');

        log('session started, initial target =', session.targetSec, 'sec');
    }

    // Применяем новые настройки к активной сессии.
    function syncCurrentSession(reason) {
        var session = state.currentSession;

        applyDefaultHlsConfig(window.Hls);

        if (!session || session.destroyed) return;
        if (!isAnyFeatureEnabled()) return;

        session.hls = getCurrentHls(session.video || getCurrentVideo());

        if (session.hls && isPluginEnabled()) {
            applyHlsRuntimeConfig(session.hls, session);
            primeHlsBuffer(session, reason || 'sync');
        }

        evaluateSession(reason || 'sync');
    }

    // Основной запуск плагина.
    function initPlugin() {
        normalizeStorage();
        registerSettings();
        ensureHlsPatched();
        bindBufferErrorCleaner();
        applyDefaultHlsConfig(window.Hls);

        // До создания Hls просим Lampa использовать именно hls.js для m3u8,
        // иначе нативный HLS браузера/вебвью не даст контролировать буфер.
        Lampa.Player.listener.follow('start', function (data) {
            ensureHlsPatched();
            applyDefaultHlsConfig(window.Hls);

            destroyCurrentSession();

            if (!isAnyFeatureEnabled()) return;

            if (isPluginEnabled() && data && data.url && isM3U8Url(data.url) && typeof window.Hls !== 'undefined' && window.Hls.isSupported && window.Hls.isSupported()) {
                data.hls_type = 'hlsjs';
            }
        });

        // После ready() video уже существует и можно стартовать сессию.
        Lampa.Player.listener.follow('ready', function (data) {
            startPlayerSession(data);
        });

        // При закрытии плеера очищаем сессию.
        Lampa.Player.listener.follow('destroy', function () {
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

    console.log('[Advanced Buffer Control] v1.1.0: file end');
}());
