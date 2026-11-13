'use strict';
// MessagePack 解码器（闲鱼 WS 推送为标准 msgpack 编码，移植自上游 xianyu_utils.MessagePackDecoder）
class MessagePackDecoder {
  constructor(data) { // data: Uint8Array
    this.data = data;
    this.pos = 0;
    this.length = data.length;
  }
  readByte() {
    if (this.pos >= this.length) throw new Error('Unexpected end of data');
    return this.data[this.pos++];
  }
  readBytes(count) {
    if (this.pos + count > this.length) throw new Error('Unexpected end of data');
    const r = this.data.slice(this.pos, this.pos + count);
    this.pos += count;
    return r;
  }
  uint16(b) { return (b[0] << 8) | b[1]; }
  uint32(b) { return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }
  uint64(b) { return Number((BigInt(b[0]) << 56n) | (BigInt(b[1]) << 48n) | (BigInt(b[2]) << 40n) | (BigInt(b[3]) << 32n) | (BigInt(b[4]) << 24n) | (BigInt(b[5]) << 16n) | (BigInt(b[6]) << 8n) | BigInt(b[7])); }
  int8(b) { return (b[0] & 0x80) ? b[0] - 256 : b[0]; }
  int16(b) { const v = this.uint16(b); return (v & 0x8000) ? v - 65536 : v; }
  int32(b) { const v = this.uint32(b); return (v & 0x80000000) ? v - 4294967296 : v; }
  int64(b) { const u = this.uint64(b); return u >= 9223372036854775808 ? u - 18446744073709551616n : u; }
  float32(b) { const buf = new ArrayBuffer(4); new Uint8Array(buf).set(b); return new Float32Array(buf)[0]; }
  float64(b) { const buf = new ArrayBuffer(8); new Uint8Array(buf).set(b); return new Float64Array(buf)[0]; }
  readString(len) { return Buffer.from(this.readBytes(len)).toString('utf8'); }
  decodeValue() {
    const fb = this.readByte();
    if (fb <= 0x7f) return fb;                                  // positive fixint
    if (fb >= 0x80 && fb <= 0x8f) return this.decodeMap(fb & 0x0f);   // fixmap
    if (fb >= 0x90 && fb <= 0x9f) return this.decodeArray(fb & 0x0f); // fixarray
    if (fb >= 0xa0 && fb <= 0xbf) return this.readString(fb & 0x1f);  // fixstr
    if (fb === 0xc0) return null;
    if (fb === 0xc2) return false;
    if (fb === 0xc3) return true;
    if (fb === 0xc4) return Buffer.from(this.readBytes(this.readByte()));           // bin8
    if (fb === 0xc5) return Buffer.from(this.readBytes(this.uint16(this.readBytes(2)))); // bin16
    if (fb === 0xc6) return Buffer.from(this.readBytes(this.uint32(this.readBytes(4)))); // bin32
    if (fb === 0xca) return this.float32(this.readBytes(4));
    if (fb === 0xcb) return this.float64(this.readBytes(8));
    if (fb === 0xcc) return this.readByte();
    if (fb === 0xcd) return this.uint16(this.readBytes(2));
    if (fb === 0xce) return this.uint32(this.readBytes(4));
    if (fb === 0xcf) return this.uint64(this.readBytes(8));
    if (fb === 0xd0) return this.int8(this.readBytes(1));
    if (fb === 0xd1) return this.int16(this.readBytes(2));
    if (fb === 0xd2) return this.int32(this.readBytes(4));
    if (fb === 0xd3) return this.int64(this.readBytes(8));
    if (fb === 0xd9) return this.readString(this.readByte());         // str8
    if (fb === 0xda) return this.readString(this.uint16(this.readBytes(2)));  // str16
    if (fb === 0xdb) return this.readString(this.uint32(this.readBytes(4)));  // str32
    if (fb === 0xdc) return this.decodeArray(this.uint16(this.readBytes(2))); // array16
    if (fb === 0xdd) return this.decodeArray(this.uint32(this.readBytes(4))); // array32
    if (fb === 0xde) return this.decodeMap(this.uint16(this.readBytes(2)));   // map16
    if (fb === 0xdf) return this.decodeMap(this.uint32(this.readBytes(4)));   // map32
    if (fb >= 0xe0) return fb - 256;                            // negative fixint
    throw new Error('Unknown msgpack format byte: ' + fb.toString(16));
  }
  decodeArray(size) { const r = []; for (let i = 0; i < size; i++) r.push(this.decodeValue()); return r; }
  decodeMap(size) {
    const r = {};
    for (let i = 0; i < size; i++) {
      const k = this.decodeValue();
      const v = this.decodeValue();
      r[typeof k === 'object' ? JSON.stringify(k) : String(k)] = v;
    }
    return r;
  }
  decode() { return this.decodeValue(); }
}

/** base64(或 Buffer) → 解码后的 JS 值 */
function decodeMsgpack(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  return new MessagePackDecoder(new Uint8Array(buf)).decode();
}

module.exports = { MessagePackDecoder, decodeMsgpack };
