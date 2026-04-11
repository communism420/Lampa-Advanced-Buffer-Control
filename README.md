# Advanced Buffer Control

## Русский

**Advanced Buffer Control** — плагин для Lampa, который включает умное заполнение буфера для HLS-видео.

Плагин:
- автоматически старается заполнить буфер до фактического предела устройства;
- отслеживает `bufferFullError` и подстраивается под реальный лимит Android / Android TV / WebView;
- запоминает найденный безопасный предел и использует его при следующих запусках;
- добавляет один переключатель в раздел **Настройки → Плеер**.

### Установка

1. В Lampa откройте **Настройки → Расширения → Добавить плагин**.
2. Вставьте ссылку:
   `https://communism420.github.io/Lampa-Advanced-Buffer-Control/advanced_buffer_control.js`
3. Подтвердите добавление плагина и перезапустите Lampa, если новая версия не подтянулась сразу.

### Настройка

- **Умное заполнение буфера** — включает или выключает систему адаптивного заполнения буфера.
- По умолчанию: **включено**.

---

## English

**Advanced Buffer Control** is a Lampa plugin that enables smart adaptive buffering for HLS video playback.

The plugin:
- tries to fill the buffer up to the actual limit of the device;
- detects `bufferFullError` and adapts to the real Android / Android TV / WebView limit;
- saves the learned safe buffer limit for future playback sessions;
- adds a single switch to **Settings → Player**.

### Installation

1. In Lampa, open **Settings → Extensions → Add plugin**.
2. Paste this URL:
   `https://communism420.github.io/Lampa-Advanced-Buffer-Control/advanced_buffer_control.js`
3. Confirm the plugin installation and restart Lampa if the updated version is not loaded immediately.

### Setting

- **Smart Buffer Fill** — enables or disables the adaptive buffering system.
- Default: **enabled**.
