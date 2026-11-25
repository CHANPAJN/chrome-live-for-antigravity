import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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

export class NativeWsPeer extends EventEmitter {
  constructor(socket, { maxPayloadBytes = 16 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maxPayloadBytes = maxPayloadBytes;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
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

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      // RFC 6455 Section 5.5: Control frames MUST have a payload length <= 125 bytes (2-byte code + <=123 UTF-8 bytes)
      const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 123);
      const body = Buffer.allocUnsafe(2 + reasonBuf.length);
      body.writeUInt16BE(code, 0);
      reasonBuf.copy(body, 2);
      this.socket.end(encodeWsFrame(0x08, body, false));
    } catch {
      try {
        this.socket.destroy();
      } catch {}
    }
    this.emit('close');
  }

  _markClosed() {
    if (this.closed) return;
    this.closed = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this.emit('close');
  }

  _onData(chunk) {
    if (this.closed) return;
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 2) {
      const first = this._buffer[0];
      const second = this._buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLen = second & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
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
      if (this._buffer.length < totalFrameLen) return;

      let payload = this._buffer.subarray(offset + maskBytes, totalFrameLen);
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      // Copy remaining unread bytes if underlying slab is large to prevent retaining multi-KB buffers
      const rem = this._buffer.subarray(totalFrameLen);
      this._buffer = rem.length === 0 ? Buffer.alloc(0) : rem.buffer.byteLength > 65536 ? Buffer.from(rem) : rem;
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
      this.close(1000, 'Peer closed');
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
      this._fragmentBytes += payload.length;
      if (this._fragmentBytes > this.maxPayloadBytes) {
        this.close(1009, 'Fragmented message too large');
        return;
      }
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments);
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
      this.emit('message', fullBuffer.toString('utf8'));
    } else if (opcode === 0x02) {
      this.emit('binary', fullBuffer);
    }
  }
}

export function upgradeHttpToWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
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
  const peer = new NativeWsPeer(socket);
  if (head && head.length > 0) {
    peer._onData(head);
  }
  return peer;
}
