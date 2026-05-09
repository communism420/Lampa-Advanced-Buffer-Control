# Advanced Buffer Control

## Русский

**Advanced Buffer Control** — плагин для Lampa, который управляет буфером для VOD-видео.

Плагин не добавляет внешний кэш сегментов и не подменяет загрузчик `hls.js`. Он работает поверх штатного плеера Lampa и возможностей браузера/WebView.

### Что умеет

- Добавляет два переключателя в **Настройки -> Плеер**.
- Для `.m3u8`, который не выглядит как live/IPTV, просит Lampa использовать `hls.js`, если он доступен.
- Для HLS VOD увеличивает целевой буфер, стартуя с 480 секунд.
- Постоянно поддерживает HLS-загрузку до текущего target во время воспроизведения и на паузе.
- Автоматически учит безопасный предел устройства по `bufferFullError` / `bufferAppendingError`.
- Запоминает найденный HLS-лимит в `Lampa.Storage` и использует его в следующих сессиях.
- Держит back-buffer коротким: около 20 секунд позади текущей позиции.
- При стабильной работе постепенно пробует поднять лимит выше.
- Опционально удерживает старт воспроизведения, пока не набрано около 15 секунд буфера.
- Заранее реагирует на риск остановки: учитывает прирост буфера, расход буфера, `waiting` / `stalled` / `suspend` и временно блокирует повышение target.
- Для обычного `video` включает `preload="auto"` и аккуратно подталкивает загрузку коротким seek только при низком буфере.

### HLS VOD

Для `.m3u8` потоков плагин сначала проверяет, что URL и данные Lampa не выглядят как live/IPTV. Если поток не похож на live и `hls.js` доступен, плагин просит Lampa использовать `hls.js`, чтобы дальше точно определить тип плейлиста.

Большой HLS-буфер включается только после подтверждения VOD:

- у данных Lampa уже есть конечная длительность;
- либо `hls.js` сообщает, что плейлист не live;
- либо у video появляется конечная длительность.

Если поток помечен как live/IPTV или позже оказался live, плагин отключает расширенное буферизование и возвращает обычные настройки `hls.js`.

Пределы HLS-буфера:

- стартовый target: 480 секунд;
- минимальный обученный target: 15 секунд;
- максимальный target: 900 секунд;
- шаг повышения после стабильной работы: 30 секунд.

### Обычное video-воспроизведение

Для MP4 и других нативных источников браузер/WebView сам решает, сколько реально загрузить. Поэтому плагин не обещает жёсткий лимит буфера для native video.

Вместо этого он:

- включает `preload="auto"`;
- следит за фактическим `video.buffered`;
- при низком буфере и активном воспроизведении делает короткий seek вперёд-назад, чтобы подтолкнуть догрузку;
- не делает такие seek, пока пользователь поставил фильм на паузу.

### Предзагрузка перед стартом

Если включён переключатель **Предзагрузка перед стартом**, плагин ставит воспроизведение на паузу в начале сессии и ждёт, пока впереди не будет около 15 секунд буфера.

Это полезно для слабых сетей, где мгновенный старт часто приводит к `waiting` / `stalled`. После набора целевого буфера плагин сам продолжает воспроизведение, если пользователь не остановил его во время предзагрузки.

### Предиктор остановок

Плагин отслеживает, насколько быстро буфер растёт и расходуется. Если буфер тает быстрее, чем загружается, или появляются события `waiting`, `stalled`, `suspend`, он заранее:

- для HLS вызывает дополнительный `startLoad()`;
- для native video применяет обычный мягкий buffer kick;
- временно запрещает повышение HLS target, чтобы не усугублять нестабильную сессию.

Для HLS отдельно работает постоянный buffer keeper. Он не ждёт низкого буфера: пока впереди меньше текущего target, плагин продолжает вызывать `startLoad()` и делает это даже когда видео стоит на паузе. Если фактический буфер не растёт несколько секунд, keeper мягко перезапускает загрузчик через `stopLoad()` / `startLoad()` без detach/reload источника. Если рост всё равно не возобновляется, keeper временно снижает HLS-уровень на шаг, чтобы буфер начал расти на более лёгком варианте потока.

### Настройки

- **Умное заполнение буфера** — включает или выключает адаптивное заполнение буфера.
- **Предзагрузка перед стартом** — удерживает старт, пока не набрано около 15 секунд буфера.

Умное заполнение буфера включено по умолчанию. Предзагрузка перед стартом выключена по умолчанию.

### Установка

1. В Lampa откройте **Настройки -> Расширения -> Добавить плагин**.
2. Вставьте ссылку:
   `https://communism420.github.io/Lampa-Advanced-Buffer-Control/advanced_buffer_control.js`
