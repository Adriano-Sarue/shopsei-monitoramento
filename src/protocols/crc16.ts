// CRC-16/ARC (polinômio 0x8005 refletido, valor inicial 0), usado pelo SIA DC-09.
export function crc16(data: string | Buffer): number {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}
