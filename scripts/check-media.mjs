// Enforces the rules of README.md: node scripts/check-media.mjs
// jsDelivr refuses GitHub packages over 50 MB, so the whole tree stays under 40 MB.
// Each image stays within the limit of its top-level folder: the longest side is the largest place
// the folder's images render at in the app (rendered size x device pixel ratio: 3 on phones,
// 2 on tablets and web; phone 430 x 932 dp, tablet 1366 x 1024 dp, web desktop 1920 x 1080 dp).
// Each raster image carries no metadata (EXIF with GPS, XMP, IPTC, ICC profiles, comments, text
// chunks, thumbnails), no orientation other than 1, no colour profile other than sRGB, and no
// bytes after its end marker. Untagged pixels are sRGB.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

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
/** Folders whose images have no place in the app yet: keep them small. */
const DEFAULT_LIMIT = { maxSide: 1200, maxBytes: 400_000 };

const SRGB_PROFILE = /^sRGB\b/i;

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

/** Description of an ICC profile ('desc' tag, v2 text or v4 mluc), or 'unknown'. */
function iccDescription(profile) {
    try {
        const count = profile.readUInt32BE(128);
        for (let i = 0; i < count; i++) {
            if (profile.toString('latin1', 132 + i * 12, 136 + i * 12) !== 'desc') continue;
            const offset = profile.readUInt32BE(136 + i * 12);
            const type = profile.toString('latin1', offset, offset + 4);
            if (type === 'desc') return profile.toString('latin1', offset + 12, offset + 12 + profile.readUInt32BE(offset + 8) - 1);
            if (type === 'mluc') {
                const length = profile.readUInt32BE(offset + 20);
                const start = offset + profile.readUInt32BE(offset + 24);
                return Buffer.from(profile.subarray(start, start + length)).swap16().toString('utf16le');
            }
        }
    } catch {
        // fall through
    }
    return 'unknown';
}

/** A profile is either not sRGB (convert the pixels) or sRGB (drop it: untagged is sRGB). */
function profileProblem(profile, where) {
    const description = iccDescription(profile);
    return SRGB_PROFILE.test(description)
        ? `${where}: ICC profile "${description}" (drop it: untagged pixels are sRGB)`
        : `${where}: non-sRGB ICC profile "${description}" (convert the pixels to sRGB, then drop the profile)`;
}

/** Orientation (tag 0x0112, null when absent) and GPS IFD presence (tag 0x8825) of an EXIF TIFF block. */
function exifTags(tiff) {
    const tags = { orientation: null, gps: false };
    try {
        const little = tiff.toString('latin1', 0, 2) === 'II';
        const u16 = offset => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
        const u32 = offset => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
        const ifd = u32(4);
        const entries = u16(ifd);
        for (let i = 0; i < entries; i++) {
            const entry = ifd + 2 + i * 12;
            if (u16(entry) === 0x0112) tags.orientation = u16(entry + 8);
            if (u16(entry) === 0x8825) tags.gps = true;
        }
    } catch {
        // fall through
    }
    return tags;
}

/** Problems of an EXIF block: always metadata, plus a GPS location or an orientation to bake. */
function exifProblems(tiff, where) {
    const { orientation, gps } = exifTags(tiff);
    const problems = [`EXIF ${where}${gps ? ' with a GPS location' : ''}`];
    if (orientation !== null && orientation !== 1) problems.push(`orientation ${orientation} (bake it into the pixels)`);
    return problems;
}

function jpegProblems(bytes) {
    const problems = [];
    const iccParts = [];
    let offset = 2;
    let scanned = false;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return [...problems, `unexpected byte at ${offset} before the scan`];
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
            offset++;
            continue;
        }
        const length = bytes.readUInt16BE(offset + 2);
        const data = bytes.subarray(offset + 4, offset + 2 + length);
        const id = data.toString('latin1', 0, 14).replace(/\0.*$/s, '');
        if (marker === 0xe0) {
            if (id !== 'JFIF') problems.push(`APP0 "${id}" segment (JFXX thumbnail or unknown)`);
            else if (data[12] !== 0 || data[13] !== 0) problems.push('JFIF thumbnail');
        } else if (marker === 0xe1) {
            if (id.startsWith('Exif')) {
                problems.push(...exifProblems(data.subarray(6), '(APP1) segment'));
            } else {
                problems.push(`${id.startsWith('http://ns.adob') ? 'XMP' : `"${id}"`} (APP1) segment`);
            }
        } else if (marker === 0xe2 && id === 'ICC_PROFILE') {
            iccParts.push(data.subarray(14));
        } else if (marker === 0xee && id.startsWith('Adobe')) {
            // Colour transform flag for the decoder, not metadata.
        } else if (marker >= 0xe2 && marker <= 0xef) {
            problems.push(`APP${marker - 0xe0} "${id}" segment${marker === 0xed ? ' (IPTC)' : ''}`);
        } else if (marker === 0xfe) {
            problems.push('comment (COM) segment');
        } else if (marker === 0xda) {
            scanned = true;
            break;
        }
        offset += 2 + length;
    }
    if (iccParts.length) problems.push(profileProblem(Buffer.concat(iccParts), 'APP2'));
    if (!scanned) problems.push('no scan found');
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) problems.push('bytes after the end marker (or no end marker)');
    return problems;
}

