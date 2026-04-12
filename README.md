# Advanced Buffer Control

## Русский

**Advanced Buffer Control** — плагин для Lampa, который добавляет умное управление буфером для разных типов видео и автоматическое восстановление после decode/media ошибок.

Плагин:
- автоматически старается заполнять буфер как для `hls.js`, так и для обычного `video`-воспроизведения;
- для `hls.js` отслеживает `bufferFullError` / `bufferAppendingError`, подстраивается под реальный лимит Android / Android TV / WebView и запоминает найденный безопасный предел;
- при decode/media ошибках сбрасывает буфер, сохраняет текущую позицию и пытается мягко восстановить воспроизведение;
- для `hls.js` использует прямое управление буфером, а для обычного `video` применяет аккуратную принудительную догрузку без жёсткого контроля лимита;
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

**Advanced Buffer Control** is a Lampa plugin for smart buffering across different video types and automatic recovery from decode/media playback errors.

The plugin:
- tries to keep buffering active for both `hls.js` and regular `video` playback;
- for `hls.js`, detects `bufferFullError` / `bufferAppendingError`, adapts to the real Android / Android TV / WebView limit, and stores the learned safe limit for future sessions;
- resets the buffer on decode/media errors, keeps the current position and attempts a smooth playback recovery;
- uses direct buffer control for `hls.js` and gentle forced re-buffering for regular `video` playback without hard limit control;
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
