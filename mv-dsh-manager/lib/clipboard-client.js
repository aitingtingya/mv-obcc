// Native-first clipboard fallback for mv-agent.
//
// The existing iframe Permissions Policy remains the primary adaptation.
// Only Chromium's unfocused-document NotAllowedError is delegated to the
// Obsidian host. Port mode is full duplex and independent of WindowProxy
// identity, so moving the same iframe into a popout does not reconnect it.

(function () {
  if (!window.__ModuleLoader__) return;
  window.__ModuleLoader__.load({
    id: '@mv-aide/mv-dsh-manager/clipboard-client',
    factory: () => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      const PROTOCOL = 'mv-aide/clipboard';
      const SCHEMA = 1;
      const OBSIDIAN_DESKTOP_ORIGIN = 'app://obsidian.md';
      const WRITE_TTL_MS = 5000;

      let channel;
      let clipboardRef;
      let originalWriteText;
      const pendingWrites = new Map();

      function validChannelData(data, expectedChannel = channel) {
        return Boolean(
          expectedChannel
          && channel === expectedChannel
          && data
          && data.protocol === PROTOCOL
          && data.schema === SCHEMA
          && data.token === expectedChannel.token
          && data.generation === expectedChannel.generation,
        );
      }

      function closePort(target = channel) {
        if (!target?.port) return;
        target.port.onmessage = null;
        target.port.close?.();
      }

      function rejectPending(error) {
        for (const [, pending] of pendingWrites) {
          window.clearTimeout(pending.timer);
          pending.reject(error);
        }
        pendingWrites.clear();
      }

      function post(message) {
        if (!channel) return;
        if (channel.port) channel.port.postMessage(message);
        else window.parent.postMessage(message, channel.origin);
      }

      function reply(type, payload = {}) {
        if (!channel) return;
        post({
          protocol: PROTOCOL,
          schema: SCHEMA,
          token: channel.token,
          generation: channel.generation,
          type,
          ...payload,
        });
      }

      function settleWrite(data, expectedChannel) {
        if (!validChannelData(data, expectedChannel) || data.type !== 'write-result') return;
        if (typeof data.requestId !== 'string') return;
        const pending = pendingWrites.get(data.requestId);
        if (!pending) return;
        pendingWrites.delete(data.requestId);
        window.clearTimeout(pending.timer);
        if (data.ok === true) pending.resolve();
        else pending.reject(new Error(
          typeof data.error === 'string' && data.error
            ? data.error
            : 'host clipboard write failed',
        ));
      }

      const onMessage = (event) => {
        const data = event.data;
        if (data?.protocol !== PROTOCOL || data.schema !== SCHEMA) return;
        if (data.type !== 'init') {
          if (
            channel?.port
            || event.source !== window.parent
            || event.origin !== channel?.origin
          ) return;
          settleWrite(data, channel);
          return;
        }
        if (data.targetOrigin !== window.location.origin) return;
        if (typeof data.token !== 'string' || typeof data.generation !== 'number') return;
        const port = event.ports?.[0];
        if (port) {
          if (event.origin !== OBSIDIAN_DESKTOP_ORIGIN) return;
        } else {
          if (event.source !== window.parent) return;
          if (event.origin === 'null' || !event.origin) return;
        }

        const previous = channel;
        closePort(previous);
        channel = {
          origin: event.origin,
          token: data.token,
          generation: data.generation,
          ...(port ? { port } : {}),
        };
        if (previous) rejectPending(new Error('clipboard bridge reconnected'));
        if (port) {
          const expectedChannel = channel;
          port.onmessage = portEvent => settleWrite(portEvent.data, expectedChannel);
          port.start?.();
        }
        reply('ready');
      };

      function requestId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      }

      function delegatedWriteText(text) {
        const requestChannel = channel;
        if (!requestChannel) return Promise.reject(new Error('clipboard bridge unavailable'));
        const id = requestId();
        return new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pendingWrites.delete(id);
            reject(new Error('clipboard bridge request timed out'));
          }, WRITE_TTL_MS);
          pendingWrites.set(id, { resolve, reject, timer });
          post({
            protocol: PROTOCOL,
            schema: SCHEMA,
            token: requestChannel.token,
            generation: requestChannel.generation,
            type: 'write-text',
            requestId: id,
            text,
          });
        });
      }

      async function writeText(text, ...rest) {
        try {
          await originalWriteText.call(clipboardRef, text, ...rest);
          return;
        } catch (nativeError) {
          if (nativeError?.name !== 'NotAllowedError') throw nativeError;
          try {
            await delegatedWriteText(text);
            return;
          } catch {
            // DSH already understands the native failure. Do not replace it
            // with a bridge/version guess or claim a successful copy.
            throw nativeError;
          }
        }
      }

      function apply() {
        const clipboard = window.navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== 'function') return;
        if (clipboard.writeText === writeText) return;
        clipboardRef = clipboard;
        originalWriteText = clipboard.writeText;
        clipboard.writeText = writeText;
      }

      function dispose() {
        if (clipboardRef?.writeText === writeText && originalWriteText) {
          clipboardRef.writeText = originalWriteText;
        }
        clipboardRef = undefined;
        originalWriteText = undefined;
        rejectPending(new Error('clipboard bridge disposed'));
        closePort();
        channel = undefined;
        window.removeEventListener('message', onMessage);
      }

      window.addEventListener('message', onMessage);
      apply();

      exports.apply = apply;
      exports.dispose = dispose;
      return module.exports;
    },
  });
})();
