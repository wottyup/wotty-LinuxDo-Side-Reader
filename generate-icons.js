#!/usr/bin/env node
/**
 * 生成简单的占位图标 PNG 文件
 * 运行: node generate-icons.js
 */
const fs = require('fs');
const path = require('path');

// 最小 PNG 文件 (带 IHDR, IDAT, IEND)
function createSimplePNG(size, r, g, b) {
  const zlib = require('zlib');

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data (each row: filter byte + RGB pixels)
  const rawData = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (1 + size * 3);
    rawData[rowOffset] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const px = rowOffset + 1 + x * 3;
      // 简单的圆角矩形效果
      const margin = Math.floor(size * 0.1);
      const cornerR = Math.floor(size * 0.2);
      const inBounds = x >= margin && x < size - margin && y >= margin && y < size - margin;

      if (inBounds) {
        // 检查圆角
        let inCorner = false;
        const corners = [
          [margin + cornerR, margin + cornerR],
          [size - margin - cornerR, margin + cornerR],
          [margin + cornerR, size - margin - cornerR],
          [size - margin - cornerR, size - margin - cornerR]
        ];
        for (const [cx, cy] of corners) {
          const dx = (x < size / 2 ? x - margin : x - (size - margin)) - cornerR;
          const dy = (y < size / 2 ? y - margin : y - (size - margin)) - cornerR;
          if (x < margin + cornerR && y < margin + cornerR && (x - margin - cornerR) ** 2 + (y - margin - cornerR) ** 2 > cornerR ** 2) inCorner = true;
          if (x >= size - margin - cornerR && y < margin + cornerR && (x - (size - margin - cornerR)) ** 2 + (y - margin - cornerR) ** 2 > cornerR ** 2) inCorner = true;
          if (x < margin + cornerR && y >= size - margin - cornerR && (x - margin - cornerR) ** 2 + (y - (size - margin - cornerR)) ** 2 > cornerR ** 2) inCorner = true;
          if (x >= size - margin - cornerR && y >= size - margin - cornerR && (x - (size - margin - cornerR)) ** 2 + (y - (size - margin - cornerR)) ** 2 > cornerR ** 2) inCorner = true;
        }

        if (inCorner) {
          rawData[px] = 255; rawData[px + 1] = 255; rawData[px + 2] = 255;
        } else {
          rawData[px] = r; rawData[px + 1] = g; rawData[px + 2] = b;
        }
      } else {
        rawData[px] = 255; rawData[px + 1] = 255; rawData[px + 2] = 255;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function makeChunk(type, data) {
    const typeBuffer = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  }

  // CRC32 implementation
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
      }
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

// 生成 16x16, 48x48, 128x128 图标 (深蓝色 #0b0b7e)
[[16, 11, 11, 126], [48, 11, 11, 126], [128, 11, 11, 126]].forEach(([size, r, g, b]) => {
  const png = createSimplePNG(size, r, g, b);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated: ${filePath}`);
});

console.log('Done! Icons generated in icons/ directory.');
