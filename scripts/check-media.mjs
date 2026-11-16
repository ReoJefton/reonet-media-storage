// Enforces the size rules of README.md: node scripts/check-media.mjs
// jsDelivr refuses GitHub packages over 50 MB, so the whole tree stays under 40 MB.
// Each image stays within the limit of its top-level folder: the longest side is the largest place
// the folder's images render at in the app (rendered size x device pixel ratio: 3 on phones,
// 2 on tablets and web; phone 430 x 932 dp, tablet 1366 x 1024 dp, web desktop 1920 x 1080 dp).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_TREE_BYTES = 40_000_000;

/** Longest side (px) and bytes per top-level folder; README.md lists the place behind each one. */
const FOLDER_LIMITS = {
    // Maps place hero: full window width x 160 dp, cover (1920 dp x 2).
    maps: { maxSide: 3840, maxBytes: 2_500_000 },
    // Social post photo: 16:9 at full width in the full-screen post view ((1920 - 2 x 16) dp x 2).
    social: { maxSide: 3776, maxBytes: 2_500_000 },
    // Social story: contained in up to 640 x 1138 dp (tablet portrait, x 2).
    music: { maxSide: 2276, maxBytes: 1_000_000 },
};
/** Folders whose images have no place in the app: keep them small. */
const DEFAULT_LIMIT = { maxSide: 1200, maxBytes: 400_000 };

const root = join(import.meta.dirname, '..');

/** Width and height of a JPEG, PNG, GIF or WebP file, or null when the header is not recognised. */
function dimensions(bytes) {
    if (bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.toString('latin1', 0, 4) === 'GIF8') {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
        const chunk = bytes.toString('latin1', 12, 16);
        if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
        if (chunk === 'VP8L') {
            const bits = bytes.readUInt32LE(21);
            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
        return null;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
            const marker = bytes[offset + 1];
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
            }
            offset += 2 + bytes.readUInt16BE(offset + 2);
        }
    }
    return null;
}

// Tracked files plus new, not ignored ones: what the next push publishes.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(file => file && existsSync(join(root, file)));

const problems = [];
let total = 0;
for (const file of files) {
    const size = statSync(join(root, file)).size;
    total += size;
    if (!/\.(jpe?g|png|gif|webp)$/i.test(file)) continue;
    const { maxSide, maxBytes } = Object.hasOwn(FOLDER_LIMITS, file.split('/')[0]) ? FOLDER_LIMITS[file.split('/')[0]] : DEFAULT_LIMIT;
    if (size > maxBytes) problems.push(`${file}: ${(size / 1000).toFixed(0)} KB > ${maxBytes / 1000} KB`);
    const box = dimensions(readFileSync(join(root, file)));
    if (!box) {
        problems.push(`${file}: unreadable image header`);
        continue;
    }
    const { width, height } = box;
    if (Math.max(width, height) > maxSide) problems.push(`${file}: ${width}x${height} > ${maxSide} px`);
}
if (total > MAX_TREE_BYTES) problems.push(`tree: ${(total / 1e6).toFixed(1)} MB > ${MAX_TREE_BYTES / 1e6} MB`);

console.log(`${files.length} files, ${(total / 1e6).toFixed(1)} MB of ${MAX_TREE_BYTES / 1e6} MB`);
if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}