const PNG_ALLOWED = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

function pngProblems(bytes) {
    const problems = [];
    const seen = new Set();
    let offset = 8;
    let ended = false;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        seen.add(type);
        if (type === 'iCCP') {
            const nameEnd = data.indexOf(0);
            try {
                problems.push(profileProblem(inflateSync(data.subarray(nameEnd + 2)), 'iCCP'));
            } catch {
                problems.push('iCCP: unreadable profile');
            }
        } else if (type === 'eXIf') {
            problems.push(...exifProblems(data, 'chunk'));
        } else if (!PNG_ALLOWED.has(type)) {
            problems.push(`${type} chunk${['tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type) ? ' (metadata)' : ''}`);
        }
        offset += 12 + length;
        if (type === 'IEND') {
            ended = true;
            break;
        }
    }
    if ((seen.has('gAMA') || seen.has('cHRM')) && !seen.has('sRGB')) problems.push('gAMA or cHRM without sRGB (non-sRGB colour)');
    if (!ended) problems.push('no IEND chunk');
    else if (offset !== bytes.length) problems.push('bytes after IEND');
    return problems;
}

function webpProblems(bytes) {
    const problems = [];
    const end = 8 + bytes.readUInt32LE(4);
    let offset = 12;
    while (offset + 8 <= end) {
        const type = bytes.toString('latin1', offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'ICCP') problems.push(profileProblem(data, 'ICCP'));
        else if (type === 'EXIF') {
            problems.push(...exifProblems(data.toString('latin1', 0, 4) === 'Exif' ? data.subarray(6) : data, 'chunk'));
        } else if (type === 'XMP ') problems.push('XMP chunk');
        else if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF'].includes(type)) problems.push(`${type} chunk`);
        offset += 8 + length + (length % 2);
    }
    if (end !== bytes.length) problems.push('bytes after the RIFF container');
    return problems;
}

function gifProblems(bytes) {
    const problems = [];
    const skipSubBlocks = start => {
        let offset = start;
        while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset];
        return offset + 1;
    };
    let offset = 13;
    if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
    while (offset < bytes.length) {
        const block = bytes[offset];
        if (block === 0x3b) {
            if (offset + 1 !== bytes.length) problems.push('bytes after the trailer');
            return problems;
        }
        if (block === 0x2c) {
            let next = offset + 10;
            if (bytes[offset + 9] & 0x80) next += 3 * 2 ** ((bytes[offset + 9] & 0x07) + 1);
            offset = skipSubBlocks(next + 1);
        } else if (block === 0x21) {
            const label = bytes[offset + 1];
            if (label === 0xfe) problems.push('comment extension');
            if (label === 0xff) {
                const app = bytes.toString('latin1', offset + 3, offset + 14);
                if (!['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(app)) problems.push(`application extension "${app}"`);
            }
            offset = skipSubBlocks(offset + 2);
        } else {
            problems.push(`unexpected block 0x${block.toString(16)}`);
            return problems;
        }
    }
    problems.push('no trailer');
    return problems;
}

/** Metadata, orientation and colour-profile problems of a raster image. */
function metadataProblems(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegProblems(bytes);
    if (bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return pngProblems(bytes);
    if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return webpProblems(bytes);
    if (bytes.toString('latin1', 0, 4) === 'GIF8') return gifProblems(bytes);
    return ['unknown image format'];
}

// Tracked files plus new, not ignored ones: what the next push publishes.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(file => file && existsSync(join(root, file)));

const problems = [];
let total = 0;
let images = 0;
for (const file of files) {
    const size = statSync(join(root, file)).size;
    total += size;
    if (!/\.(jpe?g|png|gif|webp)$/i.test(file)) continue;
    images++;
    const { maxSide, maxBytes } = Object.hasOwn(FOLDER_LIMITS, file.split('/')[0]) ? FOLDER_LIMITS[file.split('/')[0]] : DEFAULT_LIMIT;
    if (size > maxBytes) problems.push(`${file}: ${(size / 1000).toFixed(0)} KB > ${maxBytes / 1000} KB`);
    const bytes = readFileSync(join(root, file));
    for (const problem of metadataProblems(bytes)) problems.push(`${file}: ${problem}`);
    const box = dimensions(bytes);
    if (!box) {
        problems.push(`${file}: unreadable image header`);
        continue;
    }
    const { width, height } = box;
    if (Math.max(width, height) > maxSide) problems.push(`${file}: ${width}x${height} > ${maxSide} px`);
}
if (total > MAX_TREE_BYTES) problems.push(`tree: ${(total / 1e6).toFixed(1)} MB > ${MAX_TREE_BYTES / 1e6} MB`);

console.log(`${files.length} files (${images} raster images), ${(total / 1e6).toFixed(1)} MB of ${MAX_TREE_BYTES / 1e6} MB`);
if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}
