# Advanced Buffer Control

## Русский

**Advanced Buffer Control** — плагин для Lampa, который добавляет умное управление буфером и автоматическое восстановление после decode/media ошибок.

Плагин:
- автоматически старается заполнить HLS-буфер до фактического предела устройства;
- отслеживает `bufferFullError` / `bufferAppendingError` и подстраивается под реальный лимит Android / Android TV / WebView;
- запоминает найденный безопасный предел и использует его при следующих запусках;
- при decode/media ошибках сбрасывает буфер, сохраняет текущую позицию и пытается мягко восстановить воспроизведение;
- работает с `hls.js`, а восстановление после ошибок также рассчитано на обычное `video`-воспроизведение;
- добавляет два переключателя в раздел **Настройки → Плеер**.

### Установка

1. В Lampa откройте **Настройки → Расширения → Добавить плагин**.
2. Вставьте ссылку:
   `https://communism420.github.io/Lampa-Advanced-Buffer-Control/advanced_buffer_control.js`
3. Подтвердите добавление плагина и перезапустите Lampa, если новая версия не подтянулась сразу.

### Настройка

- **Умное заполнение буфера** — включает или выключает систему адаптивного заполнения буфера.
- **Восстановление после decode-ошибок** — при decode/media ошибках очищает буфер, сохраняет позицию и перезапускает воспроизведение.
- Оба пункта по умолчанию: **включены**.

---

## English

**Advanced Buffer Control** is a Lampa plugin for smart buffering and automatic recovery from decode/media playback errors.

The plugin:
- tries to fill the HLS buffer up to the actual limit of the device;
- detects `bufferFullError` / `bufferAppendingError` and adapts to the real Android / Android TV / WebView limit;
- saves the learned safe buffer limit for future playback sessions;
- resets the buffer on decode/media errors, keeps the current position and attempts a smooth playback recovery;
- works with `hls.js`, while the recovery logic also covers regular `video` playback;
- adds two switches to **Settings → Player**.

### Installation

1. In Lampa, open **Settings → Extensions → Add plugin**.
2. Paste this URL:
   `https://communism420.github.io/Lampa-Advanced-Buffer-Control/advanced_buffer_control.js`
3. Confirm the plugin installation and restart Lampa if the updated version is not loaded immediately.

### Setting

- **Smart Buffer Fill** — enables or disables the adaptive buffering system.
- **Decode Error Recovery** — clears the buffer on decode/media errors, keeps the position and restarts playback.
- Both options are **enabled** by default.
