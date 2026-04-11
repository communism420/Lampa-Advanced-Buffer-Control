/*
 * Advanced Buffer Control / Умный большой буфер
 * Версия: 1.2.0
 *
 * Плагин для Lampa:
 * - добавляет настройку размера буфера в меню настроек;
 * - при каждом запуске видео применяет выбранный размер буфера;
 * - работает с нативным <video> и с hls.js;
 * - при малом остатке буфера принудительно инициирует дальнейшую загрузку.
 */
(function () {
    'use strict';

    console.log('[Advanced Buffer Control] v1.2.0: file begin');

    // Защита от повторной инициализации, если файл был загружен несколько раз.
    if (window.advanced_buffer_control_plugin_ready) {
        console.log('[Advanced Buffer Control] v1.2.0: already initialized');
        console.log('[Advanced Buffer Control] v1.2.0: file end');
        return;
    }

    window.advanced_buffer_control_plugin_ready = true;

    // Базовые константы плагина.
    var PLUGIN_NAME = 'Advanced Buffer Control';
    var PLUGIN_TITLE = 'Умный большой буфер';
    var PLUGIN_VERSION = '1.2.0';
    var STORAGE_KEY = 'advanced_buffer_control_minutes';
    var DEFAULT_MINUTES = '20';
    var LOW_BUFFER_THRESHOLD = 55;
    var HLS_FORCE_COOLDOWN = 8000;
    var NATIVE_FORCE_COOLDOWN = 12000;
    var WATCHDOG_INTERVAL = 2000;
    var BACK_BUFFER_KEEP_SECONDS = 20;

    // Разрешённые значения буфера в минутах.
    var BUFFER_OPTIONS = {
        '5': '5 минут',
        '10': '10 минут',
        '15': '15 минут',
        '20': '20 минут',
        '25': '25 минут',
        '30': '30 минут',
        '35': '35 минут',
        '40': '40 минут'
    };

    // Общий runtime-state плагина.
    var state = {
        hlsPatched: false,
        lastHls: null,
        currentSession: null,
        playerInfoPatched: false
    };

    // Короткий логгер, чтобы все сообщения плагина было легко отфильтровать в консоли.
    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Advanced Buffer Control]');
        console.log.apply(console, args);
    }

    // Предупреждения держим отдельно, чтобы ошибки было проще заметить.
    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Advanced Buffer Control]');
        console.warn.apply(console, args);
    }

    // Простейший аналог Object.assign для большей совместимости со старыми движками.
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

    // Надёжно приводим значение к числу, иначе возвращаем запасное значение.
    function toNumber(value, fallback) {
        var num = parseFloat(value);
        return isFinite(num) ? num : fallback;
    }

    // Возвращаем выбранное пользователем количество минут и жёстко ограничиваем диапазон 5..40.
    function getSelectedMinutes() {
        var raw = (Lampa && Lampa.Storage ? Lampa.Storage.get(STORAGE_KEY, DEFAULT_MINUTES) : DEFAULT_MINUTES) + '';
        var minutes = toNumber(raw, toNumber(DEFAULT_MINUTES, 20));

        if (minutes < 5) minutes = 5;
        if (minutes > 40) minutes = 40;

        // Разрешаем только шаги по 5 минутам, чтобы настройка не уходила в неожиданные значения.
        minutes = Math.round(minutes / 5) * 5;

        if (!BUFFER_OPTIONS[String(minutes)]) minutes = 20;

        return minutes;
    }

    // Основной целевой размер буфера в секундах.
    function getTargetBufferSeconds() {
        return getSelectedMinutes() * 60;
    }

    // Для hls.js нужен ещё и лимит по байтам.
    // Формула намеренно даёт довольно высокий потолок, чтобы не упираться в стандартные 60 MB,
    // но при этом не уходит в совсем экстремальные значения.
    function getTargetBufferBytes(seconds) {
        var minBytes = 256 * 1024 * 1024;
        var maxBytes = 2048 * 1024 * 1024;
        var estimated = Math.round(seconds * 1200000);

        if (estimated < minBytes) estimated = minBytes;
        if (estimated > maxBytes) estimated = maxBytes;

        return estimated;
    }

    // Простая строковая хеш-функция для генерации короткого ключа кэша.
    function hashString(input) {
        var hash = 5381;
        var i;

        input = String(input || '');

        for (i = 0; i < input.length; i++) {
            hash = ((hash << 5) + hash) + input.charCodeAt(i);
            hash = hash & hash;
        }

        return 'h' + Math.abs(hash);
    }

    // Создаём уникальный ключ сегмента с учётом Range-запроса.
    function buildSegmentKey(url, rangeStart, rangeEnd) {
        return String(url || '') + '||' + String(rangeStart || 0) + '||' + String(rangeEnd || 0);
    }

    // Берём ключ из контекста загрузчика hls.js.
    function buildSegmentKeyFromContext(context) {
        return buildSegmentKey(
            context && context.url,
            context && context.rangeStart,
            context && context.rangeEnd
        );
    }

    // Берём ключ прямо из объекта Fragment.
    function buildSegmentKeyFromFragment(frag) {
        return buildSegmentKey(
            frag && frag.url,
            frag && frag.byteRangeStartOffset,
            frag && frag.byteRangeEndOffset
        );
    }

    // Формируем безопасный URL для CacheStorage.
    // Это не сетевой адрес, а только внутренний ключ для локального кэша браузера.
    function buildCacheRequestUrl(session, key) {
        var origin = (window.location && window.location.origin) ? window.location.origin : 'https://advanced-buffer-control.local';
        return origin + '/__abc_segment_cache__/' + encodeURIComponent(session.id) + '/' + encodeURIComponent(hashString(key));
    }

    // Создаём стандартный объект статистики, если загрузка шла не через штатный loader hls.js.
    function createLoaderStats(loadedBytes, startedAt) {
        var now = (window.performance && performance.now) ? performance.now() : Date.now();

        return {
            aborted: false,
            loaded: loadedBytes || 0,
            retry: 0,
            total: loadedBytes || 0,
            chunkCount: 1,
            bwEstimate: 0,
            loading: {
                start: startedAt || now,
                first: startedAt || now,
                end: now
            },
            parsing: {
                start: 0,
                end: 0
            },
            buffering: {
                start: 0,
                first: 0,
                end: 0
            }
        };
    }

    // Проверяем, доступен ли дисковый CacheStorage.
    function canUsePersistentCache() {
        return !!(window.caches && window.Response);
    }

    // Инициализация служебных структур одной сессии воспроизведения.
    function ensureSessionInternals(session) {
        if (!session) return;

        if (!session.id) session.id = 'abc_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        if (!session.segmentMeta) session.segmentMeta = {};
        if (!session.prefetchQueue) session.prefetchQueue = [];
        if (!session.prefetchInFlight) session.prefetchInFlight = {};
        if (!session.memoryStore) session.memoryStore = {};
        if (!session.memoryOrder) session.memoryOrder = [];
        if (!session.memoryBytes) session.memoryBytes = 0;
        if (!session.memoryLimitBytes) session.memoryLimitBytes = 128 * 1024 * 1024;
        if (!session.cacheName) session.cacheName = 'advanced-buffer-control-' + session.id;
    }

    // Удаляем самый старый элемент из memory fallback-кэша.
    function evictOldestMemoryEntry(session) {
        var oldestKey;
        var item;

        ensureSessionInternals(session);

        oldestKey = session.memoryOrder.shift();
        if (!oldestKey) return;

        item = session.memoryStore[oldestKey];
        if (item) {
            session.memoryBytes -= item.size || 0;
            delete session.memoryStore[oldestKey];
        }
    }

    // Сохраняем сегмент в memory fallback, если CacheStorage недоступен.
    function putMemorySegment(session, key, buffer) {
        var size = buffer ? (buffer.byteLength || 0) : 0;

        ensureSessionInternals(session);

        if (session.memoryStore[key]) {
            session.memoryBytes -= session.memoryStore[key].size || 0;
        } else {
            session.memoryOrder.push(key);
        }

        session.memoryStore[key] = {
            buffer: buffer,
            size: size,
            at: Date.now()
        };

        session.memoryBytes += size;

        while (session.memoryBytes > session.memoryLimitBytes && session.memoryOrder.length) {
            evictOldestMemoryEntry(session);
        }
    }

    // Читаем сегмент из memory fallback.
    function getMemorySegment(session, key) {
        var item;

        ensureSessionInternals(session);
        item = session.memoryStore[key];

        if (!item || !item.buffer) return Promise.resolve(null);

        item.at = Date.now();
        return Promise.resolve(item.buffer.slice(0));
    }

    // Сохраняем сегмент в CacheStorage.
    function putPersistentSegment(session, key, buffer) {
        ensureSessionInternals(session);

        return window.caches.open(session.cacheName).then(function (cache) {
            var requestUrl = buildCacheRequestUrl(session, key);
            var response = new Response(buffer, {
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            });

            return cache.put(requestUrl, response);
        });
    }

    // Читаем сегмент из CacheStorage.
    function getPersistentSegment(session, key) {
        ensureSessionInternals(session);

        return window.caches.open(session.cacheName).then(function (cache) {
            return cache.match(buildCacheRequestUrl(session, key)).then(function (response) {
                if (!response) return null;
                return response.arrayBuffer();
            });
        });
    }

    // Унифицированное чтение сегмента из локального кэша.
    function getCachedSegment(session, key) {
        ensureSessionInternals(session);

        if (canUsePersistentCache()) {
            return getPersistentSegment(session, key).catch(function () {
                return getMemorySegment(session, key);
            });
        }

        return getMemorySegment(session, key);
    }

    // Унифицированная запись сегмента в локальный кэш.
    function putCachedSegment(session, key, buffer) {
        ensureSessionInternals(session);

        if (canUsePersistentCache()) {
            return putPersistentSegment(session, key, buffer).catch(function () {
                putMemorySegment(session, key, buffer);
            });
        }

        putMemorySegment(session, key, buffer);
        return Promise.resolve();
    }

    // Полная очистка кэша одной игровой сессии.
    function clearSessionCache(session) {
        if (!session) return;

        ensureSessionInternals(session);

        session.memoryStore = {};
        session.memoryOrder = [];
        session.memoryBytes = 0;

        if (canUsePersistentCache()) {
            window.caches.delete(session.cacheName).catch(function () {});
        }
    }

    // Аккуратный XHR-фетч сегмента для фоновой предзагрузки.
    function fetchSegmentArrayBuffer(session, descriptor) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            var sent = false;
            var timeout = 60000;
            var xhrSetup = session && session.hls && session.hls.config ? session.hls.config.xhrSetup : null;

            xhr.open('GET', descriptor.url, true);
            xhr.responseType = 'arraybuffer';
            xhr.timeout = timeout;

            if (descriptor.rangeEnd && descriptor.rangeEnd > descriptor.rangeStart) {
                xhr.setRequestHeader('Range', 'bytes=' + descriptor.rangeStart + '-' + (descriptor.rangeEnd - 1));
            }

            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
                    resolve(xhr.response);
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };

            xhr.onerror = function () {
                reject(new Error('Network error'));
            };

            xhr.ontimeout = function () {
                reject(new Error('Timeout'));
            };

            function send() {
                if (sent) return;
                sent = true;
                xhr.send();
            }

            try {
                if (typeof xhrSetup === 'function') {
                    var maybePromise = xhrSetup(xhr, descriptor.url);

                    if (maybePromise && typeof maybePromise.then === 'function') {
                        maybePromise.then(send).catch(send);
                    } else {
                        send();
                    }
                } else {
                    send();
                }
            } catch (e) {
                send();
            }
        });
    }

    // Возвращаем человекочитаемую длительность для подписи кэша в инфо плеера.
    function toHumanSeconds(seconds) {
        if (Lampa && Lampa.Utils && typeof Lampa.Utils.secondsToTimeHuman === 'function') {
            return Lampa.Utils.secondsToTimeHuman(seconds);
        }

        seconds = Math.max(0, Math.round(seconds || 0));

        if (seconds >= 3600) return Math.round(seconds / 3600) + ' ч.';
        if (seconds >= 60) return Math.round(seconds / 60) + ' м.';
        return seconds + ' с.';
    }

    // Определяем m3u8 не только по окончанию URL, но и по query-параметрам.
    function isM3U8Url(url) {
        url = (url || '') + '';
        return /\.m3u8($|\?|#)/i.test(url);
    }

    // Находим самый лёгкий по битрейту уровень, чтобы при упоре в квоту
    // можно было наращивать запас по времени, а не по мегабайтам.
    function getLowestLevelIndex(hls) {
        var levels;
        var bestIndex = -1;
        var bestBitrate = Infinity;
        var i;
        var bitrate;

        if (!hls || !hls.levels || !hls.levels.length) return -1;

        levels = hls.levels;

        for (i = 0; i < levels.length; i++) {
            bitrate = toNumber(levels[i].bitrate || levels[i].maxBitrate || levels[i].averageBitrate, Infinity);

            if (bitrate < bestBitrate) {
                bestBitrate = bitrate;
                bestIndex = i;
            }
        }

        return bestIndex;
    }

    // Выбираем уровень, детали плейлиста которого уже загружены и подходят для предзагрузки.
    function getPrefetchLevelIndex(session) {
        var hls;
        var candidates;
        var i;
        var index;

        if (!session || !session.hls) return -1;

        hls = session.hls;
        candidates = [];

        if (session.forcedLowLevel) candidates.push(getLowestLevelIndex(hls));
        candidates.push(hls.nextLoadLevel);
        candidates.push(hls.loadLevel);
        candidates.push(hls.currentLevel);
        candidates.push(hls.nextAutoLevel);
        candidates.push(hls.startLevel);

        for (i = 0; i < candidates.length; i++) {
            index = toNumber(candidates[i], -1);

            if (index >= 0 && hls.levels && hls.levels[index] && hls.levels[index].details) {
                return index;
            }
        }

        if (hls.levels && hls.levels.length) {
            for (i = 0; i < hls.levels.length; i++) {
                if (hls.levels[i] && hls.levels[i].details) return i;
            }
        }

        return -1;
    }

    // Собираем описание сегмента для фоновой предзагрузки.
    function createSegmentDescriptor(frag, levelIndex) {
        if (!frag || !frag.url) return null;

        return {
            key: buildSegmentKeyFromFragment(frag),
            url: frag.url,
            rangeStart: frag.byteRangeStartOffset || 0,
            rangeEnd: frag.byteRangeEndOffset || 0,
            start: toNumber(frag.start, 0),
            end: toNumber(frag.end, toNumber(frag.start, 0) + toNumber(frag.duration, 0)),
            duration: toNumber(frag.duration, 0),
            levelIndex: levelIndex
        };
    }

    // Считаем виртуальный конец буфера: реальный MSE-буфер + непрерывная цепочка уже кешированных HLS-сегментов.
    function getVirtualBufferEnd(session, actualEnd) {
        var end = toNumber(actualEnd, 0);
        var keys;
        var items;
        var i;

        if (!session || !session.segmentMeta) return end;

        keys = Object.keys(session.segmentMeta);
        items = [];

        for (i = 0; i < keys.length; i++) {
            var item = session.segmentMeta[keys[i]];

            if (item && item.cached && item.start <= end + 1 && item.end > end) {
                items.push(item);
            }
        }

        items.sort(function (a, b) {
            return a.start - b.start;
        });

        for (i = 0; i < items.length; i++) {
            if (items[i].start <= end + 1 && items[i].end > end) {
                end = items[i].end;
            }
        }

        return end;
    }

    // Вычисляем "умный буфер": реальный буфер плюс внешний кэш сегментов.
    function getVirtualBufferInfo(session, realInfo) {
        var current;
        var virtualEnd;

        if (!session || !session.video) return realInfo;

        current = toNumber(session.video.currentTime, 0);
        virtualEnd = getVirtualBufferEnd(session, realInfo ? realInfo.end : current);

        return {
            ahead: Math.max(0, virtualEnd - current),
            end: virtualEnd
        };
    }

    // Патчим PlayerInfo, чтобы пользователь видел не только физический MSE-буфер, но и внешний HLS-кэш.
    function patchPlayerInfo() {
        var originalSet;

        if (state.playerInfoPatched) return;
        if (!Lampa || !Lampa.PlayerInfo || typeof Lampa.PlayerInfo.set !== 'function') return;

        originalSet = Lampa.PlayerInfo.set;

        Lampa.PlayerInfo.set = function (need, value) {
            var session;
            var realInfo;
            var virtualInfo;
            var cacheAhead;

            if (need === 'bitrate' && typeof value === 'string') {
                session = state.currentSession;

                if (session && session.lastBufferInfo) {
                    realInfo = session.lastBufferInfo;
                    virtualInfo = getVirtualBufferInfo(session, realInfo);
                    cacheAhead = Math.max(0, virtualInfo.ahead - realInfo.ahead);

                    if (cacheAhead > 20) {
                        value += ' &nbsp;•&nbsp; Кэш ' + toHumanSeconds(cacheAhead);
                    }
                }
            }

            return originalSet.call(this, need, value);
        };

        state.playerInfoPatched = true;
    }

    // Конструктор кастомного fragment loader:
    // сначала пытаемся отдать сегмент из локального кэша, иначе используем стандартный loader hls.js.
    function createAdvancedFragmentLoader(BaseLoaderCtor) {
        function AdvancedFragmentLoader(config) {
            this.config = config || {};
            this.context = null;
            this.stats = createLoaderStats(0);
            this.inner = BaseLoaderCtor ? new BaseLoaderCtor(config) : null;
            this.aborted = false;
            this.destroyed = false;
        }

        AdvancedFragmentLoader.prototype.destroy = function () {
            this.destroyed = true;
            this.abort();
            if (this.inner && typeof this.inner.destroy === 'function') this.inner.destroy();
        };

        AdvancedFragmentLoader.prototype.abort = function () {
            this.aborted = true;
            if (this.inner && typeof this.inner.abort === 'function') this.inner.abort();
        };

        AdvancedFragmentLoader.prototype.getCacheAge = function () {
            if (this.inner && typeof this.inner.getCacheAge === 'function') return this.inner.getCacheAge();
            return null;
        };

        AdvancedFragmentLoader.prototype.getResponseHeader = function (name) {
            if (this.inner && typeof this.inner.getResponseHeader === 'function') return this.inner.getResponseHeader(name);
            return null;
        };

        AdvancedFragmentLoader.prototype.load = function (context, loaderConfig, callbacks) {
            var self = this;
            var key = buildSegmentKeyFromContext(context);
            var session = state.currentSession;
            var startTime = (window.performance && performance.now) ? performance.now() : Date.now();

            this.aborted = false;
            this.context = context;

            function useInnerLoader() {
                if (!self.inner || typeof self.inner.load !== 'function') {
                    callbacks.onError({ code: 0, text: 'Base loader unavailable' }, context, null, self.stats);
                    return;
                }

                self.inner.load(context, loaderConfig, {
                    onSuccess: function (response, stats, ctx, networkDetails) {
                        var payload = response && response.data;

                        self.stats = stats || self.stats;

                        if (session && payload && payload.byteLength) {
                            putCachedSegment(session, key, payload).then(function () {
                                if (!session.segmentMeta[key]) session.segmentMeta[key] = {};
                                session.segmentMeta[key].cached = true;
                            }).catch(function () {});
                        }

                        callbacks.onSuccess(response, stats, ctx, networkDetails);
                    },
                    onError: function (error, ctx, networkDetails, stats) {
                        self.stats = stats || self.stats;
                        callbacks.onError(error, ctx, networkDetails, stats);
                    },
                    onTimeout: function (stats, ctx, networkDetails) {
                        self.stats = stats || self.stats;
                        callbacks.onTimeout(stats, ctx, networkDetails);
                    },
                    onAbort: function (stats, ctx, networkDetails) {
                        self.stats = stats || self.stats;
                        if (callbacks.onAbort) callbacks.onAbort(stats, ctx, networkDetails);
                    },
                    onProgress: callbacks.onProgress
                });
            }

            if (!session) {
                useInnerLoader();
                return;
            }

            ensureSessionInternals(session);

            getCachedSegment(session, key).then(function (buffer) {
                if (self.aborted || self.destroyed) {
                    if (callbacks.onAbort) callbacks.onAbort(self.stats, context, null);
                    return;
                }

                if (buffer && buffer.byteLength) {
                    self.stats = createLoaderStats(buffer.byteLength, startTime);
                    callbacks.onSuccess({
                        url: context.url,
                        data: buffer,
                        code: 200
                    }, self.stats, context, null);
                } else {
                    useInnerLoader();
                }
            }).catch(function () {
                useInnerLoader();
            });
        };

        return AdvancedFragmentLoader;
    }

    // Ставим задачу в очередь фоновой предзагрузки.
    function enqueuePrefetch(session, descriptor) {
        var i;

        ensureSessionInternals(session);

        if (!descriptor || !descriptor.key) return;
        if (session.prefetchInFlight[descriptor.key]) return;
        if (session.segmentMeta[descriptor.key] && session.segmentMeta[descriptor.key].cached) return;

        for (i = 0; i < session.prefetchQueue.length; i++) {
            if (session.prefetchQueue[i].key === descriptor.key) return;
        }

        session.prefetchQueue.push(descriptor);
        session.segmentMeta[descriptor.key] = extend({}, session.segmentMeta[descriptor.key], descriptor);
    }

    // Выполняем одну задачу фоновой предзагрузки.
    function runPrefetchQueue(session) {
        var descriptor;

        if (!session || session.destroyed || !session.quotaLimited) return;

        ensureSessionInternals(session);

        if (session.prefetchBusy) return;
        if (!session.prefetchQueue.length) return;

        descriptor = session.prefetchQueue.shift();
        if (!descriptor) return;

        if (session.segmentMeta[descriptor.key] && session.segmentMeta[descriptor.key].cached) {
            setTimeout(function () {
                runPrefetchQueue(session);
            }, 0);
            return;
        }

        session.prefetchBusy = true;
        session.prefetchInFlight[descriptor.key] = true;

        fetchSegmentArrayBuffer(session, descriptor).then(function (buffer) {
            return putCachedSegment(session, descriptor.key, buffer).then(function () {
                session.segmentMeta[descriptor.key] = extend({}, session.segmentMeta[descriptor.key], descriptor, {
                    cached: true,
                    size: buffer.byteLength || 0,
                    at: Date.now()
                });
            });
        }).catch(function (e) {
            warn('prefetch failed', e && e.message ? e.message : e);
        }).then(function () {
            delete session.prefetchInFlight[descriptor.key];
            session.prefetchBusy = false;

            setTimeout(function () {
                runPrefetchQueue(session);
            }, 10);
        });
    }

    // Планируем предзагрузку будущих сегментов до выбранного пользователем горизонта.
    function schedulePrefetch(session, realInfo) {
        var hls;
        var levelIndex;
        var level;
        var details;
        var fragments;
        var current;
        var virtualInfo;
        var targetEnd;
        var startFrom;
        var i;
        var frag;
        var descriptor;

        if (!session || !session.hls || !session.video || !session.quotaLimited) return;

        hls = session.hls;
        levelIndex = getPrefetchLevelIndex(session);

        if (levelIndex < 0 || !hls.levels || !hls.levels[levelIndex]) return;

        level = hls.levels[levelIndex];
        details = level.details;

        if (!details || !details.fragments || !details.fragments.length) return;

        fragments = details.fragments;
        current = toNumber(session.video.currentTime, 0);
        virtualInfo = getVirtualBufferInfo(session, realInfo || session.lastBufferInfo || { end: current, ahead: 0 });
        targetEnd = current + getTargetBufferSeconds();

        if (virtualInfo.end >= targetEnd - 5) return;

        // Реальный буфер hls.js оставляем ему самому, а внешний кэш начинаем со следующего хвоста.
        startFrom = Math.max(virtualInfo.end, (realInfo && realInfo.end) ? realInfo.end : current);

        for (i = 0; i < fragments.length; i++) {
            frag = fragments[i];

            if (!frag) continue;
            if (toNumber(frag.start, 0) + toNumber(frag.duration, 0) <= startFrom + 0.25) continue;
            if (toNumber(frag.start, 0) >= targetEnd + 0.25) break;

            descriptor = createSegmentDescriptor(frag, levelIndex);
            enqueuePrefetch(session, descriptor);
        }

        runPrefetchQueue(session);
    }

    // Инициализируем дефолтное значение, если пользователь ещё ни разу не открывал настройку.
    function ensureDefaultValue() {
        try {
            var value = Lampa.Storage.get(STORAGE_KEY, null);

            if (value === null || value === undefined || value === '') {
                Lampa.Storage.set(STORAGE_KEY, DEFAULT_MINUTES);
            }
        } catch (e) {
            warn('failed to initialize default setting', e);
        }
    }

    // Регистрируем настройку в отдельном компоненте настроек.
    function registerSettings() {
        if (!Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addComponent || !Lampa.SettingsApi.addParam) {
            warn('SettingsApi is not available, settings registration skipped');
            return;
        }

        ensureDefaultValue();

        // Создаём отдельный раздел настроек, чтобы плагин было легко найти.
        Lampa.SettingsApi.addComponent({
            component: 'advanced_buffer_control',
            name: PLUGIN_TITLE,
            icon: '<svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="8" width="28" height="20" rx="3" stroke="white" stroke-width="2.5"/><path d="M10 18H26" stroke="white" stroke-width="2.5" stroke-linecap="round"/><path d="M10 13H20" stroke="white" stroke-width="2.5" stroke-linecap="round"/><path d="M10 23H18" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'advanced_buffer_control',
            param: {
                name: STORAGE_KEY,
                type: 'select',
                values: BUFFER_OPTIONS,
                default: DEFAULT_MINUTES
            },
            field: {
                name: 'Максимальный размер буфера видео',
                description: 'Сколько минут видео заранее буферизировать (максимум 40 минут)'
            },
            // Значение Storage.set уже сохраняется самим Settings/Params API,
            // а здесь мы просто мгновенно применяем новую конфигурацию к активному плееру.
            onChange: function () {
                applyDefaultHlsConfig(window.Hls);
                syncCurrentSession('settings-change');
            }
        });
    }

    // Обновляем глобальные дефолты hls.js, чтобы новые экземпляры сразу создавались с нужным буфером.
    function applyDefaultHlsConfig(HlsCtor) {
        var seconds;
        var bytes;

        if (!HlsCtor) return;

        seconds = getTargetBufferSeconds();
        bytes = getTargetBufferBytes(seconds);

        try {
            if (HlsCtor.DefaultConfig) {
                HlsCtor.DefaultConfig.maxBufferLength = seconds;
                HlsCtor.DefaultConfig.maxMaxBufferLength = seconds;
                HlsCtor.DefaultConfig.maxBufferSize = bytes;
                HlsCtor.DefaultConfig.backBufferLength = 0;
                HlsCtor.DefaultConfig.liveBackBufferLength = 0;
                HlsCtor.DefaultConfig.lowLatencyMode = false;
            }
        } catch (e) {
            warn('failed to update Hls.DefaultConfig', e);
        }
    }

    // Применяем конфиг к уже созданному экземпляру hls.js.
    function applyHlsRuntimeConfig(hls) {
        var seconds;
        var bytes;

        if (!hls || !hls.config) return;

        seconds = getTargetBufferSeconds();
        bytes = getTargetBufferBytes(seconds);

        try {
            hls.config.maxBufferLength = seconds;
            hls.config.maxMaxBufferLength = seconds;
            hls.config.maxBufferSize = bytes;
            hls.config.backBufferLength = 0;
            hls.config.liveBackBufferLength = 0;
            hls.config.lowLatencyMode = false;
        } catch (e) {
            warn('failed to apply HLS runtime config', e);
        }
    }

    // Если браузер/MSE упёрся в квоту, aggressively чистим хвост позади текущей позиции.
    function flushBackBuffer(session, keepSeconds) {
        var hls;
        var video;
        var startOffset;
        var endOffset;

        if (!session || !session.hls || !session.video) return;

        hls = session.hls;
        video = session.video;
        keepSeconds = toNumber(keepSeconds, BACK_BUFFER_KEEP_SECONDS);

        if (!hls.trigger || !window.Hls || !window.Hls.Events || !window.Hls.Events.BUFFER_FLUSHING) return;

        startOffset = 0;
        endOffset = Math.max(0, toNumber(video.currentTime, 0) - keepSeconds);

        if (endOffset <= 0) return;

        try {
            hls.trigger(window.Hls.Events.BUFFER_FLUSHING, {
                startOffset: startOffset,
                endOffset: endOffset
            });
        } catch (e) {
            warn('failed to flush back buffer', e);
        }
    }

    // При нехватке места по байтам наращиваем будущий буфер самым лёгким уровнем.
    // Это компромисс: приоритет отдаётся минутам буфера, а не качеству удалённых сегментов.
    function enableLowLevelPrefetch(session, reason) {
        var hls;
        var lowIndex;

        if (!session || !session.hls) return;
        if (session.forcedLowLevel) return;

        hls = session.hls;
        lowIndex = getLowestLevelIndex(hls);

        if (lowIndex < 0) return;

        try {
            hls.nextLoadLevel = lowIndex;
            session.forcedLowLevel = true;
            log('enabled low-level prefetch, reason =', reason, 'level =', lowIndex);
        } catch (e) {
            warn('failed to enable low-level prefetch', e);
        }
    }

    // Когда критическая нехватка места ушла, возвращаемся к авто-логике hls.js.
    function disableLowLevelPrefetch(session, reason) {
        var hls;

        if (!session || !session.hls || !session.forcedLowLevel) return;

        hls = session.hls;

        try {
            if (typeof hls.nextAutoLevel === 'number' && isFinite(hls.nextAutoLevel) && hls.nextAutoLevel >= 0) {
                hls.nextLoadLevel = hls.nextAutoLevel;
            }

            session.forcedLowLevel = false;
            log('disabled low-level prefetch, reason =', reason);
        } catch (e) {
            warn('failed to disable low-level prefetch', e);
        }
    }

    // Подключаемся к событиям hls.js, чтобы отслеживать buffer-full и повторно возвращать нужные лимиты.
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
                applyHlsRuntimeConfig(hls);
                evaluateSession('hls-manifest-parsed');
                schedulePrefetch(session, session.lastBufferInfo);
            });

            hls.on(HlsCtor.Events.LEVEL_SWITCHED, function () {
                applyHlsRuntimeConfig(hls);
                schedulePrefetch(session, session.lastBufferInfo);
            });

            hls.on(HlsCtor.Events.FRAG_BUFFERED, function () {
                evaluateSession('hls-frag-buffered');
                schedulePrefetch(session, session.lastBufferInfo);
            });

            hls.on(HlsCtor.Events.ERROR, function (event, data) {
                if (!data || !data.details) return;

                if (data.details === HlsCtor.ErrorDetails.BUFFER_FULL_ERROR || data.details === HlsCtor.ErrorDetails.BUFFER_APPENDING_ERROR) {
                    session.quotaLimited = true;
                    applyHlsRuntimeConfig(hls);
                    flushBackBuffer(session, BACK_BUFFER_KEEP_SECONDS);
                    enableLowLevelPrefetch(session, data.details);
                    forceHlsBuffer(session, data.details);
                    schedulePrefetch(session, session.lastBufferInfo);
                    return;
                }

                if (data.details === HlsCtor.ErrorDetails.BUFFER_STALLED_ERROR) {
                    applyHlsRuntimeConfig(hls);
                    forceHlsBuffer(session, data.details);
                    schedulePrefetch(session, session.lastBufferInfo);
                }
            });
        } catch (e) {
            warn('failed to bind hls events', e);
        }
    }

    // Навешиваем патч на глобальный Hls до того, как Lampa создаст экземпляр в PlayerVideo.url().
    function ensureHlsPatched() {
        var OriginalHls;
        var originalAttachMedia;
        var originalDestroy;

        if (state.hlsPatched) return true;
        if (typeof window.Hls === 'undefined') return false;

        OriginalHls = window.Hls;

        // Если Hls уже был обёрнут кем-то ранее, но это наша обёртка, повторно ничего не делаем.
        if (OriginalHls && OriginalHls.__advancedBufferWrapped) {
            state.hlsPatched = true;
            applyDefaultHlsConfig(OriginalHls);
            return true;
        }

        // Патчим attachMedia, чтобы привязать экземпляр hls к текущему <video>.
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
                    applyHlsRuntimeConfig(this);
                } catch (e) {
                    warn('attachMedia patch failed', e);
                }

                return result;
            };

            OriginalHls.prototype.__advancedBufferAttachPatched = true;
        }

        // Патчим destroy, чтобы не оставлять висящих ссылок на старый экземпляр.
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

        // Оборачиваем сам конструктор, чтобы нужные лимиты буфера попадали в экземпляр сразу.
        function WrappedHls(config) {
            var baseFragmentLoader = (config && config.fLoader) || (config && config.loader) || (OriginalHls.DefaultConfig && (OriginalHls.DefaultConfig.fLoader || OriginalHls.DefaultConfig.loader));
            var advancedFragmentLoader = createAdvancedFragmentLoader(baseFragmentLoader);
            var mergedConfig = extend({}, config || {}, {
                maxBufferLength: getTargetBufferSeconds(),
                maxMaxBufferLength: getTargetBufferSeconds(),
                maxBufferSize: getTargetBufferBytes(getTargetBufferSeconds()),
                fLoader: advancedFragmentLoader
            });

            var instance = new OriginalHls(mergedConfig);

            state.lastHls = instance;
            window.__advancedBufferLastHls = instance;
            applyHlsRuntimeConfig(instance);

            return instance;
        }

        WrappedHls.prototype = OriginalHls.prototype;

        if (Object.setPrototypeOf) {
            Object.setPrototypeOf(WrappedHls, OriginalHls);
        } else {
            WrappedHls.__proto__ = OriginalHls; // eslint-disable-line no-proto
        }

        WrappedHls.__advancedBufferWrapped = true;

        window.Hls = WrappedHls;

        state.hlsPatched = true;

        applyDefaultHlsConfig(window.Hls);
        log('Hls patched successfully');

        return true;
    }

    // Забираем текущий video-элемент максимально безопасно для разных версий Lampa.
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

    // Ищем экземпляр hls.js, который реально привязан к текущему <video>.
    function getCurrentHls(video) {
        var candidates = [];
        var i;

        if (video && video.__advancedBufferHls) candidates.push(video.__advancedBufferHls);
        if (window.hls) candidates.push(window.hls);
        if (window.__advancedBufferLastHls) candidates.push(window.__advancedBufferLastHls);
        if (state.lastHls) candidates.push(state.lastHls);

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

    // Считаем реальный остаток буфера впереди от текущей позиции.
    // Для hls.js сперва пробуем mainForwardBufferInfo, а если его нет — падаем на video.buffered.
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
            // Ничего не делаем: ниже есть универсальный fallback через video.buffered.
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

                // Небольшой tolerance нужен, чтобы не промахнуться из-за погрешностей float.
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

    // На старте каждой сессии дополнительно просим hls.js сразу продолжать загрузку.
    function primeHlsBuffer(session, reason) {
        if (!session || !session.video) return;
        if (!session.hls || typeof session.hls.startLoad !== 'function') return;

        try {
            applyHlsRuntimeConfig(session.hls);
            session.hls.startLoad(toNumber(session.video.currentTime, -1));
            session.lastForceAt = Date.now();
            log('hls.startLoad() forced on', reason || 'prime');
        } catch (e) {
            warn('failed to prime HLS buffer', e);
        }
    }

    // Для hls.js принудительная догрузка безопаснее всего делается через startLoad().
    function forceHlsBuffer(session, reason) {
        if (!session || !session.video || !session.hls) return;
        if (typeof session.hls.startLoad !== 'function') return;
        if (Date.now() - session.lastForceAt < HLS_FORCE_COOLDOWN) return;

        try {
            applyHlsRuntimeConfig(session.hls);
            session.hls.startLoad(toNumber(session.video.currentTime, -1));
            session.lastForceAt = Date.now();
            log('forced HLS buffering, reason =', reason);
        } catch (e) {
            warn('failed to force HLS buffering', e);
        }
    }

    // У нативного <video> нет прямого API для увеличения maxBufferLength,
    // поэтому здесь используется максимально аккуратный "кик":
    // краткий seek внутрь уже имеющегося буфера и немедленный возврат назад.
    // Это best effort-механика и запускается редко, чтобы не дёргать поток лишний раз.
    function forceNativeBuffer(session, info, reason) {
        var video;
        var current;
        var duration;
        var probeTime;

        if (!session || !session.video || !info) return;
        if (Date.now() - session.lastNativeForceAt < NATIVE_FORCE_COOLDOWN) return;

        video = session.video;

        if (session.nativeKickInProgress) return;
        if (video.paused || video.seeking) return;
        if (Date.now() - session.lastProgressAt < 4000) return;

        current = toNumber(video.currentTime, 0);
        duration = toNumber(video.duration, 0);

        if (!isFinite(info.end) || info.end <= current + 2) return;
        if (isFinite(duration) && duration > 0 && current >= duration - 10) return;

        probeTime = Math.max(current + 0.15, info.end - 0.30);

        if (probeTime <= current + 0.05) return;

        session.lastNativeForceAt = Date.now();
        session.nativeKickInProgress = true;

        try {
            video.currentTime = probeTime;
        } catch (e) {
            session.nativeKickInProgress = false;
            warn('native buffer kick failed at forward seek', e);
            return;
        }

        setTimeout(function () {
            try {
                video.currentTime = current;
            } catch (e2) {
                warn('native buffer kick failed at restore seek', e2);
            }

            session.nativeKickInProgress = false;
            session.lastProgressAt = Date.now();
            log('forced native buffering, reason =', reason);
        }, 70);
    }

    // Проверяем, пора ли инициировать дальнейшую догрузку буфера.
    function evaluateSession(reason) {
        var session = state.currentSession;
        var video;
        var duration;
        var info;
        var virtualInfo;
        var playerIsOpened = !Lampa.Player || typeof Lampa.Player.opened !== 'function' || Lampa.Player.opened();

        if (!session || session.destroyed || !playerIsOpened) return;

        video = session.video || getCurrentVideo();

        if (!video || typeof video.addEventListener !== 'function') return;
        if (typeof video.buffered === 'undefined' || typeof video.currentTime === 'undefined') return;

        session.video = video;
        session.hls = getCurrentHls(video);

        // Если это hls.js, каждый проход поддерживает актуальные лимиты буфера.
        if (session.hls) {
            applyHlsRuntimeConfig(session.hls);
            bindHlsEvents(session);
        }

        // На всякий случай принудительно просим браузер максимально предзагружать видео.
        try {
            video.preload = 'auto';
            video.setAttribute('preload', 'auto');
        } catch (e) {
            // Игнорируем, потому что на некоторых оболочках setAttribute может быть ограничен.
        }

        duration = toNumber(video.duration, 0);
        var rawDuration = video.duration;

        // Для live/iptv сценариев агрессивный большой буфер обычно не нужен и может мешать.
        if ((session.playData && (session.playData.iptv || session.playData.tv || session.playData.need_check_live_stream)) || (rawDuration && !isFinite(rawDuration))) {
            return;
        }

        // Пока выполняется внутренний seek-кик для нативного видео, лишний анализ не нужен.
        if (session.nativeKickInProgress) {
            return;
        }

        if (video.ended) return;
        if (isFinite(duration) && duration > 0 && video.currentTime >= duration - 10) return;

        info = getForwardBufferInfo(video, session.hls);
        session.lastBufferInfo = info;
        virtualInfo = getVirtualBufferInfo(session, info);

        if (session.hls) {
            // Если hls.js успел сам уменьшить лимит, сразу возвращаем выбранное пользователем значение.
            if (toNumber(session.hls.config && session.hls.config.maxMaxBufferLength, 0) < getTargetBufferSeconds()) {
                applyHlsRuntimeConfig(session.hls);
            }

            // Если уже был buffer-full, стараемся держать будущее на самом лёгком уровне,
            // пока вперёд не накопится хотя бы заметный запас.
            if (session.quotaLimited && virtualInfo.ahead < Math.min(getTargetBufferSeconds(), 240)) {
                enableLowLevelPrefetch(session, 'quota-limited');
            } else if (virtualInfo.ahead > Math.min(getTargetBufferSeconds(), 300)) {
                disableLowLevelPrefetch(session, 'buffer-recovered');
            }

            schedulePrefetch(session, info);
        }

        // hls.js можно "будить" даже когда буфер уже почти закончился.
        if (session.hls && info.ahead <= LOW_BUFFER_THRESHOLD) {
            forceHlsBuffer(session, reason);
            return;
        }

        // Для нативного video делаем только мягкий kick и только когда буфер ещё есть,
        // иначе можно спровоцировать лишний stall вместо пользы.
        if (!session.hls && info.ahead > 2 && info.ahead <= LOW_BUFFER_THRESHOLD) {
            forceNativeBuffer(session, info, reason);
        }
    }

    // Навешиваем обработчики на текущий video только на время одной сессии проигрывания.
    function bindSessionEvents(session) {
        if (!session || !session.video) return;

        session.handlers = {
            progress: function () {
                session.lastProgressAt = Date.now();
                evaluateSession('progress');
            },
            timeupdate: function () {
                evaluateSession('timeupdate');
            },
            loadeddata: function () {
                session.lastProgressAt = Date.now();
                session.hls = getCurrentHls(session.video);
                if (session.hls) applyHlsRuntimeConfig(session.hls);
                evaluateSession('loadeddata');
            },
            canplay: function () {
                evaluateSession('canplay');
            },
            waiting: function () {
                evaluateSession('waiting');
            },
            seeking: function () {
                evaluateSession('seeking');
            },
            play: function () {
                evaluateSession('play');
            }
        };

        Object.keys(session.handlers).forEach(function (eventName) {
            session.video.addEventListener(eventName, session.handlers[eventName]);
        });

        session.watchdog = setInterval(function () {
            evaluateSession('watchdog');
        }, WATCHDOG_INTERVAL);
    }

    // Снимаем все слушатели и таймеры после закрытия плеера или перед стартом новой сессии.
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

        clearSessionCache(session);

        state.currentSession = null;
    }

    // После ready() видео уже создано, но иногда DOM и hls привязываются не мгновенно,
    // поэтому даём несколько коротких повторных попыток.
    function startPlayerSession(playData, attempt) {
        var session;
        var video;
        var playerIsOpened = !Lampa.Player || typeof Lampa.Player.opened !== 'function' || Lampa.Player.opened();

        if (attempt === undefined) attempt = 0;
        if (!playerIsOpened) return;
        if (playData && (playData.iptv || playData.tv || playData.need_check_live_stream)) return;

        if (!state.currentSession || state.currentSession.playData !== playData) {
            destroyCurrentSession();

            state.currentSession = {
                playData: playData || {},
                video: null,
                hls: null,
                handlers: null,
                watchdog: null,
                destroyed: false,
                lastForceAt: 0,
                lastNativeForceAt: 0,
                lastProgressAt: Date.now(),
                nativeKickInProgress: false,
                lastBufferInfo: null,
                quotaLimited: false,
                forcedLowLevel: false,
                hlsBound: null
            };
        }

        session = state.currentSession;
        ensureSessionInternals(session);
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
            // Ничего страшного.
        }

        bindSessionEvents(session);
        session.bound = true;

        // Один стартовый "толчок" нужен, чтобы hls сразу догружал буфер до нового целевого лимита.
        if (session.hls) {
            primeHlsBuffer(session, 'player-ready');
        }

        evaluateSession('player-ready');
        log('session started, buffer target =', getTargetBufferSeconds(), 'sec');
    }

    // Если пользователь изменил настройку во время воспроизведения, сразу применяем её к активному плееру.
    function syncCurrentSession(reason) {
        var session = state.currentSession;

        applyDefaultHlsConfig(window.Hls);

        if (!session || session.destroyed) return;

        session.hls = getCurrentHls(session.video || getCurrentVideo());

        if (session.hls) {
            applyHlsRuntimeConfig(session.hls);
            primeHlsBuffer(session, reason || 'sync');
        }

        evaluateSession(reason || 'sync');
    }

    // Основная инициализация плагина после готовности приложения.
    function initPlugin() {
        ensureDefaultValue();
        registerSettings();
        ensureHlsPatched();
        applyDefaultHlsConfig(window.Hls);
        patchPlayerInfo();

        // Важно: патчим Hls именно на событии start, потому что Lampa создаёт экземпляр hls.js
        // сразу после Player.listener.send('start', data), внутри Video.url(...).
        Lampa.Player.listener.follow('start', function (data) {
            ensureHlsPatched();
            applyDefaultHlsConfig(window.Hls);

            // На всякий случай чистим старую сессию перед новым запуском видео.
            destroyCurrentSession();

            // IPTV/TV/Live лучше не трогать агрессивной буферизацией вперёд.
            if (data && (data.iptv || data.tv)) {
                return;
            }

            // Ключевое отличие от прошлой версии:
            // если это HLS-поток и hls.js доступен, принудительно просим Lampa использовать именно hls.js,
            // а не нативный HLS плеер браузка/вебвью, который часто и даёт потолок около 2-3 минут.
            if (data && data.url && isM3U8Url(data.url) && typeof window.Hls !== 'undefined' && window.Hls.isSupported && window.Hls.isSupported()) {
                data.hls_type = 'hlsjs';
            }
        });

        // На ready video уже доступен, поэтому здесь создаётся живая сессия мониторинга.
        Lampa.Player.listener.follow('ready', function (data) {
            startPlayerSession(data);
        });

        // При закрытии плеера обязательно снимаем все слушатели и сбрасываем ссылки.
        Lampa.Player.listener.follow('destroy', function () {
            destroyCurrentSession();
        });

        log(PLUGIN_NAME + ' v' + PLUGIN_VERSION + ' initialized');
    }

    // Стандартный шаблон инициализации Lampa-плагина.
    if (window.appready) initPlugin();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') initPlugin();
        });
    }

    console.log('[Advanced Buffer Control] v1.2.0: file end');
}());
