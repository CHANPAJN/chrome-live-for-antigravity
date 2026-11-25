import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

export function computeWebSocketAccept(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(`${String(secWebSocketKey || '').trim()}${WS_MAGIC_GUID}`, 'utf8')
    .digest('base64');
}

export function encodeWsFrame(opcode, payloadBuffer, mask = false) {
  const payload = Buffer.isBuffer(payloadBuffer)
    ? payloadBuffer
    : Buffer.from(String(payloadBuffer ?? ''), 'utf8');
  const len = payload.length;

  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;

  const maskKey = mask ? crypto.randomBytes(4) : null;
  if (maskKey) headerLen += 4;

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f);

  let offset = 2;
  const maskBit = mask ? 0x80 : 0x00;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, offset);
    offset += 2;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), offset);
    offset += 8;
  }

  if (maskKey) {
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i & 3];
    }
  } else {
    payload.copy(frame, offset);
  }

  return frame;
}

function truncateUtf8Bytes(input, maxBytes) {
  const full = Buffer.from(String(input ?? ''), 'utf8');
  if (full.length <= maxBytes) return full;
  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes (10xxxxxx) so we never split a multi-byte code point
  while (end > 0 && (full[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return full.subarray(0, end);
}

export class NativeWsPeer extends EventEmitter {
  constructor(
    socket,
    { maxPayloadBytes = 16 * 1024 * 1024, maxFragments = 512, requireMask = false } = {}
  ) {
    super();
    this.socket = socket;
    this.maxPayloadBytes = maxPayloadBytes;
    this.maxFragments = maxFragments;
    this.requireMask = Boolean(requireMask);
    this.closed = false;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._fragmentBytes = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._markClosed());
    socket.on('end', () => this._markClosed());
    socket.on('error', (err) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this._markClosed();
    });
  }

  sendText(text) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeWsFrame(0x01, Buffer.from(text, 'utf8'), false));
      return true;
    } catch {
      this._markClosed();
      return false;
    }
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  ping() {
    if (this.closed) return;
    try {
      this.socket.write(encodeWsFrame(0x09, Buffer.alloc(0), false));
    } catch {
      this._markClosed();
    }
  }

  close(code = 1000, reason = '', emitCode = code, emitReason = reason) {
    if (this.closed) return;
    this.closed = true;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._fragments = [];
    this._fragmentBytes = 0;
    try {
      // RFC 6455 Section 5.5: Control frames MUST have payload <= 125 bytes (2-byte code + <=123 valid UTF-8 bytes)
      const reasonBuf = truncateUtf8Bytes(reason, 123);
      const body = Buffer.allocUnsafe(2 + reasonBuf.length);
      body.writeUInt16BE(code, 0);
      reasonBuf.copy(body, 2);
      this.socket.end(encodeWsFrame(0x08, body, false));
      const destroyTimer = setTimeout(() => {
        try {
          if (!this.socket.destroyed) this.socket.destroy();
        } catch {}
      }, 1500);
      destroyTimer.unref?.();
    } catch {
      try {
        this.socket.destroy();
      } catch {}
    }
    this.emit('close', emitCode, String(emitReason ?? ''));
  }

  _markClosed() {
    if (this.closed) return;
    this.closed = true;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._fragments = [];
    this._fragmentBytes = 0;
    this.emit('close', 1006, '');
  }

  _ensureLinearPrefix(minBytes) {
    if (this._chunks.length === 0) return Buffer.alloc(0);
    if (this._chunks[0].length >= minBytes || this._chunks.length === 1) {
      return this._chunks[0];
    }
    const merged = Buffer.concat(this._chunks, this._bufferedBytes);
    this._chunks = [merged];
    return merged;
  }

  _consumeBytes(count) {
    const head = this._ensureLinearPrefix(count);
    const taken = head.subarray(0, count);
    const rem = head.subarray(count);
    this._bufferedBytes -= count;
    if (rem.length === 0) {
      this._chunks = [];
    } else {
      // Avoid retaining multi-KB slabs when only a tiny tail remains
      this._chunks = [rem.buffer.byteLength > 65536 && rem.length < 4096 ? Buffer.from(rem) : rem];
    }
    return taken;
  }

  _onData(chunk) {
    if (this.closed || !chunk || chunk.length === 0) return;
    this._chunks.push(chunk);
    this._bufferedBytes += chunk.length;

    // Hard cap on buffered unparsed bytes to prevent pre-frame OOM
    if (this._bufferedBytes > this.maxPayloadBytes + 16384) {
      this.close(1009, 'Buffered frame exceeds maxPayloadBytes');
      return;
    }

    while (this._bufferedBytes >= 2) {
      const hdr = this._ensureLinearPrefix(Math.min(this._bufferedBytes, 14));
      const first = hdr[0];
      const second = hdr[1];
      if ((first & 0x70) !== 0) {
        this.close(1002, 'RSV bits must be 0 per RFC 6455');
        return;
      }
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (this.requireMask && !masked) {
        this.close(1002, 'Client frames must be masked per RFC 6455');
        return;
      }
      let payloadLen = second & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._bufferedBytes < 4) return;
        payloadLen = hdr.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._bufferedBytes < 10) return;
        const bigLen = hdr.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this.close(1009, 'Frame exceeds maxPayloadBytes');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxPayloadBytes) {
        this.close(1009, 'Frame exceeds maxPayloadBytes');
        return;
      }

      const maskBytes = masked ? 4 : 0;
      const totalFrameLen = offset + maskBytes + payloadLen;
      if (this._bufferedBytes < totalFrameLen) return;

      const rawFrame = this._consumeBytes(totalFrameLen);
      let payload = rawFrame.subarray(offset + maskBytes, totalFrameLen);
      if (masked) {
        const maskKey = rawFrame.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      this._handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    // Control frames MUST NOT be fragmented and payload MUST be <= 125 bytes per RFC 6455
    if (opcode >= 0x08) {
      if (!fin || payload.length > 125) {
        this.close(1002, 'Invalid control frame');
        return;
      }
    }
    if (opcode === 0x08) {
      if (payload.length === 1) {
        this.close(1002, 'Invalid 1-byte close payload');
        return;
      }
      let peerCode = 1005;
      let peerReason = '';
      if (payload.length >= 2) {
        peerCode = payload.readUInt16BE(0);
        const validWireCloseCode =
          (peerCode >= 1000 && peerCode <= 1003) ||
          (peerCode >= 1007 && peerCode <= 1011) ||
          (peerCode >= 3000 && peerCode <= 4999);
        if (!validWireCloseCode) {
          this.close(1002, 'Invalid RFC 6455 close code');
          return;
        }
        if (payload.length > 2) {
          try {
            peerReason = utf8FatalDecoder.decode(payload.subarray(2));
          } catch {
            this.close(1007, 'Invalid UTF-8 in close reason');
            return;
          }
        }
      }
      const replyCode = peerCode === 1005 ? 1000 : peerCode;
      this.close(replyCode, 'Peer closed', peerCode, peerReason);
      return;
    }
    if (opcode === 0x09) {
      if (!this.closed) {
        try {
          this.socket.write(encodeWsFrame(0x0a, payload, false));
        } catch {
          this._markClosed();
        }
      }
      return;
    }
    if (opcode === 0x0a) {
      this.emit('pong');
      return;
    }

    if (opcode === 0x00) {
      if (this._fragmentOpcode === 0) {
        this.close(1002, 'Unexpected continuation frame');
        return;
      }
      if (this._fragments.length >= this.maxFragments) {
        this.close(1009, 'Too many WebSocket fragments');
        return;
      }
      this._fragmentBytes += payload.length;
      if (this._fragmentBytes > this.maxPayloadBytes) {
        this.close(1009, 'Fragmented message too large');
        return;
      }
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments, this._fragmentBytes);
        const origOpcode = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentOpcode = 0;
        this._fragmentBytes = 0;
        this._emitMessage(origOpcode, full);
      }
      return;
    }

    if (opcode === 0x01 || opcode === 0x02) {
      if (this._fragmentOpcode !== 0) {
        this.close(1002, 'Interleaved data frame during fragmentation');
        return;
      }
      if (!fin) {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
        this._fragmentBytes = payload.length;
        return;
      }
      this._emitMessage(opcode, payload);
      return;
    }

    this.close(1002, `Unsupported opcode: ${opcode}`);
  }

  _emitMessage(opcode, fullBuffer) {
    if (opcode === 0x01) {
      let decodedText;
      try {
        decodedText = utf8FatalDecoder.decode(fullBuffer);
      } catch {
        this.close(1007, 'Invalid UTF-8 in text frame per RFC 6455 §8.1');
        return;
      }
      this.emit('message', decodedText);
    } else if (opcode === 0x02) {
      this.emit('binary', fullBuffer);
    }
  }
}

export function upgradeHttpToWebSocket(
  req,
  socket,
  head,
  { requireMask = true, maxPayloadBytes = 16 * 1024 * 1024, maxFragments = 512 } = {}
) {
  const method = String(req.method || '').toUpperCase();
  const upgradeHdr = String(req.headers.upgrade || '').toLowerCase();
  const wsVersion = String(req.headers['sec-websocket-version'] || '').trim();
  const key = typeof req.headers['sec-websocket-key'] === 'string' ? req.headers['sec-websocket-key'].trim() : '';
  let validKey = false;
  if (/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    try {
      validKey = Buffer.from(key, 'base64').length === 16;
    } catch {
      validKey = false;
    }
  }
  if (method !== 'GET' || !upgradeHdr.includes('websocket') || wsVersion !== '13' || !validKey) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = computeWebSocketAccept(key);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n');

  socket.write(responseHeaders);
  const peer = new NativeWsPeer(socket, { requireMask, maxPayloadBytes, maxFragments });
  if (head && head.length > 0) {
    peer._onData(head);
  }
  return peer;
}