3. Подтвердите добавление плагина и перезапустите Lampa, если новая версия не подтянулась сразу.

### Ограничения

- Live/IPTV-потоки не разгоняются большим VOD-буфером.
- Native video нельзя контролировать так же точно, как `hls.js`.
- Реальный максимум буфера зависит от Android / Android TV / WebView, памяти устройства, битрейта и реализации MSE.
- Плагин не сохраняет видео на диск и не делает офлайн-кэш.

---

## English

**Advanced Buffer Control** is a Lampa plugin that manages buffering for VOD playback.

The plugin does not add an external segment cache and does not replace the `hls.js` loader. It works on top of Lampa's regular player and browser/WebView media capabilities.

### Features

- Adds two switches to **Settings -> Player**.
- Asks Lampa to use `hls.js` for `.m3u8` streams that do not look like live/IPTV, when available.
- Increases the HLS VOD target buffer, starting from 480 seconds.
- Keeps HLS loading toward the current target during playback and while paused.
- Learns the safe device limit from `bufferFullError` / `bufferAppendingError`.
- Stores the learned HLS limit in `Lampa.Storage` and reuses it in later sessions.
- Keeps the back-buffer short: about 20 seconds behind the current position.
- Gradually probes higher limits after stable playback.
- Optionally holds playback start until about 15 seconds are buffered.
- Predicts stalls by watching buffer growth, buffer drain and `waiting` / `stalled` / `suspend`, then temporarily blocks target probing.
- For regular `video`, enables `preload="auto"` and gently nudges loading with a short seek only when the buffer is low.

### HLS VOD

For `.m3u8` streams, the plugin first checks that the URL and Lampa play data do not look like live/IPTV. If the stream does not look live and `hls.js` is available, the plugin asks Lampa to use `hls.js` so the playlist type can be detected reliably.

Large HLS buffering is enabled only after VOD is confirmed:

- Lampa play data already has a finite duration;
- or `hls.js` reports that the playlist is not live;
- or the video gets a finite duration.

If the stream is marked as live/IPTV or later turns out to be live, the plugin disables extended buffering and restores the normal `hls.js` settings.

HLS buffer limits:

- initial target: 480 seconds;
- minimum learned target: 15 seconds;
- maximum target: 900 seconds;
- stable-playback probe step: 30 seconds.

### Regular Video Playback

For MP4 and other native sources, the browser/WebView decides how much data can actually be loaded. Because of that, the plugin does not promise a hard buffer target for native video.

Instead it:

- enables `preload="auto"`;
- watches the real `video.buffered` ranges;
- when playback is active and the buffer is low, performs a short forward/back seek to nudge loading;
- skips this seek while the user has paused playback.

### Prebuffer Before Start

When **Prebuffer Before Start** is enabled, the plugin pauses playback at the beginning of a session and waits until roughly 15 seconds are buffered ahead.

This is useful on weak networks where instant playback often leads to `waiting` / `stalled`. Once the target buffer is reached, playback resumes automatically unless the user paused it during prebuffering.

### Stall Predictor

The plugin tracks how quickly the buffer grows and drains. If the buffer is draining faster than it loads, or `waiting`, `stalled`, `suspend` events appear, it proactively:

- calls an extra `startLoad()` for HLS;
- uses the regular soft buffer kick for native video;
- temporarily blocks HLS target increases so an unstable session is not pushed harder.

HLS also has a continuous buffer keeper. It does not wait for a low-buffer state: while the forward buffer is below the current target, the plugin keeps calling `startLoad()`, including while playback is paused. If the real buffered range does not grow for several seconds, the keeper softly restarts the loader with `stopLoad()` / `startLoad()` without detaching or reloading the source. If growth still does not resume, the keeper temporarily lowers the HLS level by one step so buffering can continue on a lighter stream variant.

### Settings

- **Smart Buffer Fill** — enables or disables adaptive buffering.
- **Prebuffer Before Start** — holds playback start until about 15 seconds are buffered.

Smart buffering is enabled by default. Prebuffer before start is disabled by default.

### Installation

1. In Lampa, open **Settings -> Extensions -> Add plugin**.
2. Paste this URL:
   `https://communism420.github.io/Lampa-Advanced-Buffer-Control/advanced_buffer_control.js`
3. Confirm the plugin installation and restart Lampa if the updated version is not loaded immediately.

### Limitations

- Live/IPTV streams are not expanded with the large VOD buffer.
- Native video cannot be controlled as precisely as `hls.js`.
- The real maximum buffer depends on Android / Android TV / WebView, device memory, bitrate and MSE implementation.
- The plugin does not save video to disk and does not provide offline caching.
