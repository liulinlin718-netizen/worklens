import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const sourcePath = resolve(process.argv[2] ?? 'build/icon.png')
const outputPath = resolve(process.argv[3] ?? 'build/icon.ico')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const source = await readFile(sourcePath)
const images = await Promise.all(
  sizes.map((size) =>
    sharp(source)
      .resize(size, size, { fit: 'contain' })
      .png()
      .toBuffer()
  )
)

const headerSize = 6
const directorySize = sizes.length * 16
let imageOffset = headerSize + directorySize
const header = Buffer.alloc(headerSize + directorySize)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)

for (let index = 0; index < sizes.length; index += 1) {
  const size = sizes[index]
  const image = images[index]
  const entryOffset = headerSize + index * 16
  header.writeUInt8(size === 256 ? 0 : size, entryOffset)
  header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
  header.writeUInt8(0, entryOffset + 2)
  header.writeUInt8(0, entryOffset + 3)
  header.writeUInt16LE(1, entryOffset + 4)
  header.writeUInt16LE(32, entryOffset + 6)
  header.writeUInt32LE(image.length, entryOffset + 8)
  header.writeUInt32LE(imageOffset, entryOffset + 12)
  imageOffset += image.length
}

await writeFile(outputPath, Buffer.concat([header, ...images]))
console.log(`Generated ${outputPath} with ${sizes.length} embedded PNG sizes.`)
