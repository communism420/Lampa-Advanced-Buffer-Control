# Advanced Buffer Control

## Русский

**Advanced Buffer Control** — плагин для Lampa, который управляет буфером для VOD-видео и помогает восстановить воспроизведение после decode/media ошибок.

Плагин не добавляет внешний кэш сегментов и не подменяет загрузчик `hls.js`. Он работает поверх штатного плеера Lampa и возможностей браузера/WebView.

### Что умеет

- Добавляет два переключателя в **Настройки -> Плеер**.
- Для HLS VOD включает воспроизведение через `hls.js`, если оно доступно.
- Для HLS VOD увеличивает целевой буфер, стартуя с 480 секунд.
- Автоматически учит безопасный предел устройства по `bufferFullError` / `bufferAppendingError`.
- Запоминает найденный HLS-лимит в `Lampa.Storage` и использует его в следующих сессиях.
- Держит back-buffer коротким: около 20 секунд позади текущей позиции.
- При стабильной работе постепенно пробует поднять лимит выше.
- Для обычного `video` включает `preload="auto"` и аккуратно подталкивает загрузку коротким seek только при низком буфере.
- При decode/media ошибках очищает буфер, сохраняет позицию и пытается восстановить воспроизведение.

### HLS VOD

Для `.m3u8` потоков плагин сначала проверяет, что это не live/IPTV. Большой буфер применяется только к VOD:

- поток явно не помечен как `live`, `iptv`, `tv`, `channel` или похожий live URL;
- либо `hls.js` сообщает, что плейлист не live;
- либо у видео есть конечная длительность.

Если поток оказался live, плагин отключает расширенное буферизование и возвращает обычные настройки `hls.js`.

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

### Восстановление после ошибок

Если включён переключатель **Восстановление после decode-ошибок**, плагин пытается восстановиться после decode/media ошибок:

- для HLS вызывает `hls.recoverMediaError()`, снова запускает загрузку и возвращает позицию после готовности seek;
- для обычного `video` временно сбрасывает `src` / `<source>`, вызывает `load()`, восстанавливает все атрибуты `<source>` и возвращает позицию;
- не запускает бесконечные циклы восстановления: есть cooldown 7 секунд и максимум 4 попытки до стабильного воспроизведения.

### Настройки

- **Умное заполнение буфера** — включает или выключает адаптивное заполнение буфера.
- **Восстановление после decode-ошибок** — включает или выключает восстановление после decode/media ошибок.

Оба переключателя включены по умолчанию.

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

**Advanced Buffer Control** is a Lampa plugin that manages buffering for VOD playback and helps recover from decode/media errors.

The plugin does not add an external segment cache and does not replace the `hls.js` loader. It works on top of Lampa's regular player and browser/WebView media capabilities.

### Features

- Adds two switches to **Settings -> Player**.
- Forces `hls.js` for HLS VOD playback when available.
- Increases the HLS VOD target buffer, starting from 480 seconds.
- Learns the safe device limit from `bufferFullError` / `bufferAppendingError`.
- Stores the learned HLS limit in `Lampa.Storage` and reuses it in later sessions.
- Keeps the back-buffer short: about 20 seconds behind the current position.
- Gradually probes higher limits after stable playback.
- For regular `video`, enables `preload="auto"` and gently nudges loading with a short seek only when the buffer is low.
- On decode/media errors, clears the buffer, keeps the position and attempts playback recovery.

### HLS VOD

For `.m3u8` streams, the plugin first checks that the stream is not live/IPTV. Large buffering is applied only to VOD:

- the stream is not marked as `live`, `iptv`, `tv`, `channel` or a similar live URL;
- or `hls.js` reports that the playlist is not live;
- or the video has a finite duration.

If the stream is detected as live, the plugin disables extended buffering and restores the normal `hls.js` settings.

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

### Error Recovery

When **Decode Error Recovery** is enabled, the plugin tries to recover from decode/media errors:

- for HLS, it calls `hls.recoverMediaError()`, restarts loading and restores the position once seeking is ready;
- for regular `video`, it temporarily clears `src` / `<source>`, calls `load()`, restores all `<source>` attributes and returns to the saved position;
- it avoids endless recovery loops with a 7-second cooldown and a maximum of 4 attempts before stable playback.

### Settings

- **Smart Buffer Fill** — enables or disables adaptive buffering.
- **Decode Error Recovery** — enables or disables recovery from decode/media errors.

Both switches are enabled by default.

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
